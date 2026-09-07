import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RunContext, type Tool } from '@openai/agents';
import { AttentionEngine } from '../src/daemon/attention.js';
import { MimiDispatcher } from '../src/daemon/dispatcher.js';
import { createFreshV16Schema } from '../src/daemon/persistence/schema/current.js';
import { isAuthenticScheduleTask } from '../src/daemon/schedule-tools.js';
import { taskCompletionRoute } from '../src/daemon/task-continuation.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
import { MimiStore } from '../src/daemon/store.js';

test('background completion atomically wakes the original conversation once and survives reopening', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-continuity-'));
  let store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const now = new Date();
    const authority = store.appendEvent({
      id: 'authority', externalId: 'authority', source: 'local-cli', type: 'command.received',
      trust: 'owner', payload: { prompt: '修复并验证，明天再检查' }, profileId: 'owner',
      replyRoute: { channel: 'system' }, occurredAt: now.toISOString(), receivedAt: now.toISOString(),
    }).event;
    const parent = store.enqueueTask({
      id: 'parent', idempotencyKey: 'parent', type: 'conversation', authorityEventId: authority.id,
      profileId: 'owner', sessionKey: 'owner-chat', objective: {}, executor: 'session_actor',
      workspaceAccess: 'write', priority: 100,
    });
    const child = store.enqueueTask({
      id: 'child', idempotencyKey: 'child', type: 'background', authorityEventId: authority.id,
      parentTaskId: parent.id, profileId: 'owner', sessionKey: 'worker-chat',
      objective: { objective: '修复并验证，明天再检查', successCriteria: '测试通过',
        returnToOwner: true, originSessionId: parent.sessionKey, workspaceRoot: root },
      executor: 'codex', workspaceAccess: 'write', priority: 70,
    });
    store.claimTaskById(child.id, 'worker', 60_000);
    store.completeTask(child.id, 'worker', { text: 'claimed done' }, undefined, new Date(), {
      route: { channel: 'system' }, payload: { text: 'raw worker answer' },
    });
    const reviews = store.listTasks(20, { type: 'conversation' }).filter((task) => task.id !== parent.id);
    assert.equal(reviews.length, 1);
    const review = reviews[0]!;
    assert.equal(review.sessionKey, parent.sessionKey);
    assert.equal(review.authorityEventId, authority.id);
    assert.equal(review.executor, 'session_actor');
    assert.equal((review.objective as Record<string, unknown>).workspaceRoot, root);
    assert.match(JSON.stringify(review.objective), /child/);
    assert.match(JSON.stringify(review.objective), /核查/);
    assert.equal(store.counts().outbox.pending, 0, 'only the reviewed answer should be delivered');
    assert.throws(() => store.completeTask(child.id, 'worker', {}), /租约/);
    store.close();
    store = new MimiStore(path.join(root, 'mimi.db'));
    assert.equal(store.getTask(review.id)?.status, 'queued');
    assert.equal(store.listTasks(20, { type: 'conversation' }).length, 2);
    assert.doesNotThrow(() => store.healthSnapshot());
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('scheduled checks inherit workspace and progress, coalesce overlaps, and survive v16 migration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-continuity-'));
  const file = path.join(root, 'mimi.db');
  const legacy = new DatabaseSync(file);
  createFreshV16Schema(legacy);
  legacy.close();
  let store = new MimiStore(file);
  try {
    const at = new Date(Date.now() + 1_000);
    const schedule = store.schedules.add({ name: 'observe', type: 'watch', value: '300000',
      prompt: '检查是否复发', profileId: 'owner', sessionKey: 'original-session', trust: 'owner',
      context: { workspaceRoot: root, summary: '修复已通过测试；观察两天' }, nextRunAt: at.toISOString() });
    const event = store.schedules.emitDue(at)[0]!;
    const first = store.getTask(event.id)!;
    assert.equal(isAuthenticScheduleTask(store, schedule, first, event), true);
    assert.equal((first.objective as Record<string, unknown>).workspaceRoot, root);
    assert.match(JSON.stringify(first.objective), /修复已通过测试/);
    assert.equal(store.schedules.emitDue(new Date(at.getTime() + 600_000)).length, 0);
    store.claimTaskById(first.id, 'worker', 60_000, at);
    store.completeTask(first.id, 'worker', { answer: '第一轮未复发' }, undefined, new Date(at.getTime() + 1_000));
    store.close();
    store = new MimiStore(file);
    const secondEvent = store.schedules.emitDue(new Date(at.getTime() + 600_000))[0]!;
    const second = store.getTask(secondEvent.id)!;
    assert.match(JSON.stringify(second.objective), /第一轮未复发/);
    assert.equal(isAuthenticScheduleTask(store, store.schedules.get(schedule.id)!, second, secondEvent), true);
    assert.equal(store.schedules.remove(schedule.id), true);
    assert.equal(store.getTask(second.id)?.status, 'cancelled');
    assert.equal(store.schedules.emitDue(new Date(at.getTime() + 900_000)).length, 0);
    assert.throws(() => store.schedules.add({ ...schedule, context: { workspaceRoot: 'relative' } }));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('real host/dispatcher/tool wiring reviews a worker result and persists a follow-up without a foreground client', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-review-host-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const invoke = async (tools: Tool[], name: string, input: unknown) => {
    const selected = tools.find((tool) => tool.name === name);
    assert.ok(selected && 'invoke' in selected);
    return selected.invoke(new RunContext({}), JSON.stringify(input));
  };
  const agent = { currentSessionId: 'owner', currentCapabilitySnapshot: () => undefined,
    completedExecution: async () => undefined, finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async () => undefined } as unknown as MimiAgent;
  let childId = '';
  const host = new MimiHost(agent, { execute: async (request) => {
    assert.match(request.input, /核查/);
    const tools = request.options?.hostTools ?? [];
    const result = await invoke(tools, 'inspect_background_task', { taskId: childId }) as { result: { answer: string } };
    assert.equal(result.result.answer, 'file verified');
    const followup = await invoke(tools, 'schedule_mimi_follow_up', {
      name: '明日检查', prompt: '检查是否复发', context: '修复已核查', runAt: new Date(Date.now() + 86_400_000).toISOString(),
    }) as { id: string };
    assert.ok(followup.id);
    return { answer: '已核查，明天继续检查', effects: [] };
  } }, { primaryWorkspaceRoot: root });
  try {
    const timestamp = new Date().toISOString();
    const routed = store.ingestEvent({ id: randomUUID(), externalId: randomUUID(), source: 'local-cli',
      kind: 'command', trust: 'owner', profileId: 'owner', sessionKey: 'owner', priority: 100,
      payload: { prompt: '修复后明天继续检查' }, occurredAt: timestamp, receivedAt: timestamp,
      replyRoute: { channel: 'system' } });
    const child = store.enqueueTask({ id: randomUUID(), idempotencyKey: 'child', type: 'background',
      parentTaskId: routed.task!.id, authorityEventId: routed.event.id, profileId: 'owner', sessionKey: 'worker',
      executor: 'isolated_worker', workspaceAccess: 'write', priority: 70,
      objective: { objective: '修复后明天继续检查', returnToOwner: true, originSessionId: 'owner', workspaceRoot: root } });
    childId = child.id;
    store.claimTaskById(routed.task!.id, 'foreground', 60_000);
    store.completeTask(routed.task!.id, 'foreground', { answer: '已交给后台' });
    store.claimTaskById(child.id, 'worker', 60_000);
    store.completeTask(child.id, 'worker', { answer: 'file verified' });
    const review = store.listTasks(10, { type: 'conversation' }).find((task) => task.id !== routed.task!.id)!;
    const attention = await AttentionEngine.load(path.join(root, 'attention.json'), store);
    const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
      resolveWorkspace: (_event, sessionId, task) => {
        assert.equal(sessionId, 'owner');
        return (task.objective as { workspaceRoot: string }).workspaceRoot;
      },
    });
    assert.equal(await dispatcher.processTaskById(review.id), true);
    assert.equal(store.getTask(review.id)?.status, 'completed', store.getTask(review.id)?.error);
    assert.equal(store.schedules.list()[0]?.context?.workspaceRoot, root);
    assert.equal(store.counts().outbox.pending, 1);
    const completion = store.getImmutableEvent(review.triggerEventId!)!;
    const authority = store.getImmutableEvent(child.authorityEventId)!;
    assert.equal(taskCompletionRoute({ ...child, objective: {} }, completion, authority), undefined);
    assert.equal(taskCompletionRoute({ ...child, result: { delivery: { suppressed: true } } }, completion, authority), undefined);
    assert.equal(taskCompletionRoute(child, completion, { ...authority, trust: 'external' }), undefined);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('usage is time scoped, separates task types and never substitutes zero for missing tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-usage-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const at = new Date(Date.now() + 1_000);
    const authority = store.appendEvent({ id: 'owner', externalId: 'owner', source: 'local-cli',
      type: 'command.received', trust: 'owner', payload: {}, profileId: 'owner',
      occurredAt: at.toISOString(), receivedAt: at.toISOString() }).event;
    for (const type of ['conversation', 'background'] as const) {
      const task = store.enqueueTask({ id: type, idempotencyKey: type, type, authorityEventId: authority.id,
        profileId: 'owner', sessionKey: type, objective: {}, workspaceAccess: 'write', priority: 70,
        executor: type === 'conversation' ? 'session_actor' : 'isolated_worker' });
      store.claimTaskById(task.id, 'worker', 60_000, at);
      const run = store.beginTaskAttempt(task.id, 'worker', type, 'worker', at);
      store.completeTask(task.id, 'worker', type === 'conversation'
        ? { usage: { runInputTokens: 12, runOutputTokens: 3 } } : {}, run.id, new Date(at.getTime() + 1_000));
    }
    const report = store.usageReport(7, new Date(at.getTime() + 2_000));
    assert.equal(report.byType[0]?.tasks, 1);
    assert.equal(report.byType[0]?.tokens.input, 12);
    assert.equal(report.byType[0]?.durationMs.p50, 1_000);
    assert.equal(report.byType[1]?.tokens.input, null);
    assert.equal(report.byType[1]?.tokens.unmeteredRuns, 1);
    assert.equal(store.usageReport(1, new Date(at.getTime() + 3 * 86_400_000)).byType[0]?.tasks, 0);
    assert.throws(() => store.usageReport(0));
    assert.throws(() => store.usageReport(Number.NaN));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('idle ready-task polling remains readable while another SQLite connection owns the write lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ready-lock-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const writer = new DatabaseSync(store.file);
  try {
    writer.exec('BEGIN IMMEDIATE;');
    assert.deepEqual(store.readyTasks(), []);
    assert.equal(store.healthSnapshot().pendingDigest, 0);
  } finally {
    writer.exec('ROLLBACK;'); writer.close(); store.close();
    await rm(root, { recursive: true, force: true });
  }
});
