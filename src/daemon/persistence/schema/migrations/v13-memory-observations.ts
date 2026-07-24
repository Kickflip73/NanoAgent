import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | null | undefined>;

const MEMORY_LINT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_lint_state (
    profile_id TEXT PRIMARY KEY,
    changes_since_lint INTEGER NOT NULL DEFAULT 0,
    first_changed_at TEXT,
    last_lint_at TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_lint_receipts (
    receipt_id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    page_count INTEGER NOT NULL,
    recorded_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_lint_task_receipts (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL,
    completed_at TEXT NOT NULL
  ) STRICT;
`;

export function upgradeMemoryObservationsV13(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS memory_observations (
      source_key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      run_id TEXT NOT NULL REFERENCES runs(id),
      session_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('completed', 'dead_letter')),
      trust TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      compiled_at TEXT,
      receipt_id TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS memory_observations_pending_idx
      ON memory_observations(compiled_at, profile_id, observed_at);
    CREATE INDEX IF NOT EXISTS memory_observations_task_idx
      ON memory_observations(task_id, run_id);
    ${MEMORY_LINT_SCHEMA}
    PRAGMA user_version = 13;
    COMMIT;
  `);
}

export function ensureMemoryLintSchemaV13(database: DatabaseSync): void {
  database.exec(MEMORY_LINT_SCHEMA);
}

export function hasMemoryObservationSourceKey(database: DatabaseSync): boolean {
  return (database.prepare('PRAGMA table_info(memory_observations)').all() as Row[])
    .some((row) => String(row.name) === 'source_key');
}
