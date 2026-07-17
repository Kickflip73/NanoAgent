import { createHash, randomUUID } from 'node:crypto';
import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { EventCancelResult } from './dispatcher.js';
import type { ReplyRoute, StoredEvent } from './types.js';
import { MimiStore } from './store.js';

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
    .describe('mimi（默认）由 MimiAgent 执行；codex 使用可选本地 Codex CLI，完成后仍交回 Mimi 验收'),
  workspaceAccess: z.enum(['read', 'write']).default('write')
    .describe('write（默认）可修改工作区且独占执行；read 只读工作区，可与其他只读后台任务并行'),
  priority: z.number().int().min(0).max(100).default(70),
}).strict();

export interface BackgroundTaskToolContext {
  store: MimiStore;
  event: StoredEvent;
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

export interface BackgroundTaskSummary {
  taskId: string;
  status: StoredEvent['status'];
  objective?: string;
  strategy?: string;
  executor: 'mimi' | 'codex';
  workspaceAccess: 'read' | 'write';
  sessionId?: string;
  originSessionId?: string;
  parentEventId?: string;
  depth: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

export function backgroundTaskSummary(event: StoredEvent): BackgroundTaskSummary {
  const payload = event.payload && typeof event.payload === 'object'
    ? event.payload as Record<string, unknown>
    : {};
  return {
    taskId: event.id,
    status: event.status,
    objective: typeof payload.objective === 'string' ? payload.objective.slice(0, 500) : undefined,
    strategy: typeof payload.strategy === 'string' ? payload.strategy : undefined,
    executor: payload.executor === 'codex' ? 'codex' : 'mimi',
    workspaceAccess: payload.workspaceAccess === 'read' ? 'read' : 'write',
    sessionId: event.sessionKey,
    originSessionId: event.originSessionKey,
    parentEventId: event.parentEventId,
    depth: event.taskDepth ?? 0,
    attempts: event.attempts,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    result: event.result,
    error: event.error,
  };
}

export function createBackgroundTaskTools(context: BackgroundTaskToolContext): Tool[] {
  if (context.event.executionLane === 'task') {
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
      description: '列出最近的 MimiAgent 后台任务及其 queued/running/completed/failed 状态。用于查看已委派工作；不要循环轮询，重要终态会主动通知。',
      parameters: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
      execute: async ({ limit }) => context.store.listBackgroundTasks(limit).map(backgroundTaskSummary),
    }),
    tool({
      name: 'inspect_background_task',
      description: '读取一个后台任务的目标、状态、结果和错误。仅在用户询问或需要继续处理阻塞任务时调用。',
      parameters: z.object({ taskId: z.string().uuid() }).strict(),
      execute: async ({ taskId }) => {
        const event = context.store.getEvent(taskId);
        if (!event || event.executionLane !== 'task') throw new Error(`后台任务不存在：${taskId}`);
        return backgroundTaskSummary(event);
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
        const event = context.store.getEvent(taskId);
        if (!event || event.executionLane !== 'task') throw new Error(`后台任务不存在：${taskId}`);
        const result = await context.cancel?.(taskId, reason ?? 'owner 取消了后台任务')
          ?? (['queued', 'paused', 'blocked'].includes(event.status)
            && context.store.cancelQueuedEvent(taskId, reason ?? 'owner 取消了后台任务')
            ? { state: 'cancelled' as const }
            : { state: 'not_found' as const });
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
        const event = context.store.getEvent(taskId);
        if (!event || event.executionLane !== 'task') throw new Error(`后台任务不存在：${taskId}`);
        if (event.status === 'paused') return { taskId, state: 'already_paused' as const };
        if (event.status === 'queued') {
          context.store.pauseQueuedEvent(taskId, reason ?? 'owner 暂停了后台任务');
          return { taskId, state: 'paused' as const };
        }
        if (event.status === 'running') {
          const result = await context.pause?.(taskId, reason ?? 'owner 暂停了后台任务')
            ?? { state: 'not_pauseable' as const };
          return { taskId, ...result };
        }
        if (['completed', 'ignored', 'digested', 'dead_letter', 'archived'].includes(event.status)) {
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
        const event = context.store.getEvent(taskId);
        if (!event || event.executionLane !== 'task') throw new Error(`后台任务不存在：${taskId}`);
        if (event.status !== 'paused' && event.status !== 'blocked') {
          return { taskId, state: 'not_resumable' as const };
        }
        context.store.resumeBackgroundTask(taskId, additionalContext);
        return { taskId, state: 'resumed' as const };
      },
    }),
  ];

  return [
    tool({
      name: 'delegate_background_task',
      description: '把无需在当前对话立即得到结果的长程、大型、多阶段、持续等待或定时型工作交给 MimiAgent 后台 Task Lead。成功后立即返回 taskId；当前对话不得等待或轮询该任务，也不得重复执行同一工作。简单问答、短操作和用户明确要当前结果的任务不要委派。Task Lead 内部拆分使用 Ultra Team，不会递归创建 durable 后台任务。',
      parameters: delegationSchema,
      execute: async (input) => {
        const normalized = delegationSchema.parse(input);
        const digest = createHash('sha256')
          .update(JSON.stringify(normalized))
          .digest('hex')
          .slice(0, 24);
        const taskId = randomUUID();
        const timestamp = new Date().toISOString();
        const taskSessionId = `mimi-task-${taskId}`;
        const inserted = context.store.enqueueBackgroundTask({
          id: taskId,
          externalId: `background:${context.event.id}:${digest}`,
          source: 'mimi:background-task',
          kind: 'command',
          trust: context.event.trust,
          actor: context.event.actor,
          conversation: context.event.conversation,
          payload: {
            prompt: taskPrompt(normalized),
            objective: normalized.objective,
            successCriteria: normalized.successCriteria,
            context: normalized.context,
            strategy: normalized.strategy,
            executor: normalized.executor,
            workspaceAccess: normalized.workspaceAccess,
          },
          occurredAt: timestamp,
          receivedAt: timestamp,
          priority: normalized.priority,
          profileId: context.event.profileId,
          sessionKey: taskSessionId,
          replyRoute: context.replyRoute ?? context.event.replyRoute ?? { channel: 'system' },
          executionLane: 'task',
          originSessionKey: context.sessionId,
          parentEventId: context.event.id,
          rootEventId: context.event.rootEventId ?? context.event.id,
          taskDepth: 1,
        }, MAX_BACKGROUND_TASK_CHILDREN);
        return {
          taskId: inserted.event.id,
          sessionId: inserted.event.sessionKey,
          status: inserted.event.status,
          workspaceAccess: normalized.workspaceAccess,
          executor: normalized.executor,
          accepted: inserted.inserted,
          message: '后台任务已持久化并接手；完成、失败或需要输入时 MimiAgent 会主动通知。',
        };
      },
    }),
    ...managementTools,
  ];
}
