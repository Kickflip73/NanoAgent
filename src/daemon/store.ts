import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { assertSessionId } from '../core/session-id.js';
import type {
  EventEnvelope,
  EventExecutionLane,
  EventStatus,
  DigestItem,
  HostRunRecord,
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
  StoredEvent,
  TaskControlIntent,
} from './types.js';

type Row = Record<string, string | number | null | undefined>;

const TERMINAL_EVENT_STATUSES = new Set<EventStatus>([
  'paused', 'blocked', 'completed', 'ignored', 'digested', 'dead_letter', 'archived',
]);
const DEFAULT_OUTBOX_LEASE_MS = 180_000;
const DEFAULT_EVENT_MAX_ATTEMPTS = 5;
const MAX_COMPLETION_NO_PROGRESS_DEFERRALS = 3;
const DEFAULT_PREEMPTION_RESERVATION_MS = 60_000;
const MAX_TASK_RESUME_CONTEXT_LENGTH = 4_000;
const MAX_TASK_PROMPT_LENGTH = 64_000;

export interface HistoryPruneResult {
  outbox: number;
  digestItems: number;
  runs: number;
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

function eventPreemptionResource(eventId: string): string {
  return `event-preemption:${eventId}`;
}

function eventFailurePayload(event: StoredEvent, error: unknown): Record<string, unknown> {
  const summary = errorSummary(error);
  return {
    type: 'event_dead_letter',
    eventId: event.id,
    source: event.source.slice(0, 200),
    attempts: event.attempts,
    error: summary,
    text: `MimiAgent 任务最终失败：source=${event.source.slice(0, 120)}，event=${event.id.slice(0, 80)}，尝试 ${event.attempts} 次。${summary} 请运行 mimi daemon events 检查。`.slice(0, 1_000),
  };
}

function eventFailureDelivery(
  event: StoredEvent,
  error: unknown,
): { route: ReplyRoute; payload: Record<string, unknown> } {
  if (event.executionLane !== 'task') {
    return { route: { channel: 'system' }, payload: eventFailurePayload(event, error) };
  }
  const summary = errorSummary(error);
  return {
    route: event.replyRoute ?? { channel: 'system' },
    payload: {
      type: 'background_task_failed',
      taskId: event.id,
      attempts: event.attempts,
      error: summary,
      text: `MimiAgent 后台任务失败（${event.id.slice(0, 80)}），尝试 ${event.attempts} 次：${summary}`.slice(0, 1_000),
    },
  };
}

function deliveryFailurePayload(message: OutboxMessage, error: unknown): Record<string, unknown> {
  const summary = errorSummary(error);
  return {
    type: 'delivery_dead_letter',
    eventId: message.eventId,
    outboxId: message.id,
    channel: message.channel.slice(0, 200),
    attempts: message.attempts,
    error: summary,
    text: `MimiAgent 未能确认结果是否已通过 ${message.channel.slice(0, 120)} 投递，event=${message.eventId.slice(0, 80)}，attempt=${message.attempts}。已进入 dead letter，不会自动重发。${summary} 请运行 mimi daemon outbox 核对后再决定重试或归档。`.slice(0, 1_000),
  };
}

function eventFromRow(row: Row): StoredEvent {
  return {
    id: String(row.id),
    externalId: String(row.external_id),
    source: String(row.source),
    kind: String(row.kind) as StoredEvent['kind'],
    trust: String(row.trust) as StoredEvent['trust'],
    actor: parseOptionalJson(row.actor_json),
    conversation: parseOptionalJson(row.conversation_json),
    payload: parseJson(row.payload_json),
    occurredAt: String(row.occurred_at),
    receivedAt: String(row.received_at),
    priority: Number(row.priority),
    profileId: String(row.profile_id),
    sessionKey: optional(row.session_key),
    replyRoute: parseOptionalJson(row.reply_route_json),
    executionLane: (optional(row.execution_lane) ?? 'conversation') as StoredEvent['executionLane'],
    originSessionKey: optional(row.origin_session_key),
    parentEventId: optional(row.parent_event_id),
    rootEventId: optional(row.root_event_id),
    taskDepth: Number(row.task_depth ?? 0),
    taskControl: optional(row.task_control) as TaskControlIntent | undefined,
    taskControlReason: optional(row.task_control_reason),
    status: String(row.status) as EventStatus,
    attempts: Number(row.attempts),
    maxAttempts: row.max_attempts === null || row.max_attempts === undefined
      ? undefined
      : Number(row.max_attempts),
    completionDeferrals: Number(row.completion_deferrals ?? 0),
    completionNoProgressDeferrals: Number(row.completion_no_progress_deferrals ?? 0),
    completionProgressFingerprint: optional(row.completion_progress_fingerprint),
    notBefore: String(row.not_before),
    leaseOwner: optional(row.lease_owner),
    leaseUntil: optional(row.lease_until),
    result: parseJson(row.result_json),
    error: optional(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function matchesConversationAuthority(stored: StoredEvent, expected: EventEnvelope): boolean {
  return stored.source === expected.source
    && stored.externalId === expected.externalId
    && stored.kind === expected.kind
    && stored.trust === expected.trust
    && isDeepStrictEqual(stored.actor, expected.actor)
    && isDeepStrictEqual(stored.conversation, expected.conversation)
    && isDeepStrictEqual(stored.payload, expected.payload)
    && stored.priority === expected.priority
    && stored.profileId === expected.profileId
    && stored.sessionKey === expected.sessionKey
    && isDeepStrictEqual(stored.replyRoute, expected.replyRoute)
    && stored.executionLane === 'conversation'
    && stored.originSessionKey === undefined
    && stored.parentEventId === undefined
    && stored.rootEventId === undefined
    && stored.taskDepth === 0;
}

function isConversationAuthority(event: StoredEvent | undefined): event is StoredEvent {
  return event !== undefined
    && event.executionLane === 'conversation'
    && event.originSessionKey === undefined
    && event.parentEventId === undefined
    && event.rootEventId === undefined
    && event.taskDepth === 0;
}

function outboxFromRow(row: Row): OutboxMessage {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
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
    eventId: String(row.event_id),
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

  constructor(file: string) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(this.file), 0o700);
    this.database = new DatabaseSync(this.file, { timeout: 5_000 });
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.migrate();
    chmodSync(this.file, 0o600);
  }

  close(): void {
    this.database.close();
  }

  enqueueEvent(event: EventEnvelope): { event: StoredEvent; inserted: boolean } {
    return this.insertEvent(event);
  }

  ensureConversationAuthority(event: EventEnvelope): StoredEvent {
    if (
      (event.executionLane ?? 'conversation') !== 'conversation'
      || event.originSessionKey !== undefined
      || event.parentEventId !== undefined
      || event.rootEventId !== undefined
      || (event.taskDepth ?? 0) !== 0
    ) {
      throw new Error('Conversation authority 必须是无父级的 conversation root Event');
    }
    return this.transaction(() => {
      const result = this.insertEvent({ ...event, executionLane: 'conversation', taskDepth: 0 });
      if (!result.inserted) {
        if (result.event.status !== 'completed' || !matchesConversationAuthority(result.event, event)) {
          throw new Error(`Conversation authority 冲突：${event.source}/${event.externalId}`);
        }
        return result.event;
      }
      const timestamp = nowIso();
      const updated = this.database.prepare(`
        UPDATE events SET status = 'completed', result_json = ?, updated_at = ?
        WHERE id = ? AND status = 'queued' AND attempts = 0
      `).run(json({ authority: true }), timestamp, result.event.id);
      if (Number(updated.changes) !== 1) {
        throw new Error(`Conversation authority 写入失败：${event.source}/${event.externalId}`);
      }
      this.insertAudit('event.authority_recorded', result.event.id, { source: event.source }, timestamp);
      return this.getEvent(result.event.id)!;
    });
  }

  enqueueBackgroundTask(
    event: EventEnvelope,
    maxChildren: number,
  ): { event: StoredEvent; inserted: boolean } {
    if (event.executionLane !== 'task' || !event.parentEventId) {
      throw new Error('后台任务必须声明 task execution lane 和 parent event');
    }
    if (!Number.isSafeInteger(maxChildren) || maxChildren < 1 || maxChildren > 64) {
      throw new Error('后台任务直接子任务上限必须在 1-64 之间');
    }
    const parentEventId = event.parentEventId;
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM events WHERE source = ? AND external_id = ?')
        .get(event.source, event.externalId) as Row | undefined;
      if (existing) return { event: eventFromRow(existing), inserted: false };
      if (this.backgroundTaskChildCount(parentEventId) >= maxChildren) {
        throw new Error(`当前任务最多可直接委派 ${maxChildren} 个后台子任务，请先合并或完成已有子任务`);
      }
      return this.insertEvent(event);
    });
  }

  private insertEvent(event: EventEnvelope): { event: StoredEvent; inserted: boolean } {
    const timestamp = nowIso();
    const result = this.database.prepare(`
      INSERT INTO events (
        id, external_id, source, kind, trust, actor_json, conversation_json, payload_json,
        occurred_at, received_at, priority, profile_id, session_key, reply_route_json,
        execution_lane, origin_session_key, parent_event_id, root_event_id, task_depth,
        status, attempts, not_before, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(source, external_id) DO NOTHING
    `).run(
      event.id,
      event.externalId,
      event.source,
      event.kind,
      event.trust,
      json(event.actor),
      json(event.conversation),
      json(event.payload),
      event.occurredAt,
      event.receivedAt,
      event.priority,
      event.profileId,
      event.sessionKey ?? null,
      json(event.replyRoute),
      event.executionLane ?? 'conversation',
      event.originSessionKey ?? null,
      event.parentEventId ?? null,
      event.rootEventId ?? null,
      event.taskDepth ?? 0,
      event.receivedAt,
      timestamp,
      timestamp,
    );
    const stored = this.database.prepare('SELECT * FROM events WHERE source = ? AND external_id = ?')
      .get(event.source, event.externalId) as Row | undefined;
    if (!stored) throw new Error(`事件写入失败：${event.source}/${event.externalId}`);
    return { event: eventFromRow(stored), inserted: Number(result.changes) === 1 };
  }

  getEvent(id: string): StoredEvent | undefined {
    const row = this.database.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  listEvents(limit = 50): StoredEvent[] {
    return (this.database.prepare('SELECT * FROM events ORDER BY received_at DESC LIMIT ?').all(limit) as Row[])
      .map(eventFromRow);
  }

  listBackgroundTasks(limit = 50): StoredEvent[] {
    return (this.database.prepare(`
      SELECT * FROM events WHERE execution_lane = 'task'
      ORDER BY received_at DESC, rowid DESC LIMIT ?
    `).all(managementLimit(limit)) as Row[]).map(eventFromRow);
  }

  backgroundTaskChildCount(parentEventId: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE execution_lane = 'task' AND parent_event_id = ?
    `).get(parentEventId) as Row;
    return Number(row.count);
  }

  taskControl(id: string): { intent: TaskControlIntent; reason: string } | undefined {
    const row = this.database.prepare(`
      SELECT task_control, task_control_reason FROM events
      WHERE id = ? AND execution_lane = 'task' AND task_control IS NOT NULL
    `).get(id) as Row | undefined;
    const intent = optional(row?.task_control);
    if (intent !== 'pause' && intent !== 'cancel') return undefined;
    return {
      intent,
      reason: optional(row?.task_control_reason)
        ?? (intent === 'cancel' ? 'owner 取消了后台任务' : 'owner 暂停了后台任务'),
    };
  }

  requestRunningTaskControl(
    id: string,
    intent: TaskControlIntent,
    reason: string,
    at = new Date(),
  ): StoredEvent | undefined {
    return this.transaction(() => {
      const current = this.getEvent(id);
      if (!current || current.executionLane !== 'task' || current.status !== 'running') return undefined;
      const timestamp = at.toISOString();
      const fallback = intent === 'cancel' ? 'owner 取消了后台任务' : 'owner 暂停了后台任务';
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || fallback;
      const updated = this.database.prepare(`
        UPDATE events SET
          task_control = CASE WHEN task_control = 'cancel' THEN task_control ELSE ? END,
          task_control_reason = CASE WHEN task_control = 'cancel' THEN task_control_reason ELSE ? END,
          updated_at = ?
        WHERE id = ? AND execution_lane = 'task' AND status = 'running'
      `).run(intent, summary, timestamp, id);
      if (Number(updated.changes) !== 1) return undefined;
      const stored = this.getEvent(id)!;
      if (stored.taskControl !== current.taskControl || stored.taskControlReason !== current.taskControlReason) {
        this.insertAudit('event.control_requested', id, {
          intent: stored.taskControl,
          reason: stored.taskControlReason?.slice(0, 1_000),
        }, timestamp);
      }
      return stored;
    });
  }

  listEventSummaries(requestedLimit = 50): MimiEventSummary[] {
    return (this.database.prepare(`
      SELECT id, external_id, source, kind, trust, status, priority, attempts,
        profile_id, session_key, occurred_at, received_at, updated_at, error
      FROM events ORDER BY received_at DESC, rowid DESC LIMIT ?
    `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
      id: String(row.id),
      externalId: String(row.external_id).slice(0, 500),
      source: String(row.source).slice(0, 200),
      kind: String(row.kind) as StoredEvent['kind'],
      trust: String(row.trust) as StoredEvent['trust'],
      status: String(row.status) as EventStatus,
      priority: Number(row.priority),
      attempts: Number(row.attempts),
      profileId: String(row.profile_id).slice(0, 100),
      sessionKey: optional(row.session_key),
      occurredAt: String(row.occurred_at),
      receivedAt: String(row.received_at),
      updatedAt: String(row.updated_at),
      error: optional(row.error)?.slice(0, 500),
    }));
  }

  retryDeadLetterEvent(id: string, at = new Date()): StoredEvent {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.status !== 'dead_letter') throw new Error(`事件 ${id} 不是 dead letter`);
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE events SET status = 'queued', attempts = 0, not_before = ?,
          completion_deferrals = 0, completion_no_progress_deferrals = 0,
          completion_progress_fingerprint = NULL, lease_owner = NULL, lease_until = NULL,
          result_json = NULL, error = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `).run(timestamp, timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} dead letter 状态已变化`);
      this.insertAudit('event.requeued', id, {
        previousAttempts: event.attempts,
        previousError: event.error,
      }, timestamp);
      return this.getEvent(id)!;
    });
  }

  archiveDeadLetterEvent(id: string, at = new Date()): StoredEvent {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE events SET status = 'archived', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter'
      `).run(timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 不是 dead letter`);
      this.insertAudit('event.archived', id, {}, timestamp);
      return this.getEvent(id)!;
    });
  }

  digestEvent(id: string, owner: string, reason: string): DigestItem {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.status !== 'running' || event.leaseOwner !== owner) {
        throw new Error(`事件 ${id} 租约已失效`);
      }
      const timestamp = nowIso();
      const digestId = randomUUID();
      this.database.prepare(`
        INSERT INTO digest_items (
          id, event_id, source, kind, priority, payload_json, reason, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING
      `).run(
        digestId, event.id, event.source, event.kind, event.priority, json(event.payload),
        reason.slice(0, 1_000), event.occurredAt, timestamp,
      );
      const updated = this.database.prepare(`
        UPDATE events SET status = 'digested', result_json = ?, error = NULL,
          lease_owner = NULL, lease_until = NULL, task_control = NULL,
          task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND (execution_lane <> 'task' OR task_control IS NULL)
      `).run(json({ reason }), timestamp, id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 租约已失效`);
      this.insertAudit('event.digested', id, { reason }, timestamp);
      const row = this.database.prepare('SELECT * FROM digest_items WHERE event_id = ?').get(id) as Row | undefined;
      if (!row) throw new Error(`事件 ${id} 摘要写入失败`);
      return digestFromRow(row);
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
  ): StoredEvent | undefined {
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT value FROM attention_state WHERE key = ?')
        .get(checkpointKey) as Row | undefined;
      if (existing) return undefined;
      const timestamp = nowIso();
      this.database.prepare(`
        UPDATE digest_items SET briefing_event_id = NULL
        WHERE digested_at IS NULL AND briefing_event_id IN (
          SELECT id FROM events WHERE status IN ('dead_letter', 'archived')
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
      const result = this.enqueueEvent(buildEvent(items));
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
          JOIN events ON events.id = runs.event_id
          WHERE runs.started_at >= ? AND events.source = ?
        `).get(since.toISOString(), source)
      : this.database.prepare('SELECT COUNT(*) AS count FROM runs WHERE started_at >= ?')
        .get(since.toISOString());
    return Number((row as Row).count);
  }

  claimEvent(
    owner: string,
    leaseMs = 60_000,
    at = new Date(),
    executionLane?: EventExecutionLane,
    maxAttempts?: number,
    excludedSessionKeys: readonly string[] = [],
  ): StoredEvent | undefined {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      this.recoverExpiredEventLeases(timestamp, executionLane);
      this.settleQueuedTaskControls(timestamp);
      const exclusions = [...new Set(excludedSessionKeys)].slice(0, 16);
      const exclusionSql = exclusions.length
        ? ` AND (session_key IS NULL OR session_key NOT IN (${exclusions.map(() => '?').join(', ')}))`
        : '';
      for (let scanned = 0; scanned < 100; scanned += 1) {
        const row = executionLane ? this.database.prepare(`
          SELECT * FROM events
          WHERE status = 'queued' AND not_before <= ? AND execution_lane = ?${exclusionSql}
          ORDER BY priority DESC, received_at ASC LIMIT 1
        `).get(timestamp, executionLane, ...exclusions) as Row | undefined : this.database.prepare(`
          SELECT * FROM events
          WHERE status = 'queued' AND not_before <= ?${exclusionSql}
          ORDER BY priority DESC, received_at ASC LIMIT 1
        `).get(timestamp, ...exclusions) as Row | undefined;
        if (!row) return undefined;
        try {
          eventFromRow(row);
        } catch (error) {
          this.quarantineMalformedEvent(String(row.id), error, timestamp);
          continue;
        }
        const leaseUntil = new Date(at.getTime() + leaseMs).toISOString();
        const claimed = this.database.prepare(`
          UPDATE events SET status = 'running', attempts = attempts + 1,
            max_attempts = COALESCE(max_attempts, ?),
            lease_owner = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(maxAttempts ?? null, owner, leaseUntil, timestamp, String(row.id));
        if (Number(claimed.changes) !== 1) continue;
        this.clearEventPreemptionReservation(String(row.id));
        return this.getEvent(String(row.id));
      }
      return undefined;
    });
  }

  claimEventById(
    id: string,
    owner: string,
    leaseMs = 60_000,
    at = new Date(),
    maxAttempts?: number,
  ): StoredEvent | undefined {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      this.recoverExpiredEventLeases(timestamp, undefined, id);
      this.settleQueuedTaskControls(timestamp);
      const row = this.database.prepare('SELECT * FROM events WHERE id = ?').get(id) as Row | undefined;
      if (!row) return undefined;
      try {
        eventFromRow(row);
      } catch (error) {
        this.quarantineMalformedEvent(id, error, timestamp);
        return undefined;
      }
      const leaseUntil = new Date(at.getTime() + leaseMs).toISOString();
      const claimed = this.database.prepare(`
        UPDATE events SET status = 'running', attempts = attempts + 1,
          max_attempts = COALESCE(max_attempts, ?),
          lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'queued' AND not_before <= ?
      `).run(maxAttempts ?? null, owner, leaseUntil, timestamp, id, timestamp);
      if (Number(claimed.changes) !== 1) return undefined;
      this.clearEventPreemptionReservation(id);
      return this.getEvent(id);
    });
  }

  bindRunningEventSession(id: string, owner: string, sessionKey: string): StoredEvent {
    const resolvedSessionKey = assertSessionId(sessionKey);
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.status !== 'running' || event.leaseOwner !== owner) {
        throw new Error(`事件 ${id} 租约已失效`);
      }
      if (event.sessionKey && event.sessionKey !== resolvedSessionKey) {
        throw new Error(`事件 ${id} 已绑定 Session ${event.sessionKey}，拒绝切换到 ${resolvedSessionKey}`);
      }
      if (!event.sessionKey) {
        const updated = this.database.prepare(`
          UPDATE events SET session_key = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND lease_owner = ? AND session_key IS NULL
        `).run(resolvedSessionKey, nowIso(), id, owner);
        if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} Session 绑定状态已变化`);
      }
      return this.getEvent(id)!;
    });
  }

  readyBackgroundTasks(limit = 10, at = new Date(), maxAttempts?: number): StoredEvent[] {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      this.recoverExpiredEventLeases(timestamp, 'task');
      this.settleQueuedTaskControls(timestamp);
      const rows = this.database.prepare(`
        SELECT * FROM events
        WHERE execution_lane = 'task' AND status = 'queued' AND not_before <= ?
        ORDER BY priority DESC, received_at ASC LIMIT ?
      `).all(timestamp, Math.max(1, Math.min(50, limit))) as Row[];
      const ready: StoredEvent[] = [];
      for (const row of rows) {
        try {
          ready.push(eventFromRow(row));
        } catch (error) {
          this.quarantineMalformedEvent(String(row.id), error, timestamp);
        }
      }
      return ready;
    });
  }

  readyEventsAbove(minPriority: number, abovePriority: number, limit = 10, at = new Date()): StoredEvent[] {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const rows = this.database.prepare(`
        SELECT * FROM events
        WHERE status = 'queued' AND not_before <= ? AND priority >= ? AND priority > ?
        ORDER BY priority DESC, received_at ASC LIMIT ?
      `).all(timestamp, minPriority, abovePriority, Math.max(1, Math.min(50, limit))) as Row[];
      return this.decodeReadyEvents(rows, timestamp);
    });
  }

  readyPreemptionCandidates(
    urgentPriority: number,
    activePriority: number,
    limit = 10,
    at = new Date(),
    executionLane?: EventExecutionLane,
  ): StoredEvent[] {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const rows = executionLane ? this.database.prepare(`
      SELECT * FROM events
      WHERE status = 'queued' AND not_before <= ? AND execution_lane = ? AND (
        (priority >= ? AND priority > ?)
        OR (trust = 'owner' AND kind = 'command' AND priority >= ?)
      )
      ORDER BY priority DESC, received_at ASC LIMIT ?
    `).all(
      at.toISOString(),
      executionLane,
      urgentPriority,
      activePriority,
      activePriority,
      Math.max(1, Math.min(50, limit)),
    ) as Row[] : this.database.prepare(`
      SELECT * FROM events
      WHERE status = 'queued' AND not_before <= ? AND (
        (priority >= ? AND priority > ?)
        OR (trust = 'owner' AND kind = 'command' AND priority >= ?)
      )
      ORDER BY priority DESC, received_at ASC LIMIT ?
    `).all(
      at.toISOString(),
      urgentPriority,
      activePriority,
      activePriority,
      Math.max(1, Math.min(50, limit)),
    ) as Row[];
      return this.decodeReadyEvents(rows, timestamp);
    });
  }

  private decodeReadyEvents(rows: Row[], timestamp: string): StoredEvent[] {
    const events: StoredEvent[] = [];
    for (const row of rows) {
      try {
        events.push(eventFromRow(row));
      } catch (error) {
        this.quarantineMalformedEvent(String(row.id), error, timestamp);
      }
    }
    return events;
  }

  reserveEventPreemption(
    candidateId: string,
    victimId: string,
    at = new Date(),
    reservationMs = DEFAULT_PREEMPTION_RESERVATION_MS,
  ): boolean {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const candidate = this.database.prepare(`
        SELECT id FROM events
        WHERE id = ? AND status = 'queued' AND not_before <= ?
      `).get(candidateId, timestamp) as Row | undefined;
      if (!candidate) return false;
      const resource = eventPreemptionResource(candidateId);
      this.database.prepare(`
        DELETE FROM leases WHERE resource = ? AND lease_until <= ?
      `).run(resource, timestamp);
      this.database.prepare(`
        INSERT OR IGNORE INTO leases (resource, owner, fencing_token, lease_until, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).run(
        resource,
        victimId,
        new Date(at.getTime() + Math.max(1_000, reservationMs)).toISOString(),
        timestamp,
      );
      const reservation = this.database.prepare(`
        SELECT owner FROM leases WHERE resource = ?
      `).get(resource) as Row | undefined;
      return reservation?.owner === victimId;
    });
  }

  renewEventLease(id: string, owner: string, leaseMs: number, at = new Date()): boolean {
    const result = this.database.prepare(`
      UPDATE events SET lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(new Date(at.getTime() + leaseMs).toISOString(), at.toISOString(), id, owner);
    return Number(result.changes) === 1;
  }

  completeEvent(
    id: string,
    owner: string,
    result: unknown,
    status: Extract<EventStatus, 'completed' | 'ignored'> = 'completed',
    delivery?: { route: ReplyRoute; payload: unknown },
    runId?: string,
  ): void {
    this.transaction(() => {
      const timestamp = nowIso();
      const updated = this.database.prepare(`
        UPDATE events SET status = ?, result_json = ?, error = NULL,
          lease_owner = NULL, lease_until = NULL, task_control = NULL,
          task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND (execution_lane <> 'task' OR task_control IS NULL)
      `).run(status, json(result), timestamp, id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 租约已失效`);
      if (runId) this.finishRun(runId, 'completed', result, undefined, timestamp);
      this.database.prepare(`
        UPDATE digest_items SET digested_at = ?
        WHERE briefing_event_id = ? AND digested_at IS NULL
      `).run(timestamp, id);
      if (delivery) this.insertOutbox(id, delivery.route, delivery.payload, timestamp);
      this.insertAudit('event.completed', id, { status, delivery: Boolean(delivery) }, timestamp);
    });
  }

  failEvent(id: string, owner: string, error: unknown, maxAttempts = 5, at = new Date(), runId?: string): StoredEvent {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.status !== 'running' || event.leaseOwner !== owner) {
        throw new Error(`事件 ${id} 租约已失效`);
      }
      if (event.executionLane === 'task' && event.taskControl) {
        const cancelled = event.taskControl === 'cancel';
        const reason = event.taskControlReason
          ?? (cancelled ? 'owner 取消了后台任务' : 'owner 暂停了后台任务');
        const status = cancelled ? 'archived' : 'paused';
        const updated = this.database.prepare(`
          UPDATE events SET status = ?, attempts = CASE WHEN ? = 'paused' THEN MAX(0, attempts - 1) ELSE attempts END,
            error = ?, lease_owner = NULL, lease_until = NULL, task_control = NULL,
            task_control_reason = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND execution_lane = 'task'
            AND lease_owner = ? AND task_control = ?
        `).run(status, status, reason, at.toISOString(), id, owner, event.taskControl);
        if (Number(updated.changes) !== 1) throw new Error(`后台任务 ${id} 控制状态已变化`);
        if (runId) this.finishRun(runId, 'interrupted', undefined, reason, at.toISOString());
        this.insertAudit(cancelled ? 'event.cancelled' : 'event.paused', id, {
          phase: 'worker_exit',
          reason: reason.slice(0, 1_000),
        }, at.toISOString());
        return this.getEvent(id)!;
      }
      // The leased worker may deliberately classify the current failure as
      // terminal by passing the current attempt. It may never broaden the
      // durable limit fixed by the first claim.
      const attemptLimit = Math.min(event.maxAttempts ?? maxAttempts, maxAttempts);
      const terminal = event.attempts >= attemptLimit;
      const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, event.attempts - 1));
      const next = terminal ? at : new Date(at.getTime() + delay);
      this.database.prepare(`
        UPDATE events SET status = ?, error = ?, not_before = ?, max_attempts = COALESCE(max_attempts, ?),
          lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?
      `).run(
        terminal ? 'dead_letter' : 'queued',
        (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
        next.toISOString(),
        attemptLimit,
        at.toISOString(),
        id,
      );
      if (runId) this.finishRun(runId, 'failed', undefined, error, at.toISOString());
      if (terminal) {
        const delivery = eventFailureDelivery(event, error);
        this.insertOutbox(event.id, delivery.route, delivery.payload, at.toISOString());
      }
      this.insertAudit(terminal ? 'event.dead_letter' : 'event.retry', id, { attempts: event.attempts }, at.toISOString());
      return this.getEvent(id)!;
    });
  }

  preemptEvent(
    id: string,
    owner: string,
    reason: string,
    at = new Date(),
    runId?: string,
    resumeAt = at,
  ): StoredEvent {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE events SET status = 'queued', attempts = MAX(0, attempts - 1), error = ?,
          not_before = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND task_control IS NULL
      `).run(reason.slice(0, 4_000), resumeAt.toISOString(), timestamp, id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 租约已失效`);
      if (runId) this.finishRun(runId, 'interrupted', undefined, reason, timestamp);
      this.insertAudit('event.preempted', id, { reason: reason.slice(0, 1_000) }, timestamp);
      return this.getEvent(id)!;
    });
  }

  deferEventForCompletion(
    id: string,
    owner: string,
    reason: string,
    at = new Date(),
    runId?: string,
    progressFingerprint = '',
    terminal = false,
  ): StoredEvent {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.status !== 'running' || event.leaseOwner !== owner || event.taskControl) {
        throw new Error(`事件 ${id} 租约已失效`);
      }
      const deferrals = (event.completionDeferrals ?? 0) + 1;
      const sameProgress = Boolean(progressFingerprint)
        && progressFingerprint === event.completionProgressFingerprint;
      const noProgressDeferrals = sameProgress
        ? (event.completionNoProgressDeferrals ?? 0) + 1
        : 1;
      const delayMs = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(8, noProgressDeferrals - 1));
      const timestamp = at.toISOString();
      if (terminal || noProgressDeferrals >= MAX_COMPLETION_NO_PROGRESS_DEFERRALS) {
        const terminalReason = terminal
          ? `Completion Gate 结果不可安全重放，已停止自动重试：${reason}`
          : `Completion Gate 连续 ${noProgressDeferrals} 次没有新增执行证据，已停止自动重试：${reason}`;
        const updated = this.database.prepare(`
          UPDATE events SET status = 'dead_letter', error = ?, completion_deferrals = ?,
            completion_no_progress_deferrals = ?, completion_progress_fingerprint = ?,
            not_before = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ? AND status = 'running' AND lease_owner = ? AND task_control IS NULL
        `).run(
          terminalReason.slice(0, 4_000),
          deferrals,
          noProgressDeferrals,
          progressFingerprint || null,
          timestamp,
          timestamp,
          id,
          owner,
        );
        if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 租约已失效`);
        if (runId) this.finishRun(runId, 'failed', undefined, terminalReason, timestamp);
        const delivery = eventFailureDelivery(event, terminalReason);
        this.insertOutbox(event.id, delivery.route, delivery.payload, timestamp);
        this.insertAudit('event.dead_letter', id, { completionDeferrals: deferrals }, timestamp);
        return this.getEvent(id)!;
      }
      const updated = this.database.prepare(`
        UPDATE events SET status = 'queued', attempts = MAX(0, attempts - 1),
          error = ?, completion_deferrals = ?, completion_no_progress_deferrals = ?,
          completion_progress_fingerprint = ?, not_before = ?, lease_owner = NULL,
          lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND task_control IS NULL
      `).run(
        reason.slice(0, 4_000),
        deferrals,
        noProgressDeferrals,
        progressFingerprint || null,
        new Date(at.getTime() + delayMs).toISOString(),
        timestamp,
        id,
        owner,
      );
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 租约已失效`);
      if (runId) this.finishRun(runId, 'interrupted', undefined, reason, timestamp);
      this.insertAudit('event.completion_deferred', id, {
        deferrals, noProgressDeferrals, progressFingerprint, delayMs,
      }, timestamp);
      return this.getEvent(id)!;
    });
  }

  handoffCodexTaskToMimi(
    id: string,
    owner: string,
    result: { threadId?: string; answer?: string; usage?: unknown; error?: string },
    at = new Date(),
  ): StoredEvent {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.executionLane !== 'task' || event.status !== 'running'
        || event.leaseOwner !== owner || event.taskControl) {
        throw new Error(`Codex Task ${id} 租约已失效`);
      }
      const current = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
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
      const payload = {
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
      const timestamp = at.toISOString();
      const updated = this.database.prepare(`
        UPDATE events SET status = 'queued', attempts = MAX(0, attempts - 1),
          payload_json = ?, error = ?, not_before = ?, lease_owner = NULL,
          lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND execution_lane = 'task'
          AND lease_owner = ? AND task_control IS NULL
      `).run(
        json(payload),
        result.error ? `Codex 已回退给 MimiAgent：${result.error}`.slice(0, 4_000) : 'Codex 已完成执行，等待 MimiAgent 验收',
        timestamp,
        timestamp,
        id,
        owner,
      );
      if (Number(updated.changes) !== 1) throw new Error(`Codex Task ${id} 租约已失效`);
      this.insertAudit('event.executor_handoff', id, {
        from: 'codex', to: 'mimi', threadId, fallback: Boolean(result.error),
      }, timestamp);
      return this.getEvent(id)!;
    });
  }

  checkpointCodexTask(id: string, owner: string, threadId: string, at = new Date()): StoredEvent {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.executionLane !== 'task' || event.status !== 'running' || event.leaseOwner !== owner) {
        throw new Error(`Codex Task ${id} 租约已失效`);
      }
      const current = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      const previousCodex = current.codex && typeof current.codex === 'object' && !Array.isArray(current.codex)
        ? current.codex as Record<string, unknown>
        : {};
      const payload = { ...current, codex: { ...previousCodex, threadId, checkpointedAt: at.toISOString() } };
      const updated = this.database.prepare(`
        UPDATE events SET payload_json = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND execution_lane = 'task' AND lease_owner = ?
      `).run(json(payload), at.toISOString(), id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`Codex Task ${id} 租约已失效`);
      this.insertAudit('event.executor_checkpoint', id, { executor: 'codex', threadId }, at.toISOString());
      return this.getEvent(id)!;
    });
  }

  pauseQueuedEvent(id: string, reason: string, at = new Date()): StoredEvent {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || 'owner 暂停了后台任务';
      const updated = this.database.prepare(`
        UPDATE events SET status = 'paused', error = ?,
          lease_owner = NULL, lease_until = NULL, task_control = NULL,
          task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued' AND execution_lane = 'task'
      `).run(summary, timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`后台任务 ${id} 不是可暂停的 queued 状态`);
      this.insertAudit('event.paused', id, { phase: 'queued', reason: summary.slice(0, 1_000) }, timestamp);
      return this.getEvent(id)!;
    });
  }

  pauseRunningEvent(
    id: string,
    owner: string,
    reason: string,
    runId?: string,
    at = new Date(),
  ): StoredEvent {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || 'owner 暂停了后台任务';
      const updated = this.database.prepare(`
        UPDATE events SET status = 'paused', attempts = MAX(0, attempts - 1), error = ?,
          lease_owner = NULL, lease_until = NULL, task_control = NULL,
          task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND execution_lane = 'task' AND lease_owner = ?
          AND (task_control IS NULL OR task_control = 'pause')
      `).run(summary, timestamp, id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`后台任务 ${id} 租约已失效`);
      if (runId) this.finishRun(runId, 'interrupted', undefined, summary, timestamp);
      this.insertAudit('event.paused', id, { phase: 'running', reason: summary.slice(0, 1_000) }, timestamp);
      return this.getEvent(id)!;
    });
  }

  blockRunningEvent(
    id: string,
    owner: string,
    result: unknown,
    reason: string,
    delivery: { route: ReplyRoute; payload: unknown },
    runId?: string,
    at = new Date(),
  ): StoredEvent {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || '后台任务需要用户输入';
      const updated = this.database.prepare(`
        UPDATE events SET status = 'blocked', attempts = MAX(0, attempts - 1),
          result_json = ?, error = ?, lease_owner = NULL, lease_until = NULL,
          task_control = NULL, task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND execution_lane = 'task'
          AND lease_owner = ? AND task_control IS NULL
      `).run(json(result), summary, timestamp, id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`后台任务 ${id} 租约已失效`);
      if (runId) this.finishRun(runId, 'interrupted', result, summary, timestamp);
      this.insertOutbox(id, delivery.route, delivery.payload, timestamp);
      this.insertAudit('event.blocked', id, { reason: summary.slice(0, 1_000), delivery: true }, timestamp);
      return this.getEvent(id)!;
    });
  }

  resumeBackgroundTask(id: string, additionalContext?: string, at = new Date()): StoredEvent {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || event.executionLane !== 'task' || (event.status !== 'paused' && event.status !== 'blocked')) {
        throw new Error(`后台任务 ${id} 不是可恢复的 paused/blocked 状态`);
      }
      const timestamp = at.toISOString();
      const payload = resumedTaskPayload(event.payload, additionalContext);
      const updated = this.database.prepare(`
        UPDATE events SET status = 'queued', payload_json = ?, result_json = NULL, error = NULL,
          not_before = ?, lease_owner = NULL, lease_until = NULL,
          task_control = NULL, task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND execution_lane = 'task' AND status IN ('paused', 'blocked')
      `).run(json(payload), timestamp, timestamp, id);
      if (Number(updated.changes) !== 1) throw new Error(`后台任务 ${id} 状态已变化`);
      this.insertAudit('event.resumed', id, {
        previousStatus: event.status,
        additionalContext: Boolean(additionalContext?.trim()),
      }, timestamp);
      return this.getEvent(id)!;
    });
  }

  supersedeEvent(
    id: string,
    owner: string,
    supersededBy: string,
    reason: string,
    at = new Date(),
    runId?: string,
  ): StoredEvent {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000)
        || `被新的 owner 命令 ${supersededBy} 取代`;
      const updated = this.database.prepare(`
        UPDATE events SET status = 'archived', error = ?,
          lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).run(summary, timestamp, id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 租约已失效`);
      if (runId) this.finishRun(runId, 'interrupted', undefined, summary, timestamp);
      this.insertAudit('event.superseded', id, {
        supersededBy,
        reason: summary.slice(0, 1_000),
      }, timestamp);
      return this.getEvent(id)!;
    });
  }

  cancelQueuedEvent(id: string, reason: string, at = new Date()): boolean {
    return this.transaction(() => {
      const event = this.getEvent(id);
      if (!event || !['queued', 'paused', 'blocked'].includes(event.status)) return false;
      const timestamp = at.toISOString();
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || 'owner 取消了未执行的任务';
      const updated = this.database.prepare(`
        UPDATE events SET status = 'archived', error = ?,
          lease_owner = NULL, lease_until = NULL, task_control = NULL,
          task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'paused', 'blocked')
      `).run(summary, timestamp, id);
      if (Number(updated.changes) !== 1) return false;
      this.insertAudit('event.cancelled', id, { phase: event.status, reason: summary.slice(0, 1_000) }, timestamp);
      return true;
    });
  }

  cancelRunningEvent(
    id: string,
    owner: string,
    reason: string,
    at = new Date(),
    runId?: string,
  ): StoredEvent {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || 'owner 取消了正在执行的任务';
      const updated = this.database.prepare(`
        UPDATE events SET status = 'archived', error = ?,
          lease_owner = NULL, lease_until = NULL, task_control = NULL,
          task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).run(summary, timestamp, id, owner);
      if (Number(updated.changes) !== 1) throw new Error(`事件 ${id} 租约已失效`);
      if (runId) this.finishRun(runId, 'interrupted', undefined, summary, timestamp);
      this.insertAudit('event.cancelled', id, { phase: 'running', reason: summary.slice(0, 1_000) }, timestamp);
      return this.getEvent(id)!;
    });
  }

  cancelInterruptedSessionEvent(sessionKey: string, eventId: string, reason: string, at = new Date()): boolean {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 1_000) || 'owner 取消了已中断任务';
      const updated = this.database.prepare(`
        UPDATE events SET status = 'archived', error = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued' AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.event_id = events.id AND runs.session_key = ? AND runs.status = 'interrupted'
        )
      `).run(summary, timestamp, eventId, sessionKey);
      if (Number(updated.changes) !== 1) return false;
      this.insertAudit('event.cancelled', eventId, { sessionKey, reason: summary }, timestamp);
      return true;
    });
  }

  waitForEvent(id: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<StoredEvent> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (callback: () => void) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => done(() => reject(signal?.reason ?? new Error('等待事件已取消')));
      const poll = () => {
        try {
          const event = this.getEvent(id);
          if (!event) return done(() => reject(new Error(`事件不存在：${id}`)));
          if (TERMINAL_EVENT_STATUSES.has(event.status)) return done(() => resolve(event));
          if (Date.now() - started >= timeoutMs) return done(() => reject(new Error(`等待事件超时：${id}`)));
          timer = setTimeout(poll, 100);
        } catch (error) {
          done(() => reject(error));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else poll();
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
          this.insertOutbox(message.eventId, { channel: 'system' }, deliveryFailurePayload(message, error), timestamp);
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
        this.insertOutbox(message.eventId, { channel: 'system' }, deliveryFailurePayload(message, error), timestamp);
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
      SELECT id, event_id, channel, target, status, attempts, not_before, updated_at, error
      FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
      id: String(row.id),
      eventId: String(row.event_id),
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

  beginRun(eventId: string, sessionKey: string): HostRunRecord {
    const id = randomUUID();
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO runs (id, event_id, session_key, status, started_at)
      VALUES (?, ?, ?, 'running', ?)
    `).run(id, eventId, sessionKey, timestamp);
    return this.getRun(id)!;
  }

  listRuns(limit = 50): HostRunRecord[] {
    return (this.database.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit) as Row[])
      .map(runFromRow);
  }

  listRunSummaries(requestedLimit = 50): MimiRunSummary[] {
    return (this.database.prepare(`
      SELECT id, event_id, session_key, status, started_at, completed_at,
        answer_json IS NOT NULL AS answer_available, error
      FROM runs ORDER BY started_at DESC, rowid DESC LIMIT ?
    `).all(managementLimit(requestedLimit)) as Row[]).map((row) => ({
      id: String(row.id),
      eventId: String(row.event_id),
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
      SELECT e.id AS event_id, e.source, e.kind, e.status AS event_status, e.occurred_at,
        r.status AS run_status, r.started_at, r.completed_at, r.answer_json, r.error
      FROM runs r
      JOIN events e ON e.id = r.event_id
      WHERE r.session_key = ? AND NOT EXISTS (
        SELECT 1 FROM runs newer
        WHERE newer.event_id = r.event_id AND (
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
        eventId: String(row.event_id),
        source: String(row.source),
        kind: String(row.kind) as MimiSessionActivity['kind'],
        eventStatus: String(row.event_status) as MimiSessionActivity['eventStatus'],
        runStatus: String(row.run_status) as MimiSessionActivity['runStatus'],
        occurredAt: String(row.occurred_at),
        startedAt: String(row.started_at),
        completedAt: optional(row.completed_at),
        answer,
        error: optional(row.error)?.slice(0, 1_000),
      };
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
      const authority = this.getEvent(authorityEventId);
      if (
        !isConversationAuthority(authority)
        || authority.profileId !== input.profileId
        || authority.trust !== input.trust
      ) {
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
      const cancelledEvents = Number(this.database.prepare(`
        UPDATE events SET status = 'archived', error = 'schedule cancelled before execution', updated_at = ?
        WHERE status = 'queued' AND kind = 'schedule' AND source = ?
      `).run(timestamp, `schedule:${id}`).changes);
      this.insertAudit('schedule.removed', id, { cancelledEvents }, timestamp);
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

  emitDueSchedules(at = new Date()): StoredEvent[] {
    return this.transaction(() => {
      const timestamp = at.toISOString();
      const due = this.database.prepare(`
        SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC
      `).all(timestamp) as Row[];
      const events: StoredEvent[] = [];
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
        const event = this.enqueueEvent({
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
          sessionKey: `mimi-task-${eventId}`,
          originSessionKey: schedule.sessionKey,
          replyRoute: schedule.replyRoute ?? { channel: 'system' },
          executionLane: 'task',
          parentEventId: schedule.authorityEventId,
          rootEventId: schedule.authorityEventId,
          taskDepth: 1,
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
    events: Record<EventStatus, number>;
    outbox: Record<OutboxStatus, number>;
    enabledSchedules: number;
  } {
    const eventStatuses: EventStatus[] = [
      'queued', 'running', 'paused', 'blocked', 'completed', 'ignored', 'digested', 'dead_letter', 'archived',
    ];
    const outboxStatuses: OutboxStatus[] = ['pending', 'sending', 'sent', 'dead_letter', 'archived'];
    const events = Object.fromEntries(eventStatuses.map((status) => [status, 0])) as Record<EventStatus, number>;
    const outbox = Object.fromEntries(outboxStatuses.map((status) => [status, 0])) as Record<OutboxStatus, number>;
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM events GROUP BY status').all() as Row[]) {
      events[String(row.status) as EventStatus] = Number(row.count);
    }
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status').all() as Row[]) {
      outbox[String(row.status) as OutboxStatus] = Number(row.count);
    }
    const enabledSchedules = Number((this.database.prepare('SELECT COUNT(*) AS count FROM schedules WHERE enabled = 1').get() as Row).count);
    return { events, outbox, enabledSchedules };
  }

  activitySnapshot(requestedLimit = 10): MimiActivitySnapshot {
    const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(20, requestedLimit)) : 10;
    const counts = this.counts();
    const pendingDigest = this.pendingDigestCount();
    const recentEvents = (this.database.prepare(`
      SELECT id, source, kind, status, priority, attempts, occurred_at, updated_at, error
      FROM events ORDER BY updated_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      source: String(row.source),
      kind: String(row.kind) as StoredEvent['kind'],
      status: String(row.status) as EventStatus,
      priority: Number(row.priority),
      attempts: Number(row.attempts),
      occurredAt: String(row.occurred_at),
      updatedAt: String(row.updated_at),
      error: optional(row.error)?.slice(0, 500),
    }));
    const recentRuns = (this.database.prepare(`
      SELECT id, event_id, status, started_at, completed_at, error
      FROM runs ORDER BY COALESCE(completed_at, started_at) DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      eventId: String(row.event_id),
      status: String(row.status) as HostRunRecord['status'],
      startedAt: String(row.started_at),
      completedAt: optional(row.completed_at),
      error: optional(row.error)?.slice(0, 500),
    }));
    const recentDeliveries = (this.database.prepare(`
      SELECT id, event_id, channel, status, attempts, updated_at, error
      FROM outbox ORDER BY updated_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map((row) => ({
      id: String(row.id),
      eventId: String(row.event_id),
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
      needsAttention: counts.events.blocked > 0 || counts.events.dead_letter > 0 || counts.outbox.dead_letter > 0,
      workPending: counts.events.queued + counts.events.running + counts.events.paused + counts.events.blocked
        + counts.outbox.pending + counts.outbox.sending + pendingDigest,
      pendingDigest,
      enabledSchedules: counts.enabledSchedules,
      events: counts.events,
      outbox: counts.outbox,
      recentEvents,
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
      const candidateEvents = `
        SELECT events.id FROM events
        WHERE events.status IN ('completed', 'ignored', 'digested', 'archived')
          AND events.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.event_id = events.id)
          AND NOT EXISTS (
            SELECT 1 FROM digest_items
            WHERE digest_items.event_id = events.id OR digest_items.briefing_event_id = events.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM events AS child
            WHERE (child.parent_event_id = events.id OR child.root_event_id = events.id)
              AND child.status IN ('queued', 'running', 'paused', 'blocked', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM schedules WHERE schedules.authority_event_id = events.id
          )
      `;
      const runs = Number(this.database.prepare(`
        DELETE FROM runs
        WHERE status != 'running' AND event_id IN (${candidateEvents})
      `).run(timestamp).changes);
      const events = Number(this.database.prepare(`
        DELETE FROM events
        WHERE id IN (${candidateEvents})
          AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.event_id = events.id)
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
            SELECT 1 FROM events
            WHERE events.id = audit_events.entity_id
              AND events.status IN ('queued', 'running', 'paused', 'blocked', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox
            WHERE outbox.id = audit_events.entity_id
              AND outbox.status IN ('pending', 'sending', 'dead_letter')
          )
      `).run(timestamp).changes);
      return { outbox, digestItems, runs, events, schedules, attentionState, auditEvents };
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
    const event = this.getEvent(message.eventId);
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

  private insertOutbox(eventId: string, route: ReplyRoute, payload: unknown, timestamp: string): string {
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO outbox (
        id, event_id, channel, target, payload_json, status, attempts,
        not_before, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(id, eventId, route.channel, route.target ?? null, json(payload), timestamp, timestamp, timestamp);
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
      executionLane: 'conversation',
      taskDepth: 0,
    };
  }

  private validScheduleAuthority(schedule: ScheduleRecord): boolean {
    try {
      const authority = schedule.authorityEventId ? this.getEvent(schedule.authorityEventId) : undefined;
      return isConversationAuthority(authority)
        && authority.profileId === schedule.profileId
        && authority.trust === schedule.trust;
    } catch {
      return false;
    }
  }

  private transaction<T>(operation: () => T): T {
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

  private clearEventPreemptionReservation(eventId: string): void {
    this.database.prepare('DELETE FROM leases WHERE resource = ?')
      .run(eventPreemptionResource(eventId));
  }

  private quarantineMalformedEvent(id: string, error: unknown, timestamp: string): void {
    const summary = `持久 Event 解码失败，已隔离：${errorSummary(error, 1_000)}`;
    this.database.prepare(`
      UPDATE events SET status = 'dead_letter', error = ?, lease_owner = NULL,
        lease_until = NULL, updated_at = ? WHERE id = ?
    `).run(summary, timestamp, id);
    this.clearEventPreemptionReservation(id);
    this.insertAudit('event.quarantined', id, { error: summary }, timestamp);
  }

  private quarantineMalformedOutbox(id: string, error: unknown, timestamp: string): void {
    const summary = `持久 Outbox 解码失败，已隔离：${errorSummary(error, 1_000)}`;
    this.database.prepare(`
      UPDATE outbox SET status = 'dead_letter', error = ?, lease_owner = NULL,
        lease_until = NULL, updated_at = ? WHERE id = ?
    `).run(summary, timestamp, id);
    this.insertAudit('outbox.quarantined', id, { error: summary }, timestamp);
  }

  private settleQueuedTaskControls(timestamp: string): void {
    const rows = this.database.prepare(`
      SELECT * FROM events
      WHERE execution_lane = 'task' AND status = 'queued'
        AND task_control IN ('pause', 'cancel')
      ORDER BY received_at ASC, rowid ASC
    `).all() as Row[];
    const requested: StoredEvent[] = [];
    for (const row of rows) {
      try {
        requested.push(eventFromRow(row));
      } catch (error) {
        this.quarantineMalformedEvent(String(row.id), error, timestamp);
      }
    }
    for (const event of requested) {
      const control = event.taskControl;
      if (!control) continue;
      const cancelled = control === 'cancel';
      const reason = event.taskControlReason
        ?? (cancelled ? 'owner 取消了后台任务' : 'owner 暂停了后台任务');
      const updated = this.database.prepare(`
        UPDATE events SET status = ?, error = ?, lease_owner = NULL, lease_until = NULL,
          task_control = NULL, task_control_reason = NULL, updated_at = ?
        WHERE id = ? AND execution_lane = 'task' AND status = 'queued' AND task_control = ?
      `).run(cancelled ? 'archived' : 'paused', reason, timestamp, event.id, control);
      if (Number(updated.changes) !== 1) continue;
      this.clearEventPreemptionReservation(event.id);
      this.insertAudit(cancelled ? 'event.cancelled' : 'event.paused', event.id, {
        phase: 'queued_control_recovery',
        reason: reason.slice(0, 1_000),
      }, timestamp);
    }
  }

  private recoverExpiredEventLeases(
    timestamp: string,
    executionLane?: EventExecutionLane,
    eventId?: string,
  ): void {
    const at = new Date(timestamp);
    const laneSql = executionLane ? ' AND execution_lane = ?' : '';
    const eventSql = eventId ? ' AND id = ?' : '';
    const rows = this.database.prepare(`
      SELECT * FROM events
      WHERE status = 'running' AND lease_until <= ?${laneSql}${eventSql}
      ORDER BY lease_until ASC, rowid ASC
    `).all(timestamp, ...(executionLane ? [executionLane] : []), ...(eventId ? [eventId] : [])) as Row[];
    const expired: StoredEvent[] = [];
    for (const row of rows) {
      try {
        expired.push(eventFromRow(row));
      } catch (error) {
        this.quarantineMalformedEvent(String(row.id), error, timestamp);
      }
    }
    for (const event of expired) {
      if (event.executionLane === 'task' && event.taskControl) {
        const cancelled = event.taskControl === 'cancel';
        const reason = event.taskControlReason
          ?? (cancelled ? 'owner 取消了后台任务' : 'owner 暂停了后台任务');
        const status = cancelled ? 'archived' : 'paused';
        const updated = this.database.prepare(`
          UPDATE events SET status = ?,
            attempts = CASE WHEN ? = 'paused' THEN MAX(0, attempts - 1) ELSE attempts END,
            error = ?, lease_owner = NULL, lease_until = NULL,
            task_control = NULL, task_control_reason = NULL, updated_at = ?
          WHERE id = ? AND execution_lane = 'task' AND status = 'running'
            AND lease_until <= ? AND task_control = ?
        `).run(status, status, reason, timestamp, event.id, timestamp, event.taskControl);
        if (Number(updated.changes) !== 1) continue;
        this.database.prepare(`
          UPDATE runs SET status = 'interrupted', completed_at = ?, error = ?
          WHERE status = 'running' AND event_id = ?
        `).run(timestamp, reason.slice(0, 4_000), event.id);
        this.clearEventPreemptionReservation(event.id);
        this.insertAudit(cancelled ? 'event.cancelled' : 'event.paused', event.id, {
          phase: 'lease_recovery',
          reason: reason.slice(0, 1_000),
        }, timestamp);
        continue;
      }
      const attemptLimit = event.maxAttempts ?? DEFAULT_EVENT_MAX_ATTEMPTS;
      const terminal = event.attempts >= attemptLimit;
      const reason = terminal
        ? `事件租约过期，worker 未能在 ${attemptLimit} 次有界尝试内完成`
        : '事件租约过期，worker 可能已崩溃，等待退避后重试';
      const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.max(0, event.attempts - 1));
      const notBefore = terminal ? timestamp : new Date(at.getTime() + delay).toISOString();
      const updated = this.database.prepare(`
        UPDATE events SET status = ?, error = ?, not_before = ?,
          lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_until <= ?
      `).run(
        terminal ? 'dead_letter' : 'queued',
        reason,
        notBefore,
        timestamp,
        event.id,
        timestamp,
      );
      if (Number(updated.changes) !== 1) continue;
      this.database.prepare(`
        UPDATE runs SET status = 'interrupted', completed_at = ?, error = 'event lease expired'
        WHERE status = 'running' AND event_id = ?
      `).run(timestamp, event.id);
      if (terminal) {
        this.clearEventPreemptionReservation(event.id);
        const delivery = eventFailureDelivery(event, reason);
        this.insertOutbox(event.id, delivery.route, delivery.payload, timestamp);
      }
      this.insertAudit(terminal ? 'event.dead_letter' : 'event.retry', event.id, {
        attempts: event.attempts,
        reason: 'lease_expired',
        ...(terminal ? {} : { notBefore }),
      }, timestamp);
    }
  }

  private migrate(): void {
    const version = Number((this.database.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > 11) throw new Error(`不支持的 MimiAgent 数据库版本：${version}`);
    if (version === 0) {
      this.database.exec(`
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          external_id TEXT NOT NULL,
          source TEXT NOT NULL,
          kind TEXT NOT NULL,
          trust TEXT NOT NULL,
          actor_json TEXT NOT NULL,
          conversation_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          priority INTEGER NOT NULL,
          profile_id TEXT NOT NULL,
          session_key TEXT,
          reply_route_json TEXT NOT NULL,
          execution_lane TEXT NOT NULL DEFAULT 'conversation',
          origin_session_key TEXT,
          parent_event_id TEXT,
          root_event_id TEXT,
          task_depth INTEGER NOT NULL DEFAULT 0,
          task_control TEXT,
          task_control_reason TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          max_attempts INTEGER,
          completion_deferrals INTEGER NOT NULL DEFAULT 0,
          completion_no_progress_deferrals INTEGER NOT NULL DEFAULT 0,
          completion_progress_fingerprint TEXT,
          not_before TEXT NOT NULL,
          lease_owner TEXT,
          lease_until TEXT,
          result_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(source, external_id)
        ) STRICT;
        CREATE INDEX events_ready_idx ON events(status, not_before, priority, received_at);
        CREATE INDEX events_lane_ready_idx ON events(execution_lane, status, not_before, priority, received_at);
        CREATE INDEX events_retention_idx ON events(status, updated_at);

        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES events(id),
          session_key TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          answer_json TEXT,
          error TEXT
        ) STRICT;
        CREATE INDEX runs_event_status_idx ON runs(event_id, status);

        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES events(id),
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
        CREATE INDEX outbox_ready_idx ON outbox(status, not_before, created_at);
        CREATE INDEX outbox_retention_idx ON outbox(status, updated_at);

        CREATE TABLE leases (
          resource TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          fencing_token INTEGER NOT NULL,
          lease_until TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          data_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX audit_retention_idx ON audit_events(created_at);

        CREATE TABLE schedules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          schedule_type TEXT NOT NULL,
          schedule_value TEXT NOT NULL,
          prompt TEXT NOT NULL,
          profile_id TEXT NOT NULL,
          session_key TEXT,
          authority_event_id TEXT,
          reply_route_json TEXT NOT NULL,
          trust TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          next_run_at TEXT NOT NULL,
          last_run_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX schedules_due_idx ON schedules(enabled, next_run_at);
        CREATE INDEX schedules_retention_idx ON schedules(enabled, updated_at);

        CREATE TABLE digest_items (
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
        CREATE INDEX digest_pending_idx ON digest_items(digested_at, briefing_event_id, priority, occurred_at);
        CREATE INDEX digest_retention_idx ON digest_items(digested_at);

        CREATE TABLE attention_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX attention_retention_idx ON attention_state(updated_at);
        PRAGMA user_version = 11;
      `);
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
    this.backfillScheduleAuthorities();
    this.createRetentionIndexes();
    this.createEventTaskIndexes();
    this.database.exec('PRAGMA user_version = 11;');
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
    const eventColumns = new Set((this.database.prepare('PRAGMA table_info(events)').all() as Row[])
      .map((row) => String(row.name)));
    const requiredEventColumns = [
      'id', 'external_id', 'source', 'kind', 'trust', 'actor_json', 'conversation_json', 'payload_json',
      'occurred_at', 'received_at', 'priority', 'profile_id', 'session_key', 'reply_route_json',
      'execution_lane', 'origin_session_key', 'parent_event_id', 'root_event_id', 'task_depth',
      'status', 'attempts', 'not_before', 'created_at', 'updated_at',
    ];
    const canPersistAuthority = requiredEventColumns.every((column) => eventColumns.has(column));
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
      if (!canPersistAuthority || (schedule.trust !== 'owner' && schedule.trust !== 'system')) {
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
