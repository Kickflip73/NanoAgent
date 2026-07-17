import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import type { RunStreamEvent } from '@openai/agents';
import {
  MimiLiveEvents,
  mimiRuntimeStreamEvent,
  mimiStreamEvent,
  mimiStreamEventState,
} from '../src/daemon/live-events.js';
import type { StoredEvent } from '../src/daemon/types.js';

test('Mimi live events preserve answer deltas and bounded cursor reads', () => {
  const buffer = new MimiLiveEvents(2, 2);
  const delta = mimiStreamEvent({
    type: 'raw_model_stream_event', data: { type: 'output_text_delta', delta: '流式回答' },
  } as RunStreamEvent);
  assert.deepEqual(delta, { kind: 'answer', text: '流式回答' });
  assert.ok(delta);
  buffer.publish('event-1', delta);
  buffer.publish('event-1', { kind: 'status', tone: 'tool', title: 'run_shell', next: '正在执行 run_shell' });
  const first = buffer.after('event-1', 0);
  assert.equal(first.length, 2);
  buffer.publish('event-1', { kind: 'status', tone: 'success', title: 'run_shell', next: '模型继续思考' });
  const retained = buffer.after('event-1', 0);
  assert.equal(retained.length, 2);
  assert.equal(retained[0]?.kind, 'status');
  assert.deepEqual(buffer.after('event-1', retained[0]!.sequence), [retained[1]]);
});

test('Mimi live events forward bounded Plan updates to the default CLI', () => {
  const event = mimiRuntimeStreamEvent({
    type: 'plan_updated', sessionId: 'owner',
    steps: [{ id: 'build', description: '实现统一运行时', status: 'running' }],
  });
  assert.deepEqual(event, {
    kind: 'plan', steps: [{ id: 'build', description: '实现统一运行时', status: 'running' }],
  });
});

test('Mimi live events expose only the requested recent task progress', () => {
  const buffer = new MimiLiveEvents();
  buffer.publish('task-1', { kind: 'status', tone: 'agent', title: 'Mimi Task', next: '分析目标' });
  buffer.publish('task-1', {
    kind: 'plan',
    steps: [{ id: 'build', description: '构建项目', status: 'running' }],
  });
  buffer.publish('task-1', { kind: 'status', tone: 'tool', title: 'run_shell', next: '正在执行 run_shell' });

  const recent = buffer.recent('task-1', 2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0]?.kind, 'plan');
  assert.equal(recent[1]?.kind, 'status');
  assert.deepEqual(buffer.recent('unknown'), []);
});

test('Mimi live events bound individual details and paginate by encoded bytes', () => {
  const buffer = new MimiLiveEvents();
  for (let index = 0; index < 3; index += 1) {
    buffer.publish('event-large', {
      kind: 'status', tone: 'tool', title: 'run_shell', detail: `call-${index}`,
      fullDetail: 'x'.repeat(100_000), next: '继续',
    });
  }

  const first = buffer.page('event-large', 0, 48 * 1024);
  assert.ok(first.events.length >= 1);
  assert.ok(Buffer.byteLength(JSON.stringify(first.events), 'utf8') <= 48 * 1024);
  assert.equal(first.hasMore, true);
  const status = first.events[0];
  assert.equal(status?.kind, 'status');
  if (status?.kind === 'status' && status.title !== '流式事件过大') {
    assert.ok(Buffer.byteLength(status.fullDetail ?? '', 'utf8') <= 32 * 1024);
  }

  const second = buffer.page('event-large', first.nextSequence, 48 * 1024);
  assert.ok(second.nextSequence > first.nextSequence);
});

test('terminal event stream state omits inbound payload and bounds the final answer', () => {
  const now = new Date().toISOString();
  const stored: StoredEvent = {
    id: 'event-state', externalId: 'external', source: 'local-cli', kind: 'command', trust: 'owner',
    payload: { private: 'x'.repeat(1_000_000) }, occurredAt: now, receivedAt: now, priority: 100,
    profileId: 'owner', status: 'completed', attempts: 1, notBefore: now,
    result: { answer: '\u0000'.repeat(1_000_000), effects: [{ type: 'exit_requested' }] },
    createdAt: now, updatedAt: now,
  };
  const state = mimiStreamEventState(stored);
  assert.ok(state);
  assert.equal('payload' in state, false);
  assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') < 512 * 1024);
  assert.deepEqual((state.result as Record<string, unknown>).effects, [{ type: 'exit_requested' }]);
});
