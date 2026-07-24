import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | null | undefined>;

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Row[])
    .map((row) => String(row.name)));
}

export function hasFinalEventTaskV12Schema(database: DatabaseSync): boolean {
  const events = tableColumns(database, 'events');
  const tasks = tableColumns(database, 'tasks');
  const runs = tableColumns(database, 'runs');
  const outbox = tableColumns(database, 'outbox');
  return events.has('type') && !events.has('status')
    && tasks.has('authority_event_id') && tasks.has('attempt_count')
    && runs.has('task_id') && runs.has('attempt_no')
    && outbox.has('task_id') && !outbox.has('event_id');
}

export function hasLegacyEventTaskSchema(database: DatabaseSync): boolean {
  const events = tableColumns(database, 'events');
  const runs = tableColumns(database, 'runs');
  const outbox = tableColumns(database, 'outbox');
  return events.has('kind') && events.has('status') && events.has('execution_lane')
    && !events.has('type') && runs.has('event_id') && outbox.has('event_id');
}

export function assertEmptyPartialEventTaskV12Tables(database: DatabaseSync): void {
  for (const table of ['events_v2', 'tasks', 'task_attempts', 'event_route_receipts']) {
    const exists = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table);
    if (!exists) continue;
    const count = Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count);
    if (count > 0) {
      throw new Error(`MimiAgent v12 半迁移表 ${table} 含 ${count} 行，拒绝自动覆盖；请先人工核对数据`);
    }
  }
}

export interface EventTaskV12CutoverOptions {
  removePartialV12?: boolean;
  backfillScheduleAuthorities: () => void;
}

export function cutoverEventTaskV12(
  database: DatabaseSync,
  options: EventTaskV12CutoverOptions,
): void {
  const legacyCounts = {
    events: Number((database.prepare('SELECT COUNT(*) AS count FROM events').get() as Row).count),
    executableEvents: Number((database.prepare(`
      SELECT COUNT(*) AS count FROM events WHERE status NOT IN ('digested', 'ignored')
    `).get() as Row).count),
    runs: Number((database.prepare('SELECT COUNT(*) AS count FROM runs').get() as Row).count),
    outbox: Number((database.prepare('SELECT COUNT(*) AS count FROM outbox').get() as Row).count),
  };
  database.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    if (options.removePartialV12) {
      database.exec(`
        DROP TABLE IF EXISTS task_attempts;
        DROP TABLE IF EXISTS event_route_receipts;
        DROP TABLE IF EXISTS tasks;
        DROP TABLE IF EXISTS events_v2;
      `);
    }
    database.exec(`
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
      FROM events e LEFT JOIN events parent ON parent.id = e.parent_event_id
      WHERE e.status NOT IN ('digested', 'ignored');

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
      FROM events
      WHERE status NOT IN ('digested', 'ignored');

      INSERT INTO event_route_receipts_v12 (
        event_id, router_version, decision, task_ids_json, reason_code, routed_at
      )
      SELECT id, 'migration-v12',
        CASE status WHEN 'digested' THEN 'digest' WHEN 'ignored' THEN 'rejected'
          ELSE 'task_created' END,
        CASE WHEN status IN ('digested', 'ignored') THEN '[]' ELSE json_array(id) END,
        CASE status WHEN 'digested' THEN 'legacy_digest_conversion'
          WHEN 'ignored' THEN 'legacy_ignored_conversion'
          ELSE 'legacy_event_conversion' END,
        updated_at
      FROM events;

      INSERT INTO event_route_receipts_v12 (
        event_id, router_version, decision, task_ids_json, reason_code, routed_at
      )
      SELECT 'migration-task-' || id, 'migration-v12', 'observe_only', '[]',
        'task_lifecycle', updated_at
      FROM events
      WHERE status NOT IN ('digested', 'ignored');

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
      CREATE INDEX tasks_ready_priority_idx ON tasks(priority DESC, created_at ASC, not_before)
        WHERE status = 'queued';
      CREATE INDEX tasks_recovery_idx ON tasks(status, lease_until);
      CREATE INDEX tasks_session_idx ON tasks(session_key, status, updated_at DESC);
      CREATE INDEX tasks_trigger_idx ON tasks(trigger_event_id);
      CREATE INDEX tasks_parent_idx ON tasks(parent_task_id);
      CREATE UNIQUE INDEX runs_task_attempt_idx ON runs(task_id, attempt_no);
      CREATE INDEX runs_task_status_idx ON runs(task_id, status);
      CREATE INDEX outbox_ready_idx ON outbox(status, not_before, created_at);
      CREATE INDEX outbox_retention_idx ON outbox(status, updated_at);
    `);
    options.backfillScheduleAuthorities();
    const convertedCounts = {
      tasks: Number((database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as Row).count),
      routes: Number((database.prepare('SELECT COUNT(*) AS count FROM event_route_receipts').get() as Row).count),
      runs: Number((database.prepare('SELECT COUNT(*) AS count FROM runs').get() as Row).count),
      outbox: Number((database.prepare('SELECT COUNT(*) AS count FROM outbox').get() as Row).count),
    };
    if (convertedCounts.tasks !== legacyCounts.executableEvents
      || convertedCounts.routes !== legacyCounts.events + legacyCounts.executableEvents
      || convertedCounts.runs !== legacyCounts.runs
      || convertedCounts.outbox !== legacyCounts.outbox) {
      throw new Error(`Event/Task v12 转换计数校验失败：${JSON.stringify({ legacyCounts, convertedCounts })}`);
    }
    const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyFailures.length > 0) {
      throw new Error(`Event/Task v12 转换引用校验失败：${JSON.stringify(foreignKeyFailures.slice(0, 20))}`);
    }
    database.exec('PRAGMA user_version = 12; COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys=ON;');
  }
}
