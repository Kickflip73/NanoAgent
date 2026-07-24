import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | null | undefined>;

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Row[])
    .map((row) => String(row.name)));
}

function addColumns(
  database: DatabaseSync,
  table: string,
  definitions: readonly (readonly [name: string, definition: string])[],
): void {
  const available = tableColumns(database, table);
  for (const [column, definition] of definitions) {
    if (!available.has(column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function ensureDigestAndAttentionV2(database: DatabaseSync): void {
  database.exec(`
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

function createCompatibleIndexes(database: DatabaseSync): void {
  const legacyEventColumns = tableColumns(database, 'events');
  if (['execution_lane', 'status', 'not_before', 'priority', 'received_at']
    .every((column) => legacyEventColumns.has(column))) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS events_lane_ready_idx
      ON events(execution_lane, status, not_before, priority, received_at);
    `);
  }
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
    const available = tableColumns(database, table);
    if (columns.split(', ').every((column) => available.has(column))) {
      database.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(${columns});`);
    }
  }
}

export function prepareLegacyEventSchemaForV12(database: DatabaseSync, version: number): void {
  if (version <= 2) ensureDigestAndAttentionV2(database);
  addColumns(database, 'events', [
    ['execution_lane', "TEXT NOT NULL DEFAULT 'conversation'"],
    ['origin_session_key', 'TEXT'],
    ['parent_event_id', 'TEXT'],
    ['root_event_id', 'TEXT'],
    ['task_depth', 'INTEGER NOT NULL DEFAULT 0'],
    ['task_control', 'TEXT'],
    ['task_control_reason', 'TEXT'],
    ['completion_deferrals', 'INTEGER NOT NULL DEFAULT 0'],
    ['completion_no_progress_deferrals', 'INTEGER NOT NULL DEFAULT 0'],
    ['completion_progress_fingerprint', 'TEXT'],
    ['max_attempts', 'INTEGER'],
  ]);
  if (tableColumns(database, 'schedules').size > 0) {
    addColumns(database, 'schedules', [['authority_event_id', 'TEXT']]);
  }
  createCompatibleIndexes(database);
}
