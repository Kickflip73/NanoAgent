import type { DatabaseSync } from 'node:sqlite';

export function upgradeScheduleContextV17(database: DatabaseSync): void {
  const hasContext = database.prepare('PRAGMA table_info(schedules)').all()
    .some((row) => row.name === 'context_json');
  database.exec(`
    BEGIN IMMEDIATE;
    ${hasContext ? '' : 'ALTER TABLE schedules ADD COLUMN context_json TEXT;'}
    CREATE INDEX IF NOT EXISTS runs_started_at ON runs(started_at);
    PRAGMA user_version=17;
    COMMIT;
  `);
}
