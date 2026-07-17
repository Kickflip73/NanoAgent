import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { createMimiAttentionRuleTools } from '../src/daemon/attention-rule-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((tool) => tool.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

function event(overrides: Partial<StoredEvent> = {}): StoredEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id: 'weather-1', externalId: 'weather-1', source: 'radar:weather', kind: 'alert', trust: 'public',
    payload: { text: '未来两小时有降雨' }, occurredAt: timestamp, receivedAt: timestamp, priority: 30,
    profileId: 'owner', status: 'running', attempts: 1, notBefore: timestamp,
    createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}

test('attention rule tools immediately classify events and preserve explicit first-match order', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attention-rule-tools-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const tools = createMimiAttentionRuleTools(attention);
  try {
    assert.deepEqual(await invoke(tools, 'list_mimi_attention_rules', {}), []);
    const weather = {
      id: 'weather-digest', source: 'radar:*', kinds: ['alert'] as const,
      maxPriority: 60, action: 'digest' as const, reason: '普通天气进入简报',
    };
    assert.deepEqual(await invoke(tools, 'upsert_mimi_attention_rule', weather), {
      rule: weather, created: true, position: 0,
    });
    assert.equal(attention.decide(event(), new Date('2026-07-15T12:00:00Z')).action, 'digest');

    const fallback = { id: 'all-notify', source: '*', action: 'notify' as const };
    assert.deepEqual(await invoke(tools, 'upsert_mimi_attention_rule', fallback), {
      rule: fallback, created: true, position: 1,
    });
    assert.equal(attention.decide(event(), new Date('2026-07-15T12:00:00Z')).action, 'digest');

    assert.deepEqual(await invoke(tools, 'upsert_mimi_attention_rule', {
      ...fallback, beforeId: 'weather-digest',
    }), { rule: fallback, created: false, position: 0 });
    assert.deepEqual(attention.listAttentionRules().map((rule) => rule.id), ['all-notify', 'weather-digest']);
    assert.equal(attention.decide(event(), new Date('2026-07-15T12:00:00Z')).action, 'notify');
    assert.equal(attention.decide(event({ trust: 'owner' }), new Date('2026-07-15T12:00:00Z')).action, 'run');

    assert.deepEqual(await invoke(tools, 'remove_mimi_attention_rule', { id: 'all-notify' }), {
      id: 'all-notify', removed: true,
    });
    assert.deepEqual(await invoke(tools, 'remove_mimi_attention_rule', { id: 'all-notify' }), {
      id: 'all-notify', removed: false,
    });
    assert.equal(attention.decide(event(), new Date('2026-07-15T12:00:00Z')).action, 'digest');
  } finally {
    store.close();
  }
});

test('attention rule writes serialize and reject invalid ordering or duplicate stable ids atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-attention-rule-concurrent-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  try {
    await Promise.all([
      attention.upsertAttentionRule({ id: 'mail-now', source: 'mail:*', action: 'run' }),
      attention.upsertAttentionRule({ id: 'noise-ignore', source: 'noise:*', action: 'ignore' }),
    ]);
    assert.deepEqual(attention.listAttentionRules().map((rule) => rule.id), ['mail-now', 'noise-ignore']);
    await assert.rejects(attention.upsertAttentionRule(
      { id: 'new-rule', source: '*', action: 'digest' }, 'missing-rule',
    ), /attention rule not found/);
    assert.deepEqual(attention.listAttentionRules().map((rule) => rule.id), ['mail-now', 'noise-ignore']);

    const persisted = JSON.parse(await readFile(configFile, 'utf8')) as { rules: unknown[] };
    persisted.rules.push({ id: 'mail-now', source: 'messages', action: 'notify' });
    await writeFile(configFile, `${JSON.stringify(persisted, null, 2)}\n`);
    await assert.rejects(attention.reload(), /duplicate attention rule id: mail-now/);
    assert.deepEqual(attention.listAttentionRules().map((rule) => rule.id), ['mail-now', 'noise-ignore']);
  } finally {
    store.close();
  }
});

test('attention rule writes are ledgered while listing remains read-only', () => {
  const tools = createMimiAttentionRuleTools({} as AttentionEngine);
  assert.equal(isSideEffectTool('list_mimi_attention_rules'), false);
  assert.equal(isSideEffectTool('upsert_mimi_attention_rule'), true);
  assert.equal(isSideEffectTool('remove_mimi_attention_rule'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['list_mimi_attention_rules']);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['upsert_mimi_attention_rule', 'remove_mimi_attention_rule']);
});
