import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { createMimiSessionActivityTools } from '../src/daemon/session-activity-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

function event(id: string): EventEnvelope {
  const timestamp = new Date().toISOString();
  return {
    id, externalId: id, source: 'mail:inbox', kind: 'command', trust: 'external',
    payload: { text: `private payload ${id}` }, occurredAt: timestamp, receivedAt: timestamp,
    priority: 80, profileId: 'owner',
  };
}

function complete(store: MimiStore, id: string, sessionKey: string, answer: unknown): void {
  store.enqueueEvent(event(id));
  const claimed = store.claimEvent(`worker-${id}`);
  assert.ok(claimed);
  const run = store.beginRun(claimed.id, sessionKey);
  store.completeEvent(claimed.id, `worker-${id}`, { answer }, 'completed', undefined, run.id);
}

async function invoke(tool: Tool, input: unknown): Promise<unknown> {
  assert.ok('invoke' in tool && typeof tool.invoke === 'function');
  return tool.invoke(new RunContext({}), JSON.stringify(input));
}

test('session activity tool restores bounded outcomes without crossing Session or exposing payloads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-activity-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    complete(store, 'alice-contract', 'mimi-person-alice', '已发送合同并等待 Alice 签署');
    complete(store, 'alice-trip', 'mimi-person-alice', { result: '机票已预订', confirmation: 'ABC' });
    complete(store, 'alice-long', 'mimi-person-alice', 'x'.repeat(5_000));
    complete(store, 'bob-secret', 'mimi-person-bob', 'BOB_SESSION_MUST_NOT_LEAK');
    const tool = createMimiSessionActivityTools(store, 'mimi-person-alice')[0]!;

    const recent = await invoke(tool, { limit: 10 }) as Array<Record<string, unknown>>;
    assert.equal(recent.length, 3);
    assert.match(JSON.stringify(recent), /合同|机票/);
    assert.doesNotMatch(JSON.stringify(recent), /BOB_SESSION_MUST_NOT_LEAK|private payload/);
    assert.equal(recent.some((item) => Object.hasOwn(item, 'target')), false);
    assert.equal((recent.find((item) => item.eventId === 'alice-long')?.answer as string).length, 2_000);

    const filtered = await invoke(tool, { query: '合同', limit: 5 }) as Array<{ eventId: string }>;
    assert.deepEqual(filtered.map((item) => item.eventId), ['alice-contract']);
  } finally {
    store.close();
  }
});

test('session activity is a read-only state tool', () => {
  const tools = createMimiSessionActivityTools({} as MimiStore, 'session');
  assert.equal(isSideEffectTool('inspect_mimi_session_activity'), false);
  assert.equal(isSideEffectTool('cancel_interrupted_mimi_task'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['inspect_mimi_session_activity']);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['cancel_interrupted_mimi_task']);
});

test('task cancellation is limited to interrupted work in the active Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-cancel-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const aliceId = '11111111-1111-4111-8111-111111111111';
  const bobId = '22222222-2222-4222-8222-222222222222';
  try {
    for (const [id, session] of [[aliceId, 'alice'], [bobId, 'bob']] as const) {
      store.enqueueEvent(event(id));
      const claimed = store.claimEvent(`worker-${id}`)!;
      const run = store.beginRun(id, session);
      const now = new Date();
      store.preemptEvent(id, `worker-${id}`, 'owner correction', now, run.id, new Date(now.getTime() + 60_000));
    }
    const tools = createMimiSessionActivityTools(store, 'alice');
    const cancel = tools.find((candidate) => candidate.name === 'cancel_interrupted_mimi_task')!;

    assert.deepEqual(await invoke(cancel, { eventId: bobId, reason: '不是当前会话' }), {
      eventId: bobId, cancelled: false,
    });
    assert.equal(store.getEvent(bobId)?.status, 'queued');
    assert.deepEqual(await invoke(cancel, { eventId: aliceId, reason: 'owner 已取消旧任务' }), {
      eventId: aliceId, cancelled: true,
    });
    assert.equal(store.getEvent(aliceId)?.status, 'archived');
    assert.equal(await invoke(cancel, { eventId: aliceId, reason: '重复取消' }).then(
      (value) => (value as { cancelled: boolean }).cancelled,
    ), false);
  } finally {
    store.close();
  }
});
