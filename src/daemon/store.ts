import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertSessionId } from '../core/session-id.js';
import { EventStore } from './event-store.js';
import { EventRouter } from './event-router.js';
import { TaskStore } from './task-store.js';
import type {
  EventEnvelope,
  EventRouteReceipt,
  DigestItem,
  HostRunRecord,
  IngressTaskRoute,
  ImmutableEvent,
  ImmutableEventInput,
  MimiActivitySnapshot,
  MimiEventSummary,
  MimiOutboxSummary,
  MimiRunSummary,
  MimiScheduleSummary,
  MimiSessionActivity,
  OutboxMessage,
  OutboxStatus,
  ReplyRoute,
  ScheduleRecord,
  TaskAttemptRecord,
  TaskControlIntent,
  TaskInput,
  TaskRecord,
  TaskRouteInput,
  TaskSelector,
  TaskStatus,
} from './types.js';

type Row = Record<string, string | number | null | undefined>;

const DEFAULT_OUTBOX_LEASE_MS = 180_000;
const MAX_TASK_RESUME_CONTEXT_LENGTH = 4_000;
const MAX_TASK_PROMPT_LENGTH = 64_000;

export interface IngressRouteDecision {
  decision: 'task_created' | 'digest' | 'observe_only' | 'rejected';
  reasonCode: string;
}

export interface HistoryPruneResult {
  outbox: number;
  digestItems: number;
  runs: number;
  tasks: number;
  events: number;
  schedules: number;
  attentionState: number;
  auditEvents: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | number | null | undefined): T | undefined {
  if (typeof value !== 'string') return undefined;
  return JSON.parse(value) as T;
}

function parseOptionalJson<T>(value: string | number | null | undefined): T | undefined {
  return parseJson<T | null>(value) ?? undefined;
}

function optional(value: string | number | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function managementLimit(value: number, fallback = 50): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(200, value)) : fallback;
}

function errorSummary(error: unknown, limit = 500): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit) || '未知错误';
}

function resumedTaskPayload(payload: unknown, additionalContext?: string): unknown {
  if (additionalContext === undefined) return payload;
  const context = additionalContext.trim();
  if (!context) return payload;
  if (context.length > MAX_TASK_RESUME_CONTEXT_LENGTH) {
    throw new Error(`后台任务恢复上下文不能超过 ${MAX_TASK_RESUME_CONTEXT_LENGTH} 个字符`);
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload as Record<string, unknown> }
    : {};
  const prompt = typeof record.prompt === 'string' ? record.prompt.trimEnd() : '';
  const resumedPrompt = [prompt, `## 恢复补充上下文\n${context}`].filter(Boolean).join('\n\n');
  if (resumedPrompt.length > MAX_TASK_PROMPT_LENGTH) {
    throw new Error(`后台任务累计提示词不能超过 ${MAX_TASK_PROMPT_LENGTH} 个字符`);
  }
  record.prompt = resumedPrompt;
  return record;
}

function ownerRouteKey(profileId: string): string {
  return `owner-route:${createHash('sha256').update(profileId).digest('hex').slice(0, 24)}`;
}

function deliveryFailurePayload(message: OutboxMessage, error: unknown): Record<string, unknown> {
  const summary = errorSummary(error);
  return {
    type: 'delivery_dead_letter',
    taskId: message.taskId,
    outboxId: message.id,
    channel: message.channel.slice(0, 200),
    attempts: message.attempts,
    error: summary,
    text: `MimiAgent 未能确认结果是否已通过 ${message.channel.slice(0, 120)} 投递，task=${message.taskId.slice(0, 80)}，attempt=${message.attempts}。已进入 dead letter，不会自动重发。${summary} 请运行 mimi daemon outbox 核对后再决定重试或归档。`.slice(0, 1_000),
  };
}

function outboxFromRow(row: Row): OutboxMessage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    channel: String(row.channel),
    target: optional(row.target),
    payload: parseJson(row.payload_json),
    status: String(row.status) as OutboxStatus,
    attempts: Number(row.attempts),
    notBefore: String(row.not_before),
    leaseOwner: optional(row.lease_owner),
    leaseUntil: optional(row.lease_until),
    error: optional(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function scheduleFromRow(row: Row): ScheduleRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.schedule_type) as ScheduleRecord['type'],
    value: String(row.schedule_value),
    prompt: String(row.prompt),
    profileId: String(row.profile_id),
    sessionKey: optional(row.session_key),
    authorityEventId: optional(row.authority_event_id),
    replyRoute: parseOptionalJson(row.reply_route_json),
    trust: String(row.trust) as ScheduleRecord['trust'],
    enabled: Number(row.enabled) === 1,
    nextRunAt: String(row.next_run_at),
    lastRunAt: optional(row.last_run_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function runFromRow(row: Row): HostRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    attemptNo: Number(row.attempt_no),
    workerId: String(row.worker_id),
    sessionKey: String(row.session_key),
    status: String(row.status) as HostRunRecord['status'],
    startedAt: String(row.started_at),
    completedAt: optional(row.completed_at),
    answer: parseJson(row.answer_json),
    error: optional(row.error),
  };
}

function digestFromRow(row: Row): DigestItem {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    source: String(row.source),
    kind: String(row.kind) as DigestItem['kind'],
    priority: Number(row.priority),
    payload: parseJson(row.payload_json),
    reason: String(row.reason),
    occurredAt: String(row.occurred_at),
    createdAt: String(row.created_at),
    digestedAt: optional(row.digested_at),
    briefingEventId: optional(row.briefing_event_id),
  };
}

export class MimiStore {
  readonly file: string;
  private readonly database: DatabaseSync;
  private readonly eventStore: EventStore;
  private readonly eventRouter: EventRouter;
  private readonly taskStore: TaskStore;
  private ingressRoutePolicy?: (event: EventEnvelope, at: Date) => IngressRouteDecision;

  constructor(file: string) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(this.file), 0o700);
    this.database = new DatabaseSync(this.file, { timeout: 5_000 });
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.eventStore = new EventStore(this.database);
    this.taskStore = new TaskStore(this.database);
    this.migrate();
    this.eventRouter = new EventRouter(this, 'ingress-v1');
    chmodSync(this.file, 0o600);
  }

  close(): void {
    this.database.close();
  }

  setIngressRoutePolicy(policy: (event: EventEnvelope, at: Date) => IngressRouteDecision): void {
    this.ingressRoutePolicy = policy;
  }

  appendEvent(event: ImmutableEventInput): { event: ImmutableEvent; inserted: boolean } {
    return this.transaction(() => this.eventStore.append(event, nowIso()));
  }

  getImmutableEvent(id: string): ImmutableEvent | undefined {
    return this.eventStore.get(id);
  }

  listImmutableEvents(limit = 50): ImmutableEvent[] {
    return this.eventStore.list(managementLimit(limit));
  }

  getEventRouteReceipt(eventId: string): EventRouteReceipt | undefined {
    return this.eventStore.getReceipt(eventId);
  }

  routeEvent(eventId: string, route: TaskRouteInput): EventRouteReceipt {
    return this.transaction(() => {
      const existing = this.eventStore.getReceipt(eventId);
      if (existing) return existing;
      if (!this.eventStore.get(eventId)) throw new Error(`Event 不存在：${eventId}`);
      const tasks = route.tasks ?? [];
      if (tasks.length > 16) throw new Error('单个 Event 最多路由 16 个 Task');
      if (route.decision === 'task_created' && tasks.length === 0) {
        throw new Error('task_created 路由必须创建至少一个 Task');
      }
      if (route.decision !== 'task_created' && tasks.length > 0) {
        throw new Error(`${route.decision} 路由不能创建 Task`);
      }
      if (tasks.some((task) => task.triggerEventId !== undefined && task.triggerEventId !== eventId)) {
        throw new Error('Event 路由创建的 Task 必须引用当前 trigger Event');
      }
      const timestamp = nowIso();
      const taskIds = [...new Set(tasks.map((task) => this.enqueueTaskRecord({
        ...task,
        triggerEventId: task.triggerEventId ?? eventId,
      }, timestamp).id))];
      return this.eventStore.insertReceipt({
        eventId,
        routerVersion: route.routerVersion,
        decision: route.decision,
        taskIds,
        reasonCode: route.reasonCode.slice(0, 200),
        routedAt: timestamp,
      });
    });
  }

  enqueueTask(task: TaskInput): TaskRecord {
    return this.transaction(() => this.enqueueTaskRecord(task, nowIso()));
  }

  getTask(id: string): TaskRecord | undefined {
    return this.taskStore.get(id);
  }

  listTasks(limit = 50): TaskRecord[] {
    return this.taskStore.list(managementLimit(limit));
  }

  taskChildCount(parentTaskId: string): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?')
      .get(parentTaskId) as Row;
    return Number(row.count);
  }

  claimTask(
    owner: string,
    selector: TaskSelector = {},
    leaseMs = 60_000,
    at = new Date(),
  ): TaskRecord | undefined {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      this.recoverExpiredTasks(timestamp);
      for (let scanned = 0; scanned < 100; scanned += 1) {
        const candidate = this.taskStore.claimCandidate(selector, timestamp);
        if (!candidate) return undefined;
        const leaseUntil = new Date(at.getTime() + leaseMs).toISOString();
        if (!this.taskStore.claim(candidate.id, owner, leaseUntil, timestamp)) continue;
        const task = this.taskStore.get(candidate.id)!;
        this.appendTaskLifecycleEvent(task, 'task.started', timestamp, {
          attemptNo: task.attemptCount,
          workerId: owner,
        });
        return task;
      }
      return undefined;
    });
  }

  claimTaskById(
    taskId: string,
    owner: string,
    leaseMs = 60_000,
    at = new Date(),
  ): TaskRecord | undefined {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      this.recoverExpiredTasks(timestamp);
      const task = this.taskStore.get(taskId);
      if (!task || task.status !== 'queued' || task.notBefore > timestamp) return undefined;
      const leaseUntil = new Date(at.getTime() + leaseMs).toISOString();
      if (!this.taskStore.claim(taskId, owner, leaseUntil, timestamp)) return undefined;
      const claimed = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(claimed, 'task.started', timestamp, {
        attemptNo: claimed.attemptCount,
        workerId: owner,
      });
      return claimed;
    });
  }

  readyTasks(selector: TaskSelector = {}, limit = 50, at = new Date()): TaskRecord[] {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      this.recoverExpiredTasks(timestamp);
      return this.taskStore.listReady(selector, timestamp, managementLimit(limit));
    });
  }

  beginTaskAttempt(
    taskId: string,
    owner: string,
    sessionKey: string,
    workerId = owner,
    at = new Date(),
  ): TaskAttemptRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task || task.status !== 'running' || task.leaseOwner !== owner
        || !task.leaseUntil || task.leaseUntil <= at.toISOString()) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      return this.taskStore.beginAttempt(randomUUID(), task, sessionKey, workerId, at.toISOString());
    });
  }

  renewTaskLease(taskId: string, owner: string, leaseMs = 60_000, at = new Date()): boolean {
    const timestamp = at.toISOString();
    const updated = this.database.prepare(`
      UPDATE tasks SET lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?
        AND control_intent IS NULL
    `).run(new Date(at.getTime() + leaseMs).toISOString(), timestamp, taskId, owner, timestamp);
    return Number(updated.changes) === 1;
  }

  taskControl(taskId: string): { intent: TaskControlIntent; reason: string } | undefined {
    const task = this.taskStore.get(taskId);
    if (!task?.controlIntent) return undefined;
    return {
      intent: task.controlIntent,
      reason: task.controlReason
        ?? (task.controlIntent === 'cancel' ? 'owner 取消了后台任务' : 'owner 暂停了后台任务'),
    };
  }

  getTaskAttempt(id: string): TaskAttemptRecord | undefined {
    return this.taskStore.getAttempt(id);
  }

  settleTaskControl(
    taskId: string,
    owner: string,
    attemptId?: string,
    at = new Date(),
  ): TaskRecord | undefined {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task || task.status !== 'running' || task.leaseOwner !== owner || !task.controlIntent) {
        return undefined;
      }
      const timestamp = at.toISOString();
      const cancelled = task.controlIntent === 'cancel';
      const reason = task.controlReason
        ?? (cancelled ? 'owner cancelled Task' : 'owner paused Task');
      const updated = this.database.prepare(`
        UPDATE tasks SET status = ?, error = ?, lease_owner = NULL, lease_until = NULL,
          control_intent = NULL, control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND control_intent = ?
      `).run(cancelled ? 'cancelled' : 'paused', reason, timestamp, taskId, owner, task.controlIntent);
      if (Number(updated.changes) !== 1) return undefined;
      if (!this.taskStore.finishAttempt(
        attemptId,
        taskId,
        task.attemptCount,
        'interrupted',
        undefined,
        reason,
        timestamp,
      ) && attemptId) {
        throw new Error(`Task Attempt ${attemptId} 已终止或不存在`);
      }
      const settled = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(
        settled,
        cancelled ? 'task.cancelled' : 'task.paused',
        timestamp,
        { reason, phase: 'safe_boundary' },
      );
      return settled;
    });
  }

  pauseTask(taskId: string, reason = 'owner paused Task', at = new Date()): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task) throw new Error(`Task 不存在：${taskId}`);
      const timestamp = at.toISOString();
      const summary = errorSummary(reason, 4_000);
      if (task.status === 'queued') {
        const updated = this.database.prepare(`
          UPDATE tasks SET status = 'paused', control_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(summary, timestamp, taskId);
        if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 状态已变化`);
        const paused = this.taskStore.get(taskId)!;
        this.appendTaskLifecycleEvent(paused, 'task.paused', timestamp, { reason: summary });
        return paused;
      }
      if (task.status === 'running') {
        if (task.controlIntent === 'cancel' || task.controlIntent === 'pause') return task;
        const updated = this.database.prepare(`
          UPDATE tasks SET
            control_intent = CASE WHEN control_intent = 'cancel' THEN control_intent ELSE 'pause' END,
            control_reason = CASE WHEN control_intent = 'cancel' THEN control_reason ELSE ? END,
            updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(summary, timestamp, taskId);
        if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 状态已变化`);
        const requested = this.taskStore.get(taskId)!;
        if (requested.controlIntent === 'pause') {
          this.appendTaskLifecycleEvent(requested, 'task.pause_requested', timestamp, { reason: summary });
        }
        return requested;
      }
      if (task.status === 'paused') return task;
      throw new Error(`Task ${taskId} 不是可暂停状态：${task.status}`);
    });
  }

  resumeTask(taskId: string, context?: string, at = new Date()): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task || (task.status !== 'paused' && task.status !== 'blocked')) {
        throw new Error(`Task ${taskId} 不是可恢复状态`);
      }
      const timestamp = at.toISOString();
      const objective = resumedTaskPayload(task.objective, context);
      const updated = this.database.prepare(`
        UPDATE tasks SET status = 'queued', objective_json = ?, not_before = ?, control_intent = NULL,
          control_reason = NULL, result_json = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('paused', 'blocked')
      `).run(json(objective), timestamp, timestamp, taskId);
      if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 状态已变化`);
      const resumed = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(resumed, 'task.resumed', timestamp, {
        previousStatus: task.status,
        additionalContext: Boolean(context?.trim()),
      });
      return resumed;
    });
  }

  cancelTask(taskId: string, reason = 'owner cancelled Task', at = new Date()): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task) throw new Error(`Task 不存在：${taskId}`);
      const timestamp = at.toISOString();
      const summary = errorSummary(reason, 4_000);
      if (task.status === 'running') {
        if (task.controlIntent === 'cancel') return task;
        this.database.prepare(`
          UPDATE tasks SET control_intent = 'cancel', control_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(summary, timestamp, taskId);
        const requested = this.taskStore.get(taskId)!;
        this.appendTaskLifecycleEvent(requested, 'task.cancel_requested', timestamp, { reason: summary });
        return requested;
      }
      if (task.status === 'queued' || task.status === 'paused' || task.status === 'blocked') {
        const updated = this.database.prepare(`
          UPDATE tasks SET status = 'cancelled', error = ?, control_intent = NULL,
            control_reason = NULL, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'paused', 'blocked')
        `).run(summary, timestamp, taskId);
        if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 状态已变化`);
        const cancelled = this.taskStore.get(taskId)!;
        this.appendTaskLifecycleEvent(cancelled, 'task.cancelled', timestamp, { reason: summary });
        return cancelled;
      }
      return task;
    });
  }

  completeTask(
    taskId: string,
    owner: string,
    result: unknown,
    attemptId?: string,
    at = new Date(),
    delivery?: { route: ReplyRoute; payload: unknown },
  ): TaskRecord {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const current = this.taskStore.get(taskId);
      if (!current || current.status !== 'running' || current.leaseOwner !== owner
        || !current.leaseUntil || current.leaseUntil <= timestamp) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      if (!this.taskStore.updateTerminal(taskId, owner, 'completed', result, undefined, timestamp)) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      if (!this.taskStore.finishAttempt(
        attemptId,
        taskId,
        current.attemptCount,
        'completed',
        result,
        undefined,
        timestamp,
      ) && attemptId) {
        throw new Error(`Task Attempt ${attemptId} 已终止或不存在`);
      }
      const task = this.taskStore.get(taskId)!;
      if (task.type === 'briefing' && task.triggerEventId) {
        this.database.prepare(`
          UPDATE digest_items SET digested_at = ?
          WHERE briefing_event_id = ? AND digested_at IS NULL
        `).run(timestamp, task.triggerEventId);
      }
      this.appendTaskLifecycleEvent(task, 'task.completed', timestamp, { resultAvailable: result !== undefined });
      if (delivery) this.insertOutbox(taskId, delivery.route, delivery.payload, timestamp);
      return task;
    });
  }

  bindRunningTaskSession(taskId: string, owner: string, sessionKey: string, at = new Date()): void {
    const timestamp = at.toISOString();
    const updated = this.database.prepare(`
      UPDATE tasks SET session_key = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
        AND lease_until > ? AND control_intent IS NULL
    `).run(sessionKey, timestamp, taskId, owner, timestamp);
    if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 租约已失效`);
  }

  blockTask(
    taskId: string,
    owner: string,
    result: unknown,
    reason: string,
    attemptId?: string,
    at = new Date(),
    delivery?: { route: ReplyRoute; payload: unknown },
  ): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      const timestamp = at.toISOString();
      if (!task || task.status !== 'running' || task.leaseOwner !== owner
        || !task.leaseUntil || task.leaseUntil <= timestamp || task.controlIntent !== undefined) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      const updated = this.database.prepare(`
        UPDATE tasks SET status = 'blocked', result_json = ?, error = ?, lease_owner = NULL,
          lease_until = NULL, control_intent = NULL, control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_until > ? AND control_intent IS NULL
      `).run(json(result), errorSummary(reason, 4_000), timestamp, taskId, owner, timestamp);
      if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 租约已失效`);
      if (!this.taskStore.finishAttempt(
        attemptId,
        taskId,
        task.attemptCount,
        'interrupted',
        result,
        reason,
        timestamp,
      ) && attemptId) {
        throw new Error(`Task Attempt ${attemptId} 已终止或不存在`);
      }
      const blocked = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(blocked, 'task.blocked', timestamp, { reason });
      if (delivery) this.insertOutbox(taskId, delivery.route, delivery.payload, timestamp);
      return blocked;
    });
  }

  requeueTask(taskId: string, owner: string, reason: string, attemptId?: string, at = new Date()): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      const timestamp = at.toISOString();
      if (!task || task.status !== 'running' || task.leaseOwner !== owner
        || !task.leaseUntil || task.leaseUntil <= timestamp || task.controlIntent) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      if (!this.taskStore.requeueFailure(taskId, owner, errorSummary(reason, 4_000), timestamp, timestamp)) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      if (!this.taskStore.finishAttempt(
        attemptId, taskId, task.attemptCount, 'interrupted', undefined, reason, timestamp,
      ) && attemptId) throw new Error(`Task Attempt ${attemptId} 已终止或不存在`);
      const queued = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(queued, 'task.retry_scheduled', timestamp, { reason, notBefore: timestamp });
      return queued;
    });
  }

  preemptTask(taskId: string, owner: string, reason: string, attemptId?: string, at = new Date()): TaskRecord {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const task = this.taskStore.get(taskId);
      if (!task || task.status !== 'running' || task.leaseOwner !== owner
        || !task.leaseUntil || task.leaseUntil <= timestamp || task.controlIntent) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      const updated = this.database.prepare(`
        UPDATE tasks SET status = 'queued', max_attempts = max_attempts + 1,
          not_before = ?, error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_until > ? AND control_intent IS NULL
      `).run(timestamp, errorSummary(reason, 4_000), timestamp, taskId, owner, timestamp);
      if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 租约已失效`);
      if (!this.taskStore.finishAttempt(
        attemptId, taskId, task.attemptCount, 'interrupted', undefined, reason, timestamp,
      ) && attemptId) throw new Error(`Task Attempt ${attemptId} 已终止或不存在`);
      const queued = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(queued, 'task.preempted', timestamp, { reason });
      return queued;
    });
  }

  failTask(
    taskId: string,
    owner: string,
    error: unknown,
    attemptId?: string,
    at = new Date(),
    retryable = true,
    terminalStatus: Extract<TaskStatus, 'failed' | 'dead_letter'> = 'failed',
  ): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task || task.status !== 'running' || task.leaseOwner !== owner
        || !task.leaseUntil || task.leaseUntil <= at.toISOString()) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      const timestamp = at.toISOString();
      const summary = errorSummary(error, 4_000);
      const terminal = !retryable || task.attemptCount >= task.maxAttempts;
      if (terminal) {
        const status = retryable ? 'dead_letter' : terminalStatus;
        if (!this.taskStore.updateTerminal(taskId, owner, status, undefined, summary, timestamp)) {
          throw new Error(`Task ${taskId} 租约已失效`);
        }
      } else {
        const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, task.attemptCount - 1));
        if (!this.taskStore.requeueFailure(
          taskId,
          owner,
          summary,
          new Date(at.getTime() + delay).toISOString(),
          timestamp,
        )) throw new Error(`Task ${taskId} 租约已失效`);
      }
      if (!this.taskStore.finishAttempt(
        attemptId,
        taskId,
        task.attemptCount,
        'failed',
        undefined,
        summary,
        timestamp,
      ) && attemptId) {
        throw new Error(`Task Attempt ${attemptId} 已终止或不存在`);
      }
      const updated = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(updated, terminal
        ? (updated.status === 'failed' ? 'task.failed' : 'task.dead_letter')
        : 'task.retry_scheduled', timestamp, {
        error: summary,
        attemptNo: task.attemptCount,
        notBefore: updated.notBefore,
      });
      if (terminal) {
        const trigger = task.triggerEventId ? this.eventStore.get(task.triggerEventId) : undefined;
        const authority = this.eventStore.get(task.authorityEventId);
        const route = trigger?.replyRoute ?? authority?.replyRoute;
        if (route) {
          this.insertOutbox(task.id, route, {
            type: updated.status === 'dead_letter' ? 'task_dead_letter' : 'task_failed',
            taskId: task.id,
            text: `MimiAgent 任务失败（${task.id}）：${summary}`.slice(0, 4_000),
          }, timestamp);
        }
      }
      return updated;
    });
  }

  ingestEvent(
    event: EventEnvelope,
    route: IngressTaskRoute = {},
  ): { event: ImmutableEvent; task?: TaskRecord; inserted: boolean } {
    return this.transaction(() => {
      const appended = this.eventStore.append({
        id: event.id,
        externalId: event.externalId,
        source: event.source,
        type: event.kind === 'schedule' ? 'schedule.due' : `${event.kind}.received`,
        trust: event.trust,
        actor: event.actor,
        conversation: event.conversation,
        payload: event.payload,
        correlationId: event.id,
        profileId: event.profileId,
        replyRoute: event.replyRoute,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
      }, nowIso());
      const receipt = this.eventStore.getReceipt(appended.event.id);
      if (receipt) {
        return {
          ...appended,
          task: receipt.taskIds[0] ? this.taskStore.get(receipt.taskIds[0]) : undefined,
        };
      }
      const decision = route.type
        ? { decision: 'task_created' as const, reasonCode: 'explicit_task_route' }
        : this.ingressRoutePolicy?.(event, new Date())
          ?? (event.kind === 'ambient'
            ? { decision: 'digest' as const, reasonCode: 'ambient_digest' }
            : { decision: 'task_created' as const, reasonCode: 'default_action' });
      if (decision.decision !== 'task_created') {
        const timestamp = nowIso();
        this.eventRouter.routeEvent(appended.event.id, {
          decision: decision.decision,
          reasonCode: decision.reasonCode,
        });
        if (decision.decision === 'digest') {
          this.database.prepare(`
            INSERT OR IGNORE INTO digest_items (
              id, event_id, source, kind, priority, payload_json, reason, occurred_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(), appended.event.id, event.source, event.kind, event.priority,
            json(event.payload), decision.reasonCode, event.occurredAt, timestamp,
          );
        }
        return appended;
      }
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      const taskType = route.type ?? 'conversation';
      const authorityEventId = route.authorityEventId ?? appended.event.id;
      const taskInput: TaskInput = {
        id: taskType === 'conversation' ? randomUUID() : event.id,
        type: taskType,
        idempotencyKey: `event:${appended.event.id}:reply`,
        triggerEventId: appended.event.id,
        authorityEventId: this.eventStore.get(authorityEventId) ? authorityEventId : appended.event.id,
        parentTaskId: route.parentTaskId,
        profileId: event.profileId,
        sessionKey: route.sessionKey ?? event.sessionKey,
        objective: event.payload,
        executor: route.executor
          ?? (taskType === 'conversation'
            ? 'session_actor'
            : (payload.executor === 'codex' ? 'codex' : 'isolated_worker')),
        workspaceAccess: route.workspaceAccess
          ?? (payload.workspaceAccess === 'read' ? 'read' : 'write'),
        priority: event.priority,
      };
      const routed = this.eventRouter.routeEvent(appended.event.id, {
        decision: 'task_created',
        reasonCode: decision.reasonCode,
        tasks: [taskInput],
      });
      const taskId = routed.taskIds[0];
      const task = taskId ? this.taskStore.get(taskId) : undefined;
      if (!task) throw new Error(`Event ${appended.event.id} 路由未创建 Task`);
      return { ...appended, task };
    });
  }

  ensureConversationAuthority(event: EventEnvelope): ImmutableEvent {
    return this.appendEvent({
      id: event.id,
      externalId: event.externalId,
      source: event.source,
      type: 'conversation.authority',
      trust: event.trust,
      actor: event.actor,
      conversation: event.conversation,
      payload: event.payload,
      profileId: event.profileId,
      replyRoute: event.replyRoute,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
    }).event;
  }

  listEventSummaries(requestedLimit = 50): MimiEventSummary[] {
    return (this.database.prepare(`
      SELECT id, external_id, source, type, trust, subject_type, subject_id,
        profile_id, occurred_at, received_at, created_at
      FROM events ORDER BY received_at DESC, rowid DESC LIMIT ?
    `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
      id: String(row.id),
      externalId: String(row.external_id).slice(0, 500),
      source: String(row.source).slice(0, 200),
      type: String(row.type),
      trust: String(row.trust) as ImmutableEvent['trust'],
      subjectType: optional(row.subject_type) as ImmutableEvent['subjectType'],
      subjectId: optional(row.subject_id),
      profileId: String(row.profile_id).slice(0, 100),
      occurredAt: String(row.occurred_at),
      receivedAt: String(row.received_at),
      createdAt: String(row.created_at),
    }));
  }

  retryDeadLetterTask(id: string, at = new Date()): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(id);
      if (!task || task.status !== 'dead_letter') throw new Error(`Task ${id} 不是 dead letter`);
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE tasks SET status = 'queued', max_attempts = attempt_count + 1, not_before = ?,
          control_intent = NULL, control_reason = NULL, lease_owner = NULL, lease_until = NULL,
          result_json = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `).run(timestamp, timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`Task ${id} dead letter 状态已变化`);
      const retried = this.taskStore.get(id)!;
      this.appendTaskLifecycleEvent(retried, 'task.retried', timestamp, {
        previousAttempts: task.attemptCount,
        previousError: task.error,
      });
      return retried;
    });
  }

  listPendingDigest(limit = 100): DigestItem[] {
    return (this.database.prepare(`
      SELECT * FROM digest_items WHERE digested_at IS NULL
      ORDER BY priority DESC, occurred_at ASC LIMIT ?
    `).all(limit) as Row[]).map(digestFromRow);
  }

  pendingDigestCount(): number {
    return Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM digest_items WHERE digested_at IS NULL
    `).get() as Row).count);
  }

  rememberOwnerReplyRoute(profileId: string, route: ReplyRoute, at = new Date()): void {
    const channel = route.channel.trim();
    const target = route.target?.trim();
    if (!channel || channel.length > 100 || !target || target.length > 500) {
      throw new Error('owner reply route 必须包含有效的 channel 和 target');
    }
    this.database.prepare(`
      INSERT INTO attention_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(ownerRouteKey(profileId), json({ channel, target }), at.toISOString());
  }

  recentOwnerReplyRoute(profileId: string, maxAgeMs: number, at = new Date()): ReplyRoute | undefined {
    const row = this.database.prepare(`
      SELECT value FROM attention_state WHERE key = ? AND updated_at >= ?
    `).get(ownerRouteKey(profileId), new Date(at.getTime() - maxAgeMs).toISOString()) as Row | undefined;
    try {
      const route = row ? parseJson<ReplyRoute>(row.value) : undefined;
      if (
        !route
        || typeof route.channel !== 'string'
        || !route.channel.startsWith('connector:')
        || route.channel.length > 100
        || typeof route.target !== 'string'
        || !route.target
        || route.target.length > 500
      ) return undefined;
      return { channel: route.channel, target: route.target };
    } catch {
      return undefined;
    }
  }

  enqueueDigestBriefing(
    checkpointKey: string,
    buildEvent: (items: DigestItem[]) => EventEnvelope,
    limit = 100,
    selectItems: (items: DigestItem[]) => DigestItem[] = (items) => items,
  ): ImmutableEvent | undefined {
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT value FROM attention_state WHERE key = ?')
        .get(checkpointKey) as Row | undefined;
      if (existing) return undefined;
      const timestamp = nowIso();
      this.database.prepare(`
        UPDATE digest_items SET briefing_event_id = NULL
        WHERE digested_at IS NULL AND briefing_event_id IN (
          SELECT trigger_event_id FROM tasks
          WHERE type = 'briefing'
            AND status IN ('failed', 'cancelled', 'dead_letter')
            AND trigger_event_id IS NOT NULL
        )
      `).run();
      const rows = this.database.prepare(`
        SELECT * FROM digest_items
        WHERE digested_at IS NULL AND briefing_event_id IS NULL
        ORDER BY priority DESC, occurred_at ASC LIMIT ?
      `).all(limit) as Row[];
      this.database.prepare(`
        INSERT INTO attention_state (key, value, updated_at) VALUES (?, ?, ?)
      `).run(checkpointKey, rows.length ? 'created' : 'empty', timestamp);
      if (!rows.length) return undefined;
      const candidates = rows.map(digestFromRow);
      const candidateIds = new Set(candidates.map((item) => item.id));
      const items = selectItems(candidates);
      if (!items.length || items.some((item) => !candidateIds.has(item.id))) {
        throw new Error('briefing selector 必须返回至少一个候选 digest item');
      }
      const event = buildEvent(items);
      const result = this.ingestEvent(event, {
        type: 'briefing',
        sessionKey: event.sessionKey,
        executor: 'session_actor',
        workspaceAccess: 'write',
      });
      this.database.prepare(`
        UPDATE digest_items SET briefing_event_id = ?
        WHERE id IN (${items.map(() => '?').join(', ')})
      `).run(result.event.id, ...items.map((item) => item.id));
      this.insertAudit('briefing.created', result.event.id, { checkpointKey, items: items.length }, timestamp);
      return result.event;
    });
  }

  countRunsSince(since: Date, source?: string): number {
    const row = source
      ? this.database.prepare(`
          SELECT COUNT(*) AS count FROM runs
          JOIN tasks ON tasks.id = runs.task_id
          JOIN events ON events.id = tasks.authority_event_id
          WHERE runs.started_at >= ? AND events.source = ?
        `).get(since.toISOString(), source)
      : this.database.prepare('SELECT COUNT(*) AS count FROM runs WHERE started_at >= ?')
        .get(since.toISOString());
    return Number((row as Row).count);
  }

  handoffCodexTaskToMimi(
    id: string,
    owner: string,
    result: { threadId?: string; answer?: string; usage?: unknown; error?: string },
    at = new Date(),
  ): TaskRecord {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const task = this.taskStore.get(id);
      if (!task || task.status !== 'running' || task.leaseOwner !== owner || task.controlIntent
        || !task.leaseUntil || task.leaseUntil <= timestamp) {
        throw new Error(`Codex Task ${id} 租约已失效`);
      }
      const current = task.objective && typeof task.objective === 'object' && !Array.isArray(task.objective)
        ? task.objective as Record<string, unknown>
        : {};
      const previousCodex = current.codex && typeof current.codex === 'object' && !Array.isArray(current.codex)
        ? current.codex as Record<string, unknown>
        : {};
      const threadId = result.threadId
        ?? (typeof previousCodex.threadId === 'string' ? previousCodex.threadId : undefined);
      const originalPrompt = typeof current.prompt === 'string' ? current.prompt : '';
      const codexSummary = [
        '## Codex 后台执行结果（必须由 MimiAgent 独立验收）',
        threadId ? `Codex thread：${threadId}` : '',
        result.answer ? `Codex 回答：\n${result.answer.slice(0, 12_000)}` : '',
        result.error ? `Codex 错误/不可用：${result.error.slice(0, 4_000)}` : '',
        '请检查真实工作区、运行验收测试并调用 finish_task。Codex 的自我声明不算完成证据；若它未完成则由 Mimi 继续完成。',
      ].filter(Boolean).join('\n\n');
      const objective = {
        ...current,
        executor: 'mimi',
        prompt: `${originalPrompt}\n\n${codexSummary}`.slice(0, 24_000),
        codex: {
          ...previousCodex,
          threadId,
          answer: result.answer?.slice(0, 12_000),
          usage: result.usage,
          error: result.error?.slice(0, 4_000),
          handedOffAt: at.toISOString(),
        },
      };
      const updated = this.database.prepare(`
        UPDATE tasks SET status = 'queued', executor = 'isolated_worker',
          objective_json = ?, error = ?, not_before = ?, lease_owner = NULL,
          lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_until > ? AND control_intent IS NULL
      `).run(
        json(objective),
        result.error ? `Codex 已回退给 MimiAgent：${result.error}`.slice(0, 4_000) : 'Codex 已完成执行，等待 MimiAgent 验收',
        timestamp,
        timestamp,
        id,
        owner,
        timestamp,
      );
      if (Number(updated.changes) !== 1) throw new Error(`Codex Task ${id} 租约已失效`);
      if (!this.taskStore.finishAttempt(
        undefined,
        id,
        task.attemptCount,
        'completed',
        result,
        result.error,
        timestamp,
      )) throw new Error(`Task ${id} 当前 Attempt 已终止或不存在`);
      this.insertAudit('task.executor_handoff', id, {
        from: 'codex', to: 'mimi', threadId, fallback: Boolean(result.error),
      }, timestamp);
      const handedOff = this.taskStore.get(id)!;
      this.appendTaskLifecycleEvent(handedOff, 'task.executor_handoff', timestamp, {
        from: 'codex', to: 'isolated_worker', threadId, fallback: Boolean(result.error),
      });
      return handedOff;
    });
  }

  checkpointCodexTask(id: string, owner: string, threadId: string, at = new Date()): TaskRecord {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const task = this.taskStore.get(id);
      if (!task || task.status !== 'running' || task.leaseOwner !== owner || task.controlIntent
        || !task.leaseUntil || task.leaseUntil <= timestamp) {
        throw new Error(`Codex Task ${id} 租约已失效`);
      }
      const current = task.objective && typeof task.objective === 'object' && !Array.isArray(task.objective)
        ? task.objective as Record<string, unknown>
        : {};
      const previousCodex = current.codex && typeof current.codex === 'object' && !Array.isArray(current.codex)
        ? current.codex as Record<string, unknown>
        : {};
      const objective = { ...current, codex: { ...previousCodex, threadId, checkpointedAt: at.toISOString() } };
      const updated = this.database.prepare(`
        UPDATE tasks SET objective_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_until > ? AND control_intent IS NULL
      `).run(json(objective), timestamp, id, owner, timestamp);
      if (Number(updated.changes) !== 1) throw new Error(`Codex Task ${id} 租约已失效`);
      this.insertAudit('task.executor_checkpoint', id, { executor: 'codex', threadId }, timestamp);
      return this.taskStore.get(id)!;
    });
  }

  claimOutbox(
    owner: string,
    leaseMs = DEFAULT_OUTBOX_LEASE_MS,
    at = new Date(),
    excludedRoutes: readonly ReplyRoute[] = [],
  ): OutboxMessage | undefined {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const expired = this.database.prepare(`
        SELECT * FROM outbox WHERE status = 'sending' AND lease_until <= ?
        ORDER BY created_at ASC
      `).all(timestamp) as Row[];
      for (const row of expired) {
        let message: OutboxMessage;
        try {
          message = outboxFromRow(row);
        } catch (error) {
          this.quarantineMalformedOutbox(String(row.id), error, timestamp);
          continue;
        }
        const error = new Error('投递租约过期，结果不确定；为避免重复不会自动重放');
        const updated = this.database.prepare(`
          UPDATE outbox SET status = 'dead_letter', error = ?,
            lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'sending' AND lease_until <= ?
        `).run(error.message, timestamp, message.id, timestamp);
        if (Number(updated.changes) !== 1) continue;
        const fallback = message.channel !== 'system';
        const ownerRouteInvalidated = fallback ? this.clearOwnerReplyRouteForDelivery(message) : false;
        if (fallback) {
          this.insertOutbox(message.taskId, { channel: 'system' }, deliveryFailurePayload(message, error), timestamp);
        }
        this.insertAudit('outbox.dead_letter', message.id, {
          attempts: message.attempts,
          fallback,
          ownerRouteInvalidated,
          uncertain: true,
          reason: 'lease_expired',
        }, timestamp);
      }
      const exclusions = excludedRoutes.slice(0, 16);
      const exclusionSql = exclusions.length
        ? ` AND NOT (${exclusions.map(() => '(channel = ? AND COALESCE(target, \'\') = ?)').join(' OR ')})`
        : '';
      for (let scanned = 0; scanned < 100; scanned += 1) {
        const row = this.database.prepare(`
          SELECT * FROM outbox WHERE status = 'pending' AND not_before <= ?${exclusionSql}
          ORDER BY created_at ASC LIMIT 1
        `).get(timestamp, ...exclusions.flatMap((route) => [route.channel, route.target ?? ''])) as Row | undefined;
        if (!row) return undefined;
        try {
          outboxFromRow(row);
        } catch (error) {
          this.quarantineMalformedOutbox(String(row.id), error, timestamp);
          continue;
        }
        const leaseUntil = new Date(at.getTime() + leaseMs).toISOString();
        const claimed = this.database.prepare(`
          UPDATE outbox SET status = 'sending', attempts = attempts + 1,
            lease_owner = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(owner, leaseUntil, timestamp, String(row.id));
        if (Number(claimed.changes) !== 1) continue;
        return this.getOutbox(String(row.id));
      }
      return undefined;
    });
  }

  completeOutbox(id: string, owner: string): void {
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE outbox SET status = 'sent', lease_owner = NULL, lease_until = NULL, error = NULL, updated_at = ?
      WHERE id = ? AND status = 'sending' AND lease_owner = ?
    `).run(timestamp, id, owner);
    if (Number(result.changes) !== 1) throw new Error(`Outbox ${id} 租约已失效`);
  }

  failOutbox(id: string, owner: string, error: unknown, maxAttempts = 8, at = new Date()): void {
    this.transaction(() => {
      const message = this.getOutbox(id);
      if (!message || message.status !== 'sending' || message.leaseOwner !== owner) {
        throw new Error(`Outbox ${id} 租约已失效`);
      }
      const terminal = message.attempts >= maxAttempts;
      const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, message.attempts - 1));
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE outbox SET status = ?, error = ?, not_before = ?,
          lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_owner = ?
      `).run(
        terminal ? 'dead_letter' : 'pending',
        errorSummary(error, 4_000),
        new Date(at.getTime() + (terminal ? 0 : delay)).toISOString(),
        timestamp,
        id,
        owner,
      );
      if (Number(updated.changes) !== 1) throw new Error(`Outbox ${id} 租约已失效`);
      const ownerRouteInvalidated = terminal && message.channel !== 'system'
        ? this.clearOwnerReplyRouteForDelivery(message)
        : false;
      if (terminal && message.channel !== 'system') {
        this.insertOutbox(message.taskId, { channel: 'system' }, deliveryFailurePayload(message, error), timestamp);
      }
      this.insertAudit(terminal ? 'outbox.dead_letter' : 'outbox.retry', id, {
        attempts: message.attempts,
        fallback: terminal && message.channel !== 'system',
        ownerRouteInvalidated,
      }, timestamp);
    });
  }

  listOutbox(limit = 50): OutboxMessage[] {
    return (this.database.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?').all(limit) as Row[])
      .map(outboxFromRow);
  }

  listOutboxSummaries(requestedLimit = 50): MimiOutboxSummary[] {
    return (this.database.prepare(`
      SELECT id, task_id, channel, target, status, attempts, not_before, updated_at, error
      FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      channel: String(row.channel).slice(0, 200),
      target: optional(row.target)?.slice(0, 500),
      status: String(row.status) as OutboxStatus,
      attempts: Number(row.attempts),
      notBefore: String(row.not_before),
      updatedAt: String(row.updated_at),
      error: optional(row.error)?.slice(0, 500),
    }));
  }

  retryDeadLetterOutbox(id: string, at = new Date()): OutboxMessage {
    return this.transaction(() => {
      const message = this.getOutbox(id);
      if (!message || message.status !== 'dead_letter') throw new Error(`Outbox ${id} 不是 dead letter`);
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE outbox SET status = 'pending', attempts = 0, not_before = ?,
          lease_owner = NULL, lease_until = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `).run(timestamp, timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`Outbox ${id} dead letter 状态已变化`);
      this.insertAudit('outbox.requeued', id, {
        previousAttempts: message.attempts,
        previousError: message.error,
      }, timestamp);
      return this.getOutbox(id)!;
    });
  }

  archiveDeadLetterOutbox(id: string, at = new Date()): OutboxMessage {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE outbox SET status = 'archived', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `).run(timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`Outbox ${id} 不是 dead letter`);
      this.insertAudit('outbox.archived', id, {}, timestamp);
      return this.getOutbox(id)!;
    });
  }

  listRuns(limit = 50): HostRunRecord[] {
    return (this.database.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[])
      .map(runFromRow);
  }

  listRunSummaries(requestedLimit = 50): MimiRunSummary[] {
    return (this.database.prepare(`
      SELECT id, task_id, attempt_no, session_key, status, started_at, completed_at,
        answer_json IS NOT NULL AS answer_available, error
      FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?
    `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      attemptNo: Number(row.attempt_no),
      sessionKey: String(row.session_key),
      status: String(row.status) as HostRunRecord['status'],
      startedAt: String(row.started_at),
      completedAt: optional(row.completed_at),
      answerAvailable: Number(row.answer_available) === 1,
      error: optional(row.error)?.slice(0, 500),
    }));
  }

  sessionActivity(sessionKey: string, limit = 20): MimiSessionActivity[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return (this.database.prepare(`
      SELECT t.id AS task_id, t.trigger_event_id AS event_id, e.source, e.type,
        t.status AS task_status, e.occurred_at,
        r.status AS run_status, r.started_at, r.completed_at, r.answer_json, r.error
      FROM runs r
      JOIN tasks t ON t.id = r.task_id
      JOIN events e ON e.id = t.authority_event_id
      WHERE r.session_key = ? AND NOT EXISTS (
        SELECT 1 FROM runs newer
        WHERE newer.task_id = r.task_id AND (
          newer.started_at > r.started_at OR (newer.started_at = r.started_at AND newer.id > r.id)
        )
      )
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT ?
    `).all(sessionKey, boundedLimit) as Row[]).map((row) => {
      const rawAnswer = parseJson(row.answer_json);
      const answer = rawAnswer === undefined
        ? undefined
        : (typeof rawAnswer === 'string' ? rawAnswer : JSON.stringify(rawAnswer)).slice(0, 2_000);
      return {
        taskId: String(row.task_id),
        eventId: optional(row.event_id),
        source: String(row.source),
        type: String(row.type),
        taskStatus: String(row.task_status) as MimiSessionActivity['taskStatus'],
        runStatus: String(row.run_status) as MimiSessionActivity['runStatus'],
        occurredAt: String(row.occurred_at),
        startedAt: String(row.started_at),
        completedAt: optional(row.completed_at),
        answer,
        error: optional(row.error)?.slice(0, 1_000),
      };
    });
  }

  cancelInterruptedSessionTask(sessionKey: string, taskId: string, reason: string, at = new Date()): boolean {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task || task.sessionKey !== sessionKey || task.status !== 'queued') return false;
      const interrupted = this.database.prepare(`
        SELECT 1 FROM runs WHERE task_id = ? AND session_key = ? AND status = 'interrupted' LIMIT 1
      `).get(taskId, sessionKey);
      if (!interrupted) return false;
      this.cancelTask(taskId, reason, at);
      return true;
    });
  }

  addSchedule(input: Omit<ScheduleRecord, 'id' | 'enabled' | 'lastRunAt' | 'createdAt' | 'updatedAt'>): ScheduleRecord {
    const id = randomUUID();
    const timestamp = nowIso();
    const sessionKey = input.sessionKey === undefined ? undefined : assertSessionId(input.sessionKey);
    let authorityEventId = input.authorityEventId;
    if (authorityEventId === undefined) {
      if (input.trust !== 'owner' && input.trust !== 'system') {
        throw new Error('非 owner/system Schedule 必须保留可验证的原始 Conversation authority Event');
      }
      authorityEventId = this.ensureConversationAuthority(this.syntheticScheduleAuthority({
        id, profileId: input.profileId, sessionKey, replyRoute: input.replyRoute,
        trust: input.trust, createdAt: timestamp,
      })).id;
    } else {
      const authority = this.getImmutableEvent(authorityEventId);
      if (!authority || authority.profileId !== input.profileId || authority.trust !== input.trust) {
        throw new Error('Schedule authority Event 缺失、不是 Conversation root，或 provenance 不匹配');
      }
    }
    this.database.prepare(`
      INSERT INTO schedules (
        id, name, schedule_type, schedule_value, prompt, profile_id, session_key,
        authority_event_id, reply_route_json, trust, enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.type,
      input.value,
      input.prompt,
      input.profileId,
      sessionKey ?? null,
      authorityEventId,
      json(input.replyRoute),
      input.trust,
      input.nextRunAt,
      timestamp,
      timestamp,
    );
    return this.getSchedule(id)!;
  }

  listSchedules(): ScheduleRecord[] {
    return (this.database.prepare('SELECT * FROM schedules ORDER BY next_run_at ASC').all() as Row[])
      .map(scheduleFromRow);
  }

  listScheduleSummaries(requestedLimit = 200, requestedOffset = 0): MimiScheduleSummary[] {
    const offset = Number.isSafeInteger(requestedOffset) ? Math.max(0, requestedOffset) : 0;
    return (this.database.prepare(`
      SELECT id, name, schedule_type, schedule_value, profile_id, session_key, trust,
        enabled, next_run_at, last_run_at, substr(prompt, 1, 500) AS prompt_preview,
        length(prompt) AS prompt_length, updated_at
      FROM schedules ORDER BY next_run_at ASC, rowid ASC LIMIT ? OFFSET ?
    `).all(managementLimit(requestedLimit, 200), offset) as Row[]).map((row) => {
      const promptLength = Number(row.prompt_length);
      return {
        id: String(row.id),
        name: String(row.name).slice(0, 200),
        type: String(row.schedule_type) as ScheduleRecord['type'],
        value: String(row.schedule_value).slice(0, 200),
        profileId: String(row.profile_id).slice(0, 100),
        sessionKey: optional(row.session_key),
        trust: String(row.trust) as ScheduleRecord['trust'],
        enabled: Number(row.enabled) === 1,
        nextRunAt: String(row.next_run_at),
        lastRunAt: optional(row.last_run_at),
        promptPreview: String(row.prompt_preview),
        promptLength,
        promptTruncated: promptLength > 500,
        updatedAt: String(row.updated_at),
      };
    });
  }

  scheduleCount(): number {
    return Number((this.database.prepare('SELECT COUNT(*) AS count FROM schedules').get() as Row).count);
  }

  scheduleRevision(): string {
    const hash = createHash('sha256');
    for (const row of this.database.prepare(`
      SELECT id, updated_at, next_run_at, enabled, length(prompt) AS prompt_length
      FROM schedules ORDER BY id ASC
    `).all() as Row[]) {
      hash.update(JSON.stringify([
        String(row.id),
        String(row.updated_at),
        String(row.next_run_at),
        Number(row.enabled),
        Number(row.prompt_length),
      ]));
      hash.update('\n');
    }
    return hash.digest('hex');
  }

  removeSchedule(id: string, at = new Date()): boolean {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const removed = Number(this.database.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes) === 1;
      if (!removed) return false;
      const pendingTaskIds = (this.database.prepare(`
        SELECT tasks.id FROM tasks JOIN events ON events.id = tasks.trigger_event_id
        WHERE tasks.status = 'queued' AND events.source = ?
      `).all(`schedule:${id}`) as Row[]).map((row) => String(row.id));
      const cancelledTasks = Number(this.database.prepare(`
        UPDATE tasks SET status = 'cancelled', error = 'schedule cancelled before execution', updated_at = ?
        WHERE status = 'queued' AND trigger_event_id IN (
          SELECT id FROM events WHERE source = ?
        )
      `).run(timestamp, `schedule:${id}`).changes);
      for (const taskId of pendingTaskIds) {
        const task = this.taskStore.get(taskId);
        if (task?.status === 'cancelled') {
          this.appendTaskLifecycleEvent(task, 'task.cancelled', timestamp, {
            reason: 'schedule cancelled before execution',
          });
        }
      }
      this.insertAudit('schedule.removed', id, { cancelledTasks }, timestamp);
      return true;
    });
  }

  wakeWatches(sessionKey: string, triggeringEventId: string, at = new Date()): number {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE schedules SET next_run_at = ?, updated_at = ?
        WHERE enabled = 1 AND schedule_type = 'watch' AND session_key = ? AND next_run_at > ?
      `).run(timestamp, timestamp, sessionKey, timestamp);
      const count = Number(updated.changes);
      if (count > 0) this.insertAudit('schedule.woken', triggeringEventId, { sessionKey, count }, timestamp);
      return count;
    });
  }

  emitDueSchedules(at = new Date()): ImmutableEvent[] {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const due = this.database.prepare(`
        SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC
      `).all(timestamp) as Row[];
      const events: ImmutableEvent[] = [];
      for (const row of due) {
        const schedule = scheduleFromRow(row);
        if (!this.validScheduleAuthority(schedule)) {
          this.database.prepare(`
            UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?
          `).run(timestamp, schedule.id);
          this.insertAudit('schedule.disabled', schedule.id, {
            reason: 'missing_or_invalid_authority', trust: schedule.trust,
          }, timestamp);
          continue;
        }
        const eventId = randomUUID();
        const event = this.ingestEvent({
          id: eventId,
          externalId: `${schedule.id}:${schedule.nextRunAt}`,
          source: `schedule:${schedule.id}`,
          kind: 'schedule',
          trust: schedule.trust,
          payload: {
            type: 'scheduled_task',
            prompt: schedule.prompt,
            objective: schedule.prompt,
            strategy: 'single',
            workspaceAccess: 'write',
            scheduleId: schedule.id,
            scheduleType: schedule.type,
            name: schedule.name,
          },
          occurredAt: schedule.nextRunAt,
          receivedAt: timestamp,
          priority: 50,
          profileId: schedule.profileId,
          replyRoute: schedule.replyRoute ?? { channel: 'system' },
        }, {
          type: 'scheduled',
          authorityEventId: schedule.authorityEventId,
          sessionKey: `mimi-task-${eventId}`,
          executor: 'isolated_worker',
          workspaceAccess: 'write',
        }).event;
        events.push(event);
        if (schedule.type === 'at') {
          this.database.prepare(`UPDATE schedules SET enabled = 0, last_run_at = ?, updated_at = ? WHERE id = ?`)
            .run(timestamp, timestamp, schedule.id);
        } else {
          const interval = Number(schedule.value);
          if (!Number.isSafeInteger(interval) || interval <= 0) {
            this.database.prepare(`UPDATE schedules SET enabled = 0, last_run_at = ?, updated_at = ? WHERE id = ?`)
              .run(timestamp, timestamp, schedule.id);
          } else {
            let next = Date.parse(schedule.nextRunAt) + interval;
            while (next <= at.getTime()) next += interval;
            this.database.prepare(`
              UPDATE schedules SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?
            `).run(new Date(next).toISOString(), timestamp, timestamp, schedule.id);
          }
        }
      }
      return events;
    });
  }

  counts(): {
    events: { total: number };
    tasks: Record<TaskStatus, number>;
    outbox: Record<OutboxStatus, number>;
    enabledSchedules: number;
  } {
    const taskStatuses: TaskStatus[] = [
      'queued', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled', 'dead_letter',
    ];
    const outboxStatuses: OutboxStatus[] = ['pending', 'sending', 'sent', 'dead_letter', 'archived'];
    const events = {
      total: Number((this.database.prepare('SELECT COUNT(*) AS count FROM events').get() as Row).count),
    };
    const tasks = Object.fromEntries(taskStatuses.map((status) => [status, 0])) as Record<TaskStatus, number>;
    const outbox = Object.fromEntries(outboxStatuses.map((status) => [status, 0])) as Record<OutboxStatus, number>;
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all() as Row[]) {
      tasks[String(row.status) as TaskStatus] = Number(row.count);
    }
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status').all() as Row[]) {
      outbox[String(row.status) as OutboxStatus] = Number(row.count);
    }
    const enabledSchedules = Number((this.database.prepare('SELECT COUNT(*) AS count FROM schedules WHERE enabled = 1').get() as Row).count);
    return { events, tasks, outbox, enabledSchedules };
  }

  activitySnapshot(requestedLimit = 10): MimiActivitySnapshot {
    const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 10;
    const counts = this.counts();
    const pendingDigest = this.pendingDigestCount();
    const recentEvents = (this.database.prepare(`
      SELECT id, source, type, subject_type, subject_id, occurred_at, received_at
      FROM events ORDER BY received_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      source: String(row.source),
      type: String(row.type),
      subjectType: optional(row.subject_type) as ImmutableEvent['subjectType'],
      subjectId: optional(row.subject_id),
      occurredAt: String(row.occurred_at),
      receivedAt: String(row.received_at),
    }));
    const recentTasks = (this.database.prepare(`
      SELECT id, type, status, priority, attempt_count, updated_at, error
      FROM tasks ORDER BY updated_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      type: String(row.type) as TaskRecord['type'],
      status: String(row.status) as TaskRecord['status'],
      priority: Number(row.priority),
      attemptCount: Number(row.attempt_count),
      updatedAt: String(row.updated_at),
      error: optional(row.error)?.slice(0, 500),
    }));
    const recentRuns = (this.database.prepare(`
      SELECT id, task_id, status, started_at, completed_at, error
      FROM runs ORDER BY COALESCE(completed_at, started_at) DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      status: String(row.status) as HostRunRecord['status'],
      startedAt: String(row.started_at),
      completedAt: optional(row.completed_at),
      error: optional(row.error)?.slice(0, 500),
    }));
    const recentDeliveries = (this.database.prepare(`
      SELECT id, task_id, channel, status, attempts, updated_at, error
      FROM outbox ORDER BY updated_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      channel: String(row.channel),
      status: String(row.status) as OutboxStatus,
      attempts: Number(row.attempts),
      updatedAt: String(row.updated_at),
      error: optional(row.error)?.slice(0, 500),
    }));
    const recentTransitions = (this.database.prepare(`
      SELECT sequence, event_type, entity_id, created_at
      FROM audit_events ORDER BY sequence DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      sequence: Number(row.sequence),
      type: String(row.event_type),
      entityId: String(row.entity_id),
      createdAt: String(row.created_at),
    }));
    return {
      generatedAt: nowIso(),
      needsAttention: counts.tasks.blocked > 0 || counts.tasks.dead_letter > 0 || counts.outbox.dead_letter > 0,
      workPending: counts.tasks.queued + counts.tasks.running + counts.tasks.paused + counts.tasks.blocked
        + counts.outbox.pending + counts.outbox.sending + pendingDigest,
      pendingDigest,
      enabledSchedules: counts.enabledSchedules,
      events: counts.events,
      tasks: counts.tasks,
      outbox: counts.outbox,
      recentEvents,
      recentTasks,
      recentRuns,
      recentDeliveries,
      recentTransitions,
    };
  }

  pruneHistory(cutoff: Date): HistoryPruneResult {
    if (!Number.isFinite(cutoff.getTime())) throw new Error('历史保留 cutoff 不是有效时间');
    const timestamp = cutoff.toISOString();
    const result = this.transaction(() => {
      const outbox = Number(this.database.prepare(`
        DELETE FROM outbox WHERE status IN ('sent', 'archived') AND updated_at < ?
      `).run(timestamp).changes);
      const digestItems = Number(this.database.prepare(`
        DELETE FROM digest_items WHERE digested_at IS NOT NULL AND digested_at < ?
      `).run(timestamp).changes);
      const candidateTasks = `
        SELECT tasks.id FROM tasks
        WHERE tasks.status IN ('completed', 'failed', 'cancelled')
          AND tasks.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.task_id = tasks.id)
          AND NOT EXISTS (
            SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id
              AND child.status IN ('queued', 'running', 'paused', 'blocked', 'dead_letter')
          )
      `;
      const runs = Number(this.database.prepare(`
        DELETE FROM runs
        WHERE status != 'running' AND task_id IN (${candidateTasks})
      `).run(timestamp).changes);
      const tasks = Number(this.database.prepare(`
        DELETE FROM tasks WHERE id IN (${candidateTasks})
          AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.task_id = tasks.id)
      `).run(timestamp).changes);
      const candidateEvents = `
        SELECT events.id FROM events WHERE created_at < ?
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.trigger_event_id = events.id OR tasks.authority_event_id = events.id)
          AND NOT EXISTS (SELECT 1 FROM schedules WHERE schedules.authority_event_id = events.id)
          AND NOT EXISTS (
            SELECT 1 FROM digest_items
            WHERE digest_items.event_id = events.id OR digest_items.briefing_event_id = events.id
          )
          AND NOT EXISTS (SELECT 1 FROM events child WHERE child.causation_event_id = events.id)
      `;
      this.database.prepare(`
        DELETE FROM event_route_receipts WHERE event_id IN (${candidateEvents})
      `).run(timestamp);
      const events = Number(this.database.prepare(`
        DELETE FROM events WHERE id IN (${candidateEvents})
      `).run(timestamp).changes);
      const schedules = Number(this.database.prepare(`
        DELETE FROM schedules WHERE enabled = 0 AND updated_at < ?
      `).run(timestamp).changes);
      const attentionState = Number(this.database.prepare(`
        DELETE FROM attention_state WHERE updated_at < ?
      `).run(timestamp).changes);
      const auditEvents = Number(this.database.prepare(`
        DELETE FROM audit_events
        WHERE created_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM tasks
            WHERE tasks.id = audit_events.entity_id
              AND tasks.status IN ('queued', 'running', 'paused', 'blocked', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox
            WHERE outbox.id = audit_events.entity_id
              AND outbox.status IN ('pending', 'sending', 'dead_letter')
          )
      `).run(timestamp).changes);
      return { outbox, digestItems, runs, tasks, events, schedules, attentionState, auditEvents };
    });
    try {
      this.database.exec('PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);');
    } catch {
      // Cleanup is already committed; optimization/checkpoint are best effort.
    }
    return result;
  }

  getOutbox(id: string): OutboxMessage | undefined {
    const row = this.database.prepare('SELECT * FROM outbox WHERE id = ?').get(id) as Row | undefined;
    return row ? outboxFromRow(row) : undefined;
  }

  private clearOwnerReplyRouteForDelivery(message: OutboxMessage): boolean {
    const task = this.taskStore.get(message.taskId);
    const event = task ? this.eventStore.get(task.authorityEventId) : undefined;
    if (!event) return false;
    const key = ownerRouteKey(event.profileId);
    const row = this.database.prepare('SELECT value FROM attention_state WHERE key = ?').get(key) as Row | undefined;
    if (!row) return false;
    try {
      const route = parseJson<ReplyRoute>(row.value);
      if (route?.channel !== message.channel || route.target !== message.target) return false;
    } catch {
      return false;
    }
    return Number(this.database.prepare('DELETE FROM attention_state WHERE key = ?').run(key).changes) === 1;
  }

  getRun(id: string): HostRunRecord | undefined {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Row | undefined;
    return row ? runFromRow(row) : undefined;
  }

  private finishRun(
    id: string,
    status: Extract<HostRunRecord['status'], 'completed' | 'failed' | 'interrupted'>,
    answer: unknown,
    error: unknown,
    timestamp: string,
  ): void {
    this.database.prepare(`
      UPDATE runs SET status = ?, completed_at = ?, answer_json = ?, error = ?
      WHERE id = ? AND status = 'running'
    `).run(
      status,
      timestamp,
      answer === undefined ? null : json(answer),
      error === undefined ? null : (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
      id,
    );
  }

  getSchedule(id: string): ScheduleRecord | undefined {
    const row = this.database.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    return row ? scheduleFromRow(row) : undefined;
  }

  private insertOutbox(subjectId: string, route: ReplyRoute, payload: unknown, timestamp: string): string {
    const id = randomUUID();
    if (!this.taskStore.get(subjectId)) throw new Error(`Outbox Task 不存在：${subjectId}`);
    this.database.prepare(`
      INSERT INTO outbox (
        id, task_id, channel, target, payload_json, status, attempts,
        not_before, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      id,
      subjectId,
      route.channel,
      route.target ?? null,
      json(payload),
      timestamp,
      timestamp,
      timestamp,
    );
    return id;
  }

  private insertAudit(type: string, entityId: string, data: unknown, timestamp: string): void {
    this.database.prepare(`
      INSERT INTO audit_events (id, event_type, entity_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), type, entityId, json(data), timestamp);
  }

  private syntheticScheduleAuthority(input: {
    id: string;
    profileId: string;
    sessionKey?: string;
    replyRoute?: ReplyRoute;
    trust: Extract<ScheduleRecord['trust'], 'owner' | 'system'>;
    createdAt: string;
  }): EventEnvelope {
    return {
      id: randomUUID(),
      externalId: `schedule-authority:${input.id}`,
      source: 'mimi:schedule-authority',
      kind: 'command',
      trust: input.trust,
      ...(input.sessionKey ? { conversation: { id: input.sessionKey } } : {}),
      payload: { type: 'schedule_authority', scheduleId: input.id, origin: 'local' },
      occurredAt: input.createdAt,
      receivedAt: input.createdAt,
      priority: 100,
      profileId: input.profileId,
      sessionKey: input.sessionKey,
      replyRoute: input.replyRoute,
    };
  }

  private validScheduleAuthority(schedule: ScheduleRecord): boolean {
    try {
      const authority = schedule.authorityEventId ? this.getImmutableEvent(schedule.authorityEventId) : undefined;
      return authority !== undefined
        && authority.profileId === schedule.profileId
        && authority.trust === schedule.trust;
    } catch {
      return false;
    }
  }

  private enqueueTaskRecord(input: TaskInput, timestamp: string): TaskRecord {
    const authority = this.eventStore.get(input.authorityEventId);
    if (!authority) throw new Error(`Task authority Event 不存在：${input.authorityEventId}`);
    if (authority.profileId !== input.profileId) {
      throw new Error(`Task ${input.id} 与 authority Event profile 不一致`);
    }
    if (input.triggerEventId) {
      const trigger = this.eventStore.get(input.triggerEventId);
      if (!trigger) throw new Error(`Task trigger Event 不存在：${input.triggerEventId}`);
      if (trigger.profileId !== input.profileId) {
        throw new Error(`Task ${input.id} 与 trigger Event profile 不一致`);
      }
    }
    if (input.parentTaskId === input.id) throw new Error(`Task ${input.id} 不能以自身作为 parent`);
    if (input.parentTaskId) {
      const parent = this.taskStore.get(input.parentTaskId);
      if (!parent) throw new Error(`Parent Task 不存在：${input.parentTaskId}`);
      if (parent.profileId !== input.profileId) {
        throw new Error(`Task ${input.id} 与 Parent Task profile 不一致`);
      }
      if (parent.authorityEventId !== input.authorityEventId) {
        throw new Error(`Task ${input.id} 必须继承 Parent Task authority Event`);
      }
    }
    const result = this.taskStore.enqueue(input, timestamp);
    if (result.inserted) {
      this.appendTaskLifecycleEvent(result.task, 'task.created', timestamp, {
        type: result.task.type,
        executor: result.task.executor,
        workspaceAccess: result.task.workspaceAccess,
      });
    }
    return result.task;
  }

  private appendTaskLifecycleEvent(
    task: TaskRecord,
    type: string,
    timestamp: string,
    payload: unknown,
  ): ImmutableEvent {
    const eventId = randomUUID();
    const event = this.eventStore.append({
      id: eventId,
      externalId: `${task.id}:${type}:${eventId}`,
      source: 'mimi:task',
      type,
      trust: 'system',
      payload,
      subjectType: 'task',
      subjectId: task.id,
      correlationId: task.triggerEventId ?? task.id,
      causationEventId: task.triggerEventId,
      profileId: task.profileId,
      occurredAt: timestamp,
      receivedAt: timestamp,
    }, timestamp).event;
    this.eventRouter.routeEvent(event.id);
    return event;
  }

  private recoverExpiredTasks(timestamp: string): void {
    const rows = this.database.prepare(`
      SELECT id FROM tasks
      WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
      ORDER BY lease_until ASC LIMIT 100
    `).all(timestamp) as Row[];
    for (const row of rows) {
      const task = this.taskStore.get(String(row.id));
      if (!task || task.status !== 'running' || !task.leaseOwner) continue;
      if (task.controlIntent) {
        const cancelled = task.controlIntent === 'cancel';
        const reason = task.controlReason
          ?? (cancelled ? 'owner cancelled Task' : 'owner paused Task');
        const updatedControl = this.database.prepare(`
          UPDATE tasks SET status = ?, error = ?, lease_owner = NULL, lease_until = NULL, control_intent = NULL,
            control_reason = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND lease_owner = ? AND control_intent = ?
        `).run(
          cancelled ? 'cancelled' : 'paused',
          reason,
          timestamp,
          task.id,
          task.leaseOwner,
          task.controlIntent,
        );
        if (Number(updatedControl.changes) !== 1) continue;
        this.database.prepare(`
          UPDATE runs SET status = 'interrupted', completed_at = ?, error = ?
          WHERE task_id = ? AND status = 'running'
        `).run(timestamp, reason, task.id);
        const controlled = this.taskStore.get(task.id)!;
        this.appendTaskLifecycleEvent(
          controlled,
          cancelled ? 'task.cancelled' : 'task.paused',
          timestamp,
          { reason, phase: 'lease_recovery' },
        );
        continue;
      }
      const summary = 'Task lease expired';
      const terminal = task.attemptCount >= task.maxAttempts;
      if (!this.taskStore.recoverExpired(
        task.id,
        task.leaseOwner,
        terminal,
        summary,
        timestamp,
        timestamp,
      )) continue;
      this.database.prepare(`
        UPDATE runs SET status = 'interrupted', completed_at = ?, error = ?
        WHERE task_id = ? AND status = 'running'
      `).run(timestamp, summary, task.id);
      const updated = this.taskStore.get(task.id)!;
      this.appendTaskLifecycleEvent(
        updated,
        terminal ? 'task.dead_letter' : 'task.retry_scheduled',
        timestamp,
        { error: summary, attemptNo: task.attemptCount, notBefore: updated.notBefore },
      );
    }
  }

  private transaction<T>(operation: () => T): T {
    if (this.database.isTransaction) return operation();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private quarantineMalformedOutbox(id: string, error: unknown, timestamp: string): void {
    const summary = `持久 Outbox 解码失败，已隔离：${errorSummary(error, 1_000)}`;
    this.database.prepare(`
      UPDATE outbox SET status = 'dead_letter', error = ?, lease_owner = NULL,
        lease_until = NULL, updated_at = ? WHERE id = ?
    `).run(summary, timestamp, id);
    this.insertAudit('outbox.quarantined', id, { error: summary }, timestamp);
  }

  private migrate(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > 12) throw new Error(`不支持的 MimiAgent 数据库版本：${version}`);
    if (version === 12) {
      if (this.hasFinalV12Schema()) return;
      if (!this.hasLegacyEventSchema()) {
        throw new Error('MimiAgent 数据库标记为 v12，但表结构既不是最终 v12 也不是可恢复的旧 Event schema');
      }
      this.assertEmptyPartialV12Tables();
      this.cutoverEventTaskV12(true);
      return;
    }
    if (version === 0) {
      this.createFreshV12Schema();
      return;
    }
    if (version <= 2) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS digest_items (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
          source TEXT NOT NULL,
          kind TEXT NOT NULL,
          priority INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          reason TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          digested_at TEXT,
          briefing_event_id TEXT REFERENCES events(id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS digest_pending_idx
          ON digest_items(digested_at, briefing_event_id, priority, occurred_at);
        CREATE TABLE IF NOT EXISTS attention_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    }
    this.addEventTaskColumns();
    this.addEventTaskControlColumns();
    this.addEventCompletionColumns();
    this.addEventAttemptColumns();
    this.addScheduleAuthorityColumns();
    this.createRetentionIndexes();
    this.createEventTaskIndexes();
    this.cutoverEventTaskV12();
  }

  private tableColumns(table: string): Set<string> {
    return new Set((this.database.prepare(`PRAGMA table_info(${table})`).all() as Row[])
      .map((row) => String(row.name)));
  }

  private hasFinalV12Schema(): boolean {
    const events = this.tableColumns('events');
    const tasks = this.tableColumns('tasks');
    const runs = this.tableColumns('runs');
    const outbox = this.tableColumns('outbox');
    return events.has('type') && !events.has('status')
      && tasks.has('authority_event_id') && tasks.has('attempt_count')
      && runs.has('task_id') && runs.has('attempt_no')
      && outbox.has('task_id') && !outbox.has('event_id');
  }

  private hasLegacyEventSchema(): boolean {
    const events = this.tableColumns('events');
    const runs = this.tableColumns('runs');
    const outbox = this.tableColumns('outbox');
    return events.has('kind') && events.has('status') && events.has('execution_lane')
      && !events.has('type') && runs.has('event_id') && outbox.has('event_id');
  }

  private assertEmptyPartialV12Tables(): void {
    for (const table of ['events_v2', 'tasks', 'task_attempts', 'event_route_receipts']) {
      const exists = this.database.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table);
      if (!exists) continue;
      const count = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count);
      if (count > 0) {
        throw new Error(`MimiAgent v12 半迁移表 ${table} 含 ${count} 行，拒绝自动覆盖；请先人工核对数据`);
      }
    }
  }

  private createFreshV12Schema(): void {
    this.database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE events (
        id TEXT PRIMARY KEY, external_id TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL,
        trust TEXT NOT NULL, actor_json TEXT NOT NULL, conversation_json TEXT NOT NULL,
        payload_json TEXT NOT NULL, subject_type TEXT, subject_id TEXT, correlation_id TEXT,
        causation_event_id TEXT REFERENCES events(id), profile_id TEXT NOT NULL,
        reply_route_json TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(source, external_id)
      ) STRICT;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        trigger_event_id TEXT REFERENCES events(id), authority_event_id TEXT NOT NULL REFERENCES events(id),
        parent_task_id TEXT REFERENCES tasks(id), profile_id TEXT NOT NULL, session_key TEXT,
        objective_json TEXT NOT NULL, executor TEXT NOT NULL, workspace_access TEXT NOT NULL,
        priority INTEGER NOT NULL, status TEXT NOT NULL, not_before TEXT NOT NULL,
        attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL, lease_owner TEXT,
        lease_until TEXT, control_intent TEXT, control_reason TEXT, result_json TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE event_route_receipts (
        event_id TEXT PRIMARY KEY REFERENCES events(id), router_version TEXT NOT NULL,
        decision TEXT NOT NULL, task_ids_json TEXT NOT NULL, reason_code TEXT NOT NULL,
        routed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_no INTEGER NOT NULL,
        session_key TEXT NOT NULL, worker_id TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT, answer_json TEXT, error TEXT,
        UNIQUE(task_id, attempt_no)
      ) STRICT;
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), channel TEXT NOT NULL,
        target TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
        not_before TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE leases (
        resource TEXT PRIMARY KEY, owner TEXT NOT NULL, fencing_token INTEGER NOT NULL,
        lease_until TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL, entity_id TEXT NOT NULL, data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL, prompt TEXT NOT NULL, profile_id TEXT NOT NULL,
        session_key TEXT, authority_event_id TEXT REFERENCES events(id), reply_route_json TEXT NOT NULL,
        trust TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at TEXT NOT NULL,
        last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE digest_items (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
        source TEXT NOT NULL, kind TEXT NOT NULL, priority INTEGER NOT NULL,
        payload_json TEXT NOT NULL, reason TEXT NOT NULL, occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL, digested_at TEXT, briefing_event_id TEXT REFERENCES events(id)
      ) STRICT;
      CREATE TABLE attention_state (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX events_timeline_idx ON events(received_at DESC, id);
      CREATE INDEX events_subject_idx ON events(subject_type, subject_id, received_at DESC);
      CREATE INDEX events_correlation_idx ON events(correlation_id, received_at ASC);
      CREATE INDEX events_causation_idx ON events(causation_event_id);
      CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events
      BEGIN SELECT RAISE(ABORT, 'immutable event cannot be updated'); END;
      CREATE INDEX tasks_ready_idx ON tasks(status, not_before, priority DESC, created_at ASC);
      CREATE INDEX tasks_ready_priority_idx ON tasks(priority DESC, created_at ASC, not_before)
        WHERE status = 'queued';
      CREATE INDEX tasks_recovery_idx ON tasks(status, lease_until);
      CREATE INDEX tasks_session_idx ON tasks(session_key, status, updated_at DESC);
      CREATE INDEX tasks_trigger_idx ON tasks(trigger_event_id);
      CREATE INDEX tasks_authority_idx ON tasks(authority_event_id);
      CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
      CREATE INDEX tasks_retention_idx ON tasks(status, updated_at);
      CREATE INDEX runs_task_status_idx ON runs(task_id, status);
      CREATE INDEX outbox_ready_idx ON outbox(status, not_before, created_at);
      CREATE INDEX outbox_task_idx ON outbox(task_id);
      CREATE INDEX outbox_retention_idx ON outbox(status, updated_at);
      CREATE INDEX audit_retention_idx ON audit_events(created_at);
      CREATE INDEX schedules_due_idx ON schedules(enabled, next_run_at);
      CREATE INDEX schedules_retention_idx ON schedules(enabled, updated_at);
      CREATE INDEX digest_pending_idx ON digest_items(digested_at, briefing_event_id, priority, occurred_at);
      CREATE INDEX digest_retention_idx ON digest_items(digested_at);
      CREATE INDEX attention_retention_idx ON attention_state(updated_at);
      PRAGMA user_version = 12;
      COMMIT;
    `);
  }

  private cutoverEventTaskV12(removePartialV12 = false): void {
    const legacyCounts = {
      events: Number((this.database.prepare('SELECT COUNT(*) AS count FROM events').get() as Row).count),
      runs: Number((this.database.prepare('SELECT COUNT(*) AS count FROM runs').get() as Row).count),
      outbox: Number((this.database.prepare('SELECT COUNT(*) AS count FROM outbox').get() as Row).count),
    };
    this.database.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
      if (removePartialV12) {
        this.database.exec(`
          DROP TABLE IF EXISTS task_attempts;
          DROP TABLE IF EXISTS event_route_receipts;
          DROP TABLE IF EXISTS tasks;
          DROP TABLE IF EXISTS events_v2;
        `);
      }
      this.database.exec(`
        CREATE TABLE events_v12 (
          id TEXT PRIMARY KEY,
          external_id TEXT NOT NULL,
          source TEXT NOT NULL,
          type TEXT NOT NULL,
          trust TEXT NOT NULL,
          actor_json TEXT NOT NULL,
          conversation_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          subject_type TEXT,
          subject_id TEXT,
          correlation_id TEXT,
          causation_event_id TEXT REFERENCES events_v12(id),
          profile_id TEXT NOT NULL,
          reply_route_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(source, external_id)
        ) STRICT;
        CREATE TABLE tasks_v12 (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          trigger_event_id TEXT REFERENCES events_v12(id),
          authority_event_id TEXT NOT NULL REFERENCES events_v12(id),
          parent_task_id TEXT REFERENCES tasks_v12(id),
          profile_id TEXT NOT NULL,
          session_key TEXT,
          objective_json TEXT NOT NULL,
          executor TEXT NOT NULL,
          workspace_access TEXT NOT NULL,
          priority INTEGER NOT NULL,
          status TEXT NOT NULL,
          not_before TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          max_attempts INTEGER NOT NULL,
          lease_owner TEXT,
          lease_until TEXT,
          control_intent TEXT,
          control_reason TEXT,
          result_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE event_route_receipts_v12 (
          event_id TEXT PRIMARY KEY REFERENCES events_v12(id),
          router_version TEXT NOT NULL,
          decision TEXT NOT NULL,
          task_ids_json TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          routed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE runs_v12 (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks_v12(id),
          attempt_no INTEGER NOT NULL,
          session_key TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          answer_json TEXT,
          error TEXT,
          UNIQUE(task_id, attempt_no)
        ) STRICT;
        CREATE TABLE outbox_v12 (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks_v12(id),
          channel TEXT NOT NULL,
          target TEXT,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          not_before TEXT NOT NULL,
          lease_owner TEXT,
          lease_until TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        INSERT INTO events_v12 (
          id, external_id, source, type, trust, actor_json, conversation_json, payload_json,
          correlation_id, causation_event_id, profile_id, reply_route_json,
          occurred_at, received_at, created_at
        )
        SELECT id, external_id, source,
          CASE WHEN execution_lane = 'task' THEN 'task.migrated'
            WHEN kind = 'schedule' THEN 'schedule.due' ELSE kind || '.received' END,
          trust, actor_json, conversation_json, payload_json,
          COALESCE(root_event_id, parent_event_id, id), parent_event_id, profile_id,
          reply_route_json, occurred_at, received_at, created_at
        FROM events;

        INSERT INTO tasks_v12 (
          id, type, idempotency_key, trigger_event_id, authority_event_id, parent_task_id,
          profile_id, session_key, objective_json, executor, workspace_access, priority,
          status, not_before, attempt_count, max_attempts, lease_owner, lease_until,
          control_intent, control_reason, result_json, error, created_at, updated_at
        )
        SELECT e.id,
          CASE WHEN e.execution_lane = 'task' AND e.kind = 'schedule' THEN 'scheduled'
            WHEN e.execution_lane = 'task' THEN 'background' ELSE 'conversation' END,
          'migration:event:' || e.id,
          e.id,
          COALESCE(e.root_event_id, e.parent_event_id, e.id),
          e.parent_event_id,
          e.profile_id, e.session_key, e.payload_json,
          CASE WHEN e.execution_lane = 'task' AND json_extract(e.payload_json, '$.executor') = 'codex'
            THEN 'codex' WHEN e.execution_lane = 'task' THEN 'isolated_worker' ELSE 'session_actor' END,
          CASE WHEN json_extract(e.payload_json, '$.workspaceAccess') = 'read' THEN 'read' ELSE 'write' END,
          e.priority,
          CASE e.status WHEN 'archived' THEN 'cancelled' WHEN 'ignored' THEN 'completed'
            WHEN 'digested' THEN 'completed' ELSE e.status END,
          e.not_before, e.attempts, COALESCE(e.max_attempts, 5), e.lease_owner, e.lease_until,
          e.task_control, e.task_control_reason, e.result_json, e.error, e.created_at, e.updated_at
        FROM events e LEFT JOIN events parent ON parent.id = e.parent_event_id;

        INSERT INTO events_v12 (
          id, external_id, source, type, trust, actor_json, conversation_json, payload_json,
          subject_type, subject_id, correlation_id, causation_event_id, profile_id,
          reply_route_json, occurred_at, received_at, created_at
        )
        SELECT 'migration-task-' || id, 'task:' || id || ':migration-v12', 'mimi:migration',
          'task.' || CASE status WHEN 'queued' THEN 'created' WHEN 'running' THEN 'started'
            WHEN 'dead_letter' THEN 'dead_letter' WHEN 'cancelled' THEN 'cancelled'
            ELSE status END,
          'system', 'null', 'null', json_object('provenance', 'migration-v12'),
          'task', id, COALESCE(root_event_id, parent_event_id, id), id, profile_id,
          'null', updated_at, updated_at, updated_at
        FROM events;

        INSERT INTO event_route_receipts_v12 (
          event_id, router_version, decision, task_ids_json, reason_code, routed_at
        )
        SELECT id, 'migration-v12',
          'task_created', json_array(id),
          'legacy_event_conversion', updated_at
        FROM events;

        INSERT INTO event_route_receipts_v12 (
          event_id, router_version, decision, task_ids_json, reason_code, routed_at
        )
        SELECT 'migration-task-' || id, 'migration-v12', 'observe_only', '[]',
          'task_lifecycle', updated_at
        FROM events;

        INSERT INTO runs_v12 (
          id, task_id, attempt_no, session_key, worker_id, status,
          started_at, completed_at, answer_json, error
        )
        SELECT r.id, r.event_id,
          ROW_NUMBER() OVER (PARTITION BY r.event_id ORDER BY r.started_at, r.id),
          r.session_key, COALESCE(e.lease_owner, 'migration'), r.status,
          r.started_at, r.completed_at, r.answer_json, r.error
        FROM runs r JOIN events e ON e.id = r.event_id;

        INSERT INTO outbox_v12 (
          id, task_id, channel, target, payload_json, status, attempts,
          not_before, lease_owner, lease_until, error, created_at, updated_at
        )
        SELECT id, event_id, channel, target, payload_json, status, attempts,
          not_before, lease_owner, lease_until, error, created_at, updated_at
        FROM outbox;

        DROP TABLE runs;
        DROP TABLE outbox;
        DROP TABLE events;
        ALTER TABLE events_v12 RENAME TO events;
        ALTER TABLE tasks_v12 RENAME TO tasks;
        ALTER TABLE event_route_receipts_v12 RENAME TO event_route_receipts;
        ALTER TABLE runs_v12 RENAME TO runs;
        ALTER TABLE outbox_v12 RENAME TO outbox;

        CREATE INDEX events_timeline_idx ON events(received_at DESC, id);
        CREATE INDEX events_subject_idx ON events(subject_type, subject_id, received_at DESC);
        CREATE INDEX events_correlation_idx ON events(correlation_id, received_at ASC);
        CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'immutable event cannot be updated'); END;
        CREATE INDEX tasks_ready_idx ON tasks(status, not_before, priority DESC, created_at ASC);
        CREATE INDEX tasks_ready_priority_idx ON tasks(priority DESC, created_at ASC, not_before) WHERE status = 'queued';
        CREATE INDEX tasks_recovery_idx ON tasks(status, lease_until);
        CREATE INDEX tasks_session_idx ON tasks(session_key, status, updated_at DESC);
        CREATE INDEX tasks_trigger_idx ON tasks(trigger_event_id);
        CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
        CREATE UNIQUE INDEX runs_task_attempt_idx ON runs(task_id, attempt_no);
        CREATE INDEX runs_task_status_idx ON runs(task_id, status);
        CREATE INDEX outbox_ready_idx ON outbox(status, not_before, created_at);
        CREATE INDEX outbox_retention_idx ON outbox(status, updated_at);
      `);
      this.backfillScheduleAuthorities();
      const convertedCounts = {
        tasks: Number((this.database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as Row).count),
        routes: Number((this.database.prepare('SELECT COUNT(*) AS count FROM event_route_receipts').get() as Row).count),
        runs: Number((this.database.prepare('SELECT COUNT(*) AS count FROM runs').get() as Row).count),
        outbox: Number((this.database.prepare('SELECT COUNT(*) AS count FROM outbox').get() as Row).count),
      };
      if (convertedCounts.tasks !== legacyCounts.events
        || convertedCounts.routes !== legacyCounts.events * 2
        || convertedCounts.runs !== legacyCounts.runs
        || convertedCounts.outbox !== legacyCounts.outbox) {
        throw new Error(`Event/Task v12 转换计数校验失败：${JSON.stringify({ legacyCounts, convertedCounts })}`);
      }
      const foreignKeyFailures = this.database.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyFailures.length > 0) {
        throw new Error(`Event/Task v12 转换引用校验失败：${JSON.stringify(foreignKeyFailures.slice(0, 20))}`);
      }
      this.database.exec('PRAGMA user_version = 12; COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    } finally {
      this.database.exec('PRAGMA foreign_keys=ON;');
    }
  }

  private addEventAttemptColumns(): void {
    const available = new Set((this.database.prepare('PRAGMA table_info(events)').all() as Row[])
      .map((row) => String(row.name)));
    if (!available.has('max_attempts')) {
      this.database.exec('ALTER TABLE events ADD COLUMN max_attempts INTEGER;');
    }
  }

  private addEventTaskColumns(): void {
    const available = new Set((this.database.prepare('PRAGMA table_info(events)').all() as Row[])
      .map((row) => String(row.name)));
    const definitions = [
      ['execution_lane', "TEXT NOT NULL DEFAULT 'conversation'"],
      ['origin_session_key', 'TEXT'],
      ['parent_event_id', 'TEXT'],
      ['root_event_id', 'TEXT'],
      ['task_depth', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const;
    for (const [column, definition] of definitions) {
      if (!available.has(column)) this.database.exec(`ALTER TABLE events ADD COLUMN ${column} ${definition};`);
    }
  }

  private addEventTaskControlColumns(): void {
    const available = new Set((this.database.prepare('PRAGMA table_info(events)').all() as Row[])
      .map((row) => String(row.name)));
    const definitions = [
      ['task_control', 'TEXT'],
      ['task_control_reason', 'TEXT'],
    ] as const;
    for (const [column, definition] of definitions) {
      if (!available.has(column)) this.database.exec(`ALTER TABLE events ADD COLUMN ${column} ${definition};`);
    }
  }

  private addEventCompletionColumns(): void {
    const available = new Set((this.database.prepare('PRAGMA table_info(events)').all() as Row[])
      .map((row) => String(row.name)));
    const definitions = [
      ['completion_deferrals', 'INTEGER NOT NULL DEFAULT 0'],
      ['completion_no_progress_deferrals', 'INTEGER NOT NULL DEFAULT 0'],
      ['completion_progress_fingerprint', 'TEXT'],
    ] as const;
    for (const [column, definition] of definitions) {
      if (!available.has(column)) this.database.exec(`ALTER TABLE events ADD COLUMN ${column} ${definition};`);
    }
  }

  private addScheduleAuthorityColumns(): void {
    const available = new Set((this.database.prepare('PRAGMA table_info(schedules)').all() as Row[])
      .map((row) => String(row.name)));
    if (available.size > 0 && !available.has('authority_event_id')) {
      this.database.exec('ALTER TABLE schedules ADD COLUMN authority_event_id TEXT;');
    }
  }

  private backfillScheduleAuthorities(): void {
    const scheduleColumns = new Set((this.database.prepare('PRAGMA table_info(schedules)').all() as Row[])
      .map((row) => String(row.name)));
    if (!scheduleColumns.has('authority_event_id')) return;
    const timestamp = nowIso();
    for (const row of this.database.prepare('SELECT * FROM schedules WHERE enabled = 1').all() as Row[]) {
      let schedule: ScheduleRecord;
      try {
        schedule = scheduleFromRow(row);
      } catch {
        this.database.prepare('UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(timestamp, String(row.id));
        continue;
      }
      if (this.validScheduleAuthority(schedule)) continue;
      if (schedule.trust !== 'owner' && schedule.trust !== 'system') {
        this.database.prepare('UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(timestamp, schedule.id);
        continue;
      }
      try {
        const sessionKey = schedule.sessionKey === undefined ? undefined : assertSessionId(schedule.sessionKey);
        const createdAt = Number.isFinite(Date.parse(schedule.createdAt)) ? schedule.createdAt : timestamp;
        const authority = this.ensureConversationAuthority(this.syntheticScheduleAuthority({
          id: schedule.id,
          profileId: schedule.profileId,
          sessionKey,
          replyRoute: schedule.replyRoute,
          trust: schedule.trust,
          createdAt,
        }));
        this.database.prepare(`
          UPDATE schedules SET authority_event_id = ?, updated_at = ? WHERE id = ?
        `).run(authority.id, timestamp, schedule.id);
      } catch {
        this.database.prepare('UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(timestamp, schedule.id);
      }
    }
  }

  private createEventTaskIndexes(): void {
    const available = new Set((this.database.prepare('PRAGMA table_info(events)').all() as Row[])
      .map((row) => String(row.name)));
    if (['execution_lane', 'status', 'not_before', 'priority', 'received_at']
      .every((column) => available.has(column))) {
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS events_lane_ready_idx
        ON events(execution_lane, status, not_before, priority, received_at);
      `);
    }
  }

  private createRetentionIndexes(): void {
    const definitions = [
      ['events', 'events_retention_idx', 'status, updated_at'],
      ['runs', 'runs_event_status_idx', 'event_id, status'],
      ['outbox', 'outbox_retention_idx', 'status, updated_at'],
      ['audit_events', 'audit_retention_idx', 'created_at'],
      ['schedules', 'schedules_retention_idx', 'enabled, updated_at'],
      ['digest_items', 'digest_retention_idx', 'digested_at'],
      ['attention_state', 'attention_retention_idx', 'updated_at'],
    ] as const;
    for (const [table, index, columns] of definitions) {
      const available = new Set((this.database.prepare(`PRAGMA table_info(${table})`).all() as Row[])
        .map((row) => String(row.name)));
      if (columns.split(', ').every((column) => available.has(column))) {
        this.database.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(${columns});`);
      }
    }
  }
}
