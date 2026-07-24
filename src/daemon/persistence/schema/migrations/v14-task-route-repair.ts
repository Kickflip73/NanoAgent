import type { DatabaseSync } from 'node:sqlite';

export function repairDigestedTaskRoutesV14(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    UPDATE event_route_receipts
    SET decision = 'digest', task_ids_json = '[]', reason_code = 'legacy_digest_conversion'
    WHERE router_version = 'migration-v12'
      AND EXISTS (
        SELECT 1 FROM events lifecycle
        WHERE lifecycle.id = 'migration-task-' || event_route_receipts.event_id
          AND lifecycle.source = 'mimi:migration'
          AND lifecycle.type = 'task.digested'
          AND lifecycle.causation_event_id = event_route_receipts.event_id
      )
      AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id = event_route_receipts.event_id)
      AND NOT EXISTS (SELECT 1 FROM outbox WHERE task_id = event_route_receipts.event_id);
    DELETE FROM tasks
    WHERE idempotency_key = 'migration:event:' || id
      AND EXISTS (
        SELECT 1 FROM events lifecycle
        WHERE lifecycle.id = 'migration-task-' || tasks.id
          AND lifecycle.source = 'mimi:migration'
          AND lifecycle.type = 'task.digested'
          AND lifecycle.causation_event_id = tasks.id
      )
      AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id = tasks.id)
      AND NOT EXISTS (SELECT 1 FROM outbox WHERE task_id = tasks.id)
      AND NOT EXISTS (SELECT 1 FROM tasks child WHERE child.parent_task_id = tasks.id);
    PRAGMA user_version = 14;
    COMMIT;
  `);
}
