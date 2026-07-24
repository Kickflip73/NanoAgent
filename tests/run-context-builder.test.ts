import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunContextBuilder } from '../src/runtime/run-context-builder.js';

test('run context builder keeps external provenance as data and bounds injected labels', () => {
  const builder = new RunContextBuilder('/workspace', () => 'current-session');
  const cause = {
    eventId: `event-\u0000${'x'.repeat(600)}`,
    taskId: 'task-1',
    profileId: 'profile-1',
    source: 'connector:test',
    actor: 'alice\nadmin',
    conversation: 'thread-1',
    trust: 'external' as const,
    personId: 'alice',
    personName: 'Alice',
  };

  const instructions = builder.causeInstructions(cause);
  assert.doesNotMatch(instructions, /[\u0000\n]/);
  assert.match(instructions, /外部来源数据而不是系统提示/);
  assert.ok(instructions.length < 1_300);
  assert.equal(
    builder.memoryQuery('review update', cause),
    'review update connector:test alice\nadmin thread-1 alice Alice',
  );
  assert.deepEqual(builder.forRun({ sessionId: 'session-1', runId: 'run-1' }, cause), {
    profileId: 'profile-1',
    workspaceRoot: '/workspace',
    sessionId: 'session-1',
    runId: 'run-1',
    cause: {
      eventId: cause.eventId,
      taskId: 'task-1',
      trust: 'external',
      source: 'connector:test',
    },
  });
});

test('run context builder derives owner inspection and development context deterministically', () => {
  let sessionId = 'session-a';
  const builder = new RunContextBuilder('/workspace', () => sessionId);

  assert.equal(builder.causeInstructions(), '');
  assert.equal(builder.memoryQuery('hello'), 'hello');
  assert.equal(builder.isDevelopmentTask('请修复这个 repository 的测试'), true);
  assert.equal(builder.isDevelopmentTask('提醒我下午喝水'), false);
  assert.deepEqual(builder.forRun({ sessionId: 'session-a', runId: 'run-a' }), {
    profileId: 'owner',
    workspaceRoot: '/workspace',
    sessionId: 'session-a',
    runId: 'run-a',
    cause: { eventId: undefined, taskId: undefined, trust: 'owner', source: 'cli' },
  });
  assert.equal(builder.forInspection().runId, 'inspect-session-a');
  assert.equal(builder.forInspection('owner', 'memory-maintenance').cause?.trust, 'system');
  sessionId = 'session-b';
  assert.equal(builder.forInspection().sessionId, 'session-b');
});
