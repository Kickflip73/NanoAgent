import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
import { MimiHost } from '../src/runtime/mimi-host.js';
import type {
  AgentRunObserver,
  AgentRunRequest,
  AgentRunResult,
} from '../src/runtime/run-service.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('serializes Session mutations behind the active Agent run', async () => {
  const release = deferred();
  const started = deferred();
  const order: string[] = [];
  let currentSessionId = 'session-a';
  const agent = {
    get currentSessionId() { return currentSessionId; },
    switchSession: async (sessionId: string) => {
      order.push(`switch:${sessionId}`);
      currentSessionId = sessionId;
    },
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (_request: AgentRunRequest, _observer?: AgentRunObserver): Promise<AgentRunResult> => {
      order.push('run:start');
      started.resolve();
      await release.promise;
      order.push('run:end');
      return { answer: 'done', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);

  const run = host.execute({ sessionId: 'session-a', input: 'work' });
  await started.promise;
  const mutation = host.mutate('session-b', async (runtime) => {
    order.push(`mutate:${runtime.currentSessionId}`);
    return 'changed';
  });
  await Promise.resolve();
  assert.deepEqual(order, ['run:start']);

  release.resolve();
  assert.equal((await run).answer, 'done');
  assert.equal(await mutation, 'changed');
  assert.deepEqual(order, ['run:start', 'run:end', 'switch:session-b', 'mutate:session-b']);
});

test('runs different Session actors concurrently while preserving each Session FIFO lane', async () => {
  const releaseA = deferred();
  const releaseB = deferred();
  const startedA = deferred();
  const startedB = deferred();
  const secondAStarted = deferred();
  const order: string[] = [];

  const runtime = (sessionId: string, release: ReturnType<typeof deferred>) => {
    const agent = {
      currentSessionId: sessionId,
      bindSessionActor: (boundSessionId: string) => assert.equal(boundSessionId, sessionId),
      switchSession: async () => undefined,
      sessionSnapshot: async () => { throw new Error('unused'); },
      listSessionSummaries: async () => [],
      close: async () => undefined,
    } as unknown as MimiAgent;
    let executions = 0;
    const runs = {
      execute: async (): Promise<AgentRunResult> => {
        executions += 1;
        order.push(`${sessionId}:${executions}:start`);
        if (sessionId === 'session-a' && executions === 1) startedA.resolve();
        if (sessionId === 'session-a' && executions === 2) secondAStarted.resolve();
        if (sessionId === 'session-b') startedB.resolve();
        if (executions === 1) await release.promise;
        order.push(`${sessionId}:${executions}:end`);
        return { answer: sessionId, effects: [] };
      },
    };
    return { agent, runs };
  };

  const primary = runtime('session-a', releaseA);
  const host = new MimiHost(primary.agent, primary.runs, {
    maxConcurrentSessions: 2,
    createSessionRuntime: async (sessionId) => {
      assert.equal(sessionId, 'session-b');
      return runtime(sessionId, releaseB);
    },
  });

  const firstA = host.execute({ sessionId: 'session-a', input: 'first A' });
  await startedA.promise;
  const secondA = host.execute({ sessionId: 'session-a', input: 'second A' });
  const firstB = host.execute({ sessionId: 'session-b', input: 'first B' });
  await startedB.promise;

  assert.deepEqual(order, ['session-a:1:start', 'session-b:1:start']);
  releaseB.resolve();
  assert.equal((await firstB).answer, 'session-b');
  assert.deepEqual(order, ['session-a:1:start', 'session-b:1:start', 'session-b:1:end']);

  releaseA.resolve();
  assert.equal((await firstA).answer, 'session-a');
  await secondAStarted.promise;
  assert.equal((await secondA).answer, 'session-a');
  assert.deepEqual(order, [
    'session-a:1:start',
    'session-b:1:start',
    'session-b:1:end',
    'session-a:1:end',
    'session-a:2:start',
    'session-a:2:end',
  ]);
  await host.close();
});

test('evicts least-recently-used idle Session actors without touching the primary actor', async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const runtime = (sessionId: string) => ({
    agent: {
      currentSessionId: sessionId,
      bindSessionActor: (boundSessionId: string) => assert.equal(boundSessionId, sessionId),
      switchSession: async () => undefined,
      sessionSnapshot: async () => { throw new Error('unused'); },
      listSessionSummaries: async () => [],
      close: async () => { closed.push(sessionId); },
    } as unknown as MimiAgent,
    runs: { execute: async () => ({ answer: sessionId, effects: [] }) },
  });
  const primary = runtime('session-a');
  const host = new MimiHost(primary.agent, primary.runs, {
    maxConcurrentSessions: 2,
    maxCachedSessions: 2,
    sessionIdleMs: 60_000,
    createSessionRuntime: async (sessionId) => {
      created.push(sessionId);
      return runtime(sessionId);
    },
  });

  await host.mutate('session-b', async () => undefined);
  await host.mutate('session-c', async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(created, ['session-b', 'session-c']);
  assert.deepEqual(closed, ['session-b']);

  await host.mutate('session-b', async () => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(created, ['session-b', 'session-c', 'session-b']);
  assert.deepEqual(closed, ['session-b', 'session-c']);
  await host.close();
  assert.ok(closed.includes('session-a'));
});

test('does not evict a newly created Session actor before its first operation enters the lane', async () => {
  const closed = new Set<string>();
  const operations: Array<{ sessionId: string; closed: boolean }> = [];
  const runtime = (sessionId: string) => ({
    agent: {
      currentSessionId: sessionId,
      bindSessionActor: (boundSessionId: string) => assert.equal(boundSessionId, sessionId),
      switchSession: async () => undefined,
      sessionSnapshot: async () => { throw new Error('unused'); },
      listSessionSummaries: async () => [],
      close: async () => { closed.add(sessionId); },
    } as unknown as MimiAgent,
    runs: { execute: async () => ({ answer: sessionId, effects: [] }) },
  });
  const primary = runtime('session-a');
  const host = new MimiHost(primary.agent, primary.runs, {
    maxCachedSessions: 2,
    sessionIdleMs: 60_000,
    createSessionRuntime: async (sessionId) => runtime(sessionId),
  });

  await Promise.all(['session-b', 'session-c'].map((sessionId) => host.mutate(sessionId, async () => {
    operations.push({ sessionId, closed: closed.has(sessionId) });
  })));

  assert.deepEqual(operations.sort((left, right) => left.sessionId.localeCompare(right.sessionId)), [
    { sessionId: 'session-b', closed: false },
    { sessionId: 'session-c', closed: false },
  ]);
  await host.close();
});

test('never executes an aborted mutation that is waiting in the serial lane', async () => {
  const release = deferred();
  const started = deferred();
  const order: string[] = [];
  let currentSessionId = 'session-a';
  const agent = {
    get currentSessionId() { return currentSessionId; },
    switchSession: async (sessionId: string) => {
      order.push(`switch:${sessionId}`);
      currentSessionId = sessionId;
    },
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (): Promise<AgentRunResult> => {
      started.resolve();
      await release.promise;
      return { answer: 'done', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);
  const run = host.execute({ sessionId: 'session-a', input: 'work' });
  await started.promise;
  const controller = new AbortController();
  const mutation = host.mutate('session-b', async () => {
    order.push('mutate');
    return 'changed';
  }, controller.signal);
  const rejection = assert.rejects(mutation, /request disconnected/);

  controller.abort(new Error('request disconnected'));
  release.resolve();
  await run;
  await rejection;

  assert.equal(currentSessionId, 'session-a');
  assert.deepEqual(order, []);
});

test('cancels a queued or active execution without waiting for the serial lane', async () => {
  const entered = deferred();
  const agent = {
    currentSessionId: 'session-a',
    switchSession: async () => undefined,
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (request: AgentRunRequest): Promise<AgentRunResult> => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true });
      });
      throw new Error('unreachable');
    },
  };
  const host = new MimiHost(agent, runner);
  const running = host.execute({
    executionId: 'event-1',
    sessionId: 'session-a',
    input: 'work',
  });
  await entered.promise;

  assert.deepEqual(host.cancel('event-1', new Error('owner cancelled')), { state: 'cancelled' });
  await assert.rejects(running, /owner cancelled/);
  assert.deepEqual(host.cancel('event-1'), { state: 'not_found' });
});

test('cancellation wins while a durable receipt is being recovered', async () => {
  const receiptStarted = deferred();
  const releaseReceipt = deferred();
  let runnerExecutions = 0;
  const observed: string[] = [];
  const agent = {
    currentSessionId: 'owner',
    switchSession: async () => undefined,
    completedExecution: async () => {
      receiptStarted.resolve();
      await releaseReceipt.promise;
      return { runId: 'receipt-run', answer: 'too late', effects: [] };
    },
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const host = new MimiHost(agent, {
    execute: async () => {
      runnerExecutions += 1;
      return { answer: 'duplicate', effects: [] };
    },
  });
  const running = host.execute({
    executionId: 'receipt-event', sessionId: 'owner', input: 'recover',
    options: { executionKey: 'event:receipt-event', retainExecutionLedger: true },
  }, {
    onStart: async () => { observed.push('start'); },
    onComplete: async () => { observed.push('complete'); },
  });
  await receiptStarted.promise;
  assert.deepEqual(host.cancel('receipt-event', new Error('owner cancelled recovery')), { state: 'cancelled' });
  releaseReceipt.resolve();

  await assert.rejects(running, /owner cancelled recovery/);
  assert.equal(runnerExecutions, 0);
  assert.deepEqual(observed, []);
});

test('reuses a durable completed execution receipt instead of running the model twice', async () => {
  let runnerExecutions = 0;
  let currentSessionId = 'owner';
  const selected: string[] = [];
  const finalized: Array<{ sessionId: string; executionKey: string }> = [];
  const agent = {
    get currentSessionId() { return currentSessionId; },
    switchSession: async (sessionId: string) => {
      selected.push(sessionId);
      currentSessionId = sessionId;
    },
    completedExecution: async (_sessionId: string, executionKey: string) => {
      if (executionKey !== 'event:event-1') return undefined;
      currentSessionId = 'new-session';
      return {
        runId: 'runtime-run', answer: 'recovered answer', usage: { runTotalTokens: 12 },
        effects: [{ type: 'session_changed', sessionId: 'new-session' }],
      };
    },
    finalizeExecutionLedger: async (sessionId: string, executionKey: string) => {
      finalized.push({ sessionId, executionKey });
    },
    sessionSnapshot: async () => { throw new Error('unused'); },
    listSessionSummaries: async () => [],
    close: async () => undefined,
  } as unknown as MimiAgent;
  const runner = {
    execute: async (): Promise<AgentRunResult> => {
      runnerExecutions += 1;
      return { answer: 'duplicate', effects: [] };
    },
  };
  const host = new MimiHost(agent, runner);

  const result = await host.execute({
    executionId: 'event-1', sessionId: 'owner', input: 'same event',
    options: { executionKey: 'event:event-1', retainExecutionLedger: true },
  });

  assert.equal(result.answer, 'recovered answer');
  assert.deepEqual(result.effects, [{ type: 'session_changed', sessionId: 'new-session' }]);
  assert.equal(result.usage?.runTotalTokens, 12);
  assert.equal(runnerExecutions, 0);
  await host.finalizeExecutionLedger('owner', 'event:event-1');
  assert.equal(host.currentSessionId, 'new-session');
  assert.deepEqual(selected, []);
  assert.deepEqual(finalized, [{ sessionId: 'owner', executionKey: 'event:event-1' }]);
});
