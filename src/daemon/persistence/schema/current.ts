import type { DatabaseSync } from 'node:sqlite';

export function createFreshV12Schema(database: DatabaseSync): void {
  database.exec(`
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
