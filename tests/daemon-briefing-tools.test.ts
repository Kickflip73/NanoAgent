import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { createMimiBriefingTools } from '../src/daemon/briefing-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { EventEnvelope } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[]): Promise<unknown> {
  const selected = tools.find((tool) => tool.name === 'request_mimi_briefing');
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), '{}');
}

function envelope(): EventEnvelope {
  const timestamp = '2026-07-15T08:00:00.000Z';
  return {
    id: 'signal-1',
    externalId: 'signal-1',
    source: 'news',
    kind: 'ambient',
    trust: 'public',
    payload: { headline: 'private signal text' },
    occurredAt: timestamp,
    receivedAt: timestamp,
    priority: 30,
    profileId: 'owner',
  };
}

test('briefing tool atomically creates one normal briefing event without exposing digest content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-briefing-tool-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const tools = createMimiBriefingTools(attention);
  try {
    assert.deepEqual(await invoke(tools), { created: false, reason: '当前没有待汇总事项' });

    store.enqueueEvent(envelope());
    const signal = store.claimEvent('worker', 60_000, new Date('2026-07-15T08:01:00.000Z'));
    assert.ok(signal);
    store.digestEvent(signal.id, 'worker', '稍后汇总');

    const result = await invoke(tools) as Record<string, unknown>;
    assert.equal(result.created, true);
    assert.equal(typeof result.eventId, 'string');
    assert.equal(result.sessionKey, 'mimi-briefing');
    assert.equal(result.replyChannel, 'system');
    assert.deepEqual(Object.keys(result).sort(), ['created', 'eventId', 'replyChannel', 'sessionKey']);
    assert.doesNotMatch(JSON.stringify(result), /private signal text|稍后汇总|news/);

    const digest = store.listPendingDigest();
    assert.equal(digest.length, 1);
    assert.equal(digest[0]?.briefingEventId, result.eventId);
    assert.deepEqual(await invoke(tools), { created: false, reason: '当前没有待汇总事项' });

    const briefing = store.claimEvent('briefing-worker', 60_000, new Date());
    assert.ok(briefing);
    assert.equal(briefing.id, result.eventId);
    assert.equal(briefing.source, 'attention:briefing');
    assert.equal(briefing.sessionKey, 'mimi-briefing');
    assert.deepEqual(briefing.replyRoute, { channel: 'system' });
    store.completeEvent(briefing.id, 'briefing-worker', { answer: 'briefed' });
    assert.equal(store.listPendingDigest().length, 0);
  } finally {
    store.close();
  }
});

test('briefing tool is a ledgered state write', () => {
  const tools = createMimiBriefingTools({} as AttentionEngine);
  assert.equal(isSideEffectTool('request_mimi_briefing'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }), []);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['request_mimi_briefing']);
});
