import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, type AgentInputItem } from '@openai/agents';
import { ExecutionLedger, type ExecutionCall } from '../src/core/execution-ledger.js';
import { FileSession } from '../src/core/session.js';
import { MimiHost, type HostedRunExecutor } from '../src/runtime/mimi-host.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';

interface RuntimeCall {
  name: string;
  input: Record<string, unknown>;
}

interface AgentInternals {
  ledger: ExecutionLedger;
  runner: { run: (agent: unknown) => Promise<unknown> };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function createAgent(root: string, sessionId: string): Promise<MimiAgent> {
  const previous = process.env.MIMI_SESSION;
  process.env.MIMI_SESSION = sessionId;
  try {
    return await MimiAgent.create({
      provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
      permissionMode: 'trusted', skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
      historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
    });
  } finally {
    if (previous === undefined) delete process.env.MIMI_SESSION;
    else process.env.MIMI_SESSION = previous;
  }
}

function runControlCalls(agent: MimiAgent, calls: RuntimeCall[], outputs: unknown[]): void {
  const internal = agent as unknown as AgentInternals;
  internal.runner.run = async (runtimeAgent) => {
    const tools = (runtimeAgent as { tools: Array<{
      name: string;
      invoke: (context: RunContext<unknown>, input: string, details: unknown) => Promise<unknown>;
    }> }).tools;
    for (const [index, call] of calls.entries()) {
      const selected = tools.find((tool) => tool.name === call.name);
      if (!selected) throw new Error(`missing tool ${call.name}`);
      outputs.push(await selected.invoke(
        new RunContext({}), JSON.stringify(call.input), { toolCall: { callId: `sdk-${index}` } },
      ));
    }
    return {};
  };
}

function crashBeforeRuntimeActions(agent: MimiAgent): void {
  const ledger = (agent as unknown as AgentInternals).ledger;
  const executeOnce = ledger.executeOnce.bind(ledger) as ExecutionLedger['executeOnce'];
  ledger.executeOnce = (<T>(call: ExecutionCall, operation: () => Promise<T>) => {
    if (call.toolName === '__mimi_runtime_action__') {
      return Promise.reject(new Error('simulated crash before runtime action'));
    }
    return executeOnce(call, operation);
  }) as ExecutionLedger['executeOnce'];
}

function completingExecutor(
  agent: MimiAgent,
  afterStream?: (input: string) => Promise<void>,
): HostedRunExecutor {
  return {
    execute: async (request) => {
      await agent.stream(request.input, request.signal, request.options);
      await afterStream?.(request.input);
      const answer = `done:${request.input}`;
      return { answer, effects: await agent.completeRun(answer) };
    },
  };
}

test('defers model and mode changes and restores them from a completion receipt after a crash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-actions-model-'));
  const first = await createAgent(root, 'owner');
  const before = await first.runtimeInfo();
  const targetMode = before.mode.id === 'ultra' ? 'plan' : 'ultra';
  const outputs: unknown[] = [];
  runControlCalls(first, [
    { name: 'switch_model', input: { model: 'runtime-action-test-model' } },
    { name: 'switch_mode', input: { mode: targetMode } },
  ], outputs);
  await first.stream('下一轮切换模型和模式', undefined, {
    executionKey: 'event:model-mode', retainExecutionLedger: true,
  });
  assert.equal((await first.runtimeInfo()).model, before.model);
  assert.equal((await first.runtimeInfo()).mode.id, before.mode.id);
  crashBeforeRuntimeActions(first);
  await assert.rejects(first.completeRun('scheduled'), /simulated crash/);
  const receipt = await (first as unknown as AgentInternals).ledger.getReceipt<Record<string, unknown>>(
    'owner', 'event:model-mode',
  );
  assert.deepEqual(receipt?.actions, [
    { type: 'switch_model', model: 'runtime-action-test-model' },
    { type: 'switch_mode', mode: targetMode },
  ]);
  await first.close();

  const reopened = await createAgent(root, 'owner');
  try {
    const recovered = await reopened.completedExecution('owner', 'event:model-mode');
    assert.deepEqual(recovered?.effects, [
      { type: 'model_changed', model: 'runtime-action-test-model' },
      { type: 'mode_changed', mode: targetMode },
    ]);
    assert.equal((await reopened.runtimeInfo()).model, 'runtime-action-test-model');
    assert.equal((await reopened.runtimeInfo()).mode.id, targetMode);
  } finally {
    await reopened.close();
  }
});

test('recovers the generated new Session id from the successful tool output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-actions-new-session-'));
  const first = await createAgent(root, 'owner');
  const outputs: unknown[] = [];
  runControlCalls(first, [{ name: 'new_session', input: {} }], outputs);
  await first.stream('请创建新会话', undefined, {
    executionKey: 'event:new-session', retainExecutionLedger: true,
    requireCompletionGate: false,
  });
  const generated = (outputs[0] as { sessionId: string }).sessionId;
  crashBeforeRuntimeActions(first);
  await assert.rejects(first.completeRun('created'), /simulated crash/);
  await first.close();

  const reopened = await createAgent(root, 'owner');
  try {
    const recovered = await reopened.completedExecution('owner', 'event:new-session');
    assert.deepEqual(recovered?.actions, [{ type: 'new_session', sessionId: generated }]);
    assert.deepEqual(recovered?.effects, [{ type: 'session_changed', sessionId: generated }]);
    assert.equal(reopened.currentSessionId, generated);
  } finally {
    await reopened.close();
  }
});

test('a keyed Session actor emits navigation without switching into a concurrently running Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-actions-bound-'));
  const source = await createAgent(root, 'source');
  const target = await createAgent(root, 'target');
  const targetStarted = deferred();
  const releaseTarget = deferred();
  let targetRuns = 0;
  runControlCalls(source, [{ name: 'switch_session', input: { sessionId: 'target' } }], []);
  runControlCalls(target, [], []);
  const host = new MimiHost(source, completingExecutor(source), {
    maxConcurrentSessions: 2,
    createSessionRuntime: async (sessionId) => {
      assert.equal(sessionId, 'target');
      return {
        agent: target,
        runs: completingExecutor(target, async () => {
          targetRuns += 1;
          if (targetRuns !== 1) return;
          targetStarted.resolve();
          await releaseTarget.promise;
        }),
      };
    },
  });
  const runningTarget = host.execute({
    sessionId: 'target', input: 'long target run', options: { requireCompletionGate: false },
  });
  try {
    await targetStarted.promise;
    const targetSession = new FileSession(path.join(root, '.mimi-agent', 'sessions'), 'target');
    const checkpointBefore = await targetSession.getCheckpoint();
    assert.equal(checkpointBefore?.status, 'running');

    const navigated = await host.execute({
      sessionId: 'source', input: '/switch target', options: { requireCompletionGate: false },
    });
    assert.deepEqual(navigated.effects, [{ type: 'session_changed', sessionId: 'target' }]);
    assert.equal(source.currentSessionId, 'source');
    assert.equal(target.currentSessionId, 'target');
    assert.deepEqual(await targetSession.getCheckpoint(), checkpointBefore);

    releaseTarget.resolve();
    await runningTarget;
    runControlCalls(source, [], []);
    const [sourceFollowup, targetFollowup] = await Promise.all([
      host.execute({ sessionId: 'source', input: 'source follow-up', options: { requireCompletionGate: false } }),
      host.execute({ sessionId: 'target', input: 'target follow-up', options: { requireCompletionGate: false } }),
    ]);
    assert.equal(sourceFollowup.answer, 'done:source follow-up');
    assert.equal(targetFollowup.answer, 'done:target follow-up');
    assert.equal(source.currentSessionId, 'source');
    assert.equal(target.currentSessionId, 'target');
  } finally {
    releaseTarget.resolve();
    await runningTarget.catch(() => undefined);
    await host.close();
  }
});

test('a keyed Session actor recovers a navigation receipt without taking ownership of the target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-actions-bound-receipt-'));
  const first = await createAgent(root, 'source');
  runControlCalls(first, [{ name: 'switch_session', input: { sessionId: 'target' } }], []);
  await first.stream('/switch target', undefined, {
    executionKey: 'event:bound-switch', retainExecutionLedger: true,
  });
  crashBeforeRuntimeActions(first);
  await assert.rejects(first.completeRun('switch later'), /simulated crash/);
  await first.close();

  const source = await createAgent(root, 'source');
  const target = await createAgent(root, 'target');
  const targetStarted = deferred();
  const releaseTarget = deferred();
  runControlCalls(source, [], []);
  runControlCalls(target, [], []);
  let sourceRuns = 0;
  const host = new MimiHost(source, {
    execute: async (request) => {
      sourceRuns += 1;
      return completingExecutor(source).execute(request);
    },
  }, {
    maxConcurrentSessions: 2,
    createSessionRuntime: async (sessionId) => {
      assert.equal(sessionId, 'target');
      return {
        agent: target,
        runs: completingExecutor(target, async () => {
          targetStarted.resolve();
          await releaseTarget.promise;
        }),
      };
    },
  });
  const runningTarget = host.execute({ sessionId: 'target', input: 'long target run' });
  try {
    await targetStarted.promise;
    const targetSession = new FileSession(path.join(root, '.mimi-agent', 'sessions'), 'target');
    const checkpointBefore = await targetSession.getCheckpoint();
    const recovered = await host.execute({
      sessionId: 'source', input: 'recover durable switch',
      options: { executionKey: 'event:bound-switch', retainExecutionLedger: true },
    });

    assert.equal(sourceRuns, 0);
    assert.equal(recovered.answer, 'switch later');
    assert.deepEqual(recovered.effects, [{ type: 'session_changed', sessionId: 'target' }]);
    assert.equal(source.currentSessionId, 'source');
    assert.equal(target.currentSessionId, 'target');
    assert.deepEqual(await targetSession.getCheckpoint(), checkpointBefore);
  } finally {
    releaseTarget.resolve();
    await runningTarget.catch(() => undefined);
    await host.close();
  }
});

test('clear_session retains the current receipt and is not replayed onto later data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-actions-clear-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const session = new FileSession(path.join(dataRoot, 'sessions'), 'owner');
  await session.addItems([{ role: 'user', content: 'OLD_DATA' }] as AgentInputItem[]);
  const agent = await createAgent(root, 'owner');
  runControlCalls(agent, [
    {
      name: 'prepare_task',
      input: {
        objective: '清空当前会话',
        kind: 'answer',
        criteria: [{
          id: 'cleared',
          description: '当前会话数据已由 clear_session 清除',
          requiredEvidence: 'tool_receipt',
          expectedTool: 'clear_session',
          expectedArgumentsContain: ['{}'],
        }],
      },
    },
    { name: 'clear_session', input: {} },
    {
      name: 'finish_task',
      input: {
        status: 'completed',
        proofs: [{ criterionId: 'cleared', evidence: 'clear_session 已成功', toolCallIds: ['sdk-1'] }],
      },
    },
  ], []);
  try {
    await agent.stream('请清空当前会话', undefined, {
      executionKey: 'event:clear', retainExecutionLedger: true,
    });
    assert.deepEqual(await agent.completeRun('cleared'), [{ type: 'session_cleared', sessionId: 'owner' }]);
    const ledger = (agent as unknown as AgentInternals).ledger;
    assert.ok(await ledger.getReceipt('owner', 'event:clear'));
    assert.deepEqual(await session.getItems(), []);

    await session.addItems([{ role: 'user', content: 'NEW_DATA_AFTER_CLEAR' }] as AgentInputItem[]);
    const recovered = await agent.completedExecution('owner', 'event:clear');
    assert.deepEqual(recovered?.effects, [{ type: 'session_cleared', sessionId: 'owner' }]);
    assert.match(JSON.stringify(await session.getItems()), /NEW_DATA_AFTER_CLEAR/);
    assert.ok(await ledger.getReceipt('owner', 'event:clear'));

    await agent.finalizeExecutionLedger('owner', 'event:clear');
    assert.equal(await ledger.getReceipt('owner', 'event:clear'), undefined);
  } finally {
    await agent.close();
  }
});

test('rejects an invalid persisted RuntimeAction before applying it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-runtime-actions-invalid-'));
  const agent = await createAgent(root, 'owner');
  try {
    await (agent as unknown as AgentInternals).ledger.commitReceipt('owner', 'event:invalid', {
      runId: 'runtime-run', answer: 'unsafe', actions: [{ type: 'switch_session', sessionId: '../escape' }],
    });
    await assert.rejects(agent.completedExecution('owner', 'event:invalid'), /会话 ID|RuntimeAction|invalid/i);
    assert.equal(agent.currentSessionId, 'owner');
  } finally {
    await agent.close();
  }
});
