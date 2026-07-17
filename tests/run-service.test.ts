import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
import { isTerminalRunInterruption, TerminalRunInterruptedError } from '../src/runtime/run-outcome.js';
import { AgentRunService } from '../src/runtime/run-service.js';
import { CompletionGateError } from '../src/core/completion.js';

test('shared run service owns completion, usage and observer isolation', async () => {
  let completedAnswer = '';
  let stopped = false;
  const stream = {
    rawResponses: [{ usage: { inputTokens: 11, outputTokens: 7 } }],
    runContext: { usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
    finalOutput: 'durable answer',
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() { /* no streamed deltas */ },
  };
  const agent = {
    onRuntimeEvent: () => () => { stopped = true; },
    stream: async () => stream,
    recordEvent: async () => undefined,
    completeRun: async (answer: string) => { completedAnswer = answer; return []; },
    failRun: async () => assert.fail('successful run must not fail'),
  } as unknown as MimiAgent;
  const result = await new AgentRunService(agent).execute({ input: 'work' }, {
    onComplete: () => { throw new Error('presentation failed'); },
  });
  assert.equal(result.answer, 'durable answer');
  assert.equal(completedAnswer, 'durable answer');
  assert.deepEqual(result.usage, {
    lastRequestInputTokens: 11,
    lastRequestOutputTokens: 7,
    runInputTokens: 12,
    runOutputTokens: 8,
    runTotalTokens: 20,
  });
  assert.equal(stopped, true);
});

test('shared run service records one failed terminal outcome', async () => {
  const failure = new Error('provider unavailable');
  let failed: unknown;
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => { throw failure; },
    failRun: async (error: unknown) => { failed = error; },
  } as unknown as MimiAgent;
  await assert.rejects(new AgentRunService(agent).execute({ input: 'work' }), /provider unavailable/);
  assert.equal(failed, failure);
});

test('shared run service preserves a terminal signal when the SDK throws a generic abort error', async () => {
  const controller = new AbortController();
  controller.abort(new TerminalRunInterruptedError('owner cancelled'));
  let failed: unknown;
  let interrupted = false;
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => { throw new Error('AbortError'); },
    failRun: async (error: unknown, wasInterrupted: boolean) => {
      failed = error;
      interrupted = wasInterrupted;
    },
  } as unknown as MimiAgent;

  await assert.rejects(
    new AgentRunService(agent).execute({ input: 'work', signal: controller.signal }),
    /AbortError/,
  );
  assert.equal(interrupted, true);
  assert.equal(isTerminalRunInterruption(failed), true);
});

test('completion gate rejection defers the run without recording a normal failure', async () => {
  const gateError = new CompletionGateError({
    decision: 'continue', reason: 'missing proof', unmetCriteria: ['sent'],
  });
  let deferred: CompletionGateError | undefined;
  let failed = false;
  const stream = {
    rawResponses: [],
    runContext: { usage: {} },
    finalOutput: '已经发送成功',
    completed: Promise.resolve(),
    cancelled: false,
    interruptions: [],
    async *[Symbol.asyncIterator]() {
      yield { type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '已经发送成功' } };
    },
  };
  const streamed: unknown[] = [];
  const agent = {
    completionGateRequired: true,
    onRuntimeEvent: () => () => undefined,
    stream: async () => stream,
    recordEvent: async () => undefined,
    completeRun: async () => { throw gateError; },
    deferRunForCompletion: async (error: CompletionGateError) => { deferred = error; },
    failRun: async () => { failed = true; },
  } as unknown as MimiAgent;

  await assert.rejects(new AgentRunService(agent).execute({ input: '发送消息' }, {
    onStreamEvent: (event) => { streamed.push(event); },
  }), /missing proof/);
  assert.equal(deferred, gateError);
  assert.equal(failed, false);
  assert.deepEqual(streamed, []);
});
