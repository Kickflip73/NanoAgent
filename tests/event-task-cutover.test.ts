import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
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
import { MimiStore } from '../src/daemon/store.js';

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
    const lifecycle = store.listImmutableEvents().find((event) =>
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
    assert.equal(store.getRun('legacy-run')?.taskId, 'legacy-task');
    assert.equal(store.getOutbox('legacy-outbox')?.taskId, 'legacy-task');
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
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
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
    assert.equal(store.getOutbox('protected-delivery')?.status, 'sent');
  } finally {
    store.close();
  }

  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 14);
    assert.equal((database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length, 0);
  } finally {
    database.close();
  }
  const backups = await readdir(path.join(root, 'backups'), { recursive: true });
  assert.equal(backups.some((entry) => entry.endsWith('mimi.db')), true);
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
    assert.equal(store.getRun('legacy-run')?.taskId, 'legacy-task');
    assert.equal(store.getOutbox('legacy-outbox')?.taskId, 'legacy-task');
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
