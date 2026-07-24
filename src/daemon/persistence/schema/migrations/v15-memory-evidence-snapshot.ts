import type { DatabaseSync } from 'node:sqlite';
import { boundedMemoryEvidenceSnapshot } from '../../memory-evidence.js';

type Row = Record<string, string | number | null | undefined>;

export function hasMemoryEvidenceSnapshot(database: DatabaseSync): boolean {
  return (database.prepare('PRAGMA table_info(memory_observations)').all() as Row[])
    .some((row) => String(row.name) === 'evidence_snapshot_json');
}

export function upgradeMemoryEvidenceSnapshotV15(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    if (!hasMemoryEvidenceSnapshot(database)) {
      database.exec('ALTER TABLE memory_observations ADD COLUMN evidence_snapshot_json TEXT');
    }
    const rows = database.prepare(`
      SELECT observation.source_key, task.objective_json, task.result_json, task.error
      FROM memory_observations observation
      JOIN tasks task ON task.id = observation.task_id
      WHERE observation.evidence_snapshot_json IS NULL
    `).all() as Row[];
    const update = database.prepare(`
      UPDATE memory_observations SET evidence_snapshot_json = ? WHERE source_key = ?
    `);
    for (const row of rows) {
      const objective = typeof row.objective_json === 'string'
        ? JSON.parse(row.objective_json) as unknown
        : null;
      const result = typeof row.result_json === 'string'
        ? JSON.parse(row.result_json) as unknown
        : undefined;
      const error = typeof row.error === 'string' ? row.error : undefined;
      update.run(
        JSON.stringify(boundedMemoryEvidenceSnapshot(objective, result, error)),
        String(row.source_key),
      );
    }
    database.exec('PRAGMA user_version = 15; COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
