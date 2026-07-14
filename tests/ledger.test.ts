import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, tool } from '@openai/agents';
import { z } from 'zod';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';

function call(runId = 'run-a', argumentsJson = '{"path":"a.txt"}') {
  return {
    sessionId: 'demo',
    runId,
    toolName: 'write_file',
    callId: 'call-1',
    argumentsJson,
  };
}

test('replays a successful local side effect instead of executing it twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const operation = async () => ({ value: ++executions });

  const [first, replay] = await Promise.all([
    ledger.executeOnce(call(), operation),
    ledger.executeOnce(call(), operation),
  ]);
  const laterReplay = await new ExecutionLedger(path.join(root, 'ledger.json')).executeOnce(call(), operation);

  assert.deepEqual(first, { value: 1 });
  assert.deepEqual(replay, first);
  assert.deepEqual(laterReplay, first);
  assert.equal(executions, 1);
});

test('blocks ambiguous or conflicting side-effect retries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-failure-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  await assert.rejects(ledger.executeOnce(call(), async () => {
    executions += 1;
    throw new Error('operation failed after an unknown boundary');
  }), /unknown boundary/);

  await assert.rejects(ledger.executeOnce(call(), async () => { executions += 1; }), /不会自动重试/);
  await assert.rejects(ledger.executeOnce(call('run-a', '{"path":"other.txt"}'), async () => undefined), /参数冲突/);
  assert.equal(executions, 1);
});

test('keeps identical call ids isolated by run and clears them with the session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-clear-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  await ledger.executeOnce(call('run-a'), async () => ++executions);
  await ledger.executeOnce(call('run-b'), async () => ++executions);
  await ledger.clearSession('demo');
  await ledger.executeOnce(call('run-a'), async () => ++executions);
  assert.equal(executions, 3);
});

test('clears Team worker ledger children with their parent run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-team-clear-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const child = call('run-a:team:build:claim');
  await ledger.executeOnce(child, async () => ++executions);
  await ledger.clearRun('demo', 'run-a');
  await ledger.executeOnce(child, async () => ++executions);
  assert.equal(executions, 2);
});

test('wraps SDK side-effect tools with the active run ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-tool-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const original = tool({
    name: 'write_file',
    description: 'test',
    parameters: z.object({ path: z.string() }),
    execute: async () => ({ executions: ++executions }),
  });
  const [wrapped] = withExecutionLedger([original], ledger, () => ({ sessionId: 'demo', runId: 'run-a' }));
  assert.ok(wrapped && 'invoke' in wrapped);
  const details = { toolCall: { callId: 'sdk-call-1' } } as never;

  const first = await wrapped.invoke(new RunContext({}), '{"path":"a.txt"}', details);
  const replay = await wrapped.invoke(new RunContext({}), '{"path":"a.txt"}', details);

  assert.deepEqual(replay, first);
  assert.equal(executions, 1);
});

test('fails closed when the execution ledger is corrupt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-corrupt-'));
  const file = path.join(root, 'ledger.json');
  await writeFile(file, '{broken');
  let executions = 0;

  await assert.rejects(
    new ExecutionLedger(file).executeOnce(call(), async () => ++executions),
    /状态文件损坏，已隔离/,
  );
  await assert.rejects(
    new ExecutionLedger(file).executeOnce(call(), async () => ++executions),
    /状态文件损坏，已隔离/,
  );
  assert.equal(executions, 0);
  assert.ok((await readdir(root)).some((name) => name.startsWith('ledger.json.corrupt-')));
});

test('bounds ledger outputs and entry growth without replaying side effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-limits-'));
  const outputLedger = new ExecutionLedger(path.join(root, 'outputs.json'), { maxOutputBytes: 16 });
  let outputExecutions = 0;
  await assert.rejects(
    outputLedger.executeOnce(call(), async () => ({ value: 'too-large', count: ++outputExecutions })),
    /超过执行账本 16 字节限制/,
  );
  await assert.rejects(
    outputLedger.executeOnce(call(), async () => { outputExecutions += 1; }),
    /不会自动重试/,
  );
  assert.equal(outputExecutions, 1);

  const entryLedger = new ExecutionLedger(path.join(root, 'entries.json'), { maxEntries: 1 });
  await entryLedger.executeOnce(call('run-a'), async () => 'first');
  await assert.rejects(
    entryLedger.executeOnce(call('run-b'), async () => 'second'),
    /达到 1 条上限/,
  );
});

test('rejects conflicting arguments while the same call id is still in flight', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-inflight-conflict-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const first = ledger.executeOnce(call(), async () => {
    executions += 1;
    started();
    await barrier;
    return 'done';
  });
  await entered;

  await assert.rejects(
    ledger.executeOnce(call('run-a', '{"path":"other.txt"}'), async () => { executions += 1; }),
    /参数冲突/,
  );
  release();
  assert.equal(await first, 'done');
  assert.equal(executions, 1);
});
