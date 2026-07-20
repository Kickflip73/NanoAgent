import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AttentionEngine } from '../src/daemon/attention.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';

function envelope(id = 'event-1'): EventEnvelope {
  return {
    id, externalId: 'source-message-1', source: 'test', kind: 'command', trust: 'owner',
    payload: { prompt: 'hello' }, occurredAt: '2026-07-14T00:00:00.000Z',
    receivedAt: '2026-07-14T00:00:00.000Z', priority: 100, profileId: 'owner',
  };
}

test('conversation authority roots are terminal, idempotent, and reject conflicting reuse', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-authority-root-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const authority = {
    ...envelope('authority-1'),
    externalId: 'routine-authority:daily:2026-07-15',
    source: 'attention:routine-authority',
    payload: { type: 'routine_authority', routineId: 'daily' },
    sessionKey: 'routine-daily',
    replyRoute: { channel: 'system' },
    executionLane: 'conversation' as const,
  };
  try {
    const first = store.ensureConversationAuthority(authority);
    assert.equal(first.status, 'completed');
    assert.deepEqual(first.result, { authority: true });
    assert.equal(store.claimEvent('conversation-worker', 60_000, new Date(), 'conversation'), undefined);

    const repeated = store.ensureConversationAuthority({
      ...authority,
      id: 'authority-restarted',
      occurredAt: '2026-07-14T00:01:00.000Z',
      receivedAt: '2026-07-14T00:01:00.000Z',
    });
    assert.equal(repeated.id, first.id);
    assert.equal(store.listEvents().length, 1);
    assert.throws(() => store.ensureConversationAuthority({
      ...authority,
      id: 'authority-conflict',
      payload: { type: 'routine_authority', routineId: 'other' },
    }), /authority 冲突/i);
    assert.throws(() => store.ensureConversationAuthority({
      ...authority,
      id: 'authority-task',
      externalId: 'authority-task',
      executionLane: 'task',
      parentEventId: first.id,
    }), /conversation root/i);
  } finally {
    store.close();
  }
});

test('durable inbox deduplicates source events and atomically creates outbox messages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-store-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    assert.equal(store.enqueueEvent(envelope()).inserted, true);
    assert.equal(store.enqueueEvent(envelope('event-duplicate')).inserted, false);
    const claimed = store.claimEvent('worker-1', 60_000, new Date('2026-07-14T00:00:01.000Z'))!;
    assert.equal(claimed.id, 'event-1');
    assert.equal(claimed.attempts, 1);
    const run = store.beginRun(claimed.id, 'mimi-test');
    store.completeEvent(claimed.id, 'worker-1', { answer: 'done' }, 'completed', {
      route: { channel: 'local' }, payload: { text: 'done' },
    }, run.id);
    assert.equal(store.getEvent(claimed.id)?.status, 'completed');
    assert.equal(store.listRuns()[0]?.status, 'completed');
    const outgoing = store.claimOutbox('worker-1', 30_000, new Date('2099-07-14T00:00:02.000Z'))!;
    assert.equal(outgoing.eventId, claimed.id);
    store.completeOutbox(outgoing.id, 'worker-1');
    assert.equal(store.listOutbox()[0]?.status, 'sent');
  } finally {
    store.close();
  }
});

test('malformed queue rows are quarantined without blocking later Event or Outbox work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-poison-row-'));
  const databaseFile = path.join(root, 'mimi.db');
  const store = new MimiStore(databaseFile);
  const database = new DatabaseSync(databaseFile);
  try {
    store.enqueueEvent({ ...envelope('poison-event'), externalId: 'poison-event' });
    store.enqueueEvent({ ...envelope('healthy-event'), externalId: 'healthy-event' });
    database.prepare("UPDATE events SET payload_json = '{' WHERE id = 'poison-event'").run();

    assert.equal(store.claimEvent('worker')?.id, 'healthy-event');
    assert.equal((database.prepare("SELECT status FROM events WHERE id = 'poison-event'").get() as {
      status: string;
    }).status, 'dead_letter');

    const healthy = store.getEvent('healthy-event')!;
    store.completeEvent(healthy.id, 'worker', { ok: true }, 'completed', {
      route: { channel: 'local' }, payload: { text: 'poison' },
    });
    store.enqueueEvent({ ...envelope('outbox-source'), externalId: 'outbox-source' });
    const source = store.claimEvent('worker')!;
    store.completeEvent(source.id, 'worker', { ok: true }, 'completed', {
      route: { channel: 'local' }, payload: { text: 'healthy' },
    });
    const poisonOutbox = database.prepare("SELECT id FROM outbox WHERE payload_json LIKE '%poison%'").get() as { id: string };
    database.prepare('UPDATE outbox SET payload_json = ? WHERE id = ?').run('{', poisonOutbox.id);

    assert.match(JSON.stringify(store.claimOutbox('delivery-worker')?.payload), /healthy/);
    assert.equal((database.prepare('SELECT status FROM outbox WHERE id = ?').get(poisonOutbox.id) as {
      status: string;
    }).status, 'dead_letter');
  } finally {
    database.close();
    store.close();
  }
});

test('malformed expired and task-control rows are quarantined without poisoning recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-recovery-poison-row-'));
  const databaseFile = path.join(root, 'mimi.db');
  const store = new MimiStore(databaseFile);
  const database = new DatabaseSync(databaseFile);
  try {
    store.enqueueEvent({ ...envelope('expired-poison'), externalId: 'expired-poison', priority: 110 });
    store.enqueueEvent({ ...envelope('healthy-after-expired'), externalId: 'healthy-after-expired' });
    assert.equal(store.claimEvent('expired-owner', 1, new Date('2026-07-14T00:00:00.000Z'))?.id, 'expired-poison');
    database.prepare("UPDATE events SET payload_json = '{' WHERE id = 'expired-poison'").run();
    assert.equal(store.claimEvent('healthy-owner', 1_000, new Date('2026-07-14T00:00:01.000Z'))?.id, 'healthy-after-expired');
    assert.equal((database.prepare("SELECT status FROM events WHERE id = 'expired-poison'").get() as { status: string }).status, 'dead_letter');

    store.enqueueEvent({
      ...envelope('task-control-poison'), externalId: 'task-control-poison',
      executionLane: 'task', priority: 110,
    });
    store.enqueueEvent({
      ...envelope('healthy-task'), externalId: 'healthy-task', executionLane: 'task',
    });
    database.prepare("UPDATE events SET payload_json = '{', task_control = 'pause' WHERE id = 'task-control-poison'").run();
    assert.equal(store.claimEvent('task-owner', 1_000, new Date('2026-07-14T00:00:02.000Z'), 'task')?.id, 'healthy-task');
    assert.equal((database.prepare("SELECT status FROM events WHERE id = 'task-control-poison'").get() as { status: string }).status, 'dead_letter');
  } finally {
    database.close();
    store.close();
  }
});

test('expired sending leases become uncertain dead letters instead of being replayed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-outbox-lease-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({ ...envelope('lease-event'), externalId: 'lease-event' });
    const event = store.claimEvent('worker')!;
    store.completeEvent(event.id, 'worker', { answer: 'done' }, 'completed', {
      route: { channel: 'connector:wechat', target: 'contact:friend' },
      payload: { text: 'send once' },
    });
    const started = new Date('2099-01-01T00:00:00.000Z');
    const sending = store.claimOutbox('worker-1', 1_000, started)!;

    const recovered = store.claimOutbox('worker-2', 180_000, new Date('2099-01-01T00:00:01.001Z'));
    const original = store.getOutbox(sending.id);
    assert.equal(original?.status, 'dead_letter');
    assert.equal(original?.attempts, 1);
    assert.match(original?.error ?? '', /租约过期.*结果不确定.*不会自动重放/);
    assert.equal(recovered?.channel, 'system');
    assert.equal(recovered?.eventId, event.id);
    assert.notEqual(recovered?.id, sending.id);
  } finally {
    store.close();
  }
});

test('Codex task results hand back to the same Event for Mimi verification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-handoff-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const base = envelope('codex-task');
    store.enqueueEvent({
      ...base,
      externalId: 'codex-task',
      executionLane: 'task',
      sessionKey: 'mimi-task-codex',
      parentEventId: 'owner-root',
      rootEventId: 'owner-root',
      taskDepth: 1,
      payload: { prompt: '实现功能', objective: '实现功能', executor: 'codex' },
    });
    assert.ok(store.claimEventById('codex-task', 'codex-worker'));
    const checkpointed = store.checkpointCodexTask('codex-task', 'codex-worker', 'thread-123');
    assert.equal((checkpointed.payload as { codex: { threadId: string } }).codex.threadId, 'thread-123');
    const handed = store.handoffCodexTaskToMimi('codex-task', 'codex-worker', {
      answer: '已修改代码', usage: { total: 10 },
    });
    assert.equal(handed.id, 'codex-task');
    assert.equal(handed.status, 'queued');
    assert.equal(handed.attempts, 0);
    const payload = handed.payload as { executor: string; prompt: string; codex: { threadId: string } };
    assert.equal(payload.executor, 'mimi');
    assert.equal(payload.codex.threadId, 'thread-123');
    assert.match(payload.prompt, /必须由 MimiAgent 独立验收/);
  } finally {
    store.close();
  }
});

test('a rejected Goal gate terminates the current Event without replaying it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-completion-deferral-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({
      ...envelope('gate-task'), externalId: 'gate-task',
      payload: { completionGate: { deferrals: 999 } },
    });
    assert.ok(store.claimEventById('gate-task', 'worker'));
    const terminal = store.deferEventForCompletion(
      'gate-task', 'worker', 'missing test evidence', new Date(), undefined, 'proof-a',
    );
    assert.equal(terminal.status, 'dead_letter');
    assert.equal(terminal.attempts, 1);
    assert.equal(terminal.completionDeferrals, 1);
    assert.equal(terminal.completionNoProgressDeferrals, 1);
    assert.match(terminal.error ?? '', /不会自动重放/);
    assert.equal(store.listOutbox(10)[0]?.eventId, 'gate-task');

    const retried = store.retryDeadLetterEvent('gate-task');
    assert.equal(retried.completionDeferrals, 0);
    assert.equal(retried.completionNoProgressDeferrals, 0);
  } finally {
    store.close();
  }
});

test('a claimed event binds its resolved Session once and claim skips active Sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-session-owner-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({ ...envelope('session-owner'), sessionKey: undefined });
    const claimed = store.claimEventById('session-owner', 'worker')!;
    assert.equal(claimed.sessionKey, undefined);
    assert.equal(store.bindRunningEventSession(claimed.id, 'worker', 'mimi-fixed-session').sessionKey, 'mimi-fixed-session');
    const queued = store.preemptEvent(claimed.id, 'worker', 'wait');
    assert.equal(queued.status, 'queued');
    assert.equal(store.claimEvent('other', 60_000, new Date(queued.notBefore), undefined, 5, ['mimi-fixed-session']), undefined);

    const reclaimed = store.claimEventById(claimed.id, 'worker', 60_000, new Date(queued.notBefore))!;
    assert.throws(
      () => store.bindRunningEventSession(reclaimed.id, 'worker', 'mimi-different-session'),
      /拒绝切换/,
    );
  } finally {
    store.close();
  }
});

test('management summaries stay bounded while detail getters retain large durable fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-store-summaries-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const large = '界'.repeat(200_000);
  try {
    store.enqueueEvent({ ...envelope('large-1'), externalId: 'large-1', payload: { text: large } });
    store.enqueueEvent({ ...envelope('large-2'), externalId: 'large-2', payload: { text: large } });
    const event = store.claimEvent('worker')!;
    const run = store.beginRun(event.id, 'large-session');
    store.completeEvent(event.id, 'worker', { answer: large }, 'completed', {
      route: { channel: 'system', target: 'owner' },
      payload: { text: large },
    }, run.id);
    const schedule = store.addSchedule({
      name: 'large schedule', type: 'at', value: '2099-01-01T00:00:00.000Z', prompt: large,
      profileId: 'owner', trust: 'owner', nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    for (let index = 0; index < 204; index += 1) {
      store.addSchedule({
        name: `schedule-${index}`, type: 'at', value: '2099-01-01T00:00:00.000Z', prompt: `prompt-${index}`,
        profileId: 'owner', trust: 'owner', nextRunAt: '2099-01-01T00:00:00.000Z',
      });
    }

    const summaries = {
      events: store.listEventSummaries(20),
      runs: store.listRunSummaries(20),
      outbox: store.listOutboxSummaries(20),
      schedules: store.listScheduleSummaries(),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(summaries)) < 1024 * 1024);
    assert.doesNotMatch(JSON.stringify(summaries), /界{1000}/);
    assert.equal(summaries.events.length, 20);
    assert.equal(summaries.runs[0]?.answerAvailable, true);
    assert.equal(summaries.schedules[0]?.promptTruncated, true);
    assert.equal(summaries.schedules[0]?.promptLength, large.length);
    assert.equal(store.scheduleCount(), 205);
    const remainingSchedules = store.listScheduleSummaries(200, 200);
    assert.equal(remainingSchedules.length, 5);
    assert.equal(new Set([...summaries.schedules, ...remainingSchedules].map((item) => item.id)).size, 205);
    assert.equal((store.getEvent(event.id)?.payload as { text: string }).text, large);
    assert.equal((store.getRun(run.id)?.answer as { answer: string }).answer, large);
    assert.equal((store.getOutbox(summaries.outbox[0]!.id)?.payload as { text: string }).text, large);
    assert.equal(store.getSchedule(schedule.id)?.prompt, large);
    const revision = store.scheduleRevision();
    store.addSchedule({
      name: 'revision change', type: 'at', value: '2099-01-02T00:00:00.000Z', prompt: 'new',
      profileId: 'owner', trust: 'owner', nextRunAt: '2099-01-02T00:00:00.000Z',
    });
    assert.notEqual(store.scheduleRevision(), revision);
  } finally {
    store.close();
  }
});

test('expired event leases recover and failed work uses bounded retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-retry-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent(envelope());
    store.claimEvent('dead-worker', 1_000, new Date('2026-07-14T00:00:01.000Z'));
    assert.equal(store.claimEvent('new-worker', 60_000, new Date('2026-07-14T00:00:03.000Z')), undefined);
    const waiting = store.getEvent('event-1')!;
    assert.equal(waiting.status, 'queued');
    assert.equal(waiting.notBefore, '2026-07-14T00:00:04.000Z');
    assert.match(waiting.error ?? '', /租约过期.*退避后重试/);
    const recovered = store.claimEvent('new-worker', 60_000, new Date('2026-07-14T00:00:04.000Z'))!;
    assert.equal(recovered.leaseOwner, 'new-worker');
    const retried = store.failEvent(recovered.id, 'new-worker', new Error('temporary'), 5, new Date('2026-07-14T00:00:05.000Z'));
    assert.equal(retried.status, 'queued');
    assert.match(retried.error!, /temporary/);
  } finally {
    store.close();
  }
});

test('lease recovery honors the attempt limit fixed by the first claim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-retry-limit-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent(envelope('single-attempt'));
    assert.ok(store.claimEventById(
      'single-attempt', 'dead-worker', 1_000, new Date('2026-07-14T00:00:01.000Z'), 1,
    ));
    assert.equal(store.claimEvent(
      'recovery-worker', 60_000, new Date('2026-07-14T00:00:03.000Z'), undefined, 5,
    ), undefined);
    assert.equal(store.getEvent('single-attempt')?.status, 'dead_letter');
    assert.equal(store.getEvent('single-attempt')?.maxAttempts, 1);

    store.enqueueEvent({ ...envelope('five-attempts'), externalId: 'five-attempts' });
    assert.ok(store.claimEventById(
      'five-attempts', 'other-dead-worker', 1_000, new Date('2026-07-14T00:00:04.000Z'), 5,
    ));
    assert.equal(store.claimEvent(
      'strict-recovery-worker', 60_000, new Date('2026-07-14T00:00:06.000Z'), undefined, 1,
    ), undefined);
    assert.equal(store.getEvent('five-attempts')?.status, 'queued');
    assert.equal(store.getEvent('five-attempts')?.maxAttempts, 5);
  } finally {
    store.close();
  }
});

test('eight crash recovery probes stop at five attempts and atomically dead-letter once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-crash-retry-bound-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({ ...envelope('crash-loop'), externalId: 'crash-loop' });
    let claimAt = new Date('2026-07-14T00:00:00.000Z');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = store.claimEvent(`crashed-worker-${attempt}`, 10, claimAt)!;
      assert.equal(claimed.attempts, attempt);
      store.beginRun(claimed.id, `crash-session-${attempt}`);
      const recoveryAt = new Date(claimAt.getTime() + 11);
      assert.equal(store.claimEvent(`recovery-probe-${attempt}`, 10, recoveryAt), undefined);
      const recovered = store.getEvent(claimed.id)!;
      if (attempt === 5) {
        assert.equal(recovered.status, 'dead_letter');
        assert.match(recovered.error ?? '', /5 次有界尝试/);
      } else {
        assert.equal(recovered.status, 'queued');
        claimAt = new Date(recovered.notBefore);
      }
    }

    for (let probe = 6; probe <= 8; probe += 1) {
      assert.equal(store.claimEvent(`recovery-probe-${probe}`, 10, new Date(`2026-07-15T00:00:0${probe}.000Z`)), undefined);
    }
    const alerts = store.listOutbox();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.channel, 'system');
    assert.equal((alerts[0]?.payload as { type?: string }).type, 'event_dead_letter');
    assert.equal((alerts[0]?.payload as { attempts?: number }).attempts, 5);
    const transitions = store.activitySnapshot(20).recentTransitions;
    assert.equal(transitions.filter((entry) => entry.type === 'event.retry' && entry.entityId === 'crash-loop').length, 4);
    assert.equal(transitions.filter((entry) => entry.type === 'event.dead_letter' && entry.entityId === 'crash-loop').length, 1);
    assert.ok(store.listRuns().every((run) => run.status === 'interrupted'));
  } finally {
    store.close();
  }
});

test('an event dead letter creates one bounded system notification only at terminal failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-event-escalation-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({ ...envelope('failing-event'), externalId: 'failing-event', payload: { secret: 'DO_NOT_COPY' } });
    const first = store.claimEvent('worker', 60_000, new Date('2026-07-14T00:00:01.000Z'))!;
    const retried = store.failEvent(first.id, 'worker', new Error('provider temporarily unavailable'), 2, new Date('2026-07-14T00:00:02.000Z'));
    assert.equal(retried.status, 'queued');
    assert.deepEqual(store.listOutbox(), []);

    const second = store.claimEvent('worker', 60_000, new Date('2026-07-14T00:00:04.000Z'))!;
    const terminal = store.failEvent(second.id, 'worker', new Error('provider permanently unavailable\nwith details'), 2, new Date('2026-07-14T00:00:05.000Z'));
    assert.equal(terminal.status, 'dead_letter');
    const alerts = store.listOutbox();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.channel, 'system');
    assert.equal((alerts[0]?.payload as { type?: string }).type, 'event_dead_letter');
    assert.match(JSON.stringify(alerts[0]?.payload), /failing-event|provider permanently unavailable/);
    assert.doesNotMatch(JSON.stringify(alerts[0]?.payload), /DO_NOT_COPY/);
    assert.ok(JSON.stringify(alerts[0]?.payload).length < 2_000);
  } finally {
    store.close();
  }
});

test('explicit background task failure keeps its connector reply route while conversation failure stays system', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-failure-route-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({
      ...envelope('failed-task'),
      externalId: 'failed-task',
      executionLane: 'task',
      sessionKey: 'mimi-task-failed-task',
      replyRoute: { channel: 'connector:wechat', target: 'owner-chat' },
    });
    const task = store.claimEventById('failed-task', 'task-worker')!;
    store.failEvent(task.id, 'task-worker', new Error('build failed permanently'), 1);

    store.enqueueEvent({
      ...envelope('failed-conversation'),
      externalId: 'failed-conversation',
      replyRoute: { channel: 'connector:should-not-be-used', target: 'stale-target' },
    });
    const conversation = store.claimEventById('failed-conversation', 'conversation-worker')!;
    store.failEvent(conversation.id, 'conversation-worker', new Error('conversation failed'), 1);

    const taskAlert = store.listOutbox().find((message) => message.eventId === task.id)!;
    assert.equal(taskAlert.channel, 'connector:wechat');
    assert.equal(taskAlert.target, 'owner-chat');
    assert.deepEqual(taskAlert.payload, {
      type: 'background_task_failed',
      taskId: task.id,
      attempts: 1,
      error: 'build failed permanently',
      text: `MimiAgent 后台任务失败（${task.id}），尝试 1 次：build failed permanently`,
    });

    const conversationAlert = store.listOutbox().find((message) => message.eventId === conversation.id)!;
    assert.equal(conversationAlert.channel, 'system');
    assert.equal(conversationAlert.target, undefined);
    assert.equal((conversationAlert.payload as { type?: string }).type, 'event_dead_letter');
    assert.equal((conversationAlert.payload as { eventId?: string }).eventId, conversation.id);
  } finally {
    store.close();
  }
});

test('expired background task lease dead-letters to its original connector reply route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-expired-lease-route-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({
      ...envelope('expired-task'),
      externalId: 'expired-task',
      executionLane: 'task',
      sessionKey: 'mimi-task-expired-task',
      replyRoute: { channel: 'connector:daxiang', target: 'owner-conversation' },
    });
    let claimAt = new Date('2026-07-14T00:00:00.000Z');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = store.claimEventById('expired-task', `crashed-task-worker-${attempt}`, 10, claimAt)!;
      assert.equal(claimed.attempts, attempt);
      const recoveryAt = new Date(claimAt.getTime() + 11);
      assert.equal(store.claimEvent('recovery-worker', 10, recoveryAt), undefined);
      const recovered = store.getEvent('expired-task')!;
      if (attempt < 5) claimAt = new Date(recovered.notBefore);
    }

    assert.equal(store.getEvent('expired-task')?.status, 'dead_letter');
    const alerts = store.listOutbox();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.channel, 'connector:daxiang');
    assert.equal(alerts[0]?.target, 'owner-conversation');
    const payload = alerts[0]?.payload as {
      type?: string;
      taskId?: string;
      attempts?: number;
      error?: string;
    };
    assert.equal(payload.type, 'background_task_failed');
    assert.equal(payload.taskId, 'expired-task');
    assert.equal(payload.attempts, 5);
    assert.match(payload.error ?? '', /租约过期.*5 次有界尝试/);
  } finally {
    store.close();
  }
});

test('a dead delivery falls back to system once and a failed system fallback never recurses', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-delivery-escalation-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.rememberOwnerReplyRoute('owner', {
      channel: 'connector:work-im', target: 'private-target',
    }, new Date('2099-01-01T00:00:00.000Z'));
    store.rememberOwnerReplyRoute('family', {
      channel: 'connector:work-im', target: 'private-target',
    }, new Date('2099-01-01T00:00:00.000Z'));
    store.enqueueEvent({ ...envelope('delivery-event'), externalId: 'delivery-event' });
    const event = store.claimEvent('worker', 60_000, new Date('2026-07-14T00:00:01.000Z'))!;
    store.completeEvent(event.id, 'worker', { answer: 'done' }, 'completed', {
      route: { channel: 'connector:work-im', target: 'private-target' },
      payload: { text: 'PRIVATE_RESULT' },
    });
    const first = store.claimOutbox('worker', 30_000, new Date('2099-01-01T00:00:00.000Z'))!;
    store.failOutbox(first.id, 'worker', new Error('channel temporarily offline'), 2, new Date('2099-01-01T00:00:01.000Z'));
    assert.equal(store.listOutbox().length, 1);
    assert.equal(store.listOutbox()[0]?.status, 'pending');
    assert.deepEqual(store.recentOwnerReplyRoute('owner', 60_000, new Date('2099-01-01T00:00:01.000Z')), {
      channel: 'connector:work-im', target: 'private-target',
    });

    const second = store.claimOutbox('worker', 30_000, new Date('2099-01-01T00:00:03.000Z'))!;
    store.failOutbox(second.id, 'worker', new Error('channel permanently offline'), 2, new Date('2099-01-01T00:00:04.000Z'));
    const afterFallback = store.listOutbox();
    assert.equal(afterFallback.length, 2);
    const original = afterFallback.find((message) => message.id === first.id)!;
    const fallback = afterFallback.find((message) => message.channel === 'system')!;
    assert.equal(original.status, 'dead_letter');
    assert.equal(fallback.status, 'pending');
    assert.equal((fallback.payload as { type?: string }).type, 'delivery_dead_letter');
    assert.match(JSON.stringify(fallback.payload), /connector:work-im|channel permanently offline/);
    assert.doesNotMatch(JSON.stringify(fallback.payload), /PRIVATE_RESULT|private-target/);
    assert.equal(store.recentOwnerReplyRoute('owner', 60_000, new Date('2099-01-01T00:00:04.000Z')), undefined);
    assert.deepEqual(store.recentOwnerReplyRoute('family', 60_000, new Date('2099-01-01T00:00:04.000Z')), {
      channel: 'connector:work-im', target: 'private-target',
    });

    const claimedFallback = store.claimOutbox('worker', 30_000, new Date('2099-01-01T00:00:05.000Z'))!;
    assert.equal(claimedFallback.id, fallback.id);
    store.failOutbox(fallback.id, 'worker', new Error('system notification unavailable'), 1, new Date('2099-01-01T00:00:06.000Z'));
    assert.equal(store.listOutbox().length, 2);
    assert.equal(store.listOutbox().find((message) => message.id === fallback.id)?.status, 'dead_letter');
  } finally {
    store.close();
  }
});

test('dead letters can be explicitly retried with the same id or archived', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dead-letter-repair-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({ ...envelope('repair-event'), externalId: 'repair-event' });
    const failed = store.claimEvent('worker')!;
    store.failEvent(failed.id, 'worker', new Error('first event failure'), 1);

    const retried = store.retryDeadLetterEvent(failed.id, new Date('2026-07-15T08:00:00.000Z'));
    assert.equal(retried.id, failed.id);
    assert.equal(retried.status, 'queued');
    assert.equal(retried.attempts, 0);
    assert.equal(retried.error, undefined);
    const reclaimed = store.claimEvent('worker', 60_000, new Date('2026-07-15T08:00:01.000Z'))!;
    assert.equal(reclaimed.id, failed.id);
    assert.equal(reclaimed.attempts, 1);
    store.failEvent(reclaimed.id, 'worker', new Error('second event failure'), 1);
    assert.equal(store.archiveDeadLetterEvent(failed.id).status, 'archived');
    assert.notEqual(store.claimEvent('worker')?.id, failed.id);

    store.enqueueEvent({
      ...envelope('repair-outbox-event'), externalId: 'repair-outbox-event', replyRoute: { channel: 'system' },
    });
    const deliveredEvent = store.claimEvent('worker')!;
    store.completeEvent(deliveredEvent.id, 'worker', { answer: 'done' }, 'completed', {
      route: { channel: 'system' }, payload: { text: 'result' },
    });
    let failedDelivery = store.claimOutbox('worker')!;
    while (failedDelivery.eventId !== deliveredEvent.id) {
      store.completeOutbox(failedDelivery.id, 'worker');
      failedDelivery = store.claimOutbox('worker')!;
    }
    store.failOutbox(failedDelivery.id, 'worker', new Error('first delivery failure'), 1);

    const retriedDelivery = store.retryDeadLetterOutbox(failedDelivery.id, new Date('2026-07-15T08:00:02.000Z'));
    assert.equal(retriedDelivery.id, failedDelivery.id);
    assert.equal(retriedDelivery.status, 'pending');
    assert.equal(retriedDelivery.attempts, 0);
    const reclaimedDelivery = store.claimOutbox('worker', 30_000, new Date('2026-07-15T08:00:03.000Z'))!;
    assert.equal(reclaimedDelivery.id, failedDelivery.id);
    assert.equal(reclaimedDelivery.attempts, 1);
    store.failOutbox(reclaimedDelivery.id, 'worker', new Error('second delivery failure'), 1);
    assert.equal(store.archiveDeadLetterOutbox(failedDelivery.id).status, 'archived');
    assert.notEqual(store.claimOutbox('worker')?.id, failedDelivery.id);

    assert.equal(store.counts().events.archived, 1);
    assert.equal(store.counts().outbox.archived, 1);
  } finally {
    store.close();
  }
});

test('dead-letter controls reject live and unknown records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dead-letter-state-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent(envelope());
    assert.throws(() => store.retryDeadLetterEvent('event-1'), /不是 dead letter/);
    assert.throws(() => store.archiveDeadLetterEvent('missing'), /不是 dead letter/);
    assert.throws(() => store.retryDeadLetterOutbox('missing'), /不是 dead letter/);
    assert.throws(() => store.archiveDeadLetterOutbox('missing'), /不是 dead letter/);
    assert.equal(store.getEvent('event-1')?.status, 'queued');
  } finally {
    store.close();
  }
});

test('history retention removes explicitly archived dead letters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-archived-retention-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    store.enqueueEvent({ ...envelope('archived-event'), externalId: 'archived-event' });
    const event = store.claimEvent('worker')!;
    store.failEvent(event.id, 'worker', new Error('archive me'), 1);
    const fallback = store.claimOutbox('worker')!;
    store.completeOutbox(fallback.id, 'worker');
    store.archiveDeadLetterEvent(event.id);

    store.enqueueEvent({ ...envelope('archived-outbox-event'), externalId: 'archived-outbox-event' });
    const source = store.claimEvent('worker')!;
    store.completeEvent(source.id, 'worker', {}, 'completed', {
      route: { channel: 'system' }, payload: { text: 'archive delivery' },
    });
    const outgoing = store.claimOutbox('worker')!;
    store.failOutbox(outgoing.id, 'worker', new Error('archive delivery'), 1);
    store.archiveDeadLetterOutbox(outgoing.id);

    const old = '2025-01-01T00:00:00.000Z';
    const database = new DatabaseSync(file);
    database.prepare('UPDATE events SET created_at = ?, updated_at = ?').run(old, old);
    database.prepare('UPDATE outbox SET created_at = ?, updated_at = ?').run(old, old);
    database.prepare('UPDATE audit_events SET created_at = ?').run(old);
    database.close();

    const removed = store.pruneHistory(new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(removed.outbox, 2);
    assert.equal(removed.events, 2);
    assert.equal(store.getEvent(event.id), undefined);
    assert.equal(store.getEvent(source.id), undefined);
    assert.deepEqual(store.listOutbox(), []);
  } finally {
    store.close();
  }
});

test('activity snapshot reports bounded operational metadata without cross-event content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-activity-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    store.enqueueEvent({
      ...envelope('activity-completed'), externalId: 'activity-completed',
      payload: { prompt: 'EVENT_CONTENT_MUST_NOT_LEAK' },
    });
    const completed = store.claimEvent('worker')!;
    const completedRun = store.beginRun(completed.id, 'private-session');
    store.completeEvent(completed.id, 'worker', {
      answer: 'RUN_ANSWER_MUST_NOT_LEAK',
    }, 'completed', {
      route: { channel: 'connector:private', target: 'TARGET_MUST_NOT_LEAK' },
      payload: { text: 'DELIVERY_CONTENT_MUST_NOT_LEAK' },
    }, completedRun.id);

    store.enqueueEvent({ ...envelope('activity-dead'), externalId: 'activity-dead' });
    const failed = store.claimEvent('worker')!;
    const failedRun = store.beginRun(failed.id, 'failed-session');
    store.failEvent(failed.id, 'worker', new Error(`failure-${'x'.repeat(1_000)}`), 1, new Date(), failedRun.id);

    const snapshot = store.activitySnapshot(20);
    assert.equal(snapshot.needsAttention, true);
    assert.equal(snapshot.workPending, 2);
    assert.equal(snapshot.pendingDigest, 0);
    assert.equal(snapshot.events.completed, 1);
    assert.equal(snapshot.events.dead_letter, 1);
    assert.equal(snapshot.outbox.pending, 2);
    assert.equal(snapshot.recentEvents.length, 2);
    assert.equal(snapshot.recentRuns.length, 2);
    assert.equal(snapshot.recentDeliveries.length, 2);
    assert.ok(snapshot.recentTransitions.some((entry) => entry.type === 'event.dead_letter'));
    assert.ok((snapshot.recentEvents.find((entry) => entry.id === failed.id)?.error?.length ?? 0) <= 500);
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      'EVENT_CONTENT_MUST_NOT_LEAK', 'RUN_ANSWER_MUST_NOT_LEAK',
      'TARGET_MUST_NOT_LEAK', 'DELIVERY_CONTENT_MUST_NOT_LEAK', 'private-session',
    ]) assert.doesNotMatch(serialized, new RegExp(secret));
    assert.equal(store.activitySnapshot(0).recentEvents.length, 1);
  } finally {
    store.close();
  }
});

test('background tasks persist pause, blocked, resume, notification, and cancellation transitions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-lifecycle-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const base = {
    ...envelope('task-lifecycle'),
    externalId: 'task-lifecycle',
    executionLane: 'task' as const,
    sessionKey: 'mimi-task-lifecycle',
    payload: { prompt: '完成长期任务', objective: '长期任务' },
  };
  try {
    store.enqueueEvent(base);
    const pausedBeforeStart = store.pauseQueuedEvent(base.id, '等待依赖', new Date('2026-07-14T00:00:01.000Z'));
    assert.equal(pausedBeforeStart.status, 'paused');
    assert.equal(store.claimEvent('worker', 60_000, new Date('2026-07-14T00:00:02.000Z'), 'task'), undefined);
    assert.equal(store.counts().events.paused, 1);

    const resumed = store.resumeBackgroundTask(
      base.id,
      '依赖已经准备好',
      new Date('2026-07-14T00:00:03.000Z'),
    );
    assert.equal(resumed.status, 'queued');
    assert.match((resumed.payload as { prompt: string }).prompt, /恢复补充上下文\n依赖已经准备好/);
    assert.equal(resumed.error, undefined);

    const firstRun = store.claimEvent('worker-1', 60_000, new Date('2026-07-14T00:00:04.000Z'), 'task')!;
    const firstRunRecord = store.beginRun(firstRun.id, firstRun.sessionKey!);
    assert.throws(() => store.pauseRunningEvent(
      firstRun.id,
      'wrong-worker',
      '暂停',
      firstRunRecord.id,
      new Date('2026-07-14T00:00:05.000Z'),
    ), /租约已失效/);
    const pausedDuringRun = store.pauseRunningEvent(
      firstRun.id,
      'worker-1',
      '用户暂时不需要',
      firstRunRecord.id,
      new Date('2026-07-14T00:00:05.000Z'),
    );
    assert.equal(pausedDuringRun.status, 'paused');
    assert.equal(pausedDuringRun.attempts, 0);
    assert.equal(store.getRun(firstRunRecord.id)?.status, 'interrupted');

    store.resumeBackgroundTask(base.id, undefined, new Date('2026-07-14T00:00:06.000Z'));
    const secondRun = store.claimEvent('worker-2', 60_000, new Date('2026-07-14T00:00:07.000Z'), 'task')!;
    const secondRunRecord = store.beginRun(secondRun.id, secondRun.sessionKey!);
    assert.throws(() => store.blockRunningEvent(
      secondRun.id,
      'wrong-worker',
      { answer: '需要路径' },
      '缺少目标路径',
      { route: { channel: 'system' }, payload: { text: '请提供路径' } },
      secondRunRecord.id,
    ), /租约已失效/);
    assert.equal(store.listOutbox().length, 0);

    const blocked = store.blockRunningEvent(
      secondRun.id,
      'worker-2',
      { answer: '需要路径', question: '目标路径是什么？' },
      '缺少目标路径',
      { route: { channel: 'system' }, payload: { text: '目标路径是什么？' } },
      secondRunRecord.id,
      new Date('2026-07-14T00:00:08.000Z'),
    );
    assert.equal(blocked.status, 'blocked');
    assert.deepEqual(blocked.result, { answer: '需要路径', question: '目标路径是什么？' });
    assert.equal(store.getRun(secondRunRecord.id)?.status, 'interrupted');
    assert.equal(store.listOutbox()[0]?.eventId, base.id);
    assert.equal(store.counts().events.blocked, 1);
    assert.equal(store.activitySnapshot().needsAttention, true);
    assert.equal(store.activitySnapshot().workPending, 2);

    assert.throws(() => store.resumeBackgroundTask(base.id, 'x'.repeat(4_001)), /不能超过 4000/);
    assert.equal(store.getEvent(base.id)?.status, 'blocked');
    assert.equal(store.cancelQueuedEvent(base.id, '用户取消等待中的任务'), true);
    assert.equal(store.getEvent(base.id)?.status, 'archived');
  } finally {
    store.close();
  }
});

test('durable running-task controls survive restart, cancel wins, and recovery never replays work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-control-recovery-'));
  const file = path.join(root, 'mimi.db');
  let store = new MimiStore(file);
  try {
    for (const id of [
      'cancel-after-crash',
      'pause-after-crash',
      'pause-on-worker-exit',
      'cancel-before-terminal-write',
    ]) {
      store.enqueueEvent({
        ...envelope(id),
        externalId: id,
        executionLane: 'task',
        sessionKey: `mimi-task-${id}`,
      });
    }
    const startedAt = new Date('2026-07-14T00:00:01.000Z');
    const cancelTask = store.claimEventById('cancel-after-crash', 'dead-worker-1', 1_000, startedAt)!;
    const cancelRun = store.beginRun(cancelTask.id, cancelTask.sessionKey!);
    const firstPause = store.requestRunningTaskControl(
      cancelTask.id,
      'pause',
      'pause first',
      new Date('2026-07-14T00:00:01.100Z'),
    )!;
    assert.equal(firstPause.taskControl, 'pause');
    const cancelled = store.requestRunningTaskControl(
      cancelTask.id,
      'cancel',
      'cancel must win',
      new Date('2026-07-14T00:00:01.200Z'),
    )!;
    assert.equal(cancelled.taskControl, 'cancel');
    const latePause = store.requestRunningTaskControl(
      cancelTask.id,
      'pause',
      'must not replace cancel',
      new Date('2026-07-14T00:00:01.300Z'),
    )!;
    assert.equal(latePause.taskControl, 'cancel');
    assert.equal(latePause.taskControlReason, 'cancel must win');

    const pauseTask = store.claimEventById('pause-after-crash', 'dead-worker-2', 1_000, startedAt)!;
    const pauseRun = store.beginRun(pauseTask.id, pauseTask.sessionKey!);
    store.requestRunningTaskControl(
      pauseTask.id,
      'pause',
      'keep progress for later',
      new Date('2026-07-14T00:00:01.100Z'),
    );

    const exitingTask = store.claimEventById('pause-on-worker-exit', 'exiting-worker', 60_000, startedAt)!;
    const exitingRun = store.beginRun(exitingTask.id, exitingTask.sessionKey!);
    store.requestRunningTaskControl(exitingTask.id, 'pause', 'worker lost IPC');
    const settledExit = store.failEvent(
      exitingTask.id,
      'exiting-worker',
      new Error('worker exited'),
      5,
      new Date('2026-07-14T00:00:01.500Z'),
      exitingRun.id,
    );
    assert.equal(settledExit.status, 'paused');
    assert.equal(settledExit.attempts, 0);
    assert.equal(settledExit.taskControl, undefined);

    const terminalRace = store.claimEventById(
      'cancel-before-terminal-write',
      'terminal-race-worker',
      60_000,
      startedAt,
    )!;
    store.requestRunningTaskControl(terminalRace.id, 'cancel', 'cancel before terminal write');
    assert.throws(
      () => store.digestEvent(terminalRace.id, 'terminal-race-worker', 'would incorrectly digest'),
      /租约已失效/,
    );
    assert.throws(
      () => store.completeEvent(terminalRace.id, 'terminal-race-worker', { answer: 'too late' }),
      /租约已失效/,
    );
    const settledTerminalRace = store.failEvent(
      terminalRace.id,
      'terminal-race-worker',
      new Error('control reconciliation'),
    );
    assert.equal(settledTerminalRace.status, 'archived');
    assert.equal(settledTerminalRace.error, 'cancel before terminal write');

    store.close();
    store = new MimiStore(file);
    assert.deepEqual(store.readyBackgroundTasks(10, new Date('2026-07-14T00:00:02.001Z')), []);

    const recoveredCancel = store.getEvent(cancelTask.id)!;
    assert.equal(recoveredCancel.status, 'archived');
    assert.equal(recoveredCancel.error, 'cancel must win');
    assert.equal(recoveredCancel.taskControl, undefined);
    assert.equal(store.getRun(cancelRun.id)?.status, 'interrupted');

    const recoveredPause = store.getEvent(pauseTask.id)!;
    assert.equal(recoveredPause.status, 'paused');
    assert.equal(recoveredPause.error, 'keep progress for later');
    assert.equal(recoveredPause.attempts, 0);
    assert.equal(recoveredPause.taskControl, undefined);
    assert.equal(store.getRun(pauseRun.id)?.status, 'interrupted');

    const transitions = store.activitySnapshot(50).recentTransitions;
    assert.equal(transitions.some((entry) => entry.type === 'event.cancelled'
      && entry.entityId === cancelTask.id), true);
    assert.equal(transitions.some((entry) => entry.type === 'event.paused'
      && entry.entityId === pauseTask.id), true);
  } finally {
    store.close();
  }
});

test('paused and blocked tasks are retained as unfinished state during history pruning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-retention-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    store.enqueueEvent({
      ...envelope('paused-task'), externalId: 'paused-task', executionLane: 'task', sessionKey: 'paused-task',
    });
    store.pauseQueuedEvent('paused-task', '稍后继续');
    store.enqueueEvent({
      ...envelope('blocked-task'), externalId: 'blocked-task', executionLane: 'task', sessionKey: 'blocked-task',
    });
    const running = store.claimEventById('blocked-task', 'worker')!;
    store.blockRunningEvent(
      running.id,
      'worker',
      { question: '请选择方案' },
      '等待用户选择',
      { route: { channel: 'system' }, payload: { text: '请选择方案' } },
    );
    store.enqueueEvent({ ...envelope('task-root'), externalId: 'task-root' });
    const taskRoot = store.claimEventById('task-root', 'worker')!;
    store.completeEvent(taskRoot.id, 'worker', { answer: 'delegated' });
    store.enqueueEvent({
      ...envelope('root-child'),
      externalId: 'root-child',
      executionLane: 'task',
      sessionKey: 'root-child',
      parentEventId: taskRoot.id,
      rootEventId: taskRoot.id,
      taskDepth: 1,
    });
    store.pauseQueuedEvent('root-child', '保留来源授权链');
    const database = new DatabaseSync(file);
    database.prepare('UPDATE events SET created_at = ?, updated_at = ?').run(
      '2025-01-01T00:00:00.000Z',
      '2025-01-01T00:00:00.000Z',
    );
    database.prepare('UPDATE audit_events SET created_at = ?').run('2025-01-01T00:00:00.000Z');
    database.close();

    const removed = store.pruneHistory(new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(removed.events, 0);
    assert.equal(store.getEvent('paused-task')?.status, 'paused');
    assert.equal(store.getEvent('blocked-task')?.status, 'blocked');
    assert.equal(store.getEvent('task-root')?.status, 'completed');
    assert.equal(store.getEvent('root-child')?.status, 'paused');
  } finally {
    store.close();
  }
});

test('urgent ready events can preempt without consuming a failure attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-preempt-store-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const at = new Date('2026-07-14T10:00:00.000Z');
  try {
    store.enqueueEvent({
      ...envelope('low'), externalId: 'low', priority: 40,
      occurredAt: '2026-07-14T09:59:00.000Z', receivedAt: '2026-07-14T09:59:00.000Z',
    });
    const low = store.claimEvent('worker', 60_000, at)!;
    const run = store.beginRun(low.id, 'mimi-low');
    store.enqueueEvent({
      ...envelope('equal'), externalId: 'equal', priority: 40,
      receivedAt: '2026-07-14T10:00:01.000Z',
    });
    store.enqueueEvent({
      ...envelope('urgent'), externalId: 'urgent', priority: 95,
      receivedAt: '2026-07-14T10:00:01.000Z',
    });
    store.enqueueEvent({
      ...envelope('future'), externalId: 'future', priority: 100,
      receivedAt: '2026-07-15T10:00:00.000Z',
    });

    assert.deepEqual(
      store.readyEventsAbove(95, low.priority, 10, new Date('2026-07-14T10:00:02.000Z'))
        .map((candidate) => ({ id: candidate.id, priority: candidate.priority })),
      [{ id: 'urgent', priority: 95 }],
    );
    assert.deepEqual(store.readyEventsAbove(95, 95, 10, new Date('2026-07-14T10:00:02.000Z')), []);
    const preempted = store.preemptEvent(
      low.id, 'worker', '被紧急事件 urgent（priority 95）抢占', new Date('2026-07-14T10:00:03.000Z'), run.id,
    );
    assert.equal(preempted.status, 'queued');
    assert.equal(preempted.attempts, 0);
    assert.equal(preempted.leaseOwner, undefined);
    assert.match(preempted.error ?? '', /urgent/);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.equal(store.claimEvent('next-worker', 60_000, new Date('2026-07-14T10:00:04.000Z'))?.id, 'urgent');
  } finally {
    store.close();
  }
});

test('a newer owner command supersedes an active same-session event without requeueing it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-supersede-store-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const at = new Date('2026-07-15T10:00:00.000Z');
  try {
    store.enqueueEvent({ ...envelope('old-owner-command'), externalId: 'old-owner-command' });
    const active = store.claimEvent('worker', 60_000, at)!;
    const run = store.beginRun(active.id, 'mimi-owner');
    const superseded = store.supersedeEvent(
      active.id, 'worker', 'new-owner-command',
      '被当前 Session 的新 owner 命令 new-owner-command 取代',
      new Date('2026-07-15T10:00:01.000Z'), run.id,
    );
    assert.equal(superseded.status, 'archived');
    assert.equal(superseded.leaseOwner, undefined);
    assert.match(superseded.error ?? '', /new-owner-command.*取代/);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.ok(store.activitySnapshot().recentTransitions.some((entry) => (
      entry.type === 'event.superseded' && entry.entityId === active.id
    )));
    assert.equal(store.claimEvent('next-worker', 60_000, new Date('2026-07-15T10:00:02.000Z')), undefined);
  } finally {
    store.close();
  }
});

test('recent owner reply routes are profile-scoped, bounded and expire to allow fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-owner-route-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const now = new Date('2026-07-15T10:00:00.000Z');
  try {
    store.rememberOwnerReplyRoute('owner', { channel: 'connector:qq', target: ' private:123 ' }, now);
    assert.deepEqual(store.recentOwnerReplyRoute('owner', 60_000, now), {
      channel: 'connector:qq', target: 'private:123',
    });
    assert.equal(store.recentOwnerReplyRoute('family', 60_000, now), undefined);
    assert.equal(store.recentOwnerReplyRoute('owner', 60_000, new Date(now.getTime() + 60_001)), undefined);
    assert.throws(() => store.rememberOwnerReplyRoute('owner', { channel: 'system' }, now), /channel 和 target/);
  } finally {
    store.close();
  }
});

test('due schedules produce exactly one idempotent event per occurrence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const schedule = store.addSchedule({
      name: 'morning', type: 'at', value: '2026-07-14T08:00:00.000Z', prompt: 'brief me',
      profileId: 'owner', trust: 'owner', nextRunAt: '2026-07-14T08:00:00.000Z',
    });
    const authority = store.getEvent(schedule.authorityEventId!);
    assert.equal(authority?.source, 'mimi:schedule-authority');
    assert.equal(authority?.trust, 'owner');
    assert.equal(authority?.status, 'completed');
    const [emitted] = store.emitDueSchedules(new Date('2026-07-14T08:00:01.000Z'));
    assert.equal(emitted?.rootEventId, authority?.id);
    assert.equal(emitted?.executionLane, 'task');
    assert.equal(store.emitDueSchedules(new Date('2026-07-14T08:00:02.000Z')).length, 0);
    assert.equal(store.listSchedules()[0]?.enabled, false);
  } finally {
    store.close();
  }
});

test('a due schedule runs in an independent Task lane without occupying its origin Conversation Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-task-lane-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const dueAt = new Date('2026-07-15T08:00:01.000Z');
  try {
    const authority = store.ensureConversationAuthority({
      ...envelope('origin-authority'), externalId: 'origin-authority', sessionKey: 'shared-conversation',
      replyRoute: { channel: 'connector:wechat', target: 'owner' },
    });
    store.addSchedule({
      name: 'long follow-up', type: 'at', value: '2026-07-15T08:00:00.000Z', prompt: 'finish long work',
      profileId: 'owner', sessionKey: 'shared-conversation', authorityEventId: authority.id, trust: 'owner',
      replyRoute: authority.replyRoute, nextRunAt: '2026-07-15T08:00:00.000Z',
    });
    const task = store.emitDueSchedules(dueAt)[0]!;
    assert.equal(task.executionLane, 'task');
    assert.equal(task.originSessionKey, 'shared-conversation');
    assert.notEqual(task.sessionKey, task.originSessionKey);
    assert.equal(store.claimEvent('task-worker', 60_000, dueAt, 'task')?.id, task.id);

    store.enqueueEvent({
      ...envelope('next-message'), externalId: 'next-message', sessionKey: 'shared-conversation',
      occurredAt: dueAt.toISOString(), receivedAt: dueAt.toISOString(),
    });
    assert.equal(store.claimEvent('conversation-worker', 60_000, dueAt, 'conversation')?.id, 'next-message');
    assert.equal(store.getEvent(task.id)?.status, 'running');
  } finally {
    store.close();
  }
});

test('history retention preserves an authority root while a schedule still references it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-authority-retention-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  try {
    const authority = store.ensureConversationAuthority({
      ...envelope('retained-authority'), externalId: 'retained-authority', sessionKey: 'retained-session',
    });
    const schedule = store.addSchedule({
      name: 'future', type: 'interval', value: '3600000', prompt: 'future work', profileId: 'owner',
      sessionKey: 'retained-session', authorityEventId: authority.id, trust: 'owner',
      nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    const database = new DatabaseSync(file);
    database.prepare('UPDATE events SET created_at = ?, updated_at = ? WHERE id = ?')
      .run('2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', authority.id);
    database.close();
    store.pruneHistory(new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(store.getEvent(authority.id)?.status, 'completed');
    assert.equal(store.removeSchedule(schedule.id), true);
    store.pruneHistory(new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(store.getEvent(authority.id), undefined);
  } finally {
    store.close();
  }
});

test('schedule persistence rejects invalid explicit session ids before insert', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-session-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    assert.throws(() => store.addSchedule({
      name: 'invalid', type: 'at', value: '2026-07-14T08:00:00.000Z', prompt: 'brief me',
      profileId: 'owner', sessionKey: 'invalid.session', trust: 'owner',
      nextRunAt: '2026-07-14T08:00:00.000Z',
    }), /只能包含字母/);
    assert.throws(() => store.addSchedule({
      name: 'unrooted external', type: 'at', value: '2026-07-14T08:00:00.000Z', prompt: 'brief me',
      profileId: 'owner', trust: 'external', nextRunAt: '2026-07-14T08:00:00.000Z',
    }), /原始 Conversation authority/);
    assert.deepEqual(store.listSchedules(), []);
  } finally {
    store.close();
  }
});

test('removing a schedule atomically archives its emitted but unstarted occurrence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-cancel-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const schedule = store.addSchedule({
      name: 'obsolete check', type: 'interval', value: '900000', prompt: 'do not run',
      profileId: 'owner', trust: 'owner', nextRunAt: '2026-07-15T08:00:00.000Z',
    });
    const [emitted] = store.emitDueSchedules(new Date('2026-07-15T08:00:01.000Z'));
    assert.equal(emitted?.status, 'queued');

    assert.equal(store.removeSchedule(schedule.id, new Date('2026-07-15T08:00:02.000Z')), true);
    assert.equal(store.getSchedule(schedule.id), undefined);
    assert.equal(store.getEvent(emitted!.id)?.status, 'archived');
    assert.match(store.getEvent(emitted!.id)?.error ?? '', /schedule cancelled/);
    assert.equal(store.claimEvent('worker', 60_000, new Date('2026-07-15T08:00:03.000Z')), undefined);
    assert.equal(store.removeSchedule(schedule.id), false);
  } finally {
    store.close();
  }
});

test('a related session event wakes only conditional watches without disturbing routine schedules', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-watch-wakeup-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const future = '2026-07-15T10:00:00.000Z';
    const matching = store.addSchedule({
      name: 'contract', type: 'watch', value: '900000', prompt: 'check contract', profileId: 'owner',
      sessionKey: 'mimi-person-alice', trust: 'owner', nextRunAt: future,
    });
    const routine = store.addSchedule({
      name: 'routine', type: 'interval', value: '900000', prompt: 'routine check', profileId: 'owner',
      sessionKey: 'mimi-person-alice', trust: 'owner', nextRunAt: future,
    });
    const unrelated = store.addSchedule({
      name: 'other', type: 'watch', value: '900000', prompt: 'other check', profileId: 'owner',
      sessionKey: 'mimi-person-bob', trust: 'owner', nextRunAt: future,
    });
    const now = new Date('2026-07-15T09:00:00.000Z');
    assert.equal(store.wakeWatches('mimi-person-alice', 'incoming-mail', now), 1);
    assert.equal(store.wakeWatches('mimi-person-alice', 'same-mail', now), 0);
    assert.equal(store.getSchedule(matching.id)?.nextRunAt, now.toISOString());
    assert.equal(store.getSchedule(routine.id)?.nextRunAt, future);
    assert.equal(store.getSchedule(unrelated.id)?.nextRunAt, future);
    const emitted = store.emitDueSchedules(now);
    assert.deepEqual(emitted.map((item) => item.payload), [{
      type: 'scheduled_task', prompt: 'check contract', objective: 'check contract', strategy: 'single',
      workspaceAccess: 'write', scheduleId: matching.id, scheduleType: 'watch', name: 'contract',
    }]);
    assert.equal(store.getSchedule(matching.id)?.nextRunAt, '2026-07-15T09:15:00.000Z');
  } finally {
    store.close();
  }
});

test('history retention removes only old unreferenced terminal state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-retention-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  const old = '2025-01-01T00:00:00.000Z';
  try {
    store.enqueueEvent({ ...envelope('completed-old'), externalId: 'completed-old' });
    const completed = store.claimEvent('worker')!;
    const run = store.beginRun(completed.id, 'retention-completed');
    store.completeEvent(completed.id, 'worker', { answer: 'done' }, 'completed', {
      route: { channel: 'local' }, payload: { text: 'delivered' },
    }, run.id);
    const sent = store.claimOutbox('worker')!;
    store.completeOutbox(sent.id, 'worker');

    store.enqueueEvent({ ...envelope('dead-old'), externalId: 'dead-old' });
    const dead = store.claimEvent('worker')!;
    store.failEvent(dead.id, 'worker', new Error('keep for repair'), 1);

    store.enqueueEvent({ ...envelope('archived-digest-old'), externalId: 'archived-digest-old' });
    const archivedDigest = store.claimEvent('worker')!;
    store.digestEvent(archivedDigest.id, 'worker', 'already briefed');

    store.enqueueEvent({ ...envelope('pending-digest-old'), externalId: 'pending-digest-old' });
    const pendingDigest = store.claimEvent('worker')!;
    store.digestEvent(pendingDigest.id, 'worker', 'still pending');

    store.enqueueEvent({ ...envelope('queued-old'), externalId: 'queued-old' });
    const disabledSchedule = store.addSchedule({
      name: 'expired-once', type: 'at', value: old, prompt: 'old follow-up', profileId: 'owner',
      trust: 'owner', nextRunAt: old,
    });
    const activeSchedule = store.addSchedule({
      name: 'future-routine', type: 'interval', value: '3600000', prompt: 'future check', profileId: 'owner',
      trust: 'owner', nextRunAt: '2099-01-01T00:00:00.000Z',
    });
    store.emitDueSchedules(new Date('2026-07-15T00:00:00.000Z'));

    const database = new DatabaseSync(file);
    database.exec('PRAGMA journal_mode=WAL;');
    database.prepare('UPDATE events SET created_at = ?, updated_at = ?').run(old, old);
    database.prepare('UPDATE runs SET started_at = ?, completed_at = ?').run(old, old);
    database.prepare('UPDATE outbox SET created_at = ?, updated_at = ?').run(old, old);
    database.prepare('UPDATE digest_items SET created_at = ?').run(old);
    database.prepare('UPDATE digest_items SET digested_at = ? WHERE event_id = ?').run(old, archivedDigest.id);
    database.prepare('UPDATE schedules SET created_at = ?, updated_at = ?').run(old, old);
    database.prepare(`
      INSERT INTO attention_state (key, value, updated_at) VALUES ('briefing:old', 'created', ?)
    `).run(old);
    database.prepare('UPDATE audit_events SET created_at = ?').run(old);
    database.close();

    const removed = store.pruneHistory(new Date('2026-01-01T00:00:00.000Z'));
    assert.deepEqual(removed, {
      outbox: 1,
      digestItems: 1,
      runs: 1,
      events: 2,
      schedules: 1,
      attentionState: 1,
      auditEvents: 5,
    });
    assert.equal(store.getEvent(completed.id), undefined);
    assert.equal(store.getEvent(archivedDigest.id), undefined);
    assert.equal(store.getEvent(dead.id)?.status, 'dead_letter');
    assert.equal(store.getEvent(pendingDigest.id)?.status, 'digested');
    assert.equal(store.getEvent('queued-old')?.status, 'queued');
    assert.deepEqual(store.listSchedules().map((schedule) => schedule.id), [activeSchedule.id]);
    assert.equal(store.listSchedules().some((schedule) => schedule.id === disabledSchedule.id), false);
    assert.equal(store.listOutbox().length, 1);
    assert.equal(store.listOutbox()[0]?.status, 'pending');

    const inspected = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal((inspected.prepare('SELECT COUNT(*) AS count FROM digest_items WHERE digested_at IS NULL').get() as { count: number }).count, 1);
      assert.equal((inspected.prepare('SELECT COUNT(*) AS count FROM attention_state').get() as { count: number }).count, 0);
      assert.equal((inspected.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?').get(dead.id) as { count: number }).count, 1);
      assert.equal((inspected.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?').get(completed.id) as { count: number }).count, 0);
    } finally {
      inspected.close();
    }
  } finally {
    store.close();
  }
});

test('new stores use the minimal open-permission schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schema-'));
  const file = path.join(root, 'mimi.db');
  const store = new MimiStore(file);
  store.close();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(version.user_version, 11);
    const eventColumns = new Set((database.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>)
      .map((column) => column.name));
    assert.equal(eventColumns.has('task_control'), true);
    assert.equal(eventColumns.has('task_control_reason'), true);
    const scheduleColumns = new Set((database.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>)
      .map((column) => column.name));
    assert.equal(scheduleColumns.has('authority_event_id'), true);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'events_retention_idx'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'audit_retention_idx'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'digest_items'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE name = 'attention_state'").get());
    for (const removed of ['actions', 'approvals', 'mandates', 'mandate_uses']) {
      assert.equal(database.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(removed), undefined);
    }
  } finally {
    database.close();
  }
});

test('legacy databases migrate to v11 without dropping historical tables', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schema-legacy-'));
  const file = path.join(root, 'mimi.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE approvals (id TEXT PRIMARY KEY) STRICT;
    INSERT INTO approvals (id) VALUES ('historical-approval');
    PRAGMA user_version = 4;
  `);
  legacy.close();
  const store = new MimiStore(file);
  store.close();
  const migrated = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11);
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get());
    assert.equal((migrated.prepare('SELECT id FROM approvals').get() as { id: string }).id, 'historical-approval');
  } finally {
    migrated.close();
  }
});

test('v8 owner/system schedules gain durable roots while unrooted external schedules are disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schema-v8-schedule-'));
  const file = path.join(root, 'mimi.db');
  const initial = new MimiStore(file);
  const owner = initial.addSchedule({
    name: 'legacy owner interval', type: 'interval', value: '900000', prompt: 'owner check',
    profileId: 'owner', sessionKey: 'legacy-owner', trust: 'owner',
    nextRunAt: '2026-07-15T08:00:00.000Z',
  });
  const system = initial.addSchedule({
    name: 'legacy system watch', type: 'watch', value: '900000', prompt: 'system check',
    profileId: 'system', sessionKey: 'legacy-system', trust: 'system',
    nextRunAt: '2026-07-15T08:00:00.000Z',
  });
  initial.close();
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    INSERT INTO schedules (
      id, name, schedule_type, schedule_value, prompt, profile_id, session_key,
      authority_event_id, reply_route_json, trust, enabled, next_run_at, last_run_at, created_at, updated_at
    ) VALUES (
      'legacy-external', 'legacy external', 'interval', '900000', 'external check', 'owner',
      'legacy-external', NULL, 'null', 'external', 1, '2026-07-15T08:00:00.000Z', NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    DELETE FROM events WHERE source = 'mimi:schedule-authority';
    ALTER TABLE schedules DROP COLUMN authority_event_id;
    PRAGMA user_version = 8;
  `);
  legacy.close();
  const store = new MimiStore(file);
  try {
    for (const scheduleId of [owner.id, system.id]) {
      const schedule = store.getSchedule(scheduleId)!;
      const authority = store.getEvent(schedule.authorityEventId!);
      assert.equal(schedule.enabled, true);
      assert.equal(authority?.trust, schedule.trust);
      assert.equal(authority?.profileId, schedule.profileId);
      assert.equal(authority?.executionLane, 'conversation');
      assert.equal(authority?.status, 'completed');
    }
    assert.equal(store.getSchedule('legacy-external')?.enabled, false);
    assert.equal(store.getSchedule('legacy-external')?.authorityEventId, undefined);
    const emitted = store.emitDueSchedules(new Date('2026-07-15T08:00:01.000Z'));
    assert.deepEqual(new Set(emitted.map((event) => (event.payload as { scheduleId: string }).scheduleId)),
      new Set([owner.id, system.id]));
    assert.ok(emitted.every((event) => event.executionLane === 'task' && event.rootEventId !== undefined));
    const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
    const ownerTask = emitted.find((event) => (
      event.payload as { scheduleId: string }
    ).scheduleId === owner.id)!;
    assert.equal(attention.decide(ownerTask, new Date('2026-07-15T08:00:02.000Z')).action, 'run');
  } finally {
    store.close();
  }
  const migrated = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11);
    const columns = new Set((migrated.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>)
      .map((column) => column.name));
    assert.equal(columns.has('authority_event_id'), true);
  } finally {
    migrated.close();
  }
});

test('v1 databases receive current digest tables without legacy permission migrations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schema-v1-'));
  const file = path.join(root, 'mimi.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE events (id TEXT PRIMARY KEY) STRICT;
    PRAGMA user_version = 1;
  `);
  legacy.close();
  const store = new MimiStore(file);
  store.close();
  const migrated = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11);
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'digest_retention_idx'").get());
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'digest_items'").get());
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'attention_state'").get());
    assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'mandates'").get(), undefined);
  } finally {
    migrated.close();
  }
});

test('v5 stores gain every retention index without changing data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schema-v5-'));
  const file = path.join(root, 'mimi.db');
  const initial = new MimiStore(file);
  initial.enqueueEvent({ ...envelope('v5-history'), externalId: 'v5-history' });
  initial.close();
  const downgraded = new DatabaseSync(file);
  downgraded.exec(`
    DROP INDEX events_retention_idx;
    DROP INDEX runs_event_status_idx;
    DROP INDEX outbox_retention_idx;
    DROP INDEX audit_retention_idx;
    DROP INDEX schedules_retention_idx;
    DROP INDEX digest_retention_idx;
    DROP INDEX attention_retention_idx;
    PRAGMA user_version = 5;
  `);
  downgraded.close();

  const migratedStore = new MimiStore(file);
  assert.equal(migratedStore.getEvent('v5-history')?.status, 'queued');
  migratedStore.close();
  const migrated = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11);
    for (const index of [
      'events_retention_idx', 'runs_event_status_idx', 'outbox_retention_idx', 'audit_retention_idx',
      'schedules_retention_idx', 'digest_retention_idx', 'attention_retention_idx',
    ]) {
      assert.ok(migrated.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(index));
    }
  } finally {
    migrated.close();
  }
});
