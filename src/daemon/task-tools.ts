import { createHash } from 'node:crypto';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { EventCancelResult } from './dispatcher.js';
import type { ImmutableEvent, ReplyRoute, TaskRecord } from './types.js';
import { MimiStore } from './store.js';
import {
  readCodexTaskProgress,
  type CodexProgressEvent,
} from './codex-task-progress.js';

const MAX_BACKGROUND_TASK_CHILDREN = 8;
type MaybePromise<T> = T | Promise<T>;

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
    .describe('mimi（默认）由 MimiAgent 执行；codex 由独立 Codex CLI 进程自主执行，MimiAgent 只登记、启动和追踪'),
  workspaceAccess: z.enum(['read', 'write']).default('write')
    .describe('write（默认）可修改工作区且独占执行；read 只读工作区，可与其他只读后台任务并行'),
  priority: z.number().int().min(0).max(100).default(70),
}).strict();

export interface BackgroundTaskToolContext {
  store: MimiStore;
  task: TaskRecord;
  event: ImmutableEvent;
  sessionId: string;
  replyRoute?: ReplyRoute;
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
    `\n## 工作区访问\n${input.workspaceAccess}`,
  ].filter(Boolean).join('\n');
}

function delegatedTaskId(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface BackgroundTaskSummary {
  taskId: string;
  status: TaskRecord['status'];
  objective?: string;
  strategy?: string;
  executor: 'mimi' | 'codex';
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

export function backgroundTaskSummary(task: TaskRecord): BackgroundTaskSummary {
  const payload = task.objective && typeof task.objective === 'object'
    ? task.objective as Record<string, unknown>
    : {};
  const retrying = task.status === 'queued' || task.status === 'running';
  return {
    taskId: task.id,
    status: task.status,
    objective: typeof payload.objective === 'string' ? payload.objective.slice(0, 500) : undefined,
    strategy: typeof payload.strategy === 'string' ? payload.strategy : undefined,
    executor: task.executor === 'codex' ? 'codex' : 'mimi',
    workspaceAccess: task.workspaceAccess === 'read' ? 'read' : 'write',
    sessionId: task.sessionKey,
    originSessionId: typeof payload.originSessionId === 'string' ? payload.originSessionId : undefined,
    parentTaskId: task.parentTaskId,
    authorityEventId: task.authorityEventId,
    attempts: task.attemptCount,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    result: task.result,
    error: retrying ? undefined : task.error,
    previousAttemptError: retrying ? task.error : undefined,
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
      execute: async ({ limit }) => context.store.listTasks(limit)
        .filter((task) => task.type === 'background')
        .map(backgroundTaskSummary),
    }),
    tool({
      name: 'inspect_background_task',
      description: '读取一个后台任务的目标、状态、结果和错误。Codex 任务还会直接返回持久 JSONL 输出中的最近执行事件、文件修改、命令和 agent 进展，无需再猜测或搜索日志路径。仅在用户询问或需要继续处理阻塞任务时调用。',
      parameters: z.object({ taskId: z.string().uuid() }).strict(),
      execute: async ({ taskId }) => {
        const task = context.store.getTask(taskId);
        if (!task || task.type !== 'background') throw new Error(`后台任务不存在：${taskId}`);
        return inspectBackgroundTaskSummary(task);
      },
    }),
    tool({
      name: 'cancel_background_task',
      description: '取消一个 queued、running、paused 或 blocked 的后台任务。运行中的外部副作用会先等待安全边界，不确定事务不会自动重放。',
      parameters: z.object({
        taskId: z.string().uuid(),
        reason: z.string().trim().min(1).max(1_000).optional(),
      }).strict(),
      execute: async ({ taskId, reason }) => {
        const task = context.store.getTask(taskId);
        if (!task || task.type !== 'background') throw new Error(`后台任务不存在：${taskId}`);
        const result = await context.cancel?.(taskId, reason ?? 'owner 取消了后台任务')
          ?? (() => {
            context.store.cancelTask(taskId, reason ?? 'owner 取消了后台任务');
            return { state: 'cancelled' as const };
          })();
        return { taskId, ...result };
      },
    }),
    tool({
      name: 'pause_background_task',
      description: '暂停一个 queued 或 running 的后台任务，保留其任务 Session 和持久进度，之后可继续。运行中的任务会先停在安全边界。',
      parameters: z.object({
        taskId: z.string().uuid(),
        reason: z.string().trim().min(1).max(1_000).optional(),
      }).strict(),
      execute: async ({ taskId, reason }) => {
        const task = context.store.getTask(taskId);
        if (!task || task.type !== 'background') throw new Error(`后台任务不存在：${taskId}`);
        if (task.status === 'paused') return { taskId, state: 'already_paused' as const };
        if (task.status === 'queued') {
          context.store.pauseTask(taskId, reason ?? 'owner 暂停了后台任务');
          return { taskId, state: 'paused' as const };
        }
        if (task.status === 'running') {
          const result = await context.pause?.(taskId, reason ?? 'owner 暂停了后台任务')
            ?? { state: 'not_pauseable' as const };
          return { taskId, ...result };
        }
        if (['completed', 'failed', 'cancelled', 'dead_letter'].includes(task.status)) {
          return { taskId, state: 'already_terminal' as const };
        }
        return { taskId, state: 'not_pauseable' as const };
      },
    }),
    tool({
      name: 'resume_background_task',
      description: '继续一个 paused 或 blocked 的后台任务。可附加完成任务所必需的简短新上下文；任务会复用原任务 Session 在后台继续。',
      parameters: z.object({
        taskId: z.string().uuid(),
        context: z.string().trim().min(1).max(4_000).optional(),
      }).strict(),
      execute: async ({ taskId, context: additionalContext }) => {
        const task = context.store.getTask(taskId);
        if (!task || task.type !== 'background') throw new Error(`后台任务不存在：${taskId}`);
        if (task.status !== 'paused' && task.status !== 'blocked') {
          return { taskId, state: 'not_resumable' as const };
        }
        context.store.resumeTask(taskId, additionalContext);
        return { taskId, state: 'resumed' as const };
      },
    }),
  ];

  return [
    tool({
      name: 'delegate_background_task',
      description: '把无需在当前对话立即得到结果的长程、大型、多阶段、持续等待或定时型工作持久化为后台任务。executor=mimi 时由 Task Lead 执行；executor=codex 时 MimiAgent 只登记、启动并追踪独立 Codex CLI，不参与其 Plan、工具调用、重试或验收，也不会失败后回退给 Mimi。成功后立即返回 taskId；当前对话不得等待、轮询或重复执行。',
      parameters: delegationSchema,
      execute: async (input) => {
        const normalized = delegationSchema.parse(input);
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
            prompt: taskPrompt(normalized),
            objective: normalized.objective,
            ...(normalized.successCriteria ? { successCriteria: normalized.successCriteria } : {}),
            ...(normalized.context ? { context: normalized.context } : {}),
            strategy: normalized.strategy,
            executor: normalized.executor,
            workspaceAccess: normalized.workspaceAccess,
            originSessionId: context.sessionId,
            replyRoute: context.replyRoute ?? context.event.replyRoute ?? { channel: 'system' },
          },
          executor: normalized.executor === 'codex' ? 'codex' : 'isolated_worker',
          workspaceAccess: normalized.workspaceAccess,
          priority: normalized.priority,
          ...(normalized.executor === 'codex' ? { maxAttempts: 1 } : {}),
        });
        return {
          taskId: inserted.id,
          sessionId: inserted.sessionKey,
          status: inserted.status,
          workspaceAccess: normalized.workspaceAccess,
          executor: normalized.executor,
          accepted: true,
          message: '后台任务已持久化并接手；完成、失败或需要输入时 MimiAgent 会主动通知。',
        };
      },
    }),
    ...managementTools,
  ];
}
