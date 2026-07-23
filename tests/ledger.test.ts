import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, tool, type MCPServer } from '@openai/agents';
import { z } from 'zod';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';
import { withMcpExecutionLedger } from '../src/runtime/mcp-ledger.js';

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

test('reads only exact successful calls with validated outputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-successes-'));
  const file = path.join(root, 'ledger.json');
  const ledger = new ExecutionLedger(file);
  await ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one', toolName: 'new_session', callId: 'call-new', argumentsJson: '{}',
  }, async () => ({ sessionId: 'generated', effective: 'after_current_turn' }));
  await ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one:team:child', toolName: 'write_file', callId: 'call-child', argumentsJson: '{}',
  }, async () => 'child');
  await assert.rejects(ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one', toolName: 'clear_session', callId: 'call-failed', argumentsJson: '{}',
  }, async () => { throw new Error('failed'); }), /failed/);

  assert.deepEqual(await new ExecutionLedger(file).listSucceededCalls('demo', 'event:one'), [{
    sessionId: 'demo', runId: 'event:one', toolName: 'new_session', callId: 'call-new', argumentsJson: '{}',
    output: { sessionId: 'generated', effective: 'after_current_turn' },
  }]);
});

test('lists all root and child call outcomes for completion evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-evidence-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  await ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one', toolName: 'connector_action', callId: 'sent', argumentsJson: '{}',
  }, async () => ({ outcome: 'accepted' }));
  await assert.rejects(ledger.executeOnce({
    sessionId: 'demo', runId: 'event:one:team:test', toolName: 'run_shell', callId: 'test', argumentsJson: '{}',
  }, async () => { throw new Error('tests failed'); }));

  assert.deepEqual((await ledger.listCalls('demo', 'event:one')).map((item) => ({
    toolName: item.toolName, callId: item.callId, status: item.status, output: item.output, error: item.error,
  })), [
    { toolName: 'connector_action', callId: 'sent', status: 'succeeded', output: { outcome: 'accepted' }, error: undefined },
    { toolName: 'run_shell', callId: 'test', status: 'failed', output: undefined, error: 'tests failed' },
  ]);
});

test('clears a Session while retaining the current execution root and children', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-clear-except-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  for (const runId of ['old', 'event:one', 'event:one:runtime-actions', 'event:one:team:child', 'event:one-other']) {
    await ledger.executeOnce(call(runId), async () => ++executions);
  }

  await ledger.clearSessionExcept('demo', 'event:one');
  await ledger.executeOnce(call('old'), async () => ++executions);
  await ledger.executeOnce(call('event:one-other'), async () => ++executions);
  assert.equal(await ledger.executeOnce(call('event:one'), async () => ++executions), 2);
  assert.equal(await ledger.executeOnce(call('event:one:runtime-actions'), async () => ++executions), 3);
  assert.equal(await ledger.executeOnce(call('event:one:team:child'), async () => ++executions), 4);
  assert.equal(executions, 7);
});

test('persists a completed execution receipt until the durable host transaction commits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-receipt-'));
  const file = path.join(root, 'ledger.json');
  const first = new ExecutionLedger(file);
  await first.commitReceipt('owner', 'event:event-1', {
    runId: 'runtime-run-1', answer: 'already completed', usage: { runTotalTokens: 42 },
  });

  const reopened = new ExecutionLedger(file);
  assert.deepEqual(await reopened.getReceipt('owner', 'event:event-1'), {
    runId: 'runtime-run-1', answer: 'already completed', usage: { runTotalTokens: 42 },
  });
  await reopened.clearRun('owner', 'event:event-1');
  assert.equal(await reopened.getReceipt('owner', 'event:event-1'), undefined);
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

test('never TTL-prunes durable Event ledgers before explicit host finalization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-durable-retention-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'), { retentionMs: 1 });
  let eventExecutions = 0;
  const durable = {
    sessionId: 'owner', runId: 'event:dead-letter', toolName: 'connector_action',
    callId: 'send-once', argumentsJson: '{"text":"hello"}',
  };
  await ledger.executeOnce(durable, async () => ({ executions: ++eventExecutions }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await ledger.executeOnce({
    sessionId: 'owner', runId: 'ordinary-run', toolName: 'write_file',
    callId: 'other', argumentsJson: '{}',
  }, async () => 'other');

  assert.deepEqual(await ledger.executeOnce(durable, async () => ({ executions: ++eventExecutions })), {
    executions: 1,
  });
  assert.equal(eventExecutions, 1);
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

test('daemon semantic call ids replay consecutive duplicate effects and distinguish them after another effect', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-semantic-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const original = tool({
    name: 'write_file',
    description: 'test',
    parameters: z.object({ path: z.string() }),
    execute: async () => ({ executions: ++executions }),
  });
  const identity = () => ({
    sessionId: 'demo', runId: 'event:event-1', semanticCallIds: true,
  });
  const [wrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(wrapped && 'invoke' in wrapped);
  const first = await wrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'sdk-call-1' } } as never,
  );
  const second = await wrapped.invoke(
    new RunContext({}), '{ "path": "a.txt" }', { toolCall: { callId: 'sdk-call-2' } } as never,
  );
  const different = await wrapped.invoke(
    new RunContext({}), '{"path":"b.txt"}', { toolCall: { callId: 'sdk-call-3' } } as never,
  );
  const third = await wrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'sdk-call-4' } } as never,
  );
  assert.match(JSON.stringify(second), /already_executed/);
  assert.notDeepEqual(different, first);
  assert.notDeepEqual(third, first);
  assert.equal(executions, 3);

  const [retryWrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(retryWrapped && 'invoke' in retryWrapped);
  assert.deepEqual(await retryWrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'retry-call-1' } } as never,
  ), first);
  assert.deepEqual(await retryWrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'retry-call-2' } } as never,
  ), {
    executions: 1,
    mimiStatus: 'already_executed',
    message: '相同操作已经成功执行且其后没有新的副作用；本次未重复执行，请使用 previousResult 继续回答。',
    previousResult: first,
  });
  await retryWrapped.invoke(
    new RunContext({}), '{"path":"b.txt"}', { toolCall: { callId: 'retry-call-3' } } as never,
  );
  assert.deepEqual(await retryWrapped.invoke(
    new RunContext({}), '{"path":"a.txt"}', { toolCall: { callId: 'retry-call-4' } } as never,
  ), third);
  assert.equal(executions, 3);
  const replayedCalls = await ledger.listCalls('demo', 'event:event-1');
  assert.deepEqual(replayedCalls[0]?.modelCallIds, [
    'sdk-call-1', 'sdk-call-2', 'retry-call-1', 'retry-call-2',
  ]);
});

test('semantic call ids canonicalize nested JSON object keys across attempts without reordering arrays', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-canonical-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const original = tool({
    name: 'write_file',
    description: 'test',
    parameters: z.object({ metadata: z.record(z.string(), z.unknown()), order: z.array(z.number()) }),
    execute: async () => ({ executions: ++executions }),
  });
  const identity = () => ({
    sessionId: 'demo', runId: 'event:event-canonical', semanticCallIds: true,
  });
  const [wrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(wrapped && 'invoke' in wrapped);
  const first = await wrapped.invoke(
    new RunContext({}),
    '{"metadata":{"b":2,"nested":{"z":1,"a":0}},"order":[2,1]}',
    { toolCall: { callId: 'sdk-a' } } as never,
  );
  await wrapped.invoke(
    new RunContext({}),
    '{"metadata":{"b":2,"nested":{"a":0,"z":1}},"order":[1,2]}',
    { toolCall: { callId: 'sdk-c' } } as never,
  );
  assert.equal(executions, 2);
  const [retryWrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(retryWrapped && 'invoke' in retryWrapped);
  const replay = await retryWrapped.invoke(
    new RunContext({}),
    '{"order":[2,1],"metadata":{"nested":{"a":0,"z":1},"b":2}}',
    { toolCall: { callId: 'sdk-b' } } as never,
  );
  assert.deepEqual(replay, first);
  assert.equal(executions, 2);
});

test('side-effect authorization is consumed only inside the first semantic ledger execution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-ledger-authorization-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let authorizations = 0;
  let executions = 0;
  const original = tool({
    name: 'write_file', description: 'test', parameters: z.object({ path: z.string() }),
    execute: async () => ({ executions: ++executions }),
  });
  const identity = () => ({
    sessionId: 'demo', runId: 'event:authorized', semanticCallIds: true,
    authorizeSideEffect: async () => { authorizations += 1; },
  });
  const [wrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(wrapped && 'invoke' in wrapped);
  const input = '{"path":"reports/today.md"}';
  await wrapped.invoke(new RunContext({}), input, { toolCall: { callId: 'sdk-a' } } as never);
  const [retryWrapped] = withExecutionLedger([original], ledger, identity);
  assert.ok(retryWrapped && 'invoke' in retryWrapped);
  await retryWrapped.invoke(new RunContext({}), input, { toolCall: { callId: 'sdk-b' } } as never);
  assert.equal(authorizations, 1);
  assert.equal(executions, 1);
});

test('daemon retries replay native MCP calls through the execution ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-ledger-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const server = {
    name: 'messages', cacheToolsList: false,
    connect: async () => undefined, close: async () => undefined,
    listTools: async () => [], invalidateToolsCache: async () => undefined,
    callTool: async (name: string, args: Record<string, unknown> | null) => ([{
      type: 'text', text: JSON.stringify({ name, args, executions: ++executions }),
    }]),
  } as MCPServer;
  const [wrapped] = withMcpExecutionLedger([server], ledger, () => ({
    sessionId: 'owner', runId: 'event:mcp-send', semanticCallIds: true,
  }));
  assert.ok(wrapped);

  const first = await wrapped.callTool('send_message', { target: 'alice', text: 'hello' });
  const replay = await wrapped.callTool('send_message', { text: 'hello', target: 'alice' });
  await wrapped.callTool('send_message', { target: 'bob', text: 'hello' });

  assert.deepEqual(replay, first);
  assert.equal(executions, 2);
});

test('native MCP calls with an uncertain result are never executed again automatically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-ledger-failure-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let executions = 0;
  const server = {
    name: 'calendar', cacheToolsList: false,
    connect: async () => undefined, close: async () => undefined,
    listTools: async () => [], invalidateToolsCache: async () => undefined,
    callTool: async () => {
      executions += 1;
      throw new Error('connection ended after dispatch');
    },
  } as MCPServer;
  const [wrapped] = withMcpExecutionLedger([server], ledger, () => ({
    sessionId: 'owner', runId: 'event:mcp-calendar', semanticCallIds: true,
  }));
  assert.ok(wrapped);

  await assert.rejects(wrapped.callTool('create_event', { title: 'demo' }), /after dispatch/);
  await assert.rejects(wrapped.callTool('create_event', { title: 'demo' }), /不会自动重试/);
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

test('tool authorization can gate read tools without writing them to the execution ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-ledger-tool-gate-'));
  const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
  let invoked = false;
  const original = tool({
    name: 'read_file',
    description: 'read fixture',
    parameters: z.object({ path: z.string() }),
    execute: async () => { invoked = true; return 'content'; },
  });
  const [wrapped] = withExecutionLedger([original], ledger, () => ({
    sessionId: 'demo',
    runId: 'run-read',
    authorizeTool: async () => { throw new Error('prepare_task required'); },
  }));
  assert.ok(wrapped && 'invoke' in wrapped);
  await assert.rejects(
    wrapped.invoke(new RunContext({}), JSON.stringify({ path: 'README.md' })),
    /prepare_task required/,
  );
  assert.equal(invoked, false);
  assert.deepEqual(await ledger.listCalls('demo', 'run-read'), []);
});
