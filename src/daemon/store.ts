import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  sanitizeSensitiveData,
  sanitizeSensitiveText,
} from '../core/data-sanitizer.js';
import { assertSessionId } from '../core/session-id.js';
import { runFailureRecord, type RunFailureRecord } from '../core/run-failure.js';
import type { RunFinalizationRecord } from '../core/run-finalization.js';
import { EventStore, listEventSummaries } from './event-store.js';
import { EventRouter } from './event-router.js';
import { taskCompletionRoute } from './task-continuation.js';
import { sanitizedMemoryEvidenceSnapshot } from './memory-evidence.js';
import { createFreshV16Schema } from './persistence/schema/current.js';
import { upgradeScheduleContextV17 } from './persistence/schema/migrations/v17-schedule-context.js';
import {
  ensureMemoryLintSchemaV13,
  hasMemoryObservationSourceKey,
  upgradeMemoryObservationsV13,
} from './persistence/schema/migrations/v13-memory-observations.js';
import { repairDigestedTaskRoutesV14 } from './persistence/schema/migrations/v14-task-route-repair.js';
import {
  hasMemoryEvidenceSnapshot,
  upgradeMemoryEvidenceSnapshotV15,
} from './persistence/schema/migrations/v15-memory-evidence-snapshot.js';
import {
  hasTaskExecutorOwnershipV16,
  pendingTaskExecutorOwnershipV16Repairs,
  repairExistingTaskExecutorOwnershipV16,
  upgradeTaskExecutorOwnershipV16,
} from './persistence/schema/migrations/v16-task-executor-ownership.js';
import { prepareLegacyEventSchemaForV12 } from './persistence/schema/migrations/v3-v11-legacy-event-preparation.js';
import {
  assertEmptyPartialEventTaskV12Tables,
  cutoverEventTaskV12,
  hasFinalEventTaskV12Schema,
  hasLegacyEventTaskSchema,
} from './persistence/schema/migrations/v12-event-task-cutover.js';
import { TaskStore, type TaskListSelector } from './task-store.js';
import { ActivityStore } from './activity-store.js';
import { OutboxStore } from './outbox-store.js';
import {
  ScheduleStore,
  scheduleFromRow,
  syntheticScheduleAuthority,
  validScheduleAuthority,
} from './schedule-store.js';
import { MemoryObservationStore } from './memory-observation-store.js';
import { RunStore } from './run-store.js';
import {
  errorSummary,
  hashedStateKey,
  managementLimit,
  optionalText as optional,
  parseOptionalJson as parseJson,
  type SqliteRow as Row,
} from './sqlite-domain.js';
import { validTaskRoute } from './task-routing.js';
import type {
  EventEnvelope,
  EventRouteReceipt,
  DigestItem,
  IngressTaskRoute,
  ImmutableEvent,
  ImmutableEventInput,
  MimiEventSummary,
  ReplyRoute,
  ScheduleRecord,
  TaskAttemptRecord,
  TaskControlIntent,
  TaskInput,
  TaskRecord,
  TaskRouteInput,
  TaskSelector,
} from './types.js';

const MAX_TASK_RESUME_CONTEXT_LENGTH = 4_000;
const MAX_TASK_PROMPT_LENGTH = 64_000;

type IngressRouteDecision = Pick<EventRouteReceipt, 'decision' | 'reasonCode'>;

export interface ConnectorHealthStateInput {
  connectorId: string;
  connectorSource: string;
  status: 'ready' | 'unavailable' | 'stale' | 'unknown';
  reasonCode?: string;
  detail?: string;
  automaticRestart: boolean;
  profileId: string;
  sessionKey: string;
  eventsEnabled: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function sanitizedJson(value: unknown): string {
  return JSON.stringify(sanitizeSensitiveData(value ?? null));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function profileBoundSessionKey(profileId: string, sessionKey: string | undefined): string | undefined {
  if (!sessionKey || profileId === 'owner') return sessionKey;
  return `mimi-profile-${createHash('sha256').update(profileId).digest('hex').slice(0, 12)}-${
    createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)
  }`;
}

function resumedTaskPayload(payload: unknown, additionalContext?: string): unknown {
  if (additionalContext === undefined) return payload;
  const context = additionalContext.trim();
  if (!context) return payload;
  if (context.length > MAX_TASK_RESUME_CONTEXT_LENGTH) {
    throw new Error(`后台任务恢复上下文不能超过 ${MAX_TASK_RESUME_CONTEXT_LENGTH} 个字符`);
  }
  const values = { ...record(payload) };
  const prompt = typeof values.prompt === 'string' ? values.prompt.trimEnd() : '';
  const resumedPrompt = [prompt, `## 恢复补充上下文\n${context}`].filter(Boolean).join('\n\n');
  if (resumedPrompt.length > MAX_TASK_PROMPT_LENGTH) {
    throw new Error(`后台任务累计提示词不能超过 ${MAX_TASK_PROMPT_LENGTH} 个字符`);
  }
  values.prompt = resumedPrompt;
  return values;
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

export class MimiStore extends ActivityStore {
  readonly file: string;
  private readonly eventStore: EventStore;
  private readonly eventRouter: EventRouter;
  private readonly taskStore: TaskStore;
  readonly outbox: OutboxStore;
  readonly schedules: ScheduleStore;
  readonly memoryObservations: MemoryObservationStore;
  readonly runs: RunStore;
  private ingressRoutePolicy?: (event: EventEnvelope, at: Date) => IngressRouteDecision;

  constructor(file: string) {
    const resolved = path.resolve(file);
    mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(resolved), 0o700);
    const database = new DatabaseSync(resolved, { timeout: 5_000 });
    super(database);
    this.file = resolved;
    const version = Number((database.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > 17) {
      database.close();
      throw new Error(`不支持的 MimiAgent 数据库版本：${version}`);
    }
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.eventStore = new EventStore(this.database);
    this.taskStore = new TaskStore(this.database);
    this.outbox = new OutboxStore(this.database, this.eventStore, this.taskStore);
    this.memoryObservations = new MemoryObservationStore(
      this.database,
      this.eventStore,
      this.taskStore,
      (input, timestamp) => this.enqueueTaskRecord(input, timestamp),
    );
    this.runs = new RunStore(this.database, this.taskStore);
    this.backupBeforeMigrations();
    this.migrate();
    this.eventRouter = new EventRouter(this, 'ingress-v1');
    this.schedules = new ScheduleStore(this.database, this.eventStore, this.taskStore, {
      ensureConversationAuthority: (event) => this.ensureConversationAuthority(event),
      ingestEvent: (event, schedule) => this.ingestEvent(event, {
        type: 'scheduled',
        authorityEventId: schedule.authorityEventId,
        sessionKey: `mimi-task-${event.id}`,
        executor: 'isolated_worker',
        workspaceAccess: 'write',
      }),
      appendTaskLifecycleEvent: (task, type, timestamp, payload) => {
        this.appendTaskLifecycleEvent(task, type, timestamp, payload);
      },
    });
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

  latestCompletedPersonalMessageEventForSession(
    sessionKey: string,
    before: Date,
    maxAgeMs = 10 * 60_000,
  ): ImmutableEvent | undefined {
    const row = this.database.prepare(`
      SELECT events.id
      FROM tasks
      JOIN events ON events.id = tasks.authority_event_id
      WHERE tasks.session_key = ?
        AND tasks.status = 'completed'
        AND events.source LIKE 'personal-message:%'
        AND events.received_at <= ?
      ORDER BY tasks.updated_at DESC, events.received_at DESC, events.id DESC
      LIMIT 1
    `).get(sessionKey, before.toISOString()) as Row | undefined;
    const id = row?.id;
    if (typeof id !== 'string') return undefined;
    const event = this.eventStore.get(id);
    if (!event) return undefined;
    const receivedAt = Date.parse(event.receivedAt);
    if (!Number.isFinite(receivedAt) || before.getTime() - receivedAt > maxAgeMs) return undefined;
    return event;
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

  listTasks(limit = 50, selector: TaskListSelector = {}): TaskRecord[] {
    return this.taskStore.list(managementLimit(limit), selector);
  }

  runningTasks(selector: TaskSelector = {}, limit = 50): TaskRecord[] {
    return this.taskStore.listRunning(selector, managementLimit(limit));
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
        const claimed = this.claimReadyTask(candidate.id, owner, leaseMs, at, timestamp);
        if (claimed) return claimed;
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
      return this.claimReadyTask(taskId, owner, leaseMs, at, timestamp);
    });
  }

  readyTasks(selector: TaskSelector = {}, limit = 50, at = new Date()): TaskRecord[] {
    const timestamp = at.toISOString();
    // Preemption and worker polls are reads while no lease needs recovery.
    // Avoid taking the cross-process writer lock every 250ms when idle.
    const expired = this.database.prepare(`
      SELECT 1 FROM tasks WHERE status = 'running' AND lease_until <= ? LIMIT 1
    `).get(timestamp);
    if (!expired) return this.taskStore.listReady(selector, timestamp, managementLimit(limit));
    return this.transaction(() => {
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
      const task = this.leasedTask(taskId, owner, at.toISOString());
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
      return this.settleRunningTaskControl(task, at.toISOString(), 'safe_boundary', attemptId);
    });
  }

  pauseTask(taskId: string, reason = 'owner paused Task', at = new Date()): TaskRecord {
    return this.controlTask(taskId, 'pause', reason, at);
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
      `).run(sanitizedJson(objective), timestamp, timestamp, taskId);
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
    return this.controlTask(taskId, 'cancel', reason, at);
  }

  private controlTask(
    taskId: string,
    intent: TaskControlIntent,
    reason: string,
    at: Date,
  ): TaskRecord {
    return this.transaction(() => {
      const task = this.taskStore.get(taskId);
      if (!task) throw new Error(`Task 不存在：${taskId}`);
      const timestamp = at.toISOString();
      const summary = errorSummary(reason, 4_000);
      if (task.status === 'running') {
        if (task.controlIntent === 'cancel' || task.controlIntent === intent) return task;
        const updated = this.database.prepare(`
          UPDATE tasks SET control_intent = ?, control_reason = ?, updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(intent, summary, timestamp, taskId);
        if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 状态已变化`);
        const requested = this.taskStore.get(taskId)!;
        this.appendTaskLifecycleEvent(requested, `task.${intent}_requested`, timestamp, { reason: summary });
        return requested;
      }
      const pausable = intent === 'pause' && task.status === 'queued';
      const cancellable = intent === 'cancel'
        && (task.status === 'queued' || task.status === 'paused' || task.status === 'blocked');
      if (pausable || cancellable) {
        const status = intent === 'pause' ? 'paused' : 'cancelled';
        const updated = this.database.prepare(`
          UPDATE tasks SET status = ?, error = ?, control_intent = NULL,
            control_reason = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `).run(
          status,
          intent === 'cancel' ? summary : null,
          intent === 'pause' ? summary : null,
          timestamp,
          taskId,
          task.status,
        );
        if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 状态已变化`);
        const controlled = this.taskStore.get(taskId)!;
        this.appendTaskLifecycleEvent(controlled, `task.${status}`, timestamp, { reason: summary });
        return controlled;
      }
      if (intent === 'cancel' || task.status === 'paused') return task;
      throw new Error(`Task ${taskId} 不是可暂停状态：${task.status}`);
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
      const current = this.leasedTask(taskId, owner, timestamp);
      const requiresSemanticLintReceipt = current.type === 'memory_maintenance'
        && record(current.objective)?.semanticLint === true;
      const requiresMaintenanceReceipt = current.type === 'memory_maintenance';
      if (requiresMaintenanceReceipt && !this.database.prepare(`
        SELECT 1 FROM memory_lint_task_receipts WHERE task_id=? AND profile_id=?
      `).get(current.id, current.profileId)) {
        throw new Error(requiresSemanticLintReceipt
          ? `Memory maintenance Task ${current.id} 缺少 semantic lint completion receipt`
          : `Memory maintenance Task ${current.id} 缺少 batch completion receipt`);
      }
      if (!this.taskStore.updateTerminal(taskId, owner, 'completed', result, undefined, timestamp)) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      this.finishTaskAttempt(current, attemptId, 'completed', result, undefined, timestamp);
      const task = this.taskStore.get(taskId)!;
      this.schedules.recordOutcome(task, result, timestamp);
      if (task.type === 'briefing' && task.triggerEventId) {
        this.database.prepare(`
          UPDATE digest_items SET digested_at = ?
          WHERE briefing_event_id = ? AND digested_at IS NULL
        `).run(timestamp, task.triggerEventId);
      }
      if (requiresSemanticLintReceipt) {
        this.database.prepare(`
          INSERT INTO memory_lint_state (profile_id, changes_since_lint, first_changed_at, last_lint_at)
          VALUES (?, 0, NULL, ?)
          ON CONFLICT(profile_id) DO UPDATE SET changes_since_lint=0,
            first_changed_at=NULL, last_lint_at=excluded.last_lint_at
        `).run(task.profileId, timestamp);
      }
      const completion = this.appendTaskLifecycleEvent(task, 'task.completed', timestamp, { resultAvailable: result !== undefined });
      this.memoryObservations.recordTask(task, 'completed', result, attemptId, timestamp);
      const reviewQueued = this.eventStore.getReceipt(completion.id)?.taskIds.length;
      if (delivery && !reviewQueued) this.insertOutbox(taskId, delivery.route, delivery.payload, timestamp);
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
      const timestamp = at.toISOString();
      const task = this.leasedTask(taskId, owner, timestamp, true);
      const updated = this.database.prepare(`
        UPDATE tasks SET status = 'blocked', result_json = ?, error = ?, lease_owner = NULL,
          lease_until = NULL, control_intent = NULL, control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_until > ? AND control_intent IS NULL
      `).run(sanitizedJson(result), errorSummary(reason, 4_000), timestamp, taskId, owner, timestamp);
      if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 租约已失效`);
      this.finishTaskAttempt(task, attemptId, 'interrupted', result, reason, timestamp);
      const blocked = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(blocked, 'task.blocked', timestamp, { reason });
      if (delivery) this.insertOutbox(taskId, delivery.route, delivery.payload, timestamp);
      return blocked;
    });
  }

  requeueTask(taskId: string, owner: string, reason: string, attemptId?: string, at = new Date()): TaskRecord {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const task = this.leasedTask(taskId, owner, timestamp, true);
      if (!this.taskStore.requeueFailure(
        taskId,
        owner,
        errorSummary(reason, 4_000),
        {
          code: 'task.requeued',
          disposition: {
            phase: 'runtime',
            kind: 'transient',
            retryable: true,
            dispatchStarted: false,
          },
        },
        timestamp,
        timestamp,
      )) {
        throw new Error(`Task ${taskId} 租约已失效`);
      }
      this.finishTaskAttempt(task, attemptId, 'interrupted', undefined, reason, timestamp);
      const queued = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(queued, 'task.retry_scheduled', timestamp, { reason, notBefore: timestamp });
      return queued;
    });
  }

  preemptTask(taskId: string, owner: string, reason: string, attemptId?: string, at = new Date()): TaskRecord {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const task = this.leasedTask(taskId, owner, timestamp, true);
      const updated = this.database.prepare(`
        UPDATE tasks SET status = 'queued', max_attempts = max_attempts + 1,
          not_before = ?, error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_until > ? AND control_intent IS NULL
      `).run(timestamp, errorSummary(reason, 4_000), timestamp, taskId, owner, timestamp);
      if (Number(updated.changes) !== 1) throw new Error(`Task ${taskId} 租约已失效`);
      this.finishTaskAttempt(task, attemptId, 'interrupted', undefined, reason, timestamp);
      const queued = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(queued, 'task.preempted', timestamp, { reason });
      return queued;
    });
  }

  failTask(
    taskId: string,
    owner: string,
    error: unknown,
    failure: RunFailureRecord,
    attemptId?: string,
    at = new Date(),
    retryLimit?: number,
    finalization?: RunFinalizationRecord,
  ): TaskRecord {
    return this.transaction(() => {
      const structuredFailure = runFailureRecord(failure);
      if (!structuredFailure) throw new Error('Task failure 缺少有效的结构化 disposition');
      const timestamp = at.toISOString();
      const task = this.leasedTask(taskId, owner, timestamp);
      const summary = errorSummary(error, 4_000);
      const uncertain = structuredFailure.disposition.kind === 'uncertain';
      const effectiveAttemptLimit = Math.max(
        1,
        Math.min(task.maxAttempts, retryLimit ?? task.maxAttempts),
      );
      const terminal = uncertain
        || !structuredFailure.disposition.retryable
        || task.attemptCount >= effectiveAttemptLimit;
      if (terminal) {
        const status = uncertain || structuredFailure.disposition.retryable ? 'dead_letter' : 'failed';
        if (!this.taskStore.updateTerminal(
          taskId,
          owner,
          status,
          { failure: structuredFailure, ...(finalization ? { finalization } : {}) },
          summary,
          timestamp,
        )) {
          throw new Error(`Task ${taskId} 租约已失效`);
        }
      } else {
        const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, task.attemptCount - 1));
        if (!this.taskStore.requeueFailure(
          taskId,
          owner,
          summary,
          structuredFailure,
          new Date(at.getTime() + delay).toISOString(),
          timestamp,
        )) throw new Error(`Task ${taskId} 租约已失效`);
      }
      this.finishTaskAttempt(
        task, attemptId, 'failed', finalization ? { finalization } : undefined, summary, timestamp,
      );
      const updated = this.taskStore.get(taskId)!;
      this.appendTaskLifecycleEvent(updated, terminal
        ? (updated.status === 'failed' ? 'task.failed' : 'task.dead_letter')
        : 'task.retry_scheduled', timestamp, {
        error: summary,
        failure: structuredFailure,
        attemptNo: task.attemptCount,
        notBefore: updated.notBefore,
      });
      if (terminal && updated.status === 'dead_letter') {
        this.memoryObservations.recordTask(
          updated,
          'dead_letter',
          { error: summary, failure: structuredFailure },
          attemptId,
          timestamp,
        );
      }
      if (terminal) {
        const trigger = task.triggerEventId ? this.eventStore.get(task.triggerEventId) : undefined;
        const authority = this.eventStore.get(task.authorityEventId);
        const route = trigger?.replyRoute ?? authority?.replyRoute;
        if (route) {
          this.insertOutbox(task.id, route, {
            type: updated.status === 'dead_letter' ? 'task_dead_letter' : 'task_failed',
            taskId: task.id,
            failureCode: structuredFailure.code,
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
      const payload = record(event.payload) ?? {};
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
    return listEventSummaries(this.database, requestedLimit);
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

  recordConnectorHealthState(
    input: ConnectorHealthStateInput,
    at = new Date(),
  ): ImmutableEvent | undefined {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(input.connectorId)) {
      throw new Error('Connector health state 的 connectorId 无效');
    }
    if (!['ready', 'unavailable', 'stale', 'unknown'].includes(input.status)) {
      throw new Error('Connector health state 的 status 无效');
    }
    const connectorSource = input.connectorSource.trim().slice(0, 200);
    const profileId = input.profileId.trim().slice(0, 100);
    const sessionKey = assertSessionId(input.sessionKey);
    if (!connectorSource || !profileId) throw new Error('Connector health state 缺少 source/profile');
    const reasonCode = sanitizeSensitiveText(input.reasonCode)?.trim().slice(0, 200) || undefined;
    const detail = sanitizeSensitiveText(input.detail)?.replace(/\s+/g, ' ').trim().slice(0, 500) || undefined;
    const current = { status: input.status, reasonCode, detail };
    const key = `connector-health:${input.connectorId}`;
    return this.transaction(() => {
      let previous: typeof current | undefined;
      try {
        const parsed = parseJson<Partial<typeof current>>(this.attentionState(key));
        if (parsed && ['ready', 'unavailable', 'stale', 'unknown'].includes(parsed.status ?? '')) {
          previous = {
            status: parsed.status as typeof current.status,
            reasonCode: typeof parsed.reasonCode === 'string' ? parsed.reasonCode : undefined,
            detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
          };
        }
      } catch {
        previous = undefined;
      }
      const timestamp = at.toISOString();
      if (previous?.status === current.status
        && previous.reasonCode === current.reasonCode
        && previous.detail === current.detail) {
        this.database.prepare('UPDATE attention_state SET updated_at = ? WHERE key = ?')
          .run(timestamp, key);
        return undefined;
      }
      this.upsertAttentionState(key, json(current), timestamp);
      if (!input.eventsEnabled || !previous) return undefined;
      const eventStatus = current.status === 'ready' ? 'recovered' : current.status;
      const automaticRecovery = input.automaticRestart
        ? 'Daemon 会继续执行既有自动恢复策略。'
        : '该 Connector 未启用自动重启。';
      const prompt = eventStatus === 'recovered'
        ? `Connector “${input.connectorId}” 已恢复 ready；请只处理仍然存在的业务影响，不重放结果不确定的动作。`
        : `Connector “${input.connectorId}” 当前为 ${eventStatus}。${automaticRecovery}`;
      return this.ingestEvent({
        id: randomUUID(),
        externalId: `${input.connectorId}:${eventStatus}:${randomUUID()}`,
        source: 'system:connector-health',
        kind: 'alert',
        trust: 'system',
        payload: {
          prompt,
          connectorHealth: {
            connectorId: input.connectorId,
            connectorSource,
            status: eventStatus,
            automaticRestart: input.automaticRestart,
            ...(reasonCode ? { reasonCode } : {}),
            ...(detail ? { detail } : {}),
          },
        },
        occurredAt: timestamp,
        receivedAt: timestamp,
        priority: eventStatus === 'recovered' ? 75 : 90,
        profileId,
        sessionKey,
        replyRoute: { channel: 'system' },
      }).event;
    });
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
    `).run(hashedStateKey('owner-route', profileId), json({ channel, target }), at.toISOString());
  }

  recentOwnerReplyRoute(profileId: string, maxAgeMs: number, at = new Date()): ReplyRoute | undefined {
    const row = this.database.prepare(`
      SELECT value FROM attention_state WHERE key = ? AND updated_at >= ?
    `).get(hashedStateKey('owner-route', profileId), new Date(at.getTime() - maxAgeMs).toISOString()) as Row | undefined;
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
        executor: 'isolated_worker',
        workspaceAccess: 'read',
      });
      this.database.prepare(`
        UPDATE digest_items SET briefing_event_id = ?
        WHERE id IN (${items.map(() => '?').join(', ')})
      `).run(result.event.id, ...items.map((item) => item.id));
      this.audit('briefing.created', result.event.id, { checkpointKey, items: items.length }, timestamp);
      return result.event;
    });
  }


  completeCodexTask(
    id: string,
    owner: string,
    result: {
      threadId?: string;
      answer: string;
      usage?: unknown;
      exitCode: number;
      runnerPid: number;
      codexPid?: number;
      outputJsonlPath: string;
      summaryPath: string;
      startedAt: string;
    },
    attemptId?: string,
    at = new Date(),
  ): TaskRecord {
    const task = this.taskStore.get(id);
    const current = record(task?.objective) ?? {};
    const previousCodex = record(current.codex) ?? {};
    const threadId = result.threadId
      ?? (typeof previousCodex.threadId === 'string' ? previousCodex.threadId : undefined);
    const completedAt = at.toISOString();
    const persistedResult = {
      executor: 'codex' as const,
      exitCode: result.exitCode,
      answer: result.answer.slice(0, 12_000),
      usage: result.usage,
      process: {
        runnerPid: result.runnerPid,
        codexPid: result.codexPid,
        startedAt: result.startedAt,
        completedAt,
      },
      artifacts: {
        outputJsonl: result.outputJsonlPath,
        summary: result.summaryPath,
      },
      ...(threadId ? { threadId } : {}),
    };
    const trigger = task?.triggerEventId ? this.eventStore.get(task.triggerEventId) : undefined;
    const authority = task ? this.eventStore.get(task.authorityEventId) : undefined;
    const route = trigger?.replyRoute ?? authority?.replyRoute;
    const completed = this.completeTask(id, owner, persistedResult, attemptId, at, route ? {
      route,
      payload: {
        type: 'background_task_completed',
        taskId: id,
        text: `Codex 后台任务已完成（${id}）：${result.answer}`.slice(0, 4_000),
      },
    } : undefined);
    this.audit('task.codex_completed', id, {
      threadId, exitCode: result.exitCode, runnerPid: result.runnerPid, codexPid: result.codexPid,
    }, completedAt);
    return completed;
  }

  checkpointCodexTask(
    id: string,
    owner: string,
    checkpoint: {
      threadId?: string;
      runnerPid?: number;
      codexPid?: number;
      outputJsonlPath?: string;
      summaryPath?: string;
      startedAt?: string;
      lastEvent?: string;
    },
    at = new Date(),
  ): TaskRecord {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const task = this.leasedTask(id, owner, timestamp, true);
      const current = record(task.objective) ?? {};
      const previousCodex = record(current.codex) ?? {};
      const objective = {
        ...current,
        codex: { ...previousCodex, ...checkpoint, checkpointedAt: at.toISOString() },
      };
      const updated = this.database.prepare(`
        UPDATE tasks SET objective_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_until > ? AND control_intent IS NULL
      `).run(json(objective), timestamp, id, owner, timestamp);
      if (Number(updated.changes) !== 1) throw new Error(`Codex Task ${id} 租约已失效`);
      this.audit('task.executor_checkpoint', id, { executor: 'codex', ...checkpoint }, timestamp);
      return this.taskStore.get(id)!;
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

  pruneHistory(cutoff: Date) {
    if (!Number.isFinite(cutoff.getTime())) throw new Error('历史保留 cutoff 不是有效时间');
    const timestamp = cutoff.toISOString();
    const result = this.transaction(() => {
      const observationCutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
      const memoryObservations = Number(this.database.prepare(`
        DELETE FROM memory_observations WHERE source_key IN (
          SELECT source_key FROM memory_observations
          WHERE compiled_at IS NOT NULL AND compiled_at < ?
          ORDER BY compiled_at ASC LIMIT 100
        )
      `).run(observationCutoff).changes);
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
          AND NOT EXISTS (SELECT 1 FROM memory_observations WHERE memory_observations.task_id = tasks.id)
          AND NOT EXISTS (
            SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id
              AND child.status IN ('queued', 'running', 'paused', 'blocked', 'dead_letter')
          )
      `;
      const runs = Number(this.database.prepare(`
        DELETE FROM runs
        WHERE status != 'running' AND task_id IN (${candidateTasks})
      `).run(timestamp).changes);
      this.database.prepare(`
        DELETE FROM memory_lint_task_receipts WHERE task_id IN (${candidateTasks})
      `).run(timestamp);
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
        DELETE FROM attention_state WHERE updated_at < ? AND key NOT LIKE 'connector-health:%'
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
      return { memoryObservations, outbox, digestItems, runs, tasks, events, schedules, attentionState, auditEvents };
    });
    try {
      this.database.exec('PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);');
    } catch {
      // Cleanup is already committed; optimization/checkpoint are best effort.
    }
    return result;
  }

  private insertOutbox(subjectId: string, route: ReplyRoute, payload: unknown, timestamp: string): string {
    return this.outbox.insert(subjectId, route, payload, timestamp);
  }

  private claimReadyTask(
    taskId: string,
    owner: string,
    leaseMs: number,
    at: Date,
    timestamp: string,
  ): TaskRecord | undefined {
    if (!this.taskStore.claim(
      taskId, owner, new Date(at.getTime() + leaseMs).toISOString(), timestamp,
    )) return undefined;
    const task = this.taskStore.get(taskId)!;
    this.appendTaskLifecycleEvent(task, 'task.started', timestamp, {
      attemptNo: task.attemptCount,
      workerId: owner,
    });
    return task;
  }

  private leasedTask(taskId: string, owner: string, timestamp: string, uncontrolled = false): TaskRecord {
    const task = this.taskStore.get(taskId);
    if (!task || task.status !== 'running' || task.leaseOwner !== owner
      || !task.leaseUntil || task.leaseUntil <= timestamp || (uncontrolled && task.controlIntent)) {
      throw new Error(`Task ${taskId} 租约已失效`);
    }
    return task;
  }

  private finishTaskAttempt(
    task: TaskRecord,
    attemptId: string | undefined,
    status: Exclude<TaskAttemptRecord['status'], 'running'>,
    answer: unknown,
    error: string | undefined,
    timestamp: string,
  ): void {
    if (!this.taskStore.finishAttempt(
      attemptId, task.id, task.attemptCount, status, answer, error, timestamp,
    ) && attemptId) throw new Error(`Task Attempt ${attemptId} 已终止或不存在`);
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
    const result = this.taskStore.enqueue({
      ...input,
      sessionKey: profileBoundSessionKey(input.profileId, input.sessionKey),
    }, timestamp);
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
      replyRoute: this.eventStore.get(task.authorityEventId)?.replyRoute,
      occurredAt: timestamp,
      receivedAt: timestamp,
    }, timestamp).event;
    this.eventRouter.routeEvent(event.id, taskCompletionRoute(
      task, event, this.eventStore.get(task.authorityEventId),
    ));
    return event;
  }

  private settleRunningTaskControl(
    task: TaskRecord,
    timestamp: string,
    phase: 'safe_boundary' | 'lease_recovery',
    attemptId?: string,
  ): TaskRecord | undefined {
    const intent = task.controlIntent;
    if (!intent || !task.leaseOwner) return undefined;
    const cancelled = intent === 'cancel';
    const reason = task.controlReason ?? (cancelled ? 'owner cancelled Task' : 'owner paused Task');
    const updated = this.database.prepare(`
      UPDATE tasks SET status = ?, error = ?, lease_owner = NULL, lease_until = NULL,
        control_intent = NULL, control_reason = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND control_intent = ?
    `).run(cancelled ? 'cancelled' : 'paused', reason, timestamp, task.id, task.leaseOwner, intent);
    if (Number(updated.changes) !== 1) return undefined;
    if (phase === 'lease_recovery') {
      this.database.prepare(`
        UPDATE runs SET status = 'interrupted', completed_at = ?, error = ?
        WHERE task_id = ? AND status = 'running'
      `).run(timestamp, reason, task.id);
    } else {
      this.finishTaskAttempt(task, attemptId, 'interrupted', undefined, reason, timestamp);
    }
    const settled = this.taskStore.get(task.id)!;
    this.appendTaskLifecycleEvent(settled, cancelled ? 'task.cancelled' : 'task.paused', timestamp, {
      reason,
      phase,
    });
    return settled;
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
        this.settleRunningTaskControl(task, timestamp, 'lease_recovery');
        continue;
      }
      const summary = 'Task lease expired';
      const failure: RunFailureRecord = {
        code: 'task.lease_expired',
        disposition: {
          phase: 'runtime', kind: 'transient', retryable: true, dispatchStarted: true,
        },
      };
      const terminal = task.attemptCount >= task.maxAttempts;
      if (!this.taskStore.recoverExpired(
        task.id,
        task.leaseOwner,
        terminal,
        summary,
        failure,
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
        { error: summary, failure, attemptNo: task.attemptCount, notBefore: updated.notBefore },
      );
    }
  }

  private migrate(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version === 0) {
      createFreshV16Schema(this.database);
      upgradeScheduleContextV17(this.database);
      return;
    }
    if (version >= 13 && (!hasFinalEventTaskV12Schema(this.database)
      || !hasMemoryObservationSourceKey(this.database))) {
      throw new Error(`MimiAgent 数据库标记为 v${version}，但缺少最终 Event/Task 或 Memory observation schema`);
    }
    if (version >= 15 && !hasMemoryEvidenceSnapshot(this.database)) {
      throw new Error(`MimiAgent 数据库标记为 v${version}，但缺少 Memory evidence schema`);
    }
    if (version >= 16 && !hasTaskExecutorOwnershipV16(this.database)) {
      throw new Error('MimiAgent 数据库标记为 v16，但缺少 executor schema');
    }
    if (version === 12) {
      if (!hasFinalEventTaskV12Schema(this.database) && !hasLegacyEventTaskSchema(this.database)) {
        throw new Error('MimiAgent 数据库标记为 v12，但表结构既不是最终 v12 也不是可恢复的旧 Event schema');
      }
      if (!hasFinalEventTaskV12Schema(this.database)) {
        assertEmptyPartialEventTaskV12Tables(this.database);
        cutoverEventTaskV12(this.database, {
          removePartialV12: true,
          backfillScheduleAuthorities: () => this.backfillScheduleAuthorities(),
        });
      }
    } else if (version < 12) {
      prepareLegacyEventSchemaForV12(this.database, version);
      cutoverEventTaskV12(this.database, {
        backfillScheduleAuthorities: () => this.backfillScheduleAuthorities(),
      });
    }
    if (version < 13) upgradeMemoryObservationsV13(this.database);
    ensureMemoryLintSchemaV13(this.database);
    if (version < 14) repairDigestedTaskRoutesV14(this.database);
    if (version < 15) upgradeMemoryEvidenceSnapshotV15(this.database, sanitizedMemoryEvidenceSnapshot);
    if (version < 16) upgradeTaskExecutorOwnershipV16(this.database, validTaskRoute);
    else if (version === 16) repairExistingTaskExecutorOwnershipV16(this.database);
    if (version < 17) upgradeScheduleContextV17(this.database);
    if (!this.database.prepare('PRAGMA table_info(schedules)').all().some((row) => row.name === 'context_json')) {
      throw new Error('MimiAgent 数据库标记为 v17，但缺少 schedule context schema');
    }
  }

  private backupBeforeMigrations(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as Row).user_version);
    const finalEventSchema = hasFinalEventTaskV12Schema(this.database);
    const existingV16Repairs = version === 16 && hasTaskExecutorOwnershipV16(this.database)
      ? pendingTaskExecutorOwnershipV16Repairs(this.database) : [];
    const memoryHubCurrent = version === 13 && this.database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_lint_state'
    `).get();
    const labels = [
      ...(version > 0 && version <= 13 && !memoryHubCurrent ? ['memoryhub-v13'] : []),
      ...(version === 13 && finalEventSchema ? ['task-route-v14'] : []),
      ...(version === 14 && finalEventSchema ? ['memory-evidence-v15'] : []),
      ...(version === 15 && finalEventSchema ? ['task-executor-v16'] : []),
      ...(version === 16 && finalEventSchema ? ['schedule-context-v17'] : []),
      ...(finalEventSchema ? existingV16Repairs : []),
    ];
    for (const label of labels) this.backupDatabase(label);
  }

  private backupDatabase(label: string): void {
    this.database.exec('PRAGMA wal_checkpoint(FULL);');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = path.join(
      path.dirname(this.file), 'backups', `${label}-${stamp}-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    chmodSync(backupRoot, 0o700);
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${this.file}${suffix}`;
      if (!existsSync(source)) continue;
      const target = path.join(backupRoot, `${path.basename(this.file)}${suffix}`);
      copyFileSync(source, target);
      chmodSync(target, 0o600);
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
      if (validScheduleAuthority(this.eventStore, schedule)) continue;
      if (schedule.trust !== 'owner' && schedule.trust !== 'system') {
        this.database.prepare('UPDATE schedules SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(timestamp, schedule.id);
        continue;
      }
      try {
        const sessionKey = schedule.sessionKey === undefined ? undefined : assertSessionId(schedule.sessionKey);
        const createdAt = Number.isFinite(Date.parse(schedule.createdAt)) ? schedule.createdAt : timestamp;
        const authority = this.ensureConversationAuthority(syntheticScheduleAuthority({
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

}
