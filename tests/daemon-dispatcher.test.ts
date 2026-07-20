import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunContext, type RunStreamEvent, type Tool } from '@openai/agents';
import { CompletionGateError } from '../src/core/completion.js';
import { AttentionEngine } from '../src/daemon/attention.js';
import type { ConnectorManager } from '../src/daemon/connectors.js';
import { eventFailureAttemptLimit, MimiDispatcher } from '../src/daemon/dispatcher.js';
import { NotifierRegistry, UncertainDeliveryError } from '../src/daemon/notifier.js';
import { ownerSessionId } from '../src/daemon/policy.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import type { AgentRunObserver, AgentRunRequest, AgentRunResult } from '../src/runtime/run-service.js';
import { isTerminalRunInterruption } from '../src/runtime/run-outcome.js';

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition timed out');
}

function event(id: string, prompt: string, priority: number): EventEnvelope {
  const now = new Date().toISOString();
  return {
    id, externalId: id, source: 'local-cli', kind: 'command', trust: 'owner',
    payload: { prompt }, occurredAt: now, receivedAt: now, priority, profileId: 'owner',
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function enqueueOutbox(store: MimiStore, id: string, channel: string, target = 'owner'): string {
  const eventId = `${id}-event`;
  store.enqueueEvent(event(eventId, `prepare ${id}`, 90));
  const claimed = store.claimEventById(eventId, `setup-${id}`)!;
  store.completeEvent(claimed.id, `setup-${id}`, { answer: 'prepared' }, 'completed', {
    route: { channel, target },
    payload: { text: id },
  });
  const outgoing = store.listOutbox().find((message) => message.eventId === eventId);
  assert.ok(outgoing);
  return outgoing.id;
}

test('background provider request rejections do not consume five automatic attempts', () => {
  assert.equal(eventFailureAttemptLimit(new Error('400 Invalid schema'), 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(new Error('402 Insufficient Balance'), 2, 5), 2);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('rate limited'), { status: 429 }), 1, 5), 1);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('timeout'), { status: 408 }), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(Object.assign(new Error('server unavailable'), { status: 503 }), 1, 5), 5);
  assert.equal(eventFailureAttemptLimit(new Error('Max turns (32) exceeded'), 1, 5), 1);
});

test('daemon loop executes different Session actors concurrently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-concurrent-sessions-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const releases = new Map<string, () => void>();
  const started = new Set<string>();

  const runtime = (sessionId: string) => {
    const agent = {
      currentSessionId: sessionId,
      bindSessionActor: (boundSessionId: string) => assert.equal(boundSessionId, sessionId),
      switchSession: async () => undefined,
      sessionSnapshot: async () => { throw new Error('unused'); },
      listSessionSummaries: async () => [],
      finalizeExecutionLedger: async () => undefined,
      close: async () => undefined,
    } as unknown as MimiAgent;
    const runs = {
      execute: async (): Promise<AgentRunResult> => {
        started.add(sessionId);
        await new Promise<void>((resolve) => releases.set(sessionId, resolve));
        return { answer: `done:${sessionId}`, effects: [] };
      },
    };
    return { agent, runs };
  };

  const primary = runtime('session-a');
  const host = new MimiHost(primary.agent, primary.runs, {
    maxConcurrentSessions: 2,
    createSessionRuntime: async (sessionId) => runtime(sessionId),
  });
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    maxConcurrentEvents: 2,
    pollMs: 5,
  });
  try {
    store.enqueueEvent({ ...event('concurrent-a', 'work A', 100), sessionKey: 'session-a' });
    store.enqueueEvent({ ...event('concurrent-b', 'work B', 100), sessionKey: 'session-b' });
    dispatcher.start();
    await waitUntil(() => started.size === 2);
    assert.deepEqual([...started].sort(), ['session-a', 'session-b']);
    assert.equal(store.getEvent('concurrent-a')?.status, 'running');
    assert.equal(store.getEvent('concurrent-b')?.status, 'running');

    releases.get('session-a')?.();
    releases.get('session-b')?.();
    await waitUntil(() => store.getEvent('concurrent-a')?.status === 'completed'
      && store.getEvent('concurrent-b')?.status === 'completed');
  } finally {
    for (const release of releases.values()) release();
    await dispatcher.stop();
    await host.close();
    store.close();
  }
});

test('daemon loop keeps one writer per Session without starving another Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-session-fairness-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let releaseFirstA!: () => void;
  const firstAGate = new Promise<void>((resolve) => { releaseFirstA = resolve; });
  let releaseB!: () => void;
  const bGate = new Promise<void>((resolve) => { releaseB = resolve; });
  const order: string[] = [];

  const runtime = (sessionId: string) => {
    const agent = {
      currentSessionId: sessionId,
      bindSessionActor: (boundSessionId: string) => assert.equal(boundSessionId, sessionId),
      switchSession: async () => undefined,
      sessionSnapshot: async () => { throw new Error('unused'); },
      listSessionSummaries: async () => [],
      finalizeExecutionLedger: async () => undefined,
      close: async () => undefined,
    } as unknown as MimiAgent;
    let runs = 0;
    return {
      agent,
      runs: {
        execute: async (): Promise<AgentRunResult> => {
          runs += 1;
          order.push(`${sessionId}:${runs}:start`);
          if (sessionId === 'session-a' && runs === 1) await firstAGate;
          if (sessionId === 'session-b') await bGate;
          order.push(`${sessionId}:${runs}:end`);
          return { answer: 'done', effects: [] };
        },
      },
    };
  };
  const primary = runtime('session-a');
  const host = new MimiHost(primary.agent, primary.runs, {
    maxConcurrentSessions: 2,
    createSessionRuntime: async (sessionId) => runtime(sessionId),
  });
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    maxConcurrentEvents: 2,
    pollMs: 5,
  });
  try {
    const base = Date.now();
    store.enqueueEvent({
      ...event('fair-a-1', 'first A', 100),
      source: 'system:test',
      trust: 'system',
      sessionKey: 'session-a',
      receivedAt: new Date(base).toISOString(),
    });
    store.enqueueEvent({
      ...event('fair-a-2', 'second A', 100),
      source: 'system:test',
      trust: 'system',
      sessionKey: 'session-a',
      receivedAt: new Date(base + 1).toISOString(),
    });
    store.enqueueEvent({
      ...event('fair-b', 'work B', 100),
      source: 'system:test',
      trust: 'system',
      sessionKey: 'session-b',
      receivedAt: new Date(base + 2).toISOString(),
    });
    dispatcher.start();

    await waitUntil(() => order.includes('session-b:1:start'));
    assert.deepEqual(order, ['session-a:1:start', 'session-b:1:start']);
    assert.equal(store.getEvent('fair-a-2')?.status, 'queued');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fifoDeferrals = store.activitySnapshot(100).recentTransitions.filter((transition) => (
      transition.type === 'event.preempted' && transition.entityId === 'fair-a-2'
    ));
    assert.equal(fifoDeferrals.length, 0);

    releaseB();
    releaseFirstA();
    await waitUntil(() => store.getEvent('fair-a-2')?.status === 'completed');
    assert.ok(order.indexOf('session-a:2:start') > order.indexOf('session-a:1:end'));
  } finally {
    releaseB();
    releaseFirstA();
    await dispatcher.stop();
    await host.close();
    store.close();
  }
});

test('one queued urgent Event globally preempts only one concurrent victim', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-single-urgent-victim-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const started = new Set<string>();
  const aborted: string[] = [];
  const releases = new Map<string, () => void>();
  const runCounts = new Map<string, number>();

  const runtime = (sessionId: string) => {
    const agent = {
      currentSessionId: sessionId,
      bindSessionActor: (boundSessionId: string) => assert.equal(boundSessionId, sessionId),
      switchSession: async () => undefined,
      sessionSnapshot: async () => { throw new Error('unused'); },
      listSessionSummaries: async () => [],
      finalizeExecutionLedger: async () => undefined,
      close: async () => undefined,
    } as unknown as MimiAgent;
    const runs = {
      execute: async (request: AgentRunRequest): Promise<AgentRunResult> => {
        const count = (runCounts.get(sessionId) ?? 0) + 1;
        runCounts.set(sessionId, count);
        started.add(sessionId);
        if (count > 1) return { answer: `resumed:${sessionId}`, effects: [] };
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            request.signal?.removeEventListener('abort', onAbort);
            resolve();
          };
          const onAbort = () => {
            if (settled) return;
            settled = true;
            aborted.push(sessionId);
            reject(request.signal?.reason);
          };
          releases.set(sessionId, finish);
          if (request.signal?.aborted) onAbort();
          else request.signal?.addEventListener('abort', onAbort, { once: true });
        });
        return { answer: `done:${sessionId}`, effects: [] };
      },
    };
    return { agent, runs };
  };

  const primary = runtime('session-a');
  const host = new MimiHost(primary.agent, primary.runs, {
    maxConcurrentSessions: 3,
    createSessionRuntime: async (sessionId) => runtime(sessionId),
  });
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    maxConcurrentEvents: 2,
    pollMs: 5,
    preemptPollMs: 5,
  });
  try {
    const base = Date.now();
    store.enqueueEvent({
      ...event('victim-a', 'slow A', 90), sessionKey: 'session-a',
      receivedAt: new Date(base).toISOString(),
    });
    store.enqueueEvent({
      ...event('victim-b', 'slow B', 90), sessionKey: 'session-b',
      receivedAt: new Date(base + 1).toISOString(),
    });
    dispatcher.start();
    await waitUntil(() => started.has('session-a') && started.has('session-b'));

    store.enqueueEvent({ ...event('one-urgent', 'urgent', 100), sessionKey: 'session-urgent' });
    await waitUntil(() => aborted.length === 1 && store.getEvent('one-urgent')?.status === 'running');
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(aborted.length, 1);
    const victimStatuses = [store.getEvent('victim-a')?.status, store.getEvent('victim-b')?.status];
    assert.equal(victimStatuses.filter((status) => status === 'queued').length, 1);
    assert.equal(victimStatuses.filter((status) => status === 'running').length, 1);

    for (const release of releases.values()) release();
    await waitUntil(() => store.getEvent('one-urgent')?.status === 'completed'
      && store.getEvent('victim-a')?.status === 'completed'
      && store.getEvent('victim-b')?.status === 'completed');
  } finally {
    for (const release of releases.values()) release();
    await dispatcher.stop();
    await host.close();
    store.close();
  }
});

test('a priority-100 owner conversation never preempts an independent running Task lane', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-conversation-preemption-isolation-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let started = false;
  let aborted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const agent = {
    currentSessionId: 'mimi-task-lane-isolation',
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      started = true;
      await Promise.race([
        gate,
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            aborted = true;
            reject(request.signal?.reason);
          };
          if (request.signal?.aborted) onAbort();
          else request.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      return { answer: 'task completed without foreground interference', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    claimExecutionLane: 'task',
    preemptPollMs: 5,
  });
  try {
    store.enqueueEvent({
      ...event('isolated-running-task', 'long background work', 70),
      sessionKey: 'mimi-task-lane-isolation',
      executionLane: 'task',
    });
    const processing = dispatcher.processEventById('isolated-running-task');
    await waitUntil(() => started);
    store.enqueueEvent({
      ...event('foreground-owner-command', 'continue chatting now', 100),
      sessionKey: 'owner-conversation',
      executionLane: 'conversation',
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(aborted, false);
    assert.equal(store.getEvent('isolated-running-task')?.status, 'running');
    assert.equal(store.getEvent('foreground-owner-command')?.status, 'queued');

    release();
    assert.equal(await processing, true);
    assert.equal(store.getEvent('isolated-running-task')?.status, 'completed');
  } finally {
    release();
    await host.close();
    store.close();
  }
});

test('an urgent Task can still preempt lower-priority work inside the Task lane', { timeout: 3_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-lane-preemption-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let started = false;
  let aborted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const agent = {
    currentSessionId: 'mimi-task-low-priority',
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      started = true;
      await Promise.race([
        gate,
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            aborted = true;
            reject(request.signal?.reason);
          };
          if (request.signal?.aborted) onAbort();
          else request.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      return { answer: 'unexpected completion', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    claimExecutionLane: 'task',
    preemptPollMs: 5,
  });
  try {
    store.enqueueEvent({
      ...event('low-priority-task', 'low priority background work', 70),
      sessionKey: 'mimi-task-low-priority',
      executionLane: 'task',
    });
    const processing = dispatcher.processEventById('low-priority-task');
    await waitUntil(() => started);
    store.enqueueEvent({
      ...event('urgent-task', 'urgent background work', 100),
      sessionKey: 'mimi-task-urgent',
      executionLane: 'task',
    });

    assert.equal(await processing, true);
    assert.equal(aborted, true);
    assert.equal(store.getEvent('low-priority-task')?.status, 'queued');
    assert.equal(store.getEvent('low-priority-task')?.attempts, 0);
    assert.equal(store.getEvent('urgent-task')?.status, 'queued');
  } finally {
    release();
    await host.close();
    store.close();
  }
});

test('an equal-priority owner command cannot correct a different Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-owner-correction-session-scope-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let activeStarted = false;
  let activeAborted = false;
  let releaseActive!: () => void;
  const activeGate = new Promise<void>((resolve) => { releaseActive = resolve; });
  const runtime = (sessionId: string) => {
    const agent = {
      currentSessionId: sessionId,
      bindSessionActor: (boundSessionId: string) => assert.equal(boundSessionId, sessionId),
      switchSession: async () => undefined,
      sessionSnapshot: async () => { throw new Error('unused'); },
      listSessionSummaries: async () => [],
      finalizeExecutionLedger: async () => undefined,
      close: async () => undefined,
    } as unknown as MimiAgent;
    return {
      agent,
      runs: {
        execute: async (request: AgentRunRequest): Promise<AgentRunResult> => {
          if (sessionId === 'session-a') {
            activeStarted = true;
            await Promise.race([
              activeGate,
              new Promise<never>((_resolve, reject) => {
                const onAbort = () => {
                  activeAborted = true;
                  reject(request.signal?.reason);
                };
                if (request.signal?.aborted) onAbort();
                else request.signal?.addEventListener('abort', onAbort, { once: true });
              }),
            ]);
          }
          return { answer: `done:${sessionId}`, effects: [] };
        },
      },
    };
  };
  const primary = runtime('session-a');
  const host = new MimiHost(primary.agent, primary.runs, {
    maxConcurrentSessions: 2,
    createSessionRuntime: async (sessionId) => runtime(sessionId),
  });
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, { preemptPollMs: 5 });
  try {
    store.enqueueEvent({ ...event('session-a-old', 'old A', 100), sessionKey: 'session-a' });
    const processing = dispatcher.processOnce();
    await waitUntil(() => activeStarted);
    store.enqueueEvent({ ...event('session-b-correction', 'change B', 100), sessionKey: 'session-b' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(activeAborted, false);
    assert.equal(store.getEvent('session-a-old')?.status, 'running');

    releaseActive();
    assert.equal(await processing, true);
    assert.equal(store.getEvent('session-a-old')?.status, 'completed');
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('session-b-correction')?.status, 'completed');
  } finally {
    releaseActive();
    await host.close();
    store.close();
  }
});

test('dispatcher dead-letters an uncertain delivery without automatically replaying it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-uncertain-delivery-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const notifier = new NotifierRegistry();
  notifier.register('connector:wechat', {
    deliver: async () => { throw new UncertainDeliveryError('send result is uncertain'); },
  });
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention, notifier);
  try {
    store.enqueueEvent(event('uncertain-delivery', 'send once', 90));
    const claimed = store.claimEvent('worker')!;
    store.completeEvent(claimed.id, 'worker', { answer: 'done' }, 'completed', {
      route: { channel: 'connector:wechat', target: 'contact:friend' },
      payload: { text: 'hello' },
    });

    assert.equal(await dispatcher.processOnce(), true);
    const messages = store.listOutbox();
    const original = messages.find((message) => message.channel === 'connector:wechat');
    assert.equal(original?.status, 'dead_letter');
    assert.equal(original?.attempts, 1);
    assert.ok(messages.some((message) => message.channel === 'system' && message.status === 'pending'));
  } finally {
    store.close();
  }
});

test('a failed local delivery commit never requeues a remotely confirmed message', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-confirm-commit-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const notifier = new NotifierRegistry();
  let deliveries = 0;
  notifier.register('connector:confirmed', { deliver: async () => { deliveries += 1; } });
  const outboxId = enqueueOutbox(store, 'confirmed-commit', 'connector:confirmed');
  const originalComplete = store.completeOutbox.bind(store);
  let failCommit = true;
  store.completeOutbox = ((id: string, owner: string) => {
    if (failCommit) {
      failCommit = false;
      throw new Error('simulated SQLite commit failure');
    }
    return originalComplete(id, owner);
  }) as typeof store.completeOutbox;
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention, notifier);
  try {
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(deliveries, 1);
    assert.equal(store.getOutbox(outboxId)?.status, 'sending');

    store.claimOutbox('recovery-worker', 60_000, new Date(Date.now() + 240_000));
    assert.equal(store.getOutbox(outboxId)?.status, 'dead_letter');
    assert.equal(deliveries, 1);
  } finally {
    store.close();
  }
});

test('a slow Outbox delivery does not block admission of a new Conversation Event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-slow-delivery-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const notifier = new NotifierRegistry();
  const deliveryGate = deferred();
  let deliveryStarted = false;
  notifier.register('connector:slow', {
    deliver: async () => {
      deliveryStarted = true;
      await deliveryGate.promise;
    },
  });
  const outboxId = enqueueOutbox(store, 'slow-delivery', 'connector:slow');
  const sessionId = 'responsive-session';
  let conversationStarted = false;
  const agent = {
    currentSessionId: sessionId,
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (): Promise<AgentRunResult> => {
      conversationStarted = true;
      return { answer: 'conversation stayed responsive', effects: [] };
    },
  });
  const dispatcher = new MimiDispatcher(store, host, attention, notifier, undefined, {
    pollMs: 5,
    maxConcurrentEvents: 1,
  });
  try {
    store.enqueueEvent({
      ...event('conversation-during-delivery', 'answer now', 100),
      sessionKey: sessionId,
    });
    dispatcher.start();
    await waitUntil(() => deliveryStarted);
    await waitUntil(() => store.getEvent('conversation-during-delivery')?.status === 'completed');
    assert.equal(conversationStarted, true);
    assert.equal(store.getOutbox(outboxId)?.status, 'sending');

    deliveryGate.resolve();
    await waitUntil(() => store.getOutbox(outboxId)?.status === 'sent');
  } finally {
    deliveryGate.resolve();
    await dispatcher.stop();
    await host.close();
    store.close();
  }
});

test('the daemon loop runs at most one Outbox delivery per route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-delivery-slot-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const notifier = new NotifierRegistry();
  const releases: Array<() => void> = [];
  let started = 0;
  let active = 0;
  let maximumActive = 0;
  notifier.register('connector:slow', {
    deliver: async () => {
      started += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    },
  });
  const outboxIds = [
    enqueueOutbox(store, 'delivery-slot-1', 'connector:slow'),
    enqueueOutbox(store, 'delivery-slot-2', 'connector:slow'),
  ];
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention, notifier, undefined, { pollMs: 1 });
  try {
    dispatcher.start();
    await waitUntil(() => started === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(started, 1);
    assert.equal(active, 1);
    assert.equal(maximumActive, 1);
    assert.equal(store.listOutbox().filter((message) => message.status === 'sending').length, 1);

    releases.shift()!();
    await waitUntil(() => started === 2);
    assert.equal(active, 1);
    assert.equal(maximumActive, 1);
    releases.shift()!();
    await waitUntil(() => outboxIds.every((id) => store.getOutbox(id)?.status === 'sent'));
  } finally {
    for (const release of releases.splice(0)) release();
    await dispatcher.stop();
    store.close();
  }
});

test('a blocked connector channel does not hold up another Outbox channel', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-delivery-lanes-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const notifier = new NotifierRegistry();
  const slowGate = deferred();
  let slowStarted = false;
  let fastDelivered = false;
  notifier.register('connector:qq', {
    deliver: async () => {
      slowStarted = true;
      await slowGate.promise;
    },
  });
  notifier.register('connector:wechat', {
    deliver: async () => { fastDelivered = true; },
  });
  const slowId = enqueueOutbox(store, 'delivery-lane-qq', 'connector:qq');
  const fastId = enqueueOutbox(store, 'delivery-lane-wechat', 'connector:wechat');
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention, notifier, undefined, { pollMs: 1 });
  try {
    dispatcher.start();
    await waitUntil(() => slowStarted && fastDelivered);
    assert.equal(store.getOutbox(slowId)?.status, 'sending');
    assert.equal(store.getOutbox(fastId)?.status, 'sent');
    slowGate.resolve();
    await waitUntil(() => store.getOutbox(slowId)?.status === 'sent');
  } finally {
    slowGate.resolve();
    await dispatcher.stop();
    store.close();
  }
});

test('a blocked Connector target does not hold up another target on the same channel', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-delivery-target-lanes-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const notifier = new NotifierRegistry();
  const slowGate = deferred();
  let slowStarted = false;
  let fastDelivered = false;
  notifier.register('connector:qq', {
    deliver: async (message) => {
      if (message.target === 'group:slow') {
        slowStarted = true;
        await slowGate.promise;
      } else {
        fastDelivered = true;
      }
    },
  });
  const slowId = enqueueOutbox(store, 'delivery-target-slow', 'connector:qq', 'group:slow');
  const fastId = enqueueOutbox(store, 'delivery-target-fast', 'connector:qq', 'single:fast');
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention, notifier, undefined, { pollMs: 1 });
  try {
    dispatcher.start();
    await waitUntil(() => slowStarted && fastDelivered);
    assert.equal(store.getOutbox(slowId)?.status, 'sending');
    assert.equal(store.getOutbox(fastId)?.status, 'sent');
    slowGate.resolve();
    await waitUntil(() => store.getOutbox(slowId)?.status === 'sent');
  } finally {
    slowGate.resolve();
    await dispatcher.stop();
    store.close();
  }
});

test('dispatcher stop waits for an in-flight Outbox delivery to commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-delivery-stop-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const notifier = new NotifierRegistry();
  const deliveryGate = deferred();
  let deliveryStarted = false;
  notifier.register('connector:slow', {
    deliver: async () => {
      deliveryStarted = true;
      await deliveryGate.promise;
    },
  });
  const outboxId = enqueueOutbox(store, 'delivery-stop', 'connector:slow');
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention, notifier, undefined, { pollMs: 1 });
  let stopping: Promise<void> | undefined;
  try {
    dispatcher.start();
    await waitUntil(() => deliveryStarted);
    let stopped = false;
    stopping = dispatcher.stop().then(() => { stopped = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(store.getOutbox(outboxId)?.status, 'sending');

    deliveryGate.resolve();
    await stopping;
    assert.equal(stopped, true);
    assert.equal(store.getOutbox(outboxId)?.status, 'sent');
  } finally {
    deliveryGate.resolve();
    await stopping;
    await dispatcher.stop();
    store.close();
  }
});

test('dispatcher preempts a low-priority run, handles urgency, then resumes the original event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-preempt-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const inputs: string[] = [];
  const hostInstructions: string[] = [];
  const delivered: string[] = [];
  const interrupted: boolean[] = [];
  let firstSlowStarted = false;
  let firstToolFinished = false;
  let slowRuns = 0;
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (input: string, signal?: AbortSignal, options?: { hostInstructions?: string }) => {
      inputs.push(input);
      hostInstructions.push(options?.hostInstructions ?? '');
      const shouldWait = input === 'slow task' && slowRuns++ === 0;
      if (shouldWait) firstSlowStarted = true;
      const completed = shouldWait
        ? new Promise<void>((resolve, reject) => {
            const safety = setTimeout(() => reject(new Error('preemption did not arrive')), 2_000);
            const onAbort = () => {
              clearTimeout(safety);
              reject(signal?.reason);
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });
          })
        : Promise.resolve();
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: `done: ${input}`,
        completed,
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() {
          if (shouldWait) {
            yield {
              type: 'run_item_stream_event', name: 'tool_called',
              item: { rawItem: { name: 'connector_action', arguments: '{}' } },
            };
            await new Promise((resolve) => setTimeout(resolve, 60));
            firstToolFinished = true;
            yield {
              type: 'run_item_stream_event', name: 'tool_output',
              item: { rawItem: { name: 'connector_action' }, output: 'done' },
            };
          }
          await completed;
        },
      };
    },
    completeRun: async () => [],
    failRun: async (_error: unknown, wasInterrupted: boolean) => { interrupted.push(wasInterrupted); },
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const notifier = new NotifierRegistry();
  notifier.register('system', { deliver: async (message) => { delivered.push(message.eventId); } });
  const dispatcher = new MimiDispatcher(store, agent, attention, notifier, undefined, { preemptPollMs: 10 });
  try {
    store.enqueueEvent(event('low', 'slow task', 90));
    const processingLow = dispatcher.processOnce();
    await waitUntil(() => firstSlowStarted);
    store.enqueueEvent({
      ...event('noise', 'ambient noise', 100), source: 'sensor', kind: 'ambient', trust: 'external',
      receivedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    store.enqueueEvent(event('urgent', 'urgent task', 100));
    assert.equal(await processingLow, true);
    assert.equal(firstToolFinished, true);

    const preempted = store.getEvent('low')!;
    assert.equal(preempted.status, 'queued');
    assert.equal(preempted.attempts, 0);
    assert.match(preempted.error ?? '', /urgent/);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.deepEqual(interrupted, [true]);

    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('noise')?.status, 'digested');
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('urgent')?.status, 'completed');
    assert.deepEqual(delivered, []);
    assert.equal(store.getEvent('low')?.status, 'queued');
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('low')?.status, 'completed');
    assert.deepEqual(inputs, ['slow task', 'urgent task', 'slow task']);
    assert.ok(hostInstructions.every((instructions) => instructions.includes('MimiAgent 常驻执行契约')));
  } finally {
    store.close();
  }
});

test('dispatcher aborts an idle model run and preserves the normal terminal failure path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-idle-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const interrupted: boolean[] = [];
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (_input: string, signal?: AbortSignal) => {
      const completed = new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: undefined,
        completed,
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() { await completed; },
      };
    },
    completeRun: async () => [],
    failRun: async (_error: unknown, wasInterrupted: boolean) => { interrupted.push(wasInterrupted); },
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, {
    runIdleTimeoutMs: 30,
    maxAttempts: 1,
  });
  try {
    store.enqueueEvent(event('idle', 'never responds', 90));
    assert.equal(await dispatcher.processOnce(), true);
    const failed = store.getEvent('idle')!;
    assert.equal(failed.status, 'dead_letter');
    assert.match(failed.error ?? '', /30ms 无进展/);
    assert.equal(store.listRuns()[0]?.status, 'failed');
    assert.deepEqual(interrupted, [true]);
    assert.equal(store.listOutbox().length, 1);
  } finally {
    store.close();
  }
});

test('a same-Session owner correction can preempt an equal-priority active task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-owner-correction-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let oldStarted = false;
  let oldRuns = 0;
  const inputs: string[] = [];
  const terminalInterruptions: boolean[] = [];
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (input: string, signal?: AbortSignal) => {
      const current = input.split('## 当前事件\n').at(-1)!;
      inputs.push(current);
      const blocks = current === 'old task' && oldRuns++ === 0;
      if (blocks) oldStarted = true;
      const completed = blocks ? new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      }) : Promise.resolve();
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: `done: ${current}`,
        completed,
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() { await completed; },
      };
    },
    completeRun: async () => [],
    failRun: async (error: unknown) => { terminalInterruptions.push(isTerminalRunInterruption(error)); },
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, { preemptPollMs: 10 });
  try {
    store.enqueueEvent(event('old', 'old task', 100));
    const processingOld = dispatcher.processOnce();
    await waitUntil(() => oldStarted);
    store.enqueueEvent({
      ...event('correction', 'stop the old task', 100),
      source: 'connector:qq', actor: { id: 'owner-qq' }, conversation: { id: 'private-owner' },
    });
    assert.equal(await processingOld, true);
    assert.equal(store.getEvent('old')?.status, 'archived');
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.match(store.getEvent('old')?.error ?? '', /新 owner 命令.*取代/);
    assert.deepEqual(terminalInterruptions, [true]);

    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('correction')?.status, 'completed');
    assert.deepEqual(inputs, ['old task', 'stop the old task']);
  } finally {
    store.close();
  }
});

test('dispatcher pauses the idle watchdog while a tool is running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-tool-watchdog-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async () => ({
      rawResponses: [],
      runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      finalOutput: 'tool finished',
      completed: Promise.resolve(),
      cancelled: false,
      interruptions: [],
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'run_item_stream_event', name: 'tool_called',
          item: { rawItem: { name: 'connector_action', arguments: '{}' } },
        };
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield {
          type: 'run_item_stream_event', name: 'tool_output',
          item: { rawItem: { name: 'connector_action' }, output: 'done' },
        };
      },
    }),
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, { runIdleTimeoutMs: 25 });
  try {
    store.enqueueEvent(event('tool', 'run a long tool', 90));
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('tool')?.status, 'completed');
    assert.equal(store.listRuns()[0]?.status, 'completed');
  } finally {
    store.close();
  }
});

test('dispatcher injects read-only activity self-inspection into every Agent run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-activity-tool-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let hostToolNames: string[] = [];
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (_input: string, _signal?: AbortSignal, options?: { hostTools?: Array<{ name: string }> }) => {
      hostToolNames = options?.hostTools?.map((tool) => tool.name) ?? [];
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: 'inspected',
        completed: Promise.resolve(),
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() {},
      };
    },
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const connectors = {
    listCapabilities: () => [{
      id: 'fixture', enabled: true, online: true, source: 'fixture', trust: 'external', actions: [],
      readiness: { inbound: 'ready', outbound: 'ready', deliveryConfirmed: true },
    }],
  } as unknown as ConnectorManager;
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, connectors);
  try {
    store.enqueueEvent(event('activity-tool', 'inspect yourself', 90));
    assert.equal(await dispatcher.processOnce(), true);
    assert.ok(hostToolNames.includes('inspect_mimi_activity'));
    assert.ok(hostToolNames.includes('inspect_mimi_session_activity'));
    assert.ok(hostToolNames.includes('cancel_interrupted_mimi_task'));
    assert.ok(hostToolNames.includes('inspect_mimi_capabilities'));
    assert.ok(hostToolNames.includes('set_mimi_connector_enabled'));
    assert.ok(hostToolNames.includes('reload_mimi_connectors'));
    assert.ok(hostToolNames.includes('connector_action'));
    assert.ok(hostToolNames.includes('list_mimi_schedules'));
    assert.ok(hostToolNames.includes('schedule_mimi_watch'));
    assert.equal(hostToolNames.includes('complete_current_mimi_schedule'), false);
    assert.ok(hostToolNames.includes('list_mimi_routines'));
    assert.ok(hostToolNames.includes('upsert_mimi_routine'));
    assert.ok(hostToolNames.includes('remove_mimi_routine'));
    assert.ok(hostToolNames.includes('list_mimi_standing_orders'));
    assert.ok(hostToolNames.includes('add_mimi_standing_order'));
    assert.ok(hostToolNames.includes('remove_mimi_standing_order'));
    assert.ok(hostToolNames.includes('list_mimi_people'));
    assert.ok(hostToolNames.includes('upsert_mimi_person'));
    assert.ok(hostToolNames.includes('remove_mimi_person'));
    assert.ok(hostToolNames.includes('list_mimi_source_policies'));
    assert.ok(hostToolNames.includes('upsert_mimi_source_policy'));
    assert.ok(hostToolNames.includes('remove_mimi_source_policy'));
    assert.ok(hostToolNames.includes('list_mimi_attention_rules'));
    assert.ok(hostToolNames.includes('upsert_mimi_attention_rule'));
    assert.ok(hostToolNames.includes('remove_mimi_attention_rule'));
    assert.ok(hostToolNames.includes('get_mimi_settings'));
    assert.ok(hostToolNames.includes('update_mimi_settings'));
    assert.ok(hostToolNames.includes('get_mimi_snooze'));
    assert.ok(hostToolNames.includes('snooze_mimi'));
    assert.ok(hostToolNames.includes('clear_mimi_snooze'));
    assert.ok(hostToolNames.includes('request_mimi_briefing'));
    assert.equal(hostToolNames.includes('finish_mimi_silently'), false);
  } finally {
    store.close();
  }
});

test('dispatcher wakes a person watch when a related cross-channel event starts running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-watch-wakeup-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  await attention.upsertPerson({
    id: 'alice', displayName: 'Alice', aliases: [{ source: 'mail:*', actor: 'alice@example.com' }], context: [],
  });
  const settings = attention.getSettings();
  settings.quietHours.enabled = false;
  await attention.updateSettings(settings);
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const authority = store.ensureConversationAuthority({
    ...event('alice-watch-authority', 'watch Alice contract', 90),
    source: 'mail:inbox', trust: 'external', actor: { id: 'alice@example.com' },
    sessionKey: 'mimi-person-alice',
  });
  const watch = store.addSchedule({
    name: 'Alice contract', type: 'watch', value: '900000', prompt: 'check Alice contract',
    profileId: 'owner', sessionKey: 'mimi-person-alice', authorityEventId: authority.id,
    trust: 'external', nextRunAt: future,
  });
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async () => ({
      rawResponses: [],
      runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      finalOutput: 'handled Alice update',
      completed: Promise.resolve(),
      cancelled: false,
      interruptions: [],
      async *[Symbol.asyncIterator]() {},
    }),
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention);
  try {
    const incoming = event('alice-mail', 'contract update', 90);
    store.enqueueEvent({
      ...incoming, source: 'mail:inbox', trust: 'external', actor: { id: 'alice@example.com' },
    });
    assert.equal(await dispatcher.processOnce(), true);
    assert.notEqual(store.getSchedule(watch.id)?.nextRunAt, future);
    const emitted = store.emitDueSchedules(new Date());
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.originSessionKey, 'mimi-person-alice');
    assert.equal(emitted[0]?.sessionKey, `mimi-task-${emitted[0]?.id}`);
    assert.equal((emitted[0]?.payload as { scheduleId?: string }).scheduleId, watch.id);
  } finally {
    store.close();
  }
});

test('dispatcher keeps autonomous work auditable while suppressing a no-change delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-silent-run-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let silentToolSeen = false;
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (_input: string, _signal?: AbortSignal, options?: { hostTools?: Tool[] }) => {
      const silent = options?.hostTools?.find((tool) => tool.name === 'finish_mimi_silently');
      assert.ok(silent && 'invoke' in silent && typeof silent.invoke === 'function');
      silentToolSeen = true;
      await silent.invoke(new RunContext({}), JSON.stringify({ reason: '巡检完成，没有新变化' }));
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } },
        finalOutput: '后台巡检完成，没有需要通知的内容',
        completed: Promise.resolve(),
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() {},
      };
    },
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention);
  try {
    await attention.removeRoutine('morning-plan');
    await attention.removeRoutine('evening-close');
    await attention.upsertRoutine({
      id: 'quiet-check', enabled: true, time: '00:00', prompt: 'check for changes', priority: 70,
      replyChannel: 'system',
    });
    const proactive = attention.emitDueRoutines(new Date())[0];
    assert.ok(proactive);
    assert.equal(await dispatcher.processOnce(), true);
    const completed = store.getEvent(proactive.id)!;
    assert.equal(silentToolSeen, true);
    assert.equal(completed.status, 'completed');
    const result = completed.result as {
      answer: string;
      sessionId: string;
      usage: { runInputTokens: number; runOutputTokens: number; runTotalTokens: number };
      delivery: { suppressed: boolean; reason: string };
    };
    assert.equal(result.answer, '后台巡检完成，没有需要通知的内容');
    assert.equal(result.sessionId, proactive.sessionKey);
    assert.notEqual(result.sessionId, proactive.originSessionKey);
    assert.deepEqual(result.usage, { runInputTokens: 2, runOutputTokens: 1, runTotalTokens: 3 });
    assert.deepEqual(result.delivery, { suppressed: true, reason: '巡检完成，没有新变化' });
    assert.deepEqual(store.listOutbox(), []);
    assert.equal(store.listRuns()[0]?.status, 'completed');
  } finally {
    store.close();
  }
});

test('dispatcher lets a Messages alert suppress an unnecessary conversation reply', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-message-silent-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const settings = attention.getSettings();
  settings.quietHours.enabled = false;
  await attention.updateSettings(settings);
  let inputSeen = '';
  let hostInstructionsSeen = '';
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (
      input: string,
      _signal?: AbortSignal,
      options?: { hostInstructions?: string; hostTools?: Tool[] },
    ) => {
      inputSeen = input;
      hostInstructionsSeen = options?.hostInstructions ?? '';
      const silent = options?.hostTools?.find((tool) => tool.name === 'finish_mimi_silently');
      assert.ok(silent && 'invoke' in silent && typeof silent.invoke === 'function');
      await silent.invoke(new RunContext({}), JSON.stringify({ reason: '这是一条无需答复的通知' }));
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        finalOutput: '无需回复',
        completed: Promise.resolve(),
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() {},
      };
    },
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention);
  try {
    const now = new Date().toISOString();
    store.enqueueEvent({
      id: 'message-alert', externalId: 'message:one', source: 'messages', kind: 'alert', trust: 'external',
      actor: { id: '+15550001111' }, conversation: { id: 'messages-chat', threadId: 'iMessage;+;chat-1' },
      payload: { type: 'incoming_message', chatId: 'iMessage;+;chat-1', text: 'FYI only' },
      occurredAt: now, receivedAt: now, priority: 80, profileId: 'owner',
      replyRoute: { channel: 'connector:macos-messages', target: 'iMessage;+;chat-1' },
    });
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(inputSeen, 'FYI only');
    assert.match(hostInstructionsSeen, /本机即时消息事务执行剧本/);
    assert.deepEqual(store.listOutbox(), []);
    const result = store.getEvent('message-alert')?.result as { delivery?: { suppressed: boolean; reason: string } };
    assert.deepEqual(result.delivery, { suppressed: true, reason: '这是一条无需答复的通知' });
  } finally {
    store.close();
  }
});

test('dispatcher does not call the model for a queued routine removed before execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-stale-routine-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let modelCalls = 0;
  const agent = {
    stream: async () => {
      modelCalls += 1;
      throw new Error('stale routine must not reach the model');
    },
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention);
  try {
    await attention.removeRoutine('morning-plan');
    await attention.removeRoutine('evening-close');
    await attention.upsertRoutine({
      id: 'temporary', enabled: true, time: '00:00', prompt: '不应执行', priority: 70,
    });
    const queued = attention.emitDueRoutines(new Date())[0];
    assert.ok(queued);
    await attention.removeRoutine('temporary');

    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(modelCalls, 0);
    assert.equal(store.getEvent(queued.id)?.status, 'ignored');
    assert.match(JSON.stringify(store.getEvent(queued.id)?.result), /Daily Routine/);
    assert.deepEqual(store.listRuns(), []);
  } finally {
    store.close();
  }
});

test('dispatcher reliably delivers autonomous results through the owner fallback route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-owner-route-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const configFile = path.join(root, 'assistant.json');
  const attention = await AttentionEngine.load(configFile, store);
  const config = JSON.parse(await readFile(configFile, 'utf8')) as {
    owner: { replyRoute?: { channel: string; target?: string } };
    quietHours: { enabled: boolean };
    routines: unknown[];
  };
  config.owner.replyRoute = { channel: 'connector:daxiang', target: 'owner-conversation' };
  config.quietHours.enabled = false;
  config.routines = [];
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
  await attention.reload();
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async () => ({
      rawResponses: [],
      runContext: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      finalOutput: '主动任务已处理',
      completed: Promise.resolve(),
      cancelled: false,
      interruptions: [],
      async *[Symbol.asyncIterator]() {},
    }),
    completeRun: async () => [{ type: 'model_changed', model: 'fixture-next' }],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention);
  try {
    store.enqueueEvent({
      ...event('autonomous', 'check system risk', 90), source: 'macos-system', trust: 'system',
    });
    assert.equal(await dispatcher.processOnce(), true);
    const outgoing = store.listOutbox()[0];
    assert.equal(store.getEvent('autonomous')?.status, 'completed');
    assert.deepEqual((store.getEvent('autonomous')?.result as { effects?: unknown }).effects, [
      { type: 'model_changed', model: 'fixture-next' },
    ]);
    assert.equal(outgoing?.channel, 'connector:daxiang');
    assert.equal(outgoing?.target, 'owner-conversation');
    assert.deepEqual(outgoing?.payload, { text: '主动任务已处理', eventId: 'autonomous' });
  } finally {
    store.close();
  }
});

test('dispatcher remembers the latest owner Connector without routing local CLI results back to it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-recent-owner-route-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const delivered: string[] = [];
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (input: string) => ({
      rawResponses: [],
      runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      finalOutput: input === 'remember this channel' ? '' : '收到',
      completed: Promise.resolve(), cancelled: false, interruptions: [],
      async *[Symbol.asyncIterator]() {},
    }),
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const notifier = new NotifierRegistry();
  notifier.register('connector:daxiang', { deliver: async (message) => { delivered.push(message.eventId); } });
  const dispatcher = new MimiDispatcher(store, agent, attention, notifier);
  try {
    store.enqueueEvent({
      ...event('owner-mobile', 'remember this channel', 100), source: 'connector:daxiang', trust: 'owner',
      replyRoute: { channel: 'connector:daxiang', target: 'single:owner' },
    });
    assert.equal(await dispatcher.processOnce(), true);
    assert.deepEqual(attention.replyRouteFor({
      ...store.getEvent('owner-mobile')!, source: 'macos-system', replyRoute: undefined,
    }), { channel: 'connector:daxiang', target: 'single:owner' });
    assert.equal(store.listOutbox()[0]?.eventId, 'owner-mobile');
    assert.equal(await dispatcher.processOnce(), true);
    assert.deepEqual(delivered, ['owner-mobile']);

    store.enqueueEvent(event('cli-follow-up', 'answer only in the waiting CLI', 100));
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('cli-follow-up')?.status, 'completed');
    assert.equal(store.listOutbox().some((message) => message.eventId === 'cli-follow-up'), false);
  } finally {
    store.close();
  }
});

test('dispatcher preserves an authenticated webhook request for no result delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-silent-webhook-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const configFile = path.join(root, 'assistant.json');
  const attention = await AttentionEngine.load(configFile, store);
  const config = JSON.parse(await readFile(configFile, 'utf8')) as {
    owner: { replyRoute?: { channel: string; target?: string } };
    quietHours: { enabled: boolean };
    routines: unknown[];
  };
  config.owner.replyRoute = { channel: 'connector:daxiang', target: 'owner-conversation' };
  config.quietHours.enabled = false;
  config.routines = [];
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
  await attention.reload();
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async () => ({
      rawResponses: [],
      runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      finalOutput: 'processed without reply',
      completed: Promise.resolve(),
      cancelled: false,
      interruptions: [],
      async *[Symbol.asyncIterator]() {},
    }),
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention);
  try {
    store.enqueueEvent({
      ...event('silent-webhook', 'process in background', 90), source: 'webhook:automation',
      kind: 'webhook', trust: 'external',
    });
    assert.equal(await dispatcher.processOnce(), true);
    assert.equal(store.getEvent('silent-webhook')?.status, 'completed');
    assert.deepEqual(store.listOutbox(), []);
  } finally {
    store.close();
  }
});

test('dispatcher shutdown requeues an active model run without retry penalty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-stop-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let started = false;
  const interrupted: boolean[] = [];
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (_input: string, signal?: AbortSignal) => {
      started = true;
      const completed = new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: undefined,
        completed,
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() { await completed; },
      };
    },
    completeRun: async () => [],
    failRun: async (_error: unknown, wasInterrupted: boolean) => { interrupted.push(wasInterrupted); },
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, { pollMs: 5 });
  try {
    store.enqueueEvent(event('stop', 'survive restart', 90));
    dispatcher.start();
    await waitUntil(() => started);
    await dispatcher.stop();
    const requeued = store.getEvent('stop')!;
    assert.equal(requeued.status, 'queued');
    assert.equal(requeued.attempts, 0);
    assert.match(requeued.error ?? '', /停止/);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.deepEqual(interrupted, [true]);
  } finally {
    store.close();
  }
});

test('a failed or throwing lease renewal safely aborts the old Run without escaping', async (t) => {
  for (const failure of ['false', 'throw'] as const) {
    await t.test(failure, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `mimi-lease-renew-${failure}-`));
      const store = new MimiStore(path.join(root, 'mimi.db'));
      const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
      const sessionId = ownerSessionId('owner');
      let started = false;
      let continuedAfterLeaseLoss = false;
      const agent = {
        currentSessionId: sessionId,
        switchSession: async () => undefined,
        sessionSnapshot: async () => { throw new Error('unused'); },
        listSessionSummaries: async () => [],
        finalizeExecutionLedger: async () => undefined,
        close: async () => undefined,
      } as unknown as MimiAgent;
      const host = new MimiHost(agent, {
        execute: async (request: AgentRunRequest, observer?: AgentRunObserver): Promise<AgentRunResult> => {
          started = true;
          await observer?.onStreamEvent?.({
            type: 'run_item_stream_event', name: 'tool_called',
            item: { rawItem: { name: 'shell', arguments: '{}' } },
          } as RunStreamEvent);
          await new Promise<void>((_resolve, reject) => {
            const safety = setTimeout(() => reject(new Error('lease renewal did not abort the Run')), 1_000);
            const onAbort = () => {
              clearTimeout(safety);
              reject(request.signal?.reason);
            };
            if (request.signal?.aborted) onAbort();
            else request.signal?.addEventListener('abort', onAbort, { once: true });
          });
          continuedAfterLeaseLoss = true;
          return { answer: 'must not complete', effects: [] };
        },
      });
      store.renewEventLease = () => {
        if (failure === 'throw') throw new Error('sqlite renewal unavailable');
        return false;
      };
      const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, { leaseMs: 90 });
      try {
        store.enqueueEvent(event(`renew-${failure}`, 'long run', 90));
        const processing = dispatcher.processOnce();
        await waitUntil(() => started);
        assert.equal(await processing, true);
        assert.equal(continuedAfterLeaseLoss, false);
        assert.equal(store.getEvent(`renew-${failure}`)?.status, 'running');
        assert.equal(store.listRuns()[0]?.status, 'running');
      } finally {
        await host.close();
        store.close();
      }
    });
  }
});

test('forceStop aborts an in-flight tool immediately while normal stop remains safe', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-force-stop-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const sessionId = ownerSessionId('owner');
  let toolStarted = false;
  let observedSignal: AbortSignal | undefined;
  const agent = {
    currentSessionId: sessionId,
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (request: AgentRunRequest, observer?: AgentRunObserver): Promise<AgentRunResult> => {
      observedSignal = request.signal;
      toolStarted = true;
      await observer?.onStreamEvent?.({
        type: 'run_item_stream_event', name: 'tool_called',
        item: { rawItem: { name: 'shell', arguments: '{}' } },
      } as RunStreamEvent);
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(request.signal?.reason);
        if (request.signal?.aborted) onAbort();
        else request.signal?.addEventListener('abort', onAbort, { once: true });
      });
      return { answer: 'must not finish', effects: [] };
    },
  });
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    store.enqueueEvent(event('force-stop-tool', 'long shell command', 90));
    const processing = dispatcher.processOnce();
    await waitUntil(() => toolStarted);
    dispatcher.forceStop('task worker grace period expired');
    assert.equal(observedSignal?.aborted, true);
    assert.equal(await processing, true);
    assert.equal(store.getEvent('force-stop-tool')?.status, 'queued');
    assert.equal(store.getEvent('force-stop-tool')?.attempts, 0);
    assert.match(store.getEvent('force-stop-tool')?.error ?? '', /停止/);
  } finally {
    await host.close();
    store.close();
  }
});

test('dispatcher shutdown waits for an active tool before requeueing the event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-stop-tool-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let releaseTool!: () => void;
  const toolReleased = new Promise<void>((resolve) => { releaseTool = resolve; });
  let toolStarted = false;
  let toolFinished = false;
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (_input: string, signal?: AbortSignal) => {
      const aborted = new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: undefined,
        completed: aborted,
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() {
          toolStarted = true;
          yield {
            type: 'run_item_stream_event', name: 'tool_called',
            item: { rawItem: { name: 'connector_action', arguments: '{}' } },
          };
          await toolReleased;
          toolFinished = true;
          yield {
            type: 'run_item_stream_event', name: 'tool_output',
            item: { rawItem: { name: 'connector_action' }, output: 'committed' },
          };
          await aborted;
        },
      };
    },
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, { pollMs: 5 });
  try {
    store.enqueueEvent(event('stop-tool', 'finish side effect before stop', 90));
    dispatcher.start();
    await waitUntil(() => toolStarted);
    const stopping = dispatcher.stop();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(toolFinished, false);
    assert.equal(store.getEvent('stop-tool')?.status, 'running');
    releaseTool();
    await stopping;
    assert.equal(toolFinished, true);
    assert.equal(store.getEvent('stop-tool')?.status, 'queued');
    assert.equal(store.getEvent('stop-tool')?.attempts, 0);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
  } finally {
    releaseTool();
    store.close();
  }
});

test('dispatcher runs history maintenance at most once per interval and honors hot reload disable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-maintenance-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const configFile = path.join(root, 'assistant.json');
  const attention = await AttentionEngine.load(configFile, store);
  attention.emitDueRoutines = () => [];
  attention.emitDueBriefings = () => [];
  const cutoffs: Date[] = [];
  store.pruneHistory = (cutoff: Date) => {
    cutoffs.push(cutoff);
    return { outbox: 0, digestItems: 0, runs: 0, events: 0, schedules: 0, attentionState: 0, auditEvents: 0 };
  };
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention);
  try {
    assert.equal(await dispatcher.processOnce(), false);
    assert.equal(await dispatcher.processOnce(), false);
    assert.equal(cutoffs.length, 1);
    const retentionDays = Math.round((Date.now() - cutoffs[0]!.getTime()) / (24 * 60 * 60_000));
    assert.equal(retentionDays, 90);

    const config = JSON.parse(await readFile(configFile, 'utf8')) as { maintenance: { enabled: boolean } };
    config.maintenance.enabled = false;
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await attention.reload();
    assert.equal(await dispatcher.processOnce(), false);
    assert.equal(cutoffs.length, 1);

    config.maintenance.enabled = true;
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await attention.reload();
    assert.equal(await dispatcher.processOnce(), false);
    assert.equal(cutoffs.length, 2);
  } finally {
    store.close();
  }
});

test('dispatcher cancellation atomically archives a queued event and is idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-cancel-queued-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const dispatcher = new MimiDispatcher(store, {} as MimiAgent, attention);
  try {
    store.enqueueEvent(event('cancel-queued', 'do not start', 100));
    assert.deepEqual(dispatcher.cancel('cancel-queued', '用户按下 Esc 取消任务'), { state: 'cancelled' });
    assert.equal(store.getEvent('cancel-queued')?.status, 'archived');
    assert.match(store.getEvent('cancel-queued')?.error ?? '', /Esc/);
    assert.equal(store.listRuns().length, 0);
    assert.equal(store.listOutbox().length, 0);
    assert.deepEqual(dispatcher.cancel('cancel-queued'), { state: 'already_terminal' });
    assert.deepEqual(dispatcher.cancel('missing-event'), { state: 'not_found' });
  } finally {
    store.close();
  }
});

test('dispatcher cancellation interrupts an active event without retry or Outbox delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-cancel-active-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let started = false;
  let abortObserved = false;
  const interrupted: boolean[] = [];
  const terminalInterruptions: boolean[] = [];
  const finalized: Array<{ sessionId: string; executionKey: string }> = [];
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (_input: string, signal?: AbortSignal) => {
      started = true;
      const completed = new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          abortObserved = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: undefined,
        completed,
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() { await completed; },
      };
    },
    completeRun: async () => [],
    failRun: async (error: unknown, wasInterrupted: boolean) => {
      interrupted.push(wasInterrupted);
      terminalInterruptions.push(isTerminalRunInterruption(error));
    },
    finalizeExecutionLedger: async (sessionId: string, executionKey: string) => {
      finalized.push({ sessionId, executionKey });
    },
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention);
  try {
    store.enqueueEvent(event('cancel-active', 'keep working until Esc', 100));
    const processing = dispatcher.processOnce();
    await waitUntil(() => started);
    assert.deepEqual(dispatcher.cancel('cancel-active', '用户按下 Esc 取消任务'), { state: 'cancelled' });
    assert.deepEqual(dispatcher.cancel('cancel-active', '重复取消'), { state: 'cancelled' });
    await processing;
    assert.equal(abortObserved, true);
    assert.equal(store.getEvent('cancel-active')?.status, 'archived');
    assert.equal(store.getEvent('cancel-active')?.attempts, 1);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.deepEqual(interrupted, [true]);
    assert.deepEqual(terminalInterruptions, [true]);
    assert.deepEqual(finalized, [{
      sessionId: ownerSessionId(), executionKey: 'event:cancel-active',
    }]);
    assert.equal(store.listOutbox().length, 0);
    assert.deepEqual(dispatcher.cancel('cancel-active'), { state: 'already_terminal' });
  } finally {
    store.close();
  }
});

test('dispatcher waits for the final tool output safe point before cancelling an active event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-cancel-tool-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
  let toolObserved = false;
  let toolFinished = false;
  let abortObserved = false;
  const agent = {
    switchSession: async () => undefined,
    onRuntimeEvent: () => () => undefined,
    recordEvent: async () => undefined,
    stream: async (_input: string, signal?: AbortSignal) => {
      const aborted = new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          abortObserved = true;
          reject(signal?.reason);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
      return {
        rawResponses: [],
        runContext: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        finalOutput: undefined,
        completed: aborted,
        cancelled: false,
        interruptions: [],
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'run_item_stream_event', name: 'tool_called',
            item: { rawItem: { name: 'connector_action', arguments: '{}' } },
          };
          await toolGate;
          toolFinished = true;
          yield {
            type: 'run_item_stream_event', name: 'tool_output',
            item: { rawItem: { name: 'connector_action' }, output: 'committed' },
          };
          await aborted;
        },
      };
    },
    completeRun: async () => [],
    failRun: async () => undefined,
    finalizeExecutionLedger: async () => undefined,
  } as unknown as MimiAgent;
  const dispatcher = new MimiDispatcher(store, agent, attention, undefined, undefined, {
    onStreamEvent: (_eventId, streamEvent) => {
      if (streamEvent.type === 'run_item_stream_event' && streamEvent.name === 'tool_called') toolObserved = true;
    },
  });
  try {
    store.enqueueEvent(event('cancel-tool', 'finish side effect before cancelling', 100));
    const processing = dispatcher.processOnce();
    await waitUntil(() => toolObserved);
    assert.deepEqual(dispatcher.cancel('cancel-tool', '用户按下 Esc 取消任务'), { state: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(abortObserved, false);
    assert.equal(toolFinished, false);
    assert.equal(store.getEvent('cancel-tool')?.status, 'running');

    releaseTool();
    await processing;
    assert.equal(toolFinished, true);
    assert.equal(abortObserved, true);
    assert.equal(store.getEvent('cancel-tool')?.status, 'archived');
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.equal(store.listOutbox().length, 0);
  } finally {
    releaseTool();
    store.close();
  }
});

test('dispatcher pauses a running background task only after the active tool reaches a safe boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-pause-task-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let releaseTool!: () => void;
  const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
  let toolStarted = false;
  let signalAborted = false;
  const reopened: string[] = [];
  const agent = {
    currentSessionId: 'mimi-task-pause-safe-point',
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async (_sessionId: string, executionKey: string) => {
      reopened.push(executionKey);
    },
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (request: AgentRunRequest, observer?: AgentRunObserver): Promise<AgentRunResult> => {
      toolStarted = true;
      await observer?.onStreamEvent?.({
        type: 'run_item_stream_event', name: 'tool_called',
        item: { rawItem: { name: 'shell', arguments: '{}' } },
      } as never);
      await toolGate;
      await observer?.onStreamEvent?.({
        type: 'run_item_stream_event', name: 'tool_output',
        item: { rawItem: { name: 'shell' }, output: 'committed' },
      } as never);
      signalAborted = request.signal?.aborted ?? false;
      request.signal?.throwIfAborted();
      return { answer: 'unexpected completion', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    store.enqueueEvent({
      ...event('pause-safe-point', 'run a long task', 100),
      sessionKey: 'mimi-task-pause-safe-point',
      executionLane: 'task',
    });
    const processing = dispatcher.processOnce();
    await waitUntil(() => toolStarted);
    assert.deepEqual(dispatcher.pause('pause-safe-point', '用户稍后继续'), { state: 'paused' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(signalAborted, false);
    assert.equal(store.getEvent('pause-safe-point')?.status, 'running');

    releaseTool();
    await processing;
    assert.equal(signalAborted, true);
    assert.equal(store.getEvent('pause-safe-point')?.status, 'paused');
    assert.equal(store.getEvent('pause-safe-point')?.attempts, 0);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
    assert.deepEqual(reopened, ['event:pause-safe-point']);
  } finally {
    releaseTool();
    await host.close();
    store.close();
  }
});

test('task dispatcher consumes a durable cancel intent even when worker-control IPC is lost', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-durable-cancel-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let started = false;
  const agent = {
    currentSessionId: 'mimi-task-durable-cancel',
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined,
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      started = true;
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(request.signal?.reason ?? new Error('cancelled'));
        if (request.signal?.aborted) abort();
        else request.signal?.addEventListener('abort', abort, { once: true });
      });
      return { answer: 'unexpected completion', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);
  const dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
    leaseMs: 90,
  });
  try {
    store.enqueueEvent({
      ...event('durable-cancel-no-ipc', 'run until cancelled', 100),
      sessionKey: 'mimi-task-durable-cancel',
      executionLane: 'task',
    });
    const processing = dispatcher.processOnce();
    await waitUntil(() => started && store.getEvent('durable-cancel-no-ipc')?.status === 'running');
    const requested = store.requestRunningTaskControl(
      'durable-cancel-no-ipc',
      'cancel',
      'kernel accepted cancel before IPC disappeared',
    );
    assert.equal(requested?.taskControl, 'cancel');

    await processing;
    const cancelled = store.getEvent('durable-cancel-no-ipc')!;
    assert.equal(cancelled.status, 'archived');
    assert.equal(cancelled.error, 'kernel accepted cancel before IPC disappeared');
    assert.equal(cancelled.taskControl, undefined);
    assert.equal(store.listRuns()[0]?.status, 'interrupted');
  } finally {
    await host.close();
    store.close();
  }
});

test('background input request atomically blocks the task and creates a notification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-block-task-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const reopened: string[] = [];
  const agent = {
    currentSessionId: 'mimi-task-needs-input',
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined,
    reopenExecutionLedger: async (_sessionId: string, executionKey: string) => {
      reopened.push(executionKey);
    },
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (request: AgentRunRequest, observer?: AgentRunObserver): Promise<AgentRunResult> => {
      const block = request.options?.hostTools?.find((tool) => tool.name === 'request_background_task_input');
      assert.ok(block && 'invoke' in block);
      await observer?.onStreamEvent?.({
        type: 'run_item_stream_event', name: 'tool_called',
        item: { rawItem: { name: block.name, arguments: '{}' } },
      } as never);
      const output = await block.invoke(new RunContext({}), JSON.stringify({
        question: '请提供测试环境的访问地址',
        reason: '缺少地址无法继续验证',
      }));
      await observer?.onStreamEvent?.({
        type: 'run_item_stream_event', name: 'tool_output',
        item: { rawItem: { name: block.name }, output },
      } as never);
      request.signal?.throwIfAborted();
      return { answer: 'unexpected completion', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    store.enqueueEvent({
      ...event('block-for-input', 'verify the deployment', 100),
      sessionKey: 'mimi-task-needs-input',
      executionLane: 'task',
      originSessionKey: 'conversation-owner',
      replyRoute: { channel: 'system' },
    });
    assert.equal(await dispatcher.processOnce(), true);
    const blocked = store.getEvent('block-for-input')!;
    assert.equal(blocked.status, 'blocked');
    assert.match(JSON.stringify(blocked.result), /测试环境的访问地址/);
    assert.deepEqual(reopened, ['event:block-for-input']);
    const notification = store.listOutbox()[0];
    assert.equal(notification?.eventId, 'block-for-input');
    assert.match(JSON.stringify(notification?.payload), /background_task_blocked/);
    assert.match(JSON.stringify(notification?.payload), /测试环境的访问地址/);
  } finally {
    await host.close();
    store.close();
  }
});

test('an uncertain Completion Gate result is terminal and never automatically replayed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-uncertain-gate-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  let runs = 0;
  const agent = {
    currentSessionId: ownerSessionId(), switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); }, listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async () => {
      runs += 1;
      throw new CompletionGateError({
        decision: 'uncertain', reason: 'connector outcome uncertain', unmetCriteria: ['sent'],
      }, 'same-evidence');
    },
  });
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    store.enqueueEvent(event('uncertain-gate', '发送消息', 100));
    await dispatcher.processOnce();
    assert.equal(runs, 1);
    assert.equal(store.getEvent('uncertain-gate')?.status, 'dead_letter');
    assert.equal(store.getEvent('uncertain-gate')?.completionDeferrals, 1);
  } finally {
    await host.close();
    store.close();
  }
});

test('three identical tool calls and results terminate one run as a no-progress loop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-tool-loop-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const agent = {
    currentSessionId: ownerSessionId(), switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); }, listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (request, observer) => {
      for (let index = 0; index < 3; index += 1) {
        await observer?.onStreamEvent?.({
          type: 'run_item_stream_event', name: 'tool_called',
          item: { rawItem: { name: 'connector_action', arguments: '{"same":true}' } },
        } as RunStreamEvent);
        await observer?.onStreamEvent?.({
          type: 'run_item_stream_event', name: 'tool_output',
          item: { rawItem: { name: 'connector_action' }, output: { outcome: 'confirmed', messageId: 'one' } },
        } as RunStreamEvent);
      }
      request.signal?.throwIfAborted();
      return { answer: 'should not complete', effects: [] };
    },
  });
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    store.enqueueEvent(event('tool-loop', '发送消息', 100));
    await dispatcher.processOnce();
    assert.equal(store.getEvent('tool-loop')?.status, 'dead_letter');
    assert.equal(store.getEvent('tool-loop')?.attempts, 1);
    assert.match(store.getEvent('tool-loop')?.error ?? '', /无进展循环/);
  } finally {
    await host.close();
    store.close();
  }
});

test('three repeated five-tool cycles terminate one run as a no-progress loop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-long-tool-loop-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const agent = {
    currentSessionId: ownerSessionId(), switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); }, listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (request, observer) => {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        for (let index = 0; index < 5; index += 1) {
          await observer?.onStreamEvent?.({
            type: 'run_item_stream_event', name: 'tool_called',
            item: { rawItem: { name: `tool_${index}`, arguments: `{"index":${index}}` } },
          } as RunStreamEvent);
          await observer?.onStreamEvent?.({
            type: 'run_item_stream_event', name: 'tool_output',
            item: { rawItem: { name: `tool_${index}` }, output: { ok: true, index } },
          } as RunStreamEvent);
        }
      }
      request.signal?.throwIfAborted();
      return { answer: 'should not complete', effects: [] };
    },
  });
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    store.enqueueEvent(event('long-tool-loop', '重复五工具链', 100));
    await dispatcher.processOnce();
    assert.equal(store.getEvent('long-tool-loop')?.status, 'dead_letter');
    assert.match(store.getEvent('long-tool-loop')?.error ?? '', /无进展循环/);
  } finally {
    await host.close();
    store.close();
  }
});

test('persisted confirmed Connector evidence suppresses final delivery after a pre-receipt crash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-dispatcher-ledger-delivery-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const agent = {
    currentSessionId: ownerSessionId(), switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); }, listSessionSummaries: async () => [],
    finalizeExecutionLedger: async () => undefined, close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async (request) => {
      const delivery = await request.options?.completionDelivery?.([{
        sessionId: ownerSessionId(), runId: 'event:ledger-send', toolName: 'connector_action',
        callId: 'semantic-send', argumentsJson: '{}', status: 'succeeded',
        output: {
          tool: 'connector_action', connector: 'qq', action: 'send_message', target: 'single:42',
          outcome: 'confirmed', operationId: 'message-1', occurredAt: new Date().toISOString(),
        },
      }]);
      return { answer: 'sent already', effects: [], delivery };
    },
  });
  const dispatcher = new MimiDispatcher(store, host, attention);
  try {
    store.enqueueEvent({
      ...event('ledger-send', '发送QQ消息', 100),
      replyRoute: { channel: 'connector:qq', target: 'single:42' },
    });
    await dispatcher.processOnce();
    assert.equal(store.getEvent('ledger-send')?.status, 'completed');
    assert.deepEqual((store.getEvent('ledger-send')?.result as { delivery?: unknown }).delivery, {
      suppressed: true,
      reason: '执行账本确认已通过同一 Connector 会话发送，抑制重复最终投递',
    });
    assert.equal(store.listOutbox().some((message) => message.eventId === 'ledger-send'), false);
  } finally {
    await host.close();
    store.close();
  }
});
