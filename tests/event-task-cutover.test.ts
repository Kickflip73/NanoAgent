import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  cutoverEventTaskV12,
  hasFinalEventTaskV12Schema,
  hasLegacyEventTaskSchema,
} from '../src/daemon/persistence/schema/migrations/v12-event-task-cutover.js';
import {
  prepareLegacyEventSchemaForV12,
} from '../src/daemon/persistence/schema/migrations/v3-v11-legacy-event-preparation.js';
import {
  analyzeHistoricalHealthDigestCompactionV16,
  needsHistoricalHealthDigestCompactionV16,
  needsTaskFailureFactsRepairV16,
  repairHistoricalHealthDigestCompactionV16,
  repairTaskFailureFactsV16,
  upgradeTaskExecutorOwnershipV16,
} from '../src/daemon/persistence/schema/migrations/v16-task-executor-ownership.js';
import { MimiStore } from '../src/daemon/store.js';
import { validTaskRoute } from '../src/daemon/task-routing.js';

function createLegacyV2(file: string): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      not_before TEXT NOT NULL,
      priority INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      status TEXT NOT NULL
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 2;
  `);
  database.close();
}

function createLegacyV11(file: string): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, external_id TEXT NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL,
      trust TEXT NOT NULL, actor_json TEXT NOT NULL, conversation_json TEXT NOT NULL,
      payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
      priority INTEGER NOT NULL, profile_id TEXT NOT NULL, session_key TEXT, reply_route_json TEXT NOT NULL,
      execution_lane TEXT NOT NULL, origin_session_key TEXT, parent_event_id TEXT, root_event_id TEXT,
      task_depth INTEGER NOT NULL, task_control TEXT, task_control_reason TEXT, status TEXT NOT NULL,
      attempts INTEGER NOT NULL, max_attempts INTEGER, completion_deferrals INTEGER NOT NULL,
      completion_no_progress_deferrals INTEGER NOT NULL, completion_progress_fingerprint TEXT,
      not_before TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, result_json TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(source, external_id)
    ) STRICT;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), session_key TEXT NOT NULL,
      status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT, answer_json TEXT, error TEXT
    ) STRICT;
    CREATE TABLE outbox (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), channel TEXT NOT NULL,
      target TEXT, payload_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
      not_before TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE leases (
      resource TEXT PRIMARY KEY, owner TEXT NOT NULL, fencing_token INTEGER NOT NULL,
      lease_until TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
      prompt TEXT NOT NULL, profile_id TEXT NOT NULL, session_key TEXT, authority_event_id TEXT,
      reply_route_json TEXT NOT NULL, trust TEXT NOT NULL, enabled INTEGER NOT NULL,
      next_run_at TEXT NOT NULL, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE digest_items (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES events(id), source TEXT NOT NULL,
      kind TEXT NOT NULL, priority INTEGER NOT NULL, payload_json TEXT NOT NULL, reason TEXT NOT NULL,
      occurred_at TEXT NOT NULL, created_at TEXT NOT NULL, digested_at TEXT,
      briefing_event_id TEXT REFERENCES events(id)
    ) STRICT;
    CREATE TABLE attention_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    INSERT INTO events VALUES (
      'legacy-root', 'legacy:root', 'local-cli', 'command', 'owner', 'null', 'null',
      '{"prompt":"delegate"}', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
      100, 'owner', 'owner-session', '{"channel":"system"}', 'conversation', NULL,
      NULL, NULL, 0, NULL, NULL, 'completed', 1, 5, 0, 0, NULL,
      '2026-07-20T00:00:00.000Z', NULL, NULL, '{"answer":"delegated"}', NULL,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:30.000Z'
    );
    INSERT INTO events VALUES (
      'legacy-task', 'legacy:task', 'mimi:background-task', 'command', 'owner', 'null', 'null',
      '{"prompt":"finish migration"}', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
      70, 'owner', 'mimi-task-legacy', '{"channel":"system"}', 'task', 'owner-session',
      'legacy-root', 'legacy-root', 1, NULL, NULL, 'completed', 1, 5, 0, 0, NULL,
      '2026-07-20T00:00:00.000Z', NULL, NULL, '{"answer":"done"}', NULL,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:01:00.000Z'
    );
    INSERT INTO events VALUES (
      'legacy-digest', 'legacy:digest', 'qq', 'command', 'trusted', 'null', 'null',
      '{"text":"ordinary group chatter"}', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z',
      10, 'owner', 'qq-group', 'null', 'conversation', NULL,
      NULL, NULL, 0, NULL, NULL, 'digested', 0, 5, 0, 0, NULL,
      '2026-07-20T00:00:00.000Z', NULL, NULL, NULL, NULL,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:30.000Z'
    );
    INSERT INTO runs VALUES (
      'legacy-run', 'legacy-task', 'mimi-task-legacy', 'completed',
      '2026-07-20T00:00:10.000Z', '2026-07-20T00:01:00.000Z', '{"answer":"done"}', NULL
    );
    INSERT INTO outbox VALUES (
      'legacy-outbox', 'legacy-task', 'system', NULL, '{"text":"done"}', 'sent', 1,
      '2026-07-20T00:01:00.000Z', NULL, NULL, NULL,
      '2026-07-20T00:01:00.000Z', '2026-07-20T00:01:01.000Z'
    );
    PRAGMA user_version = 11;
  `);
  database.close();
}

function markAsEmptyPartialV12(file: string): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE events_v2 (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      trigger_event_id TEXT REFERENCES events_v2(id),
      authority_event_id TEXT REFERENCES events_v2(id),
      attempt_count INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE task_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id)
    ) STRICT;
    CREATE TABLE event_route_receipts (
      event_id TEXT PRIMARY KEY REFERENCES events_v2(id)
    ) STRICT;
    PRAGMA user_version = 12;
  `);
  database.close();
}

function addV13PhantomDigestedTask(file: string): void {
  const database = new DatabaseSync(file);
  database.exec(`
    INSERT INTO events (
      id, external_id, source, type, trust, actor_json, conversation_json, payload_json,
      correlation_id, profile_id, reply_route_json, occurred_at, received_at, created_at
    ) VALUES (
      'phantom-digest', 'phantom-digest', 'qq', 'command.received', 'trusted', 'null', 'null',
      '{"text":"ordinary group chatter"}', 'phantom-digest', 'owner', 'null',
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z'
    );
    INSERT INTO tasks (
      id, type, idempotency_key, trigger_event_id, authority_event_id, profile_id, session_key,
      objective_json, executor, workspace_access, priority, status, not_before, attempt_count,
      max_attempts, created_at, updated_at
    ) VALUES (
      'phantom-digest', 'conversation', 'migration:event:phantom-digest', 'phantom-digest',
      'phantom-digest', 'owner', 'qq-group', '{"text":"ordinary group chatter"}',
      'session_actor', 'write', 10, 'completed', '2026-07-20T00:00:00.000Z', 0, 5,
      '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:30.000Z'
    );
    INSERT INTO events (
      id, external_id, source, type, trust, actor_json, conversation_json, payload_json,
      subject_type, subject_id, correlation_id, causation_event_id, profile_id,
      reply_route_json, occurred_at, received_at, created_at
    ) VALUES (
      'migration-task-phantom-digest', 'task:phantom-digest:migration-v12', 'mimi:migration',
      'task.digested', 'system', 'null', 'null', '{"provenance":"migration-v12"}',
      'task', 'phantom-digest', 'phantom-digest', 'phantom-digest', 'owner', 'null',
      '2026-07-20T00:00:30.000Z', '2026-07-20T00:00:30.000Z', '2026-07-20T00:00:30.000Z'
    );
    INSERT INTO event_route_receipts VALUES (
      'phantom-digest', 'migration-v12', 'task_created', '["phantom-digest"]',
      'legacy_event_conversion', '2026-07-20T00:00:30.000Z'
    );
    INSERT INTO event_route_receipts VALUES (
      'migration-task-phantom-digest', 'migration-v12', 'observe_only', '[]',
      'task_lifecycle', '2026-07-20T00:00:30.000Z'
    );
    PRAGMA user_version = 13;
  `);
  database.close();
}

function addV13ProtectedDigestedTask(file: string): void {
  const database = new DatabaseSync(file);
  database.exec(`
    INSERT INTO events
    SELECT 'protected-digest', 'protected-digest', source, type, trust, actor_json,
      conversation_json, payload_json, subject_type, subject_id, 'protected-digest',
      causation_event_id, profile_id, reply_route_json, occurred_at, received_at, created_at
    FROM events WHERE id = 'phantom-digest';
    INSERT INTO tasks
    SELECT 'protected-digest', type, 'migration:event:protected-digest', 'protected-digest',
      'protected-digest', parent_task_id, profile_id, session_key, objective_json, executor,
      workspace_access, priority, status, not_before, attempt_count, max_attempts, lease_owner,
      lease_until, control_intent, control_reason, result_json, error, created_at, updated_at
    FROM tasks WHERE id = 'phantom-digest';
    INSERT INTO events
    SELECT 'migration-task-protected-digest', 'task:protected-digest:migration-v12', source,
      type, trust, actor_json, conversation_json, payload_json, subject_type, 'protected-digest',
      'protected-digest', 'protected-digest', profile_id, reply_route_json, occurred_at,
      received_at, created_at
    FROM events WHERE id = 'migration-task-phantom-digest';
    INSERT INTO event_route_receipts VALUES (
      'protected-digest', 'migration-v12', 'task_created', '["protected-digest"]',
      'legacy_event_conversion', '2026-07-20T00:00:30.000Z'
    );
    INSERT INTO event_route_receipts VALUES (
      'migration-task-protected-digest', 'migration-v12', 'observe_only', '[]',
      'task_lifecycle', '2026-07-20T00:00:30.000Z'
    );
    INSERT INTO outbox (
      id, task_id, channel, payload_json, status, attempts, not_before, created_at, updated_at
    ) VALUES (
      'protected-delivery', 'protected-digest', 'system', '{"text":"already delivered"}',
      'sent', 1, '2026-07-20T00:00:30.000Z', '2026-07-20T00:00:30.000Z',
      '2026-07-20T00:00:30.000Z'
    );
  `);
  database.close();
}

test('legacy v2 schema preparation is idempotent and produces the complete v11 cutover shape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v2-preparation-'));
  const file = path.join(root, 'mimi.db');
  createLegacyV2(file);
  const database = new DatabaseSync(file);
  try {
    prepareLegacyEventSchemaForV12(database, 2);
    const indexesAfterFirstRun = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all();
    prepareLegacyEventSchemaForV12(database, 2);

    const eventColumns = new Set(
      (database.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    assert.deepEqual(
      [
        'execution_lane',
        'origin_session_key',
        'parent_event_id',
        'root_event_id',
        'task_depth',
        'task_control',
        'task_control_reason',
        'completion_deferrals',
        'completion_no_progress_deferrals',
        'completion_progress_fingerprint',
        'max_attempts',
      ].filter((column) => !eventColumns.has(column)),
      [],
    );
    const scheduleColumns = new Set(
      (database.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    );
    assert.equal(scheduleColumns.has('authority_event_id'), true);
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='digest_items'").get());
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attention_state'").get());
    assert.deepEqual(database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name
    `).all(), indexesAfterFirstRun);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  } finally {
    database.close();
  }
});

test('v12 migration pre/post checks and rollback preserve the legacy database atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v12-direct-'));
  const file = path.join(root, 'mimi.db');
  createLegacyV11(file);
  const database = new DatabaseSync(file);
  try {
    assert.equal(hasLegacyEventTaskSchema(database), true);
    assert.equal(hasFinalEventTaskV12Schema(database), false);
    assert.throws(
      () => cutoverEventTaskV12(database, {
        backfillScheduleAuthorities: () => {
          throw new Error('injected backfill failure');
        },
      }),
      /injected backfill failure/,
    );
    assert.equal(hasLegacyEventTaskSchema(database), true);
    assert.equal(hasFinalEventTaskV12Schema(database), false);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'tasks'").get(), undefined);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11);
    assert.equal((database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);

    cutoverEventTaskV12(database, { backfillScheduleAuthorities: () => undefined });
    assert.equal(hasLegacyEventTaskSchema(database), false);
    assert.equal(hasFinalEventTaskV12Schema(database), true);
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 2);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number }).count, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM outbox').get() as { count: number }).count, 1);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('ingress records an immutable Event and routes one executable Task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-ingress-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    const at = new Date().toISOString();
    const accepted = store.ingestEvent({
      id: 'message-1', externalId: 'connector:message-1', source: 'connector:test', kind: 'command',
      trust: 'owner', payload: { prompt: 'reply' }, occurredAt: at, receivedAt: at,
      priority: 100, profileId: 'owner', replyRoute: { channel: 'connector:test', target: 'owner' },
    });
    assert.equal(accepted.event.type, 'command.received');
    assert.equal(accepted.task?.triggerEventId, accepted.event.id);
    assert.equal(accepted.task?.authorityEventId, accepted.event.id);
    assert.deepEqual(store.getEventRouteReceipt(accepted.event.id)?.taskIds, [accepted.task?.id]);
    const lifecycle = store.listEventSummaries().find((event) =>
      event.type === 'task.created' && event.subjectId === accepted.task?.id);
    assert.equal(store.getEventRouteReceipt(lifecycle!.id)?.decision, 'observe_only');

    const database = new DatabaseSync(file);
    try {
      const columns = new Set((database.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
        .map((column) => column.name));
      for (const removed of ['status', 'attempts', 'lease_owner', 'execution_lane', 'result_json']) {
        assert.equal(columns.has(removed), false);
      }
      assert.throws(
        () => database.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run('{}', accepted.event.id),
        /immutable event cannot be updated/,
      );
    } finally {
      database.close();
    }
  } finally {
    store.close();
  }
});

test('retention removes routed observe-only Events with their receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-prune-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const appended = store.appendEvent({
      id: 'observation-1', externalId: 'observation-1', source: 'test', type: 'observed',
      trust: 'system', payload: {}, profileId: 'owner',
      occurredAt: '2026-07-20T00:00:00.000Z', receivedAt: '2026-07-20T00:00:00.000Z',
    });
    store.routeEvent(appended.event.id, {
      routerVersion: 'test', decision: 'observe_only', reasonCode: 'test_observation',
    });
    const cutoff = new Date(Date.parse(appended.event.createdAt) + 1);
    assert.equal(store.pruneHistory(cutoff).events, 1);
    assert.equal(store.getImmutableEvent(appended.event.id), undefined);
    assert.equal(store.getEventRouteReceipt(appended.event.id), undefined);
  } finally {
    store.close();
  }
});

test('retention preserves Events referenced by active Tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-prune-active-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const accepted = store.ingestEvent({
      id: 'active-event', externalId: 'active-event', source: 'test', kind: 'command',
      trust: 'owner', payload: { prompt: 'still active' }, profileId: 'owner',
      occurredAt: '2026-07-20T00:00:00.000Z', receivedAt: '2026-07-20T00:00:00.000Z',
      priority: 100,
    });
    const cutoff = new Date(Date.parse(accepted.event.createdAt) + 1);
    assert.ok(accepted.task);
    assert.equal(store.pruneHistory(cutoff).tasks, 0);
    assert.equal(store.getImmutableEvent(accepted.event.id)?.id, accepted.event.id);
    assert.deepEqual(store.getEventRouteReceipt(accepted.event.id)?.taskIds, [accepted.task.id]);
  } finally {
    store.close();
  }
});

test('ingress deduplicates connector redelivery and applies Attention before creating a Task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-route-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.setIngressRoutePolicy((event) => event.priority < 50
      ? { decision: 'digest', reasonCode: 'test_low_priority' }
      : { decision: 'task_created', reasonCode: 'test_immediate' });
    const first = store.ingestEvent({
      id: 'delivery-1', externalId: 'upstream-1', source: 'connector:test', kind: 'webhook',
      trust: 'external', payload: { prompt: 'low priority update' },
      occurredAt: '2026-07-20T00:00:00.000Z', receivedAt: '2026-07-20T00:00:01.000Z',
      priority: 10, profileId: 'owner',
    });
    const redelivery = store.ingestEvent({
      id: 'delivery-2', externalId: 'upstream-1', source: 'connector:test', kind: 'webhook',
      trust: 'external', payload: { prompt: 'low priority update' },
      occurredAt: '2026-07-20T00:00:00.000Z', receivedAt: '2026-07-20T00:00:05.000Z',
      priority: 10, profileId: 'owner',
    });
    assert.equal(first.inserted, true);
    assert.equal(redelivery.inserted, false);
    assert.equal(redelivery.event.id, first.event.id);
    assert.equal(first.task, undefined);
    assert.equal(store.getEventRouteReceipt(first.event.id)?.decision, 'digest');
    assert.equal(store.listTasks().length, 0);
    assert.equal(store.pendingDigestCount(), 1);
  } finally {
    store.close();
  }
});

test('Task session ownership binds explicit session keys to non-owner profiles', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-profile-session-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const route = (profileId: string) => store.ingestEvent({
      id: `event-${profileId}`, externalId: `event-${profileId}`, source: 'connector:test', kind: 'command',
      trust: 'trusted', payload: { prompt: 'same upstream conversation' }, profileId, sessionKey: 'shared-key',
      occurredAt: '2026-07-20T00:00:00.000Z', receivedAt: '2026-07-20T00:00:00.000Z', priority: 50,
    }).task!;
    const first = route('profile-a');
    const second = route('profile-b');
    assert.notEqual(first.sessionKey, second.sessionKey);
    assert.notEqual(first.sessionKey, 'shared-key');
    assert.notEqual(second.sessionKey, 'shared-key');
  } finally {
    store.close();
  }
});

test('v11 cutover atomically preserves Task, Run and Outbox ownership without parallel tables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v11-'));
  const file = path.join(root, 'mimi.db');
  createLegacyV11(file);
  const store = new MimiStore(file);
  try {
    assert.equal(store.getImmutableEvent('legacy-task')?.type, 'task.migrated');
    assert.equal(store.getTask('legacy-task')?.status, 'completed');
    assert.equal(store.getTask('legacy-task')?.parentTaskId, 'legacy-root');
    assert.equal(store.runs.get('legacy-run')?.taskId, 'legacy-task');
    assert.equal(store.outbox.get('legacy-outbox')?.taskId, 'legacy-task');
    assert.equal(store.getEventRouteReceipt('legacy-task')?.decision, 'task_created');
    assert.equal(store.getEventRouteReceipt('migration-task-legacy-task')?.decision, 'observe_only');
    assert.equal(store.getTask('legacy-digest'), undefined);
    assert.equal(store.getEventRouteReceipt('legacy-digest')?.decision, 'digest');
    assert.equal(store.getEventRouteReceipt('legacy-digest')?.taskIds.length, 0);
    assert.equal(store.getImmutableEvent('migration-task-legacy-digest'), undefined);
    const backups = await readdir(path.join(root, 'backups'), { recursive: true });
    assert.equal(backups.some((entry) => entry.endsWith('mimi.db')), true);
  } finally {
    store.close();
  }
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'events_v2'").get(), undefined);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'task_attempts'").get(), undefined);
    assert.equal((database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);
  } finally {
    database.close();
  }
});

test('v14 removes only artifact-free digested Tasks and repairs their route receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v14-repair-'));
  const file = path.join(root, 'mimi.db');
  new MimiStore(file).close();
  addV13PhantomDigestedTask(file);
  addV13ProtectedDigestedTask(file);

  const store = new MimiStore(file);
  try {
    assert.equal(store.getTask('phantom-digest'), undefined);
    assert.deepEqual(store.getEventRouteReceipt('phantom-digest'), {
      eventId: 'phantom-digest',
      routerVersion: 'migration-v12',
      decision: 'digest',
      taskIds: [],
      reasonCode: 'legacy_digest_conversion',
      routedAt: '2026-07-20T00:00:30.000Z',
    });
    assert.equal(store.getImmutableEvent('phantom-digest')?.type, 'command.received');
    assert.equal(store.getImmutableEvent('migration-task-phantom-digest')?.type, 'task.digested');
    assert.equal(store.getTask('protected-digest')?.status, 'completed');
    assert.equal(store.getEventRouteReceipt('protected-digest')?.decision, 'task_created');
    assert.equal(store.outbox.get('protected-delivery')?.status, 'sent');
  } finally {
    store.close();
  }

  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17);
    assert.equal((database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);
  } finally {
    database.close();
  }
  const backups = await readdir(path.join(root, 'backups'), { recursive: true });
  assert.equal(backups.some((entry) => entry.endsWith('mimi.db')), true);
});

test('v16 migrates only the known queued Briefing route and records unresolved combinations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v16-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  const at = '2026-07-20T00:00:00.000Z';
  try {
    const authority = store.appendEvent({
      id: 'briefing-authority', externalId: 'briefing-authority', source: 'attention:briefing',
      type: 'alert.received', trust: 'external', payload: {}, profileId: 'owner',
      occurredAt: at, receivedAt: at,
    }).event;
    store.enqueueTask({
      id: 'legacy-briefing', type: 'background', idempotencyKey: 'legacy-briefing',
      authorityEventId: authority.id, profileId: 'owner', sessionKey: 'mimi-briefing', objective: {},
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 85,
    });
    store.enqueueTask({
      id: 'unresolved-briefing', type: 'background', idempotencyKey: 'unresolved-briefing',
      authorityEventId: authority.id, profileId: 'owner', sessionKey: 'mimi-briefing-unknown', objective: {},
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 84,
    });
    store.enqueueTask({
      id: 'unknown-historical-type', type: 'background', idempotencyKey: 'unknown-historical-type',
      authorityEventId: authority.id, profileId: 'owner', sessionKey: 'mimi-unknown-type', objective: {},
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 83,
    });
    store.setIngressRoutePolicy(() => ({ decision: 'digest', reasonCode: 'health_fixture' }));
    for (const [index, status] of ['offline', 'offline', 'recovered'].entries()) {
      const timestamp = new Date(Date.parse(at) + index * 1_000).toISOString();
      store.ingestEvent({
        id: `health-${index}`,
        externalId: `health-${index}`,
        source: 'system:connector-health',
        kind: 'ambient',
        trust: 'system',
        payload: { connectorHealth: { connectorId: 'fixture', status } },
        occurredAt: timestamp,
        receivedAt: timestamp,
        priority: 10,
        profileId: 'owner',
      });
    }
    assert.equal(store.pendingDigestCount(), 3);
  } finally {
    store.close();
  }
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    UPDATE tasks SET type = 'briefing', executor = 'session_actor', workspace_access = 'write'
      WHERE id = 'legacy-briefing';
    UPDATE tasks SET type = 'briefing', executor = 'codex', workspace_access = 'write'
      , status = 'dead_letter', error = 'legacy error text', result_json = NULL
      WHERE id = 'unresolved-briefing';
    UPDATE tasks SET type = 'retired_worker_kind', status = 'failed',
      error = 'different legacy explanation', result_json = NULL
      WHERE id = 'unknown-historical-type';
    PRAGMA user_version = 15;
  `);
  legacy.close();

  const migrated = new MimiStore(file);
  try {
    assert.equal(migrated.getTask('legacy-briefing')?.executor, 'isolated_worker');
    assert.equal(migrated.getTask('legacy-briefing')?.workspaceAccess, 'read');
    assert.equal(migrated.getTask('unresolved-briefing')?.executor, 'codex');
    assert.equal(migrated.getTask('unresolved-briefing')?.workspaceAccess, 'write');
    assert.equal(migrated.getTask('unresolved-briefing')?.status, 'failed');
    assert.equal(migrated.getTask('unknown-historical-type')?.type, 'retired_worker_kind');
    assert.deepEqual(migrated.getTask('unresolved-briefing')?.failure, {
      code: 'historical.briefing.codex.retained_dead_letter',
      disposition: {
        phase: 'runtime', kind: 'unclassified', retryable: false, dispatchStarted: false,
      },
    });
    assert.equal(
      migrated.getTask('unknown-historical-type')?.failure?.code,
      'historical.retired_worker_kind.isolated_worker.retained_failed',
    );
    assert.equal(migrated.activitySnapshot(20).failureClassification.unclassifiedDeadLetters, 0);
    assert.deepEqual(migrated.activitySnapshot(20).failureClassification.deadLetters, []);
    assert.equal(migrated.pendingDigestCount(), 2);
    assert.equal(
      migrated.listEventSummaries(200)
        .filter((event) => event.source === 'system:connector-health').length,
      3,
    );
    assert.equal(
      migrated.activitySnapshot(20).recentTransitions.some((item) => (
        item.type === 'migration.task_executor_v16' && item.entityId === 'schema:v16'
      )),
      true,
    );
  } finally {
    migrated.close();
  }
  const verified = new DatabaseSync(file, { readOnly: true });
  assert.equal((verified.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 17);
  assert.equal(
    (verified.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
    'ok',
  );
  assert.equal(verified.prepare('PRAGMA foreign_key_check').all().length, 0);
  const audit = verified.prepare(`
    SELECT data_json FROM audit_events WHERE event_type = 'migration.task_executor_v16'
  `).get() as { data_json: string };
  const auditData = JSON.parse(audit.data_json) as {
    after: {
      unresolvedHistoricalCombinations: number;
      collapsedHealthDigestItems: number;
      historicalTerminalTasks: number;
      backfilledFailureRecords: number;
      reclassifiedHistoricalDeadLetters: number;
    };
  };
  assert.equal(auditData.after.unresolvedHistoricalCombinations, 2);
  assert.equal(auditData.after.collapsedHealthDigestItems, 1);
  assert.equal(auditData.after.historicalTerminalTasks, 2);
  assert.equal(auditData.after.backfilledFailureRecords, 2);
  assert.equal(auditData.after.reclassifiedHistoricalDeadLetters, 1);
  verified.close();
  const backups = await readdir(path.join(root, 'backups'), { recursive: true });
  assert.equal(backups.some((entry) => entry.includes('task-executor-v16-')), true);
  assert.equal(backups.some((entry) => entry.endsWith('mimi.db')), true);
});

test('v16 executor migration rolls back every projection when integrity fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v16-rollback-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    const authority = store.appendEvent({
      id: 'rollback-authority', externalId: 'rollback-authority', source: 'fixture',
      type: 'alert.received', trust: 'system', payload: {}, profileId: 'owner',
      occurredAt: '2026-08-02T00:00:00.000Z', receivedAt: '2026-08-02T00:00:00.000Z',
    }).event;
    store.enqueueTask({
      id: 'rollback-briefing', type: 'background', idempotencyKey: 'rollback-briefing',
      authorityEventId: authority.id, profileId: 'owner', objective: {},
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 50,
    });
  } finally {
    store.close();
  }
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    UPDATE tasks SET type='briefing', executor='session_actor', workspace_access='write',
      authority_event_id='missing-event' WHERE id='rollback-briefing';
    DROP INDEX tasks_executor_ready_idx;
    PRAGMA user_version = 15;
  `);
  assert.throws(() => upgradeTaskExecutorOwnershipV16(database, validTaskRoute), /完整性检查失败/);
  const task = database.prepare(`
    SELECT executor, workspace_access FROM tasks WHERE id='rollback-briefing'
  `).get() as { executor: string; workspace_access: string };
  assert.deepEqual({ ...task }, { executor: 'session_actor', workspace_access: 'write' });
  assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 15);
  assert.equal(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='tasks_executor_ready_idx'").get(),
    undefined,
  );
  assert.equal(
    database.prepare("SELECT 1 FROM audit_events WHERE event_type='migration.task_executor_v16'").get(),
    undefined,
  );
  database.close();
});

test('existing v16 databases backfill failure facts once with backup and audit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v16-failure-facts-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    const authority = store.appendEvent({
      id: 'v16-failure-authority', externalId: 'v16-failure-authority', source: 'fixture',
      type: 'alert.received', trust: 'system', payload: {}, profileId: 'owner',
      occurredAt: '2026-08-02T00:00:00.000Z', receivedAt: '2026-08-02T00:00:00.000Z',
    }).event;
    store.enqueueTask({
      id: 'v16-legacy-dead', type: 'background', idempotencyKey: 'v16-legacy-dead',
      authorityEventId: authority.id, profileId: 'owner', objective: {},
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 50,
    });
    store.enqueueTask({
      id: 'v16-actionable-dead', type: 'background', idempotencyKey: 'v16-actionable-dead',
      authorityEventId: authority.id, profileId: 'owner', objective: {},
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 50,
    });
  } finally {
    store.close();
  }
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA user_version=16;
    UPDATE tasks SET status='dead_letter', error='historical explanation', result_json=NULL
      WHERE id='v16-legacy-dead';
  `);
  legacy.prepare(`
    UPDATE tasks SET status='dead_letter', error='retryable failure', result_json=?
      WHERE id='v16-actionable-dead'
  `).run(JSON.stringify({
    failure: {
      code: 'provider.http_503',
      disposition: { phase: 'provider', kind: 'transient', retryable: true, dispatchStarted: false },
    },
  }));
  assert.equal(needsTaskFailureFactsRepairV16(legacy), true);
  legacy.close();

  const repaired = new MimiStore(file);
  try {
    assert.equal(
      repaired.getTask('v16-legacy-dead')?.failure?.code,
      'historical.background.isolated_worker.retained_dead_letter',
    );
    assert.equal(repaired.getTask('v16-legacy-dead')?.status, 'failed');
    assert.equal(repaired.getTask('v16-actionable-dead')?.status, 'dead_letter');
    assert.equal(repaired.activitySnapshot(10).failureClassification.unclassifiedDeadLetters, 0);
  } finally {
    repaired.close();
  }
  const verified = new DatabaseSync(file, { readOnly: true });
  assert.equal(needsTaskFailureFactsRepairV16(verified), false);
  assert.equal(Number((verified.prepare(`
    SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type='migration.task_failure_facts_v16'
  `).get() as { count: number }).count), 1);
  verified.close();
  const firstBackups = await readdir(path.join(root, 'backups'));
  assert.equal(firstBackups.filter((entry) => entry.startsWith('task-failure-facts-v16-')).length, 1);

  new MimiStore(file).close();
  const secondBackups = await readdir(path.join(root, 'backups'));
  assert.equal(secondBackups.filter((entry) => entry.startsWith('task-failure-facts-v16-')).length, 1);
});

test('v16 failure facts repair rolls back when integrity fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v16-failure-rollback-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    const authority = store.appendEvent({
      id: 'failure-rollback-authority', externalId: 'failure-rollback-authority', source: 'fixture',
      type: 'alert.received', trust: 'system', payload: {}, profileId: 'owner',
      occurredAt: '2026-08-02T00:00:00.000Z', receivedAt: '2026-08-02T00:00:00.000Z',
    }).event;
    store.enqueueTask({
      id: 'failure-rollback-task', type: 'background', idempotencyKey: 'failure-rollback-task',
      authorityEventId: authority.id, profileId: 'owner', objective: {},
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 50,
    });
  } finally {
    store.close();
  }
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA foreign_keys=OFF;
    UPDATE tasks SET status='dead_letter', result_json=NULL, authority_event_id='missing-event'
      WHERE id='failure-rollback-task';
  `);
  assert.throws(() => repairTaskFailureFactsV16(database), /完整性检查失败/);
  const task = database.prepare(`
    SELECT result_json FROM tasks WHERE id='failure-rollback-task'
  `).get() as { result_json: string | null };
  assert.equal(
    task.result_json,
    null,
  );
  assert.equal(database.prepare(`
    SELECT 1 FROM audit_events WHERE event_type='migration.task_failure_facts_v16'
  `).get(), undefined);
  database.close();
});

test('existing v16 databases compact historical health Digests once with backup and audit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v16-health-digest-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  const at = '2026-08-03T00:00:00.000Z';
  try {
    store.setIngressRoutePolicy(() => ({ decision: 'digest', reasonCode: 'health_fixture' }));
    const fixtures = [
      { connectorId: 'fixture', status: 'offline' },
      { connectorId: 'fixture', status: 'unavailable' },
      { connectorId: 'fixture', status: 'offline' },
      { connectorId: 'fixture', status: 'recovered' },
      { connectorId: 'fixture', status: 'recovered' },
      { connectorId: 'other', status: 'stale' },
      { connectorId: 'fixture', status: 'healthy' },
    ];
    for (const [index, connectorHealth] of fixtures.entries()) {
      const timestamp = new Date(Date.parse(at) + index * 1_000).toISOString();
      store.ingestEvent({
        id: `historical-health-${index}`,
        externalId: `historical-health-${index}`,
        source: 'system:connector-health',
        kind: 'ambient',
        trust: 'system',
        payload: { connectorHealth },
        occurredAt: timestamp,
        receivedAt: timestamp,
        priority: 10,
        profileId: 'owner',
      });
    }
    assert.equal(store.pendingDigestCount(), 7);
  } finally {
    store.close();
  }

  const legacyVersion = new DatabaseSync(file);
  legacyVersion.exec('PRAGMA user_version=16;');
  legacyVersion.close();
  const dryRun = new DatabaseSync(file, { readOnly: true });
  assert.deepEqual(analyzeHistoricalHealthDigestCompactionV16(dryRun), {
    pendingHealthDigestItems: 7,
    retainedHealthGroups: 3,
    collapsibleHealthDigestItems: 3,
    unclassifiedHealthDigestItems: 1,
  });
  assert.equal(needsHistoricalHealthDigestCompactionV16(dryRun), true);
  dryRun.close();

  const repaired = new MimiStore(file);
  try {
    assert.equal(repaired.pendingDigestCount(), 4);
    assert.equal(
      repaired.listEventSummaries(100)
        .filter((event) => event.source === 'system:connector-health').length,
      7,
    );
  } finally {
    repaired.close();
  }

  const verified = new DatabaseSync(file, { readOnly: true });
  assert.equal(needsHistoricalHealthDigestCompactionV16(verified), false);
  assert.deepEqual(
    (verified.prepare(`
      SELECT events.id FROM digest_items JOIN events ON events.id=digest_items.event_id
      WHERE digest_items.digested_at IS NULL AND events.source='system:connector-health'
      ORDER BY events.id
    `).all() as Array<{ id: string }>).map((row) => row.id),
    ['historical-health-2', 'historical-health-4', 'historical-health-5', 'historical-health-6'],
  );
  assert.equal(Number((verified.prepare(`
    SELECT COUNT(*) AS count FROM audit_events
    WHERE event_type='migration.health_digest_compaction_v16'
  `).get() as { count: number }).count), 1);
  const audit = verified.prepare(`
    SELECT data_json FROM audit_events
    WHERE event_type='migration.health_digest_compaction_v16'
  `).get() as { data_json: string };
  assert.deepEqual(JSON.parse(audit.data_json), {
    before: {
      pendingHealthDigestItems: 7,
      retainedHealthGroups: 3,
      collapsibleHealthDigestItems: 3,
      unclassifiedHealthDigestItems: 1,
    },
    after: {
      pendingHealthDigestItems: 4,
      collapsedHealthDigestItems: 3,
    },
    integrity: 'ok',
    foreignKeyViolations: 0,
  });
  verified.close();

  const firstBackups = await readdir(path.join(root, 'backups'));
  assert.equal(firstBackups.filter((entry) => entry.startsWith('health-digest-compaction-v16-')).length, 1);
  new MimiStore(file).close();
  const secondBackups = await readdir(path.join(root, 'backups'));
  assert.equal(secondBackups.filter((entry) => entry.startsWith('health-digest-compaction-v16-')).length, 1);
});

test('v16 historical health Digest compaction rolls back when integrity fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-v16-health-rollback-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    store.setIngressRoutePolicy(() => ({ decision: 'digest', reasonCode: 'health_fixture' }));
    for (const index of [0, 1]) {
      const timestamp = `2026-08-03T00:00:0${index}.000Z`;
      store.ingestEvent({
        id: `rollback-health-${index}`,
        externalId: `rollback-health-${index}`,
        source: 'system:connector-health',
        kind: 'ambient',
        trust: 'system',
        payload: { connectorHealth: { connectorId: 'fixture', status: 'offline' } },
        occurredAt: timestamp,
        receivedAt: timestamp,
        priority: 10,
        profileId: 'owner',
      });
    }
  } finally {
    store.close();
  }

  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA foreign_keys=OFF;
    INSERT INTO event_route_receipts (
      event_id, router_version, decision, task_ids_json, reason_code, routed_at
    ) VALUES ('missing-event', 'fixture', 'observe_only', '[]', 'fixture',
      '2026-08-03T00:00:00.000Z');
  `);
  assert.equal(needsHistoricalHealthDigestCompactionV16(database), true);
  assert.throws(
    () => repairHistoricalHealthDigestCompactionV16(database),
    /完整性检查失败/,
  );
  assert.equal(Number((database.prepare(`
    SELECT COUNT(*) AS count FROM digest_items WHERE digested_at IS NOT NULL
  `).get() as { count: number }).count), 0);
  assert.equal(database.prepare(`
    SELECT 1 FROM audit_events WHERE event_type='migration.health_digest_compaction_v16'
  `).get(), undefined);
  database.close();
});

test('repairs an empty half-migrated v12 database before accepting new Events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-partial-v12-'));
  const file = path.join(root, 'mimi.db');
  createLegacyV11(file);
  markAsEmptyPartialV12(file);

  const store = new MimiStore(file);
  try {
    assert.equal(store.getImmutableEvent('legacy-task')?.type, 'task.migrated');
    assert.equal(store.getTask('legacy-task')?.status, 'completed');
    assert.equal(store.runs.get('legacy-run')?.taskId, 'legacy-task');
    assert.equal(store.outbox.get('legacy-outbox')?.taskId, 'legacy-task');
  } finally {
    store.close();
  }

  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const eventColumns = new Set((database.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
      .map((column) => column.name));
    assert.equal(eventColumns.has('type'), true);
    assert.equal(eventColumns.has('status'), false);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'events_v2'").get(), undefined);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'task_attempts'").get(), undefined);
    assert.equal((database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);
  } finally {
    database.close();
  }
});

test('refuses to overwrite non-empty half-migrated v12 tables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-partial-v12-data-'));
  const file = path.join(root, 'mimi.db');
  createLegacyV11(file);
  markAsEmptyPartialV12(file);
  const database = new DatabaseSync(file);
  database.prepare('INSERT INTO events_v2 (id) VALUES (?)').run('unreviewed-partial-event');
  database.close();

  assert.throws(
    () => new MimiStore(file),
    /半迁移表 events_v2 含 1 行，拒绝自动覆盖/,
  );
});

test('rejects a future database version without modifying the file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-task-future-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  store.close();
  const database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=18;');
  database.close();
  const before = await readFile(file);

  assert.throws(() => new MimiStore(file), /不支持的 MimiAgent 数据库版本：18/);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(root), ['mimi.db']);
});
