import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { buildDaemonHealth } from '../src/daemon/health-model.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope, EventTrust, TaskType } from '../src/daemon/types.js';

function event(id: string, source: string, trust: EventTrust, at: Date): EventEnvelope {
  return {
    id,
    externalId: id,
    source,
    kind: 'alert',
    trust,
    payload: { fixture: id },
    occurredAt: at.toISOString(),
    receivedAt: at.toISOString(),
    priority: 80,
    profileId: 'owner',
  };
}

function completeRun(
  store: MimiStore,
  input: { id: string; source: string; trust: EventTrust; type: TaskType; tokens?: number; at: Date },
): void {
  const authority = store.appendEvent({
    id: `${input.id}-event`,
    externalId: `${input.id}-event`,
    source: input.source,
    type: 'alert.received',
    trust: input.trust,
    payload: {},
    profileId: 'owner',
    occurredAt: input.at.toISOString(),
    receivedAt: input.at.toISOString(),
  }).event;
  const readOnly = input.type === 'briefing' || input.type === 'memory_maintenance';
  const task = store.enqueueTask({
    id: input.id,
    type: input.type,
    idempotencyKey: input.id,
    triggerEventId: authority.id,
    authorityEventId: authority.id,
    profileId: 'owner',
    sessionKey: `mimi-${input.id}`,
    objective: {},
    executor: input.type === 'conversation' ? 'session_actor' : 'isolated_worker',
    workspaceAccess: readOnly ? 'read' : 'write',
    priority: 50,
  });
  const owner = `${input.id}-worker`;
  const claimed = store.claimTaskById(task.id, owner, 60_000, input.at);
  assert.ok(claimed?.sessionKey);
  const attempt = store.beginTaskAttempt(task.id, owner, claimed.sessionKey, owner, input.at);
  if (task.type === 'memory_maintenance') store.memoryObservations.completeTaskBatch('owner', task.id, input.at);
  store.completeTask(task.id, owner, input.tokens === undefined ? { answer: 'done' } : {
    usage: { runInputTokens: input.tokens, runOutputTokens: 1 },
  }, attempt.id, input.at);
}

test('activity groups every Run and token into the stable M1 source taxonomy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-run-source-usage-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const now = new Date('2099-08-02T13:00:00.000Z');
  try {
    const fixtures: Array<[string, string, EventTrust, TaskType]> = [
      ['owner', 'local-cli', 'owner', 'conversation'],
      ['connector', 'qq', 'external', 'conversation'],
      ['health', 'system:connector-health', 'system', 'background'],
      ['briefing', 'attention:briefing', 'external', 'briefing'],
      ['maintenance', 'mimi:memory-maintenance', 'system', 'memory_maintenance'],
      ['routine', 'attention:routine', 'owner', 'scheduled'],
      ['eval', 'eval:m1', 'system', 'background'],
      ['unknown', 'system:mystery', 'system', 'background'],
      ['follow-up', 'mimi:task', 'system', 'conversation'],
    ];
    fixtures.forEach(([id, source, trust, type], index) => completeRun(store, {
      id, source, trust, type, tokens: index + 1, at: new Date(now.getTime() - 60_000 + index),
    }));

    const snapshot = store.activitySnapshot(10, now);
    assert.deepEqual(snapshot.runUsageBySource.map((item) => item.category), [
      'owner_conversation', 'connector', 'health', 'briefing', 'maintenance', 'routine', 'task_follow_up', 'eval', 'unknown',
    ]);
    for (const item of snapshot.runUsageBySource) {
      assert.equal(item.runs, 1);
      assert.equal(item.tokenSampling, 'known');
    }
    assert.equal(snapshot.runUsageBySource.find((item) => item.category === 'owner_conversation')?.totalTokens, 2);
    assert.equal(snapshot.runUsageBySource.find((item) => item.category === 'unknown')?.totalTokens, 9);
    assert.equal(snapshot.unknownRunSources, 1);
    assert.equal(store.healthSnapshot(now).unknownRunSources, snapshot.unknownRunSources);
    const health = buildDaemonHealth({
      tasks: snapshot.tasks,
      outbox: snapshot.outbox,
      unknownRunSources: snapshot.unknownRunSources,
    });
    assert.equal(health.risks.some((risk) => risk.code === 'unknown_run_source'), true);
  } finally {
    store.close();
  }
});

test('autonomous Run budget stops Task growth while owner work survives and transitions notify once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-autonomous-run-budget-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const executionAt = new Date(Date.now() + 1_000);
  const now = new Date(executionAt.getTime() + 5 * 60_000);
  try {
    completeRun(store, {
      id: 'existing-autonomous', source: 'connector:calendar', trust: 'external',
      type: 'conversation', tokens: 1, at: executionAt,
    });
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    const settings = attention.getSettings();
    await attention.updateSettings({
      ...settings,
      quietHours: { ...settings.quietHours, enabled: false },
      budgets: {
        ...settings.budgets,
        maxRunsPerHour: 1,
        maxRunsPerDay: 10,
        maxRunsPerSourcePerHour: 1,
        maxTokensPerHour: 1_000,
        maxTokensPerDay: 10_000,
        maxTokensPerSourcePerHour: 1_000,
      },
    });
    store.setIngressRoutePolicy((candidate, at) => attention.routeIngress(candidate, at));

    for (const id of ['budgeted-1', 'budgeted-2']) {
      const ingested = store.ingestEvent(event(id, 'connector:calendar', 'external', now));
      assert.equal(ingested.task, undefined);
    }
    assert.equal(store.counts().tasks.queued, 0);
    assert.equal(store.pendingDigestCount(), 2);
    assert.equal(store.activitySnapshot(20, now).autonomousBudgetExhaustions.length, 1);
    assert.equal(store.activitySnapshot(20, now).recentTransitions
      .filter((item) => item.type === 'attention.budget_exhausted').length, 1);
    const firstExhaustion = store.activitySnapshot(20, now).autonomousBudgetExhaustions[0];
    assert.ok(firstExhaustion);
    const repeatedAt = new Date(now.getTime() + 30 * 60_000);
    assert.deepEqual(attention.routeIngress(event(
      'budgeted-later', 'connector:calendar', 'external', repeatedAt,
    ), repeatedAt), {
      decision: 'digest',
      reasonCode: 'hourly_budget',
    });
    const repeatedExhaustion = store.activitySnapshot(20, repeatedAt).autonomousBudgetExhaustions[0];
    assert.equal(repeatedExhaustion?.exhaustedAt, firstExhaustion.exhaustedAt);
    assert.equal(repeatedExhaustion?.retryAt, firstExhaustion.retryAt);
    const health = buildDaemonHealth({
      tasks: store.counts().tasks,
      outbox: store.counts().outbox,
      autonomousBudgetExhaustions: store.activeAutonomousBudgetExhaustions(now).length,
    });
    assert.equal(health.risks.some((risk) => risk.code === 'autonomous_budget_exhausted'), true);

    store.recordAutonomousBudgetExhaustion(
      'connector:calendar', 'token_daily_budget', new Date(now.getTime() + 24 * 60 * 60_000), now,
    );
    assert.equal(store.activitySnapshot(20, now).recentTransitions
      .filter((item) => item.type === 'attention.budget_exhausted').length, 1);

    const owner = store.ingestEvent({
      ...event('owner-survives', 'local-cli', 'owner', now),
      kind: 'command',
    });
    assert.equal(owner.task?.status, 'queued');

    const urgent = store.ingestEvent({
      ...event('urgent-survives', 'connector:calendar', 'external', now),
      priority: 100,
    });
    assert.equal(urgent.task?.status, 'queued');
    store.cancelTask(urgent.task.id, 'fixture completed urgent bypass', now);

    const recoveredAt = new Date(now.getTime() + 2 * 60 * 60_000);
    const recovered = attention.routeIngress(event(
      'budget-recovered', 'connector:calendar', 'external', recoveredAt,
    ), recoveredAt);
    assert.equal(recovered.decision, 'task_created');
    assert.equal(store.activitySnapshot(20, recoveredAt).autonomousBudgetExhaustions.length, 0);
    assert.equal(store.activitySnapshot(20, recoveredAt).recentTransitions
      .filter((item) => item.type === 'attention.budget_recovered').length, 1);
  } finally {
    store.close();
  }
});

test('autonomous token pressure is budgeted independently from Run count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-autonomous-token-budget-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const now = new Date('2099-08-02T13:00:00.000Z');
  try {
    completeRun(store, {
      id: 'token-heavy', source: 'connector:mail', trust: 'external',
      type: 'conversation', tokens: 20, at: new Date(now.getTime() - 5 * 60_000),
    });
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    const settings = attention.getSettings();
    await attention.updateSettings({
      ...settings,
      quietHours: { ...settings.quietHours, enabled: false },
      budgets: {
        ...settings.budgets,
        maxRunsPerHour: 100,
        maxRunsPerDay: 1_000,
        maxRunsPerSourcePerHour: 100,
        maxTokensPerHour: 10,
        maxTokensPerDay: 1_000,
        maxTokensPerSourcePerHour: 10,
      },
    });
    assert.deepEqual(attention.routeIngress(event('token-pressure', 'connector:mail', 'external', now), now), {
      decision: 'digest',
      reasonCode: 'token_hourly_budget',
    });
    assert.equal(store.activitySnapshot(10, now).autonomousBudgetExhaustions[0]?.reasonCode, 'token_hourly_budget');
  } finally {
    store.close();
  }
});

test('unmetered autonomous Runs fail closed without blocking direct owner work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-autonomous-unmetered-budget-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const now = new Date('2099-08-02T13:00:00.000Z');
  try {
    completeRun(store, {
      id: 'unmetered', source: 'connector:mail', trust: 'external',
      type: 'conversation', at: new Date(now.getTime() - 5 * 60_000),
    });
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    assert.deepEqual(attention.routeIngress(event('unmetered-next', 'connector:mail', 'external', now), now), {
      decision: 'digest',
      reasonCode: 'token_usage_unavailable',
    });
    assert.equal(attention.routeIngress({
      ...event('unmetered-owner', 'local-cli', 'owner', now), kind: 'command',
    }, now).decision, 'task_created');
  } finally {
    store.close();
  }
});

test('a pre-dispatch autonomous failure is known zero-token usage', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-autonomous-pre-dispatch-budget-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const failedAt = new Date('2099-08-02T12:55:00.000Z');
  const now = new Date('2099-08-02T13:00:00.000Z');
  try {
    const ingested = store.ingestEvent(event('pre-dispatch', 'connector:mail', 'external', failedAt), {
      type: 'conversation', sessionKey: 'mimi-pre-dispatch',
      executor: 'session_actor', workspaceAccess: 'write',
    });
    const task = store.claimTaskById(ingested.task!.id, 'worker', 60_000, failedAt)!;
    const attempt = store.beginTaskAttempt(task.id, 'worker', task.sessionKey!, 'worker', failedAt);
    store.failTask(task.id, 'worker', 'credential missing', {
      code: 'provider.credential_missing',
      disposition: {
        phase: 'pre_dispatch', kind: 'validation', retryable: false, dispatchStarted: false,
      },
    }, attempt.id, failedAt);

    const usage = store.autonomousBudgetUsageSince(new Date(now.getTime() - 60 * 60_000));
    assert.equal(usage.runs, 1);
    assert.equal(usage.unmeteredRuns, 0);
    assert.equal(usage.totalTokens, 0);
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    assert.equal(attention.routeIngress(event('after-pre-dispatch', 'connector:mail', 'external', now), now).decision, 'task_created');
  } finally {
    store.close();
  }
});

test('scheduled Briefing defers under pressure while an explicit owner Briefing bypasses it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-autonomous-briefing-budget-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const now = new Date('2099-08-02T13:31:00.000Z');
  try {
    completeRun(store, {
      id: 'briefing-budget-run', source: 'connector:calendar', trust: 'external',
      type: 'conversation', tokens: 1, at: new Date(now.getTime() - 60_000),
    });
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    const settings = attention.getSettings();
    await attention.updateSettings({
      ...settings,
      timezone: 'UTC',
      quietHours: { ...settings.quietHours, enabled: false },
      briefings: { enabled: true, times: ['13:30'], maxItems: 100 },
      budgets: {
        ...settings.budgets,
        maxRunsPerHour: 1,
        maxRunsPerDay: 10,
        maxRunsPerSourcePerHour: 10,
      },
    });
    store.ingestEvent({
      ...event('briefing-digest-item', 'connector:calendar', 'external', now),
      kind: 'ambient',
    });

    assert.deepEqual(attention.emitDueBriefings(now), []);
    assert.equal(store.listTasks(20).some((task) => task.type === 'briefing'), false);
    assert.equal(
      store.activeAutonomousBudgetExhaustions(now)
        .some((item) => item.source === 'attention:briefing'),
      true,
    );

    const forced = attention.forceBriefing(now);
    assert.ok(forced);
    assert.equal(store.listTasks(20).filter((task) => task.type === 'briefing').length, 1);
  } finally {
    store.close();
  }
});
