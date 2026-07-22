import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type {
  TaskAttemptRecord,
  TaskInput,
  TaskRecord,
  TaskSelector,
  TaskStatus,
} from './types.js';

type Row = Record<string, string | number | null | undefined>;

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | number | null | undefined): T | undefined {
  if (typeof value !== 'string') return undefined;
  return JSON.parse(value) as T;
}

function optional(value: string | number | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function taskFromRow(row: Row): TaskRecord {
  return {
    id: String(row.id),
    type: String(row.type) as TaskRecord['type'],
    idempotencyKey: String(row.idempotency_key),
    triggerEventId: optional(row.trigger_event_id),
    authorityEventId: String(row.authority_event_id),
    parentTaskId: optional(row.parent_task_id),
    profileId: String(row.profile_id),
    sessionKey: optional(row.session_key),
    objective: parseJson(row.objective_json),
    executor: String(row.executor) as TaskRecord['executor'],
    workspaceAccess: String(row.workspace_access) as TaskRecord['workspaceAccess'],
    priority: Number(row.priority),
    status: String(row.status) as TaskStatus,
    notBefore: String(row.not_before),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    leaseOwner: optional(row.lease_owner),
    leaseUntil: optional(row.lease_until),
    controlIntent: optional(row.control_intent) as TaskRecord['controlIntent'],
    controlReason: optional(row.control_reason),
    result: parseJson(row.result_json),
    error: optional(row.error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function attemptFromRow(row: Row): TaskAttemptRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    attemptNo: Number(row.attempt_no),
    sessionKey: String(row.session_key),
    workerId: String(row.worker_id),
    status: String(row.status) as TaskAttemptRecord['status'],
    startedAt: String(row.started_at),
    completedAt: optional(row.completed_at),
    answer: parseJson(row.answer_json),
    error: optional(row.error),
  };
}

function sameTask(stored: TaskRecord, input: TaskInput): boolean {
  return stored.type === input.type
    && stored.idempotencyKey === input.idempotencyKey
    && stored.triggerEventId === input.triggerEventId
    && stored.authorityEventId === input.authorityEventId
    && stored.parentTaskId === input.parentTaskId
    && stored.profileId === input.profileId
    && stored.sessionKey === input.sessionKey
    && isDeepStrictEqual(stored.objective, input.objective)
    && stored.executor === input.executor
    && stored.workspaceAccess === input.workspaceAccess
    && stored.priority === input.priority
    && (input.notBefore === undefined || stored.notBefore === input.notBefore)
    && stored.maxAttempts === (input.maxAttempts ?? 5);
}

export class TaskStore {
  constructor(private readonly database: DatabaseSync) {}

  enqueue(input: TaskInput, timestamp: string): { task: TaskRecord; inserted: boolean } {
    const inserted = this.database.prepare(`
      INSERT INTO tasks (
        id, type, idempotency_key, trigger_event_id, authority_event_id, parent_task_id,
        profile_id, session_key, objective_json, executor, workspace_access, priority,
        status, not_before, attempt_count, max_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      input.id,
      input.type,
      input.idempotencyKey,
      input.triggerEventId ?? null,
      input.authorityEventId,
      input.parentTaskId ?? null,
      input.profileId,
      input.sessionKey ?? null,
      json(input.objective),
      input.executor,
      input.workspaceAccess,
      input.priority,
      input.notBefore ?? timestamp,
      input.maxAttempts ?? 5,
      timestamp,
      timestamp,
    );
    const task = this.getByIdempotencyKey(input.idempotencyKey);
    if (!task) throw new Error(`Task 写入失败：${input.idempotencyKey}`);
    if (!sameTask(task, input)) throw new Error(`Task 幂等键冲突：${input.idempotencyKey}`);
    return { task, inserted: Number(inserted.changes) === 1 };
  }

  get(id: string): TaskRecord | undefined {
    const row = this.database.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  getByIdempotencyKey(key: string): TaskRecord | undefined {
    const row = this.database.prepare('SELECT * FROM tasks WHERE idempotency_key = ?').get(key) as Row | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  list(limit: number): TaskRecord[] {
    return (this.database.prepare(`
      SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Row[]).map(taskFromRow);
  }

  listReady(selector: TaskSelector, timestamp: string, limit: number): TaskRecord[] {
    const types = [...new Set(selector.types ?? [])].slice(0, 8);
    const excludedSessions = [...new Set(selector.excludedSessionKeys ?? [])].slice(0, 16);
    const clauses = ["status = 'queued'", 'not_before <= ?'];
    const parameters: Array<string | number> = [timestamp];
    if (types.length) {
      clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
      parameters.push(...types);
    }
    if (selector.executor) {
      clauses.push('executor = ?');
      parameters.push(selector.executor);
    }
    if (excludedSessions.length) {
      clauses.push(`(session_key IS NULL OR session_key NOT IN (${excludedSessions.map(() => '?').join(', ')}))`);
      parameters.push(...excludedSessions);
    }
    parameters.push(limit);
    return (this.database.prepare(`
      SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
      ORDER BY priority DESC, created_at ASC LIMIT ?
    `).all(...parameters) as Row[]).map(taskFromRow);
  }

  listRunning(selector: TaskSelector, limit: number): TaskRecord[] {
    const types = [...new Set(selector.types ?? [])].slice(0, 8);
    const clauses = ["status = 'running'"];
    const parameters: Array<string | number> = [];
    if (types.length) {
      clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
      parameters.push(...types);
    }
    if (selector.executor) {
      clauses.push('executor = ?');
      parameters.push(selector.executor);
    }
    parameters.push(limit);
    return (this.database.prepare(`
      SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
      ORDER BY priority DESC, created_at ASC LIMIT ?
    `).all(...parameters) as Row[]).map(taskFromRow);
  }

  claimCandidate(selector: TaskSelector, timestamp: string): TaskRecord | undefined {
    const types = [...new Set(selector.types ?? [])].slice(0, 8);
    const excludedSessions = [...new Set(selector.excludedSessionKeys ?? [])].slice(0, 16);
    const clauses = ["status = 'queued'", 'not_before <= ?'];
    const parameters: Array<string> = [timestamp];
    if (types.length) {
      clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
      parameters.push(...types);
    }
    if (selector.executor) {
      clauses.push('executor = ?');
      parameters.push(selector.executor);
    }
    if (excludedSessions.length) {
      clauses.push(`(session_key IS NULL OR session_key NOT IN (${excludedSessions.map(() => '?').join(', ')}))`);
      parameters.push(...excludedSessions);
    }
    const row = this.database.prepare(`
      SELECT * FROM tasks WHERE ${clauses.join(' AND ')}
      ORDER BY priority DESC, created_at ASC LIMIT 1
    `).get(...parameters) as Row | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  claim(id: string, owner: string, leaseUntil: string, timestamp: string): boolean {
    const updated = this.database.prepare(`
      UPDATE tasks SET status = 'running', attempt_count = attempt_count + 1,
        lease_owner = ?, lease_until = ?, error = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued' AND not_before <= ?
    `).run(owner, leaseUntil, timestamp, id, timestamp);
    return Number(updated.changes) === 1;
  }

  updateTerminal(
    id: string,
    owner: string,
    status: Extract<TaskStatus, 'completed' | 'failed' | 'cancelled' | 'dead_letter'>,
    result: unknown,
    error: string | undefined,
    timestamp: string,
  ): boolean {
    const updated = this.database.prepare(`
      UPDATE tasks SET status = ?, result_json = ?, error = ?, lease_owner = NULL,
        lease_until = NULL, control_intent = NULL, control_reason = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND control_intent IS NULL
        AND lease_until > ?
    `).run(status, json(result), error ?? null, timestamp, id, owner, timestamp);
    return Number(updated.changes) === 1;
  }

  requeueFailure(id: string, owner: string, error: string, notBefore: string, timestamp: string): boolean {
    const updated = this.database.prepare(`
      UPDATE tasks SET status = 'queued', error = ?, not_before = ?, lease_owner = NULL,
        lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND control_intent IS NULL
        AND lease_until > ?
    `).run(error, notBefore, timestamp, id, owner, timestamp);
    return Number(updated.changes) === 1;
  }

  recoverExpired(
    id: string,
    owner: string,
    terminal: boolean,
    error: string,
    notBefore: string,
    timestamp: string,
  ): boolean {
    const updated = this.database.prepare(`
      UPDATE tasks SET status = ?, error = ?, not_before = ?, lease_owner = NULL,
        lease_until = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND control_intent IS NULL
        AND lease_until <= ?
    `).run(terminal ? 'dead_letter' : 'queued', error, notBefore, timestamp, id, owner, timestamp);
    return Number(updated.changes) === 1;
  }

  beginAttempt(
    id: string,
    task: TaskRecord,
    sessionKey: string,
    workerId: string,
    timestamp: string,
  ): TaskAttemptRecord {
    this.database.prepare(`
      INSERT INTO runs (
        id, task_id, attempt_no, session_key, worker_id, status, started_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?)
    `).run(id, task.id, task.attemptCount, sessionKey, workerId, timestamp);
    return this.getAttempt(id)!;
  }

  getAttempt(id: string): TaskAttemptRecord | undefined {
    const row = this.database.prepare('SELECT * FROM runs WHERE id = ? AND task_id IS NOT NULL')
      .get(id) as Row | undefined;
    return row ? attemptFromRow(row) : undefined;
  }

  finishAttempt(
    id: string | undefined,
    taskId: string,
    attemptNo: number,
    status: Exclude<TaskAttemptRecord['status'], 'running'>,
    answer: unknown,
    error: string | undefined,
    timestamp: string,
  ): boolean {
    const idClause = id ? ' AND id = ?' : '';
    const updated = this.database.prepare(`
      UPDATE runs SET status = ?, completed_at = ?, answer_json = ?, error = ?
      WHERE task_id = ? AND attempt_no = ? AND status = 'running'${idClause}
    `).run(status, timestamp, json(answer), error ?? null, taskId, attemptNo, ...(id ? [id] : []));
    return Number(updated.changes) === 1;
  }
}
