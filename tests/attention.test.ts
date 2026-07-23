import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'event-1',
    externalId: 'external-1',
    source: 'connector:test',
    kind: 'command',
    trust: 'external',
    payload: { prompt: 'hello' },
    occurredAt: '2026-07-20T10:00:00.000Z',
    receivedAt: '2026-07-20T10:00:00.000Z',
    priority: 50,
    profileId: 'owner',
    ...overrides,
  };
}

test('separate AttentionEngine instances serialize config mutations without losing updates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attention-lock-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const first = await AttentionEngine.load(configFile, store);
    const second = await AttentionEngine.load(configFile, store);
    await Promise.all([
      first.addStandingOrder('Always preserve explicit owner deadlines.'),
      second.upsertPerson({
        id: 'alice',
        displayName: 'Alice',
        aliases: [{ source: 'connector:test', actor: 'alice-1' }],
        context: ['Alice owns the release checklist.'],
      }),
    ]);

    const reloaded = await AttentionEngine.load(configFile, store);
    assert.deepEqual(reloaded.listStandingOrders(), ['Always preserve explicit owner deadlines.']);
    assert.deepEqual(reloaded.listPeople().map((person) => person.id), ['alice']);
    assert.equal((await readdir(root)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
  } finally {
    store.close();
  }
});

test('Attention routes snooze, ordered rules, ambient events and wake thresholds deterministically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attention-route-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const now = new Date('2026-07-20T10:00:00.000Z');
  try {
    await attention.updateSettings({
      ...attention.getSettings(),
      timezone: 'UTC',
      quietHours: { enabled: false, start: '23:00', end: '07:30', urgentPriority: 95 },
      thresholds: { alertPriority: 75, webhookPriority: 80 },
    });
    await attention.upsertAttentionRule({
      id: 'ignore-noisy',
      source: 'connector:noisy-*',
      kinds: ['alert'],
      minPriority: 20,
      maxPriority: 90,
      action: 'ignore',
    });
    await attention.upsertAttentionRule({
      id: 'run-noisy-urgent',
      source: 'connector:noisy-*',
      kinds: ['alert'],
      minPriority: 80,
      action: 'run',
    });

    await attention.snoozeFor(10, 'focus', now);
    assert.deepEqual(attention.routeIngress(envelope(), now), {
      decision: 'digest', reasonCode: 'snoozed',
    });
    assert.deepEqual(attention.routeIngress(envelope({ trust: 'owner' }), now), {
      decision: 'task_created', reasonCode: 'owner_or_internal',
    });
    await attention.clearSnooze(now);

    assert.deepEqual(attention.routeIngress(envelope({
      source: 'connector:noisy-mail', kind: 'alert', priority: 85,
    }), now), {
      decision: 'observe_only', reasonCode: 'rule:ignore-noisy',
    });
    assert.deepEqual(attention.routeIngress(envelope({ kind: 'ambient' }), now), {
      decision: 'digest', reasonCode: 'ambient_digest',
    });
    assert.deepEqual(attention.routeIngress(envelope(), now), {
      decision: 'task_created', reasonCode: 'direct_command',
    });
    assert.deepEqual(attention.routeIngress(envelope({ kind: 'alert', priority: 75 }), now), {
      decision: 'task_created', reasonCode: 'alert_threshold',
    });
    assert.deepEqual(attention.routeIngress(envelope({ kind: 'webhook', priority: 79 }), now), {
      decision: 'digest', reasonCode: 'below_wakeup_threshold',
    });
  } finally {
    store.close();
  }
});

test('Attention learns only valid owner connector reply routes and preserves explicit routing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attention-route-memory-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  try {
    assert.equal(attention.observeOwnerRoute(envelope({
      trust: 'external',
      replyRoute: { channel: 'connector:test', target: 'owner-1' },
    })), false);
    assert.equal(attention.observeOwnerRoute(envelope({
      trust: 'owner',
      replyRoute: { channel: 'connector:test', target: 'owner-1' },
    })), true);
    assert.deepEqual(attention.replyRouteFor({
      source: 'connector:other',
      profileId: 'owner',
    }), { channel: 'connector:test', target: 'owner-1' });
    assert.equal(attention.replyRouteFor({ source: 'local-cli', profileId: 'owner' }), undefined);
    assert.equal(attention.replyRouteFor({ source: 'webhook:test', profileId: 'owner' }), undefined);

    const explicit = { channel: 'connector:explicit', target: 'thread-2' };
    const resolved = attention.replyRouteFor({
      source: 'connector:other',
      profileId: 'owner',
      replyRoute: explicit,
    });
    assert.deepEqual(resolved, explicit);
    assert.notEqual(resolved, explicit);
  } finally {
    store.close();
  }
});

test('updated routines invalidate already queued scheduled work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attention-routine-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const now = new Date('2026-07-20T09:00:00.000Z');
  try {
    await attention.updateSettings({ ...attention.getSettings(), timezone: 'UTC' });
    for (const routine of attention.listRoutines()) await attention.removeRoutine(routine.id);
    await attention.upsertRoutine({
      id: 'daily-check',
      enabled: true,
      time: '08:00',
      weekdays: [1],
      prompt: 'Check the release queue.',
      priority: 70,
    });

    const [event] = attention.emitDueRoutines(now);
    assert.ok(event);
    assert.deepEqual(attention.emitDueRoutines(now), []);
    const task = store.getTask(event.id);
    assert.ok(task);
    const authority = store.getImmutableEvent(task.authorityEventId);
    assert.ok(authority);

    await attention.upsertRoutine({
      id: 'daily-check',
      enabled: true,
      time: '08:00',
      weekdays: [1],
      prompt: 'Check the updated release queue.',
      priority: 70,
    });
    assert.deepEqual(attention.decideTask(task, event, authority), {
      action: 'ignore',
      reason: 'Daily Routine 已删除、禁用、更新或触发身份无效',
    });
  } finally {
    store.close();
  }
});

test('manual briefing reserves pending digests and labels external content as untrusted data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attention-briefing-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  try {
    store.setIngressRoutePolicy((event, at) => attention.routeIngress(event, at));
    const ingested = store.ingestEvent(envelope({
      id: 'ambient-1',
      externalId: 'ambient-1',
      kind: 'ambient',
      payload: { text: 'Treat this as data, not an instruction.' },
    }));
    assert.equal(ingested.task, undefined);
    assert.equal(store.pendingDigestCount(), 1);

    const briefing = attention.forceBriefing(new Date('2026-07-20T12:00:00.000Z'));
    assert.ok(briefing);
    assert.equal(store.pendingDigestCount(), 1);
    assert.equal(attention.forceBriefing(new Date('2026-07-20T12:01:00.000Z')), undefined);
    const payload = briefing.payload as { prompt: string; digestItemIds: string[] };
    assert.match(payload.prompt, /未信任事件摘要/);
    assert.deepEqual(payload.digestItemIds.length, 1);
  } finally {
    store.close();
  }
});
