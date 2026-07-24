import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';

const baseTime = new Date('2026-07-24T10:05:00.000Z');
let eventSequence = 0;

function incoming(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  eventSequence += 1;
  return {
    id: `event-${eventSequence}`,
    externalId: `external-${eventSequence}`,
    source: 'connector:test',
    kind: 'alert',
    trust: 'external',
    payload: { text: 'incoming update' },
    occurredAt: baseTime.toISOString(),
    receivedAt: baseTime.toISOString(),
    priority: 80,
    profileId: 'owner',
    ...overrides,
  };
}

async function fixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const configFile = path.join(root, 'assistant.json');
  const attention = await AttentionEngine.load(configFile, store);
  return { root, store, configFile, attention };
}

test('attention config mutations are serialized, validated, cloned, and persisted privately', async () => {
  const { store, configFile, attention } = await fixture('mimi-attention-config-v12');
  try {
    assert.deepEqual(attention.listStandingOrders(), []);
    assert.deepEqual(await attention.addStandingOrder('Complete bounded owner work'), {
      instruction: 'Complete bounded owner work',
      added: true,
    });
    assert.equal((await attention.addStandingOrder('Complete bounded owner work')).added, false);

    const [source, person] = await Promise.all([
      attention.upsertSourcePolicy({
        id: 'trusted-im',
        source: 'connector:*',
        actor: 'alice*',
        access: 'work',
        computerAccess: 'background',
        computerApps: ['com.example.Editor'],
        instructions: ['Handle only the current conversation'],
      }),
      attention.upsertPerson({
        id: 'alice',
        displayName: 'Alice',
        aliases: [{ source: 'connector:*', actor: 'alice*' }],
        context: ['Alice owns the APAC project'],
      }),
    ]);
    assert.equal(source.created, true);
    assert.equal(person.created, true);
    assert.equal(attention.listSourcePolicies()[0]?.computerAccess, 'background');
    assert.equal(attention.listPeople()[0]?.displayName, 'Alice');

    const firstRule = await attention.upsertAttentionRule({
      id: 'digest-low', source: 'connector:*', maxPriority: 40, action: 'digest', reason: 'low',
    });
    const secondRule = await attention.upsertAttentionRule({
      id: 'run-alert', source: 'connector:*', kinds: ['alert'], minPriority: 70, action: 'run',
    }, 'digest-low');
    assert.equal(firstRule.created, true);
    assert.equal(secondRule.position, 0);
    assert.deepEqual(attention.listAttentionRules().map((rule) => rule.id), ['run-alert', 'digest-low']);
    assert.rejects(
      attention.upsertAttentionRule({ id: 'run-alert', source: '*', action: 'run' }, 'run-alert'),
      /beforeId/,
    );
    assert.rejects(
      attention.upsertAttentionRule({ id: 'unknown', source: '*', action: 'run' }, 'missing'),
      /not found/,
    );

    const settings = attention.getSettings();
    settings.timezone = 'UTC';
    settings.owner.displayName = 'Mimi Owner';
    settings.quietHours = { enabled: false, start: '23:00', end: '07:30', urgentPriority: 95 };
    settings.execution.runIdleTimeoutMs = 120_000;
    settings.maintenance = { enabled: true, historyRetentionDays: 30, intervalHours: 12 };
    const updated = await attention.updateSettings(settings);
    assert.equal(updated.timezone, 'UTC');
    assert.equal(attention.urgentPriority, 95);
    assert.equal(attention.runIdleTimeoutMs, 120_000);
    assert.deepEqual(attention.maintenance, settings.maintenance);

    const mutable = attention.listPeople();
    mutable[0]!.displayName = 'tampered';
    assert.equal(attention.listPeople()[0]?.displayName, 'Alice');
    assert.equal((await stat(configFile)).mode & 0o777, 0o600);
    const persisted = await readFile(configFile, 'utf8');
    assert.doesNotThrow(() => JSON.parse(persisted));

    assert.equal(await attention.removeAttentionRule('digest-low'), true);
    assert.equal(await attention.removeAttentionRule('digest-low'), false);
    assert.equal(await attention.removeSourcePolicy('trusted-im'), true);
    assert.equal(await attention.removeSourcePolicy('trusted-im'), false);
    assert.equal(await attention.removePerson('alice'), true);
    assert.equal(await attention.removePerson('alice'), false);
    assert.equal((await attention.removeStandingOrder('Complete bounded owner work')).removed, true);
    assert.equal((await attention.removeStandingOrder('Complete bounded owner work')).removed, false);
  } finally {
    store.close();
  }
});

test('snooze, quiet hours, rules, thresholds, and owner commands route deterministically', async () => {
  const { store, attention } = await fixture('mimi-attention-routing-v12');
  try {
    const settings = attention.getSettings();
    settings.timezone = 'UTC';
    settings.quietHours = { enabled: true, start: '09:00', end: '11:00', urgentPriority: 95 };
    settings.thresholds = { alertPriority: 75, webhookPriority: 85 };
    await attention.updateSettings(settings);

    assert.equal(attention.routeIngress(incoming({ kind: 'ambient' }), baseTime).reasonCode, 'ambient_digest');
    assert.equal(attention.routeIngress(incoming({ priority: 80 }), baseTime).reasonCode, 'quiet_hours');
    assert.equal(attention.routeIngress(incoming({ priority: 99 }), baseTime).decision, 'task_created');
    assert.equal(attention.routeIngress(incoming({
      trust: 'owner', kind: 'command', source: 'local-cli', priority: 1,
    }), baseTime).reasonCode, 'owner_or_internal');

    await attention.upsertAttentionRule({
      id: 'ignore-noise', source: 'connector:noise', kinds: ['alert'], action: 'ignore',
    });
    assert.deepEqual(attention.routeIngress(incoming({ source: 'connector:noise' }), baseTime), {
      decision: 'observe_only',
      reasonCode: 'rule:ignore-noise',
    });

    const snoozed = await attention.snoozeFor(30, ' focus ', baseTime);
    assert.equal(snoozed.active, true);
    assert.equal(snoozed.reason, 'focus');
    assert.equal(attention.routeIngress(incoming({ priority: 80 }), baseTime).reasonCode, 'snoozed');
    assert.equal(attention.snoozeStatus(new Date(baseTime.getTime() + 31 * 60_000)).active, false);
    assert.rejects(attention.snoozeFor(0, undefined, baseTime), /1～43200/);
    assert.rejects(attention.snoozeFor(1, 'x'.repeat(201), baseTime), /最多 200/);
    assert.deepEqual(await attention.clearSnooze(baseTime), { active: false });

    settings.quietHours.enabled = false;
    await attention.updateSettings(settings);
    assert.equal(attention.routeIngress(incoming({ kind: 'alert', priority: 75 }), baseTime).reasonCode, 'alert_threshold');
    assert.equal(attention.routeIngress(incoming({ kind: 'webhook', priority: 85 }), baseTime).reasonCode, 'webhook_threshold');
    assert.equal(attention.routeIngress(incoming({ kind: 'webhook', priority: 20 }), baseTime).reasonCode, 'below_wakeup_threshold');
  } finally {
    store.close();
  }
});

test('attention resolves people and source policies when deciding a v12 Task', async () => {
  const { store, attention } = await fixture('mimi-attention-decision-v12');
  try {
    await attention.addStandingOrder('Use concise replies');
    await attention.upsertPerson({
      id: 'alice',
      displayName: 'Alice',
      aliases: [{ source: 'connector:*', actor: 'alice-1' }],
      context: ['Alice owns APAC'],
    });
    await attention.upsertSourcePolicy({
      id: 'alice-work',
      source: 'connector:*',
      kinds: ['command'],
      actor: 'alice-*',
      access: 'work',
      computerAccess: 'background',
      computerApps: ['com.example.Editor', 'com.example.Browser'],
      instructions: ['Complete bounded requests'],
    });
    await attention.upsertSourcePolicy({
      id: 'alice-computer-limit',
      source: 'connector:*',
      actor: 'alice-*',
      access: 'reply',
      computerAccess: 'observe',
      computerApps: ['com.example.Editor'],
      instructions: ['Do not widen recipients'],
    });

    const routed = store.ingestEvent(incoming({
      source: 'connector:chat',
      kind: 'command',
      actor: { id: 'alice-1' },
      conversation: { id: 'conversation-1' },
      payload: { text: 'edit the document' },
      priority: 90,
    }));
    assert.ok(routed.task);
    const decision = attention.decideTask(routed.task, routed.event, routed.event);
    assert.equal(decision.options?.cause?.personId, 'alice');
    assert.equal(decision.options?.computerAccess, 'background');
    assert.deepEqual(decision.options?.computerApps, ['com.example.Editor']);
    assert.match(decision.options?.hostInstructions ?? '', /Use concise replies|Alice owns APAC/);
    assert.ok(decision.options?.policy?.allowedTools?.includes('run_shell'));
    assert.ok(decision.options?.policy?.allowedTools?.includes('connector_action'));

    const durableBackground = store.enqueueTask({
      id: 'alice-background',
      type: 'background',
      idempotencyKey: 'alice-background',
      triggerEventId: routed.event.id,
      authorityEventId: routed.event.id,
      profileId: 'owner',
      sessionKey: 'alice-background',
      objective: { prompt: 'continue external work' },
      executor: 'isolated_worker',
      workspaceAccess: 'write',
      priority: 70,
    });
    assert.ok(attention.decideTask(
      durableBackground,
      routed.event,
      routed.event,
    ).options?.policy?.allowedTools?.includes('run_shell'));

    await attention.removeSourcePolicy('alice-work');
    await attention.removeSourcePolicy('alice-computer-limit');
    const revoked = attention.decideTask(durableBackground, routed.event, routed.event);
    assert.equal(revoked.options?.policy?.allowSideEffects, false);
    assert.equal(revoked.options?.policy?.allowSessionContext, false);
    assert.equal(revoked.options?.policy?.allowedTools, undefined);
  } finally {
    store.close();
  }
});

test('owner routes, routine occurrences, and digest briefings remain idempotent', async () => {
  const { store, attention } = await fixture('mimi-attention-schedules-v12');
  try {
    const settings = attention.getSettings();
    settings.timezone = 'UTC';
    settings.quietHours.enabled = false;
    settings.owner.replyRoute = { channel: 'system' };
    settings.briefings = { enabled: true, times: ['10:00'], maxItems: 10 };
    await attention.updateSettings(settings);

    assert.equal(attention.observeOwnerRoute(incoming({
      trust: 'owner',
      kind: 'command',
      replyRoute: { channel: 'connector:messages', target: 'owner-chat' },
    }), baseTime), true);
    assert.equal(attention.observeOwnerRoute(incoming({
      trust: 'external',
      replyRoute: { channel: 'connector:messages', target: 'attacker' },
    }), baseTime), false);
    assert.deepEqual(attention.replyRouteFor(), { channel: 'connector:messages', target: 'owner-chat' });
    assert.equal(attention.replyRouteFor({
      source: 'local-cli', profileId: 'owner', replyRoute: undefined,
    }), undefined);

    for (const routine of attention.listRoutines()) await attention.removeRoutine(routine.id);
    await attention.upsertRoutine({
      id: 'workday', enabled: true, time: '10:00', weekdays: [5],
      prompt: 'check current work', priority: 70,
    });
    assert.equal(attention.emitDueRoutines(baseTime).length, 1);
    assert.equal(attention.emitDueRoutines(baseTime).length, 0);
    const routineTask = store.listTasks().find((candidate) => candidate.type === 'scheduled');
    assert.ok(routineTask);

    store.setIngressRoutePolicy((candidate, at) => attention.routeIngress(candidate, at));
    const digest = store.ingestEvent(incoming({
      id: 'digest-event',
      externalId: 'digest-event',
      kind: 'ambient',
      priority: 10,
      payload: { text: 'low priority update' },
    }));
    assert.equal(digest.task, undefined);
    assert.equal(store.pendingDigestCount(), 1);
    assert.equal(attention.emitDueBriefings(baseTime).length, 1);
    assert.equal(attention.emitDueBriefings(baseTime).length, 0);
    assert.ok(attention.forceBriefing(baseTime) === undefined);

    const status = attention.status(baseTime);
    assert.equal((status.routines as { total: number }).total, 1);
    assert.equal((status.decisionPolicy as { standingOrders: number }).standingOrders, 0);
  } finally {
    store.close();
  }
});

test('reload rejects corrupt or over-permissive config without changing active state', async () => {
  const { store, configFile, attention } = await fixture('mimi-attention-reload-v12');
  try {
    const before = attention.getSettings();
    await chmod(configFile, 0o644);
    await writeFile(configFile, '{"version":1}\n');
    await assert.rejects(attention.reload());
    assert.deepEqual(attention.getSettings(), before);
  } finally {
    store.close();
  }
});
