import { createHash } from 'node:crypto';
import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import type {
  WorkUnitArtifact,
  WorkUnitDescriptor,
  WorkUnitResult,
  WorkUnitStatus,
} from '../core/work-unit.js';
import {
  sanitizeSensitiveData,
  sanitizeSensitiveText,
} from '../core/data-sanitizer.js';
import {
  modelTargetSchema,
  type ModelTarget,
} from '../core/model-routing.js';
import type { EventCancelResult } from './dispatcher.js';
import type { ImmutableEvent, ReplyRoute, TaskRecord } from './types.js';
import { MimiStore } from './store.js';
import {
  readCodexTaskProgress,
  type CodexProgressEvent,
} from './codex-task-progress.js';

const MAX_BACKGROUND_TASK_CHILDREN = 8;
type MaybePromise<T> = T | Promise<T>;

const backgroundTaskIdSchema = z.string().trim().refine(
  (taskId) => /^[0-9a-f]{8}$/i.test(taskId) || z.string().uuid().safeParse(taskId).success,
  'taskId 必须是完整 UUID 或 8 位十六进制短 ID',
).describe('完整后台任务 UUID，或其前 8 位短 ID');

const delegationSchema = z.object({
  objective: z.string().trim().min(1).max(8_000)
    .describe('后台任务的完整目标；应独立可执行，不要只写“继续处理”'),
  successCriteria: z.string().trim().min(1).max(4_000).optional()
    .describe('可验证的完成标准、预期产物或必须通过的检查'),
  context: z.string().trim().min(1).max(8_000).optional()
    .describe('完成任务必需、且没有写入目标的有界上下文；不要复制整段会话'),
  strategy: z.enum(['single', 'team']).default('single')
    .describe('single 由一个 Task Lead 完成；可安全拆分的大型任务才使用 team'),
  executor: z.enum(['mimi', 'codex']).default('mimi')
    .describe('mimi（默认）由 MimiAgent 执行；codex 由独立 Codex CLI 执行。完成后均由 Mimi 回到原对话核查结果和安排原目标要求的后续步骤'),
  modelTarget: modelTargetSchema.optional()
    .describe('仅当用户明确指定 Mimi 后台任务模型时填写精确 providerId/modelId；省略时按 background.default 场景路由。只适用于 executor=mimi'),
  workspaceAccess: z.enum(['read', 'write']).default('write')
    .describe('write（默认）可修改工作区且独占执行；read 只读工作区，可与其他只读后台任务并行'),
  requiredCapabilities: z.array(
    z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(120),
  ).min(1).max(20)
    .describe('任务实际需要的结构化能力；例如 workspace.read、workspace.write、shell.execute、browser.page.read 或 computer.act。后台委派不能扩大当前能力'),
  priority: z.number().int().min(0).max(100).default(70),
}).strict();

export interface BackgroundTaskToolContext {
  store: MimiStore;
  task: TaskRecord;
  event: ImmutableEvent;
  sessionId: string;
  workspaceRoot?: string;
  replyRoute?: ReplyRoute;
  connectorCapabilities?: readonly string[];
  cancel?: (eventId: string, reason?: string) => MaybePromise<EventCancelResult>;
  pause?: (eventId: string, reason?: string) => MaybePromise<BackgroundTaskPauseResult>;
  block?: (request: BackgroundTaskBlockRequest) => MaybePromise<unknown>;
}

export interface BackgroundTaskBlockRequest {
  question: string;
  reason?: string;
}

export type BackgroundTaskPauseResult =
  | { state: 'paused' }
  | { state: 'pause_requested' }
  | { state: 'already_paused' }
  | { state: 'not_pauseable' }
  | { state: 'already_terminal' }
  | { state: 'not_found' };

export type BackgroundTaskResumeResult =
  | { state: 'resumed' }
  | { state: 'not_resumable' }
  | { state: 'not_found' };

function taskPrompt(input: z.infer<typeof delegationSchema>): string {
  return [
    '## 后台任务目标',
    input.objective,
    input.successCriteria ? `\n## 完成标准\n${input.successCriteria}` : '',
    input.context ? `\n## 必要上下文\n${input.context}` : '',
    `\n## 执行策略\n${input.strategy}`,
    `\n## 执行器\n${input.executor}`,
    input.modelTarget
      ? `\n## 指定模型\n${input.modelTarget.providerId}/${input.modelTarget.modelId}`
      : '',
    `\n## 工作区访问\n${input.workspaceAccess}`,
    `\n## 必需能力\n${input.requiredCapabilities.join(', ')}`,
  ].filter(Boolean).join('\n');
}

function delegatedCapabilities(
  input: z.infer<typeof delegationSchema>,
  connectorCapabilities: readonly string[],
): Set<string> {
  const available = new Set<string>(['workspace.read']);
  if (input.workspaceAccess === 'write') {
    available.add('workspace.write');
    available.add('shell.execute');
  }
  if (input.executor === 'mimi') {
    available.add('connector.catalog.read');
    for (const capability of connectorCapabilities) available.add(capability);
  }
  return available;
}

function effectiveWorkspaceAccess(
  input: z.infer<typeof delegationSchema>,
): 'read' | 'write' {
  // A supervised Shell process is a host side effect even when its command does
  // not edit project files. Give that worker the exclusive write lane so a
  // "keep the dev server running, do not modify files" task remains executable
  // without weakening the deterministic read-only worker contract.
  return input.requiredCapabilities.includes('shell.execute') ? 'write' : input.workspaceAccess;
}

function delegatedTaskId(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function resolveBackgroundTask(store: MimiStore, taskId: string): TaskRecord {
  const normalizedTaskId = taskId.toLowerCase();
  const exact = z.string().uuid().safeParse(normalizedTaskId).success;
  const matches = exact
    ? [store.getTask(normalizedTaskId)].filter((task): task is TaskRecord => task?.type === 'background')
    : store.listTasks(2, { type: 'background', idPrefix: normalizedTaskId });
  if (matches.length === 0) throw new Error(`后台任务不存在：${taskId}`);
  if (matches.length > 1) throw new Error(`后台任务短 ID 不唯一，请使用完整 UUID：${taskId}`);
  return matches[0]!;
}

export interface BackgroundTaskSummary {
  taskId: string;
  status: TaskRecord['status'];
  objective?: string;
  strategy?: string;
  executor: 'mimi' | 'codex';
  requestedModelTarget?: ModelTarget;
  workspaceAccess: 'read' | 'write';
  sessionId?: string;
  originSessionId?: string;
  parentTaskId?: string;
  authorityEventId: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  previousAttemptError?: string;
  workUnit: {
    descriptor: WorkUnitDescriptor;
    result: WorkUnitResult;
  };
  execution?: {
    leaseActive: boolean;
    leaseUntil?: string;
  };
  codex?: {
    runnerPid?: number;
    codexPid?: number;
    threadId?: string;
    startedAt?: string;
    checkpointedAt?: string;
    lastEvent?: string;
    outputJsonlPath?: string;
    summaryPath?: string;
    logBytes?: number;
    logUpdatedAt?: string;
    latestActivity?: string;
    recentEvents?: CodexProgressEvent[];
  };
}

function workUnitStatus(status: TaskRecord['status']): WorkUnitStatus {
  if (status === 'queued' || status === 'paused') return 'pending';
  if (status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

function workUnitArtifacts(result: unknown): WorkUnitArtifact[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const artifacts = (result as Record<string, unknown>).artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return [];
  return Object.values(artifacts).filter((value): value is string => typeof value === 'string')
    .map((artifactPath) => ({ path: artifactPath }));
}

export function backgroundTaskWorkUnit(task: TaskRecord): {
  descriptor: WorkUnitDescriptor;
  result: WorkUnitResult;
} {
  const payload = task.objective && typeof task.objective === 'object' && !Array.isArray(task.objective)
    ? task.objective as Record<string, unknown>
    : {};
  const objective = typeof payload.objective === 'string'
    ? payload.objective
    : typeof payload.prompt === 'string' ? payload.prompt : `Task ${task.id}`;
  const status = workUnitStatus(task.status);
  const resultText = task.result === undefined
    ? ''
    : typeof task.result === 'string' ? task.result : JSON.stringify(task.result);
  const descriptor: WorkUnitDescriptor = {
    id: task.id,
    kind: task.executor === 'codex' ? 'codex' : 'background',
    parentRunId: task.parentTaskId ? `task:${task.parentTaskId}` : `event:${task.authorityEventId}`,
    ...(task.parentTaskId ? { parentWorkUnitId: task.parentTaskId } : {}),
    objective: sanitizeSensitiveText(objective)?.slice(0, 8_000) ?? '',
    dependencies: [],
    capabilities: task.workspaceAccess === 'write'
      ? ['read', 'write', 'execute', 'state-read', 'state-write']
      : ['read', 'state-read'],
    workspaceAccess: task.workspaceAccess,
    paths: [],
  };
  return {
    descriptor,
    result: {
      id: task.id,
      status,
      summary: sanitizeSensitiveText(resultText || task.error || `${status}: ${objective}`)?.slice(0, 12_000) ?? '',
      artifacts: sanitizeSensitiveData(workUnitArtifacts(task.result)),
      evidence: [
        { type: 'task', ref: `task:${task.id}` },
        ...(task.executor === 'codex' && typeof payload.codex === 'object'
          ? [{ type: 'codex-checkpoint', ref: `task:${task.id}:codex` }]
          : []),
      ],
      ...(status === 'failed' && task.error
        ? { error: sanitizeSensitiveText(task.error)?.slice(0, 2_000) }
        : {}),
      startedAt: task.createdAt,
      ...(status === 'completed' || status === 'failed' || status === 'cancelled'
        ? { completedAt: task.updatedAt }
        : {}),
    },
  };
}

export function backgroundTaskSummary(task: TaskRecord): BackgroundTaskSummary {
  const payload = task.objective && typeof task.objective === 'object'
    ? task.objective as Record<string, unknown>
    : {};
  const modelProfile = payload.modelProfile && typeof payload.modelProfile === 'object'
    && !Array.isArray(payload.modelProfile)
    ? payload.modelProfile as Record<string, unknown>
    : {};
  const requestedModelTarget = modelTargetSchema.safeParse(modelProfile.modelTarget);
  const retrying = task.status === 'queued' || task.status === 'running';
  return {
    taskId: task.id,
    status: task.status,
    objective: typeof payload.objective === 'string'
      ? sanitizeSensitiveText(payload.objective)?.slice(0, 500)
      : undefined,
    strategy: typeof payload.strategy === 'string' ? payload.strategy : undefined,
    executor: task.executor === 'codex' ? 'codex' : 'mimi',
    requestedModelTarget: requestedModelTarget.success ? requestedModelTarget.data : undefined,
    workspaceAccess: task.workspaceAccess === 'read' ? 'read' : 'write',
    sessionId: task.sessionKey,
    originSessionId: typeof payload.originSessionId === 'string' ? payload.originSessionId : undefined,
    parentTaskId: task.parentTaskId,
    authorityEventId: task.authorityEventId,
    attempts: task.attemptCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: sanitizeSensitiveData(task.result),
    error: retrying ? undefined : sanitizeSensitiveText(task.error),
    previousAttemptError: retrying ? sanitizeSensitiveText(task.error) : undefined,
    workUnit: backgroundTaskWorkUnit(task),
    execution: {
      leaseActive: task.status === 'running'
        && task.leaseUntil !== undefined
        && task.leaseUntil > new Date().toISOString(),
      leaseUntil: task.leaseUntil,
    },
    ...(task.executor === 'codex' && payload.codex && typeof payload.codex === 'object'
      ? { codex: payload.codex as BackgroundTaskSummary['codex'] }
      : {}),
  };
}

export async function inspectBackgroundTaskSummary(task: TaskRecord): Promise<BackgroundTaskSummary> {
  const summary = backgroundTaskSummary(task);
  const outputJsonlPath = summary.codex?.outputJsonlPath;
  if (!outputJsonlPath || task.executor !== 'codex') return summary;
  const progress = await readCodexTaskProgress(outputJsonlPath);
  if (!progress) return summary;
  return {
    ...summary,
    codex: {
      ...summary.codex,
      ...progress,
    },
  };
}

export function createBackgroundTaskTools(context: BackgroundTaskToolContext): Tool[] {
  if (context.task.type !== 'conversation') {
    if (!context.block) return [];
    return [tool({
      name: 'request_background_task_input',
      description: '仅当后台任务确实无法在现有上下文中安全继续时，请求用户提供一个明确输入。调用后只给出简短终止答复，不再执行其他工具或工作；MimiAgent 会持久化 blocked 状态并主动通知用户。Task 内需要拆分并行工作时使用 Ultra Team，不得再创建 durable 后台子任务。',
      parameters: z.object({
        question: z.string().trim().min(1).max(2_000)
          .describe('要让用户回答的单个、具体问题'),
        reason: z.string().trim().min(1).max(1_000).optional()
          .describe('为什么没有该输入就无法继续'),
      }).strict(),
      execute: async ({ question, reason }) => {
        await context.block?.({ question, reason });
        return {
          accepted: true,
          question,
          ...(reason ? { reason } : {}),
          message: '已请求用户输入；现在停止本次后台执行并给出简短说明。',
        };
      },
    })];
  }

  const managementTools: Tool[] = [
    tool({
      name: 'list_background_tasks',
      description: '列出最近的 MimiAgent 后台任务及其 queued/running/completed/failed 状态。这只是概览；用户询问某个 Codex 任务的实际进度时，必须继续调用 inspect_background_task 读取其持久输出日志。不要循环轮询，重要终态会主动通知。',
      parameters: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
      execute: async ({ limit }) => context.store.listTasks(limit, { type: 'background' })
        .map(backgroundTaskSummary),
    }),
    tool({
      name: 'inspect_background_task',
      description: '读取一个后台任务的目标、状态、结果和错误。Codex 任务还会直接返回持久 JSONL 输出中的最近执行事件、文件修改、命令和 agent 进展，无需再猜测或搜索日志路径。仅在用户询问或需要继续处理阻塞任务时调用。',
      parameters: z.object({ taskId: backgroundTaskIdSchema }).strict(),
      execute: async ({ taskId }) => {
        const task = resolveBackgroundTask(context.store, taskId);
        return inspectBackgroundTaskSummary(task);
      },
    }),
    tool({
      name: 'cancel_background_task',
      description: '取消一个 queued、running、paused 或 blocked 的后台任务。运行中的外部副作用会先等待安全边界，不确定事务不会自动重放。',
      parameters: z.object({
        taskId: backgroundTaskIdSchema,
        reason: z.string().trim().min(1).max(1_000).optional(),
      }).strict(),
      execute: async ({ taskId, reason }) => {
        const task = resolveBackgroundTask(context.store, taskId);
        const result = await context.cancel?.(task.id, reason ?? 'owner 取消了后台任务')
          ?? (() => {
            context.store.cancelTask(task.id, reason ?? 'owner 取消了后台任务');
            return { state: 'cancelled' as const };
          })();
        return { taskId: task.id, ...result };
      },
    }),
    tool({
      name: 'pause_background_task',
      description: '暂停一个 queued 或 running 的后台任务，保留其任务 Session 和持久进度，之后可继续。运行中的任务会先停在安全边界。',
      parameters: z.object({
        taskId: backgroundTaskIdSchema,
        reason: z.string().trim().min(1).max(1_000).optional(),
      }).strict(),
      execute: async ({ taskId, reason }) => {
        const task = resolveBackgroundTask(context.store, taskId);
        if (task.status === 'paused') return { taskId: task.id, state: 'already_paused' as const };
        if (task.status === 'queued') {
          context.store.pauseTask(task.id, reason ?? 'owner 暂停了后台任务');
          return { taskId: task.id, state: 'paused' as const };
        }
        if (task.status === 'running') {
          const result = await context.pause?.(task.id, reason ?? 'owner 暂停了后台任务')
            ?? { state: 'not_pauseable' as const };
          return { taskId: task.id, ...result };
        }
        if (['completed', 'failed', 'cancelled', 'dead_letter'].includes(task.status)) {
          return { taskId: task.id, state: 'already_terminal' as const };
        }
        return { taskId: task.id, state: 'not_pauseable' as const };
      },
    }),
    tool({
      name: 'resume_background_task',
      description: '继续一个 paused 或 blocked 的后台任务。可附加完成任务所必需的简短新上下文；任务会复用原任务 Session 在后台继续。',
      parameters: z.object({
        taskId: backgroundTaskIdSchema,
        context: z.string().trim().min(1).max(4_000).optional(),
      }).strict(),
      execute: async ({ taskId, context: additionalContext }) => {
        const task = resolveBackgroundTask(context.store, taskId);
        if (task.status !== 'paused' && task.status !== 'blocked') {
          return { taskId: task.id, state: 'not_resumable' as const };
        }
        context.store.resumeTask(task.id, additionalContext);
        return { taskId: task.id, state: 'resumed' as const };
      },
    }),
  ];

  return [
    tool({
      name: 'delegate_background_task',
      description: '把长程或多阶段工作持久化为后台任务。mimi 由 Task Lead 执行；codex 由独立 Codex CLI 执行，不干预执行器内部过程或失败后自动切换执行器。完成后 Mimi 会回到原对话核查结果、处理原目标要求的后续步骤。完整保留用户的观察/跟进要求。成功后立即返回 taskId；当前对话无需等待或轮询。',
      parameters: delegationSchema,
      execute: async (input) => {
        const normalized = delegationSchema.parse(input);
        const parentObjective = context.task.objective as Record<string, unknown> | null;
        const continuationDepth = typeof parentObjective?.continuationDepth === 'number'
          ? parentObjective.continuationDepth : 0;
        if (continuationDepth >= 3) throw new Error('连续核查已达到三轮，请总结已完成项和剩余卡点，让用户决定后续方向');
        const workspaceAccess = effectiveWorkspaceAccess(normalized);
        const effectiveInput = { ...normalized, workspaceAccess };
        if (normalized.executor === 'codex' && normalized.modelTarget) {
          throw new Error(
            'modelTarget 只适用于 executor=mimi；Codex executor 不使用 Mimi Provider registry',
          );
        }
        const availableCapabilities = delegatedCapabilities(
          effectiveInput,
          context.connectorCapabilities ?? [],
        );
        const missingCapabilities = normalized.requiredCapabilities.filter(
          (capability) => !availableCapabilities.has(capability),
        );
        if (missingCapabilities.length) {
          throw new Error(
            `后台 worker 不具备必需能力：${missingCapabilities.join(', ')}；`
            + `可用能力：${[...availableCapabilities].sort().join(', ')}。`
            + '委派不能用于恢复当前 Run 没有的 Computer、Browser 或 Connector 权限。',
          );
        }
        const digest = createHash('sha256')
          .update(JSON.stringify(normalized))
          .digest('hex')
          .slice(0, 24);
        const idempotencyKey = `delegate:${context.task.id}:${digest}`;
        const taskId = delegatedTaskId(idempotencyKey);
        const taskSessionId = `mimi-task-${taskId}`;
        if (!context.store.getTask(taskId)
          && context.store.taskChildCount(context.task.id) >= MAX_BACKGROUND_TASK_CHILDREN) {
          throw new Error(`当前任务最多可直接委派 ${MAX_BACKGROUND_TASK_CHILDREN} 个后台子任务`);
        }
        const inserted = context.store.enqueueTask({
          id: taskId,
          type: 'background',
          idempotencyKey,
          triggerEventId: context.task.triggerEventId,
          authorityEventId: context.task.authorityEventId,
          parentTaskId: context.task.id,
          profileId: context.task.profileId,
          sessionKey: taskSessionId,
          objective: {
            prompt: taskPrompt(effectiveInput),
            objective: normalized.objective,
            ...(normalized.successCriteria ? { successCriteria: normalized.successCriteria } : {}),
            ...(normalized.context ? { context: normalized.context } : {}),
            strategy: normalized.strategy,
            executor: normalized.executor,
            ...(normalized.modelTarget
              ? { modelProfile: { modelTarget: normalized.modelTarget } }
              : {}),
            workspaceAccess,
            requiredCapabilities: normalized.requiredCapabilities,
            ...(context.workspaceRoot ? { workspaceRoot: context.workspaceRoot } : {}),
            originSessionId: context.sessionId,
            returnToOwner: true,
            continuationDepth,
            replyRoute: context.replyRoute ?? context.event.replyRoute ?? { channel: 'system' },
          },
          executor: normalized.executor === 'codex' ? 'codex' : 'isolated_worker',
          workspaceAccess,
          priority: normalized.priority,
          ...(normalized.executor === 'codex' ? { maxAttempts: 1 } : {}),
        });
        return {
          taskId: inserted.id,
          sessionId: inserted.sessionKey,
          status: inserted.status,
          workspaceAccess,
          executor: normalized.executor,
          requestedModelTarget: normalized.modelTarget,
          accepted: true,
          message: '后台任务已持久化并接手；完成、失败或需要输入时 MimiAgent 会主动通知。',
        };
      },
    }),
    ...managementTools,
  ];
}
