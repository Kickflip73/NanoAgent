import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { createMemoryMaintenanceTools } from '../src/daemon/memory-maintenance-tools.js';
import { decideEvent } from '../src/daemon/policy.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventTrust } from '../src/daemon/types.js';

function addTask(store: MimiStore, id: string, at: Date, trust: EventTrust = 'owner'): void {
  const event = store.appendEvent({
    id: `event-${id}`, externalId: `event-${id}`, source: 'test', type: 'command.received',
    trust, payload: { prompt: `objective ${id}` }, profileId: 'owner',
    occurredAt: at.toISOString(), receivedAt: at.toISOString(),
  }).event;
  store.routeEvent(event.id, {
    routerVersion: 'test', decision: 'task_created', reasonCode: 'test', tasks: [{
      id, type: 'conversation', idempotencyKey: id, triggerEventId: event.id,
      authorityEventId: event.id, profileId: 'owner', sessionKey: `session-${id}`,
      objective: { prompt: `objective ${id}` }, executor: 'session_actor', workspaceAccess: 'write',
      priority: 50,
    }],
  });
  const owner = `worker-${id}`;
  const executionAt = new Date(at.getTime() + 1_000);
  store.claimTaskById(id, owner, 60_000, executionAt);
  const attempt = store.beginTaskAttempt(id, owner, `session-${id}`, owner, executionAt);
  store.completeTask(id, owner, { answer: `durable result ${id}` }, attempt.id, executionAt);
}

test('terminal Tasks atomically register observations and emit one bounded maintenance Task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-maintenance-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const at = new Date();
    for (let index = 0; index < 10; index += 1) addTask(store, `task-${index}`, at);
    const observations = store.listMemoryObservations('owner');
    assert.equal(observations.length, 10);
    assert.equal(observations[0]?.sourceRef.type, 'mimi-event');
    assert.deepEqual(observations[0]?.result, { answer: 'durable result task-0' });

    const emitted = store.emitDueMemoryMaintenanceTasks(at);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.type, 'memory_maintenance');
    assert.equal(emitted[0]?.priority, 0);
    assert.equal(emitted[0]?.workspaceAccess, 'read');
    assert.deepEqual(store.emitDueMemoryMaintenanceTasks(at), []);
    assert.equal(store.getImmutableEvent(emitted[0]!.triggerEventId!)?.trust, 'system');
    const decision = decideEvent({
      id: 'maintenance-authority', externalId: 'maintenance-authority', source: 'mimi:memory-maintenance',
      kind: 'command', trust: 'system', payload: { type: 'memory_maintenance' }, profileId: 'owner',
      occurredAt: at.toISOString(), receivedAt: at.toISOString(), priority: 0,
    }, [], undefined, undefined, false, emitted[0]);
    assert.deepEqual(decision.options?.policy?.allowedTools, [
      'memory_search', 'memory_read', 'memory_links',
      'list_memory_observations', 'upsert_memory_page', 'complete_memory_observations',
    ]);
    assert.equal(decision.options?.policy?.allowMcp, false);
    assert.equal(decision.options?.policy?.allowSessionContext, false);

    const tools = createMemoryMaintenanceTools(store, emitted[0]!, {
      capture: async (input, profileId) => ({
        id: `receipt-${profileId}`, operation: 'capture', status: 'applied', digest: 'digest',
        pageRefs: [{ scope: 'private', profileId, id: input.title }],
      }),
      reject: async (_sources, _reason, profileId) => ({
        id: `rejected-${profileId}`, operation: 'capture', status: 'rejected', digest: 'digest', pageRefs: [],
      }),
      lint: async () => ({ valid: true, checked: 0, issues: [] }),
    });
    const invoke = (name: string, input: unknown) => tools.find((tool) => tool.name === name)!
      .invoke(new RunContext({}), JSON.stringify(input));
    const listed = await invoke('list_memory_observations', { limit: 20 }) as unknown as {
      observations: Array<{ sourceKey: string }>; deterministicLint: { valid: boolean };
    };
    assert.equal(listed.deterministicLint.valid, true);
    const sourceKeys = listed.observations.map((item) => item.sourceKey);
    await invoke('upsert_memory_page', {
      sourceKeys, action: 'upsert', title: 'Stable lesson', content: 'Reuse this verified result.',
      kind: 'lesson', status: 'active', reasonCode: 'repeated_success',
    });
    assert.equal(await invoke('complete_memory_observations', { sourceKeys }) as unknown, 10);
    assert.equal(store.memoryObservationStatus('owner').pending, 0);
  } finally {
    store.close();
  }
});

test('maintenance cannot promote one untrusted observation to active memory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-trust-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const at = new Date();
    addTask(store, 'external-one', at, 'external');
    const maintenance = store.emitDueMemoryMaintenanceTasks(at, 'owner')[0]!;
    let captures = 0;
    const tools = createMemoryMaintenanceTools(store, maintenance, {
      capture: async (input, profileId) => {
        captures += 1;
        return {
          id: `receipt-${profileId}-${captures}`, operation: 'capture', status: 'applied', digest: 'digest',
          pageRefs: [{ scope: 'private', profileId, id: input.title }],
        };
      },
      reject: async (_sources, _reason, profileId) => ({
        id: `rejected-${profileId}`, operation: 'capture', status: 'rejected', digest: 'digest', pageRefs: [],
      }),
      lint: async () => ({ valid: true, checked: 0, issues: [] }),
    });
    const invoke = (name: string, input: unknown) => tools.find((tool) => tool.name === name)!
      .invoke(new RunContext({}), JSON.stringify(input));
    const listed = await invoke('list_memory_observations', { limit: 20 }) as unknown as {
      observations: Array<{ sourceKey: string }>;
    };
    const denied = await invoke('upsert_memory_page', {
      sourceKeys: [listed.observations[0]!.sourceKey], action: 'upsert', title: 'Unverified claim', content: 'Claim',
      kind: 'fact', status: 'active', reasonCode: 'single_external_claim',
    });
    assert.match(String(denied), /不能写为 active/);
    assert.equal(captures, 0);
    addTask(store, 'external-two', new Date(at.getTime() + 2_000), 'external');
    const repeated = await invoke('list_memory_observations', { limit: 20 }) as unknown as {
      observations: Array<{ sourceKey: string }>;
    };
    const applied = await invoke('upsert_memory_page', {
      sourceKeys: repeated.observations.map((item) => item.sourceKey), action: 'upsert',
      title: 'Repeated external claim', content: 'The same durable claim was observed independently twice.',
      kind: 'fact', status: 'active', reasonCode: 'repeated_external_observation',
    }) as unknown as { status: string };
    assert.equal(applied.status, 'applied');
    assert.equal(captures, 1);
    const rejected = await invoke('upsert_memory_page', {
      sourceKeys: [listed.observations[0]!.sourceKey], action: 'reject', reasonCode: 'unverified_external_claim',
    }) as unknown as { status: string };
    assert.equal(rejected.status, 'rejected');
  } finally {
    store.close();
  }
});

test('observation completion is profile scoped and requires explicit receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-observation-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const at = new Date();
    addTask(store, 'task-one', at);
    const observation = store.listMemoryObservations('owner')[0]!;
    assert.throws(
      () => store.completeMemoryObservations('other', [{ sourceKey: observation.sourceKey, receiptId: 'receipt-1' }]),
      /profile 不匹配/,
    );
    assert.equal(store.completeMemoryObservations('owner', [{
      sourceKey: observation.sourceKey, receiptId: 'receipt-1',
    }]), 1);
    assert.equal(store.memoryObservationStatus('owner').pending, 0);
    assert.throws(
      () => store.completeMemoryObservations('owner', [{ sourceKey: observation.sourceKey, receiptId: 'receipt-2' }]),
      /已完成/,
    );
  } finally {
    store.close();
  }
});

test('empty automatic maintenance stays dormant while owner can request semantic lint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-lint-task-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const at = new Date();
    assert.deepEqual(store.emitDueMemoryMaintenanceTasks(at), []);
    const task = store.emitDueMemoryMaintenanceTasks(at, 'owner')[0]!;
    assert.equal(task.type, 'memory_maintenance');
    assert.equal((task.objective as { semanticLint?: boolean }).semanticLint, true);
    assert.equal(store.getImmutableEvent(task.authorityEventId)?.trust, 'system');
  } finally {
    store.close();
  }
});

test('page changes trigger semantic lint at 50 and successful maintenance resets the counter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-lint-threshold-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const at = new Date();
    for (let index = 0; index < 10; index += 1) {
      assert.equal(store.recordMemoryPageChanges('owner', `receipt-${index}`, 5, at), true);
      assert.equal(store.recordMemoryPageChanges('owner', `receipt-${index}`, 5, at), false);
    }
    assert.equal(store.memoryObservationStatus('owner').changesSinceSemanticLint, 50);
    assert.equal(store.memoryObservationStatus('owner').semanticLintDue, true);
    const task = store.emitDueMemoryMaintenanceTasks(at)[0]!;
    assert.equal((task.objective as { semanticLint?: boolean }).semanticLint, true);
    const owner = 'lint-worker';
    const executionAt = new Date(at.getTime() + 1_000);
    store.claimTaskById(task.id, owner, 60_000, executionAt);
    const attempt = store.beginTaskAttempt(task.id, owner, task.sessionKey!, owner, executionAt);
    assert.throws(
      () => store.completeTask(task.id, owner, { answer: 'semantic lint completed' }, attempt.id, executionAt),
      /缺少 semantic lint completion receipt/,
    );
    store.completeMemorySemanticLint('owner', task.id, executionAt);
    store.completeTask(task.id, owner, { answer: 'semantic lint completed' }, attempt.id, executionAt);
    const status = store.memoryObservationStatus('owner');
    assert.equal(status.changesSinceSemanticLint, 0);
    assert.equal(status.semanticLintDue, false);
    assert.equal(status.lastSemanticLintAt, executionAt.toISOString());
    const staleChangeAt = new Date(at.getTime() - 8 * 24 * 60 * 60_000);
    store.recordMemoryPageChanges('owner', 'receipt-stale-change', 1, staleChangeAt);
    const aged = store.emitDueMemoryMaintenanceTasks(new Date(at.getTime() + 2_000))[0]!;
    assert.equal((aged.objective as { semanticLint?: boolean }).semanticLint, true);
  } finally {
    store.close();
  }
});
