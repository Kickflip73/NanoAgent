import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MimiAgent } from '../src/runtime/mimi-agent.js';
import { isTerminalRunInterruption, TerminalRunInterruptedError } from '../src/runtime/run-outcome.js';
import { AgentRunService } from '../src/runtime/run-service.js';

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

test('trusted host answers complete without invoking the model stream', async () => {
  let hostInput = '';
  let hostAnswer = '';
  let streamed = false;
  const observed: string[] = [];
  const agent = {
    onRuntimeEvent: () => () => undefined,
    stream: async () => { streamed = true; throw new Error('model must not run'); },
    completeHostRun: async (input: string, answer: string) => {
      hostInput = input;
      hostAnswer = answer;
      return [];
    },
    failRun: async () => assert.fail('successful host answer must not fail'),
  } as unknown as MimiAgent;

  const result = await new AgentRunService(agent).execute({
    input: '咋样了？', trustedHostAnswer: '当前没有任务在运行。',
  }, {
    onStart: () => { observed.push('start'); },
    onComplete: () => { observed.push('complete'); },
  });

  assert.equal(streamed, false);
  assert.equal(hostInput, '咋样了？');
  assert.equal(hostAnswer, '当前没有任务在运行。');
  assert.equal(result.answer, '当前没有任务在运行。');
  assert.deepEqual(observed, ['start', 'complete']);
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

test('an unfinished Goal completes the Event once with the Host-committed safe answer', async () => {
  const safeAnswer = '长期 Goal 尚未通过验收，已保留当前 Goal 和检查点，不会从头自动重跑。';
  let committedAnswer: string | undefined;
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
    completeRun: async () => { committedAnswer = safeAnswer; return []; },
    get completedRunAnswer() { return committedAnswer; },
    failRun: async () => { failed = true; },
  } as unknown as MimiAgent;

  const result = await new AgentRunService(agent).execute({ input: '继续 Goal' }, {
    onStreamEvent: (event) => { streamed.push(event); },
  });
  assert.equal(result.answer, safeAnswer);
  assert.equal(failed, false);
  assert.deepEqual(streamed, []);
});
