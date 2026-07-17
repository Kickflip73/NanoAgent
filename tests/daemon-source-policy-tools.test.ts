import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { createMimiSourcePolicyTools } from '../src/daemon/source-policy-tools.js';
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
    id: 'dx-1', externalId: 'dx-1', source: 'daxiang:message', kind: 'command', trust: 'system',
    actor: { id: 'boss-001' }, conversation: { id: 'leadership-1' }, payload: { text: '请处理项目风险' },
    occurredAt: timestamp, receivedAt: timestamp, priority: 80, profileId: 'owner', status: 'running',
    attempts: 1, notBefore: timestamp, createdAt: timestamp, updatedAt: timestamp,
    ...overrides,
  };
}

test('source policy tools scope privileged substitute behavior by channel, actor and conversation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-source-policy-tools-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  const tools = createMimiSourcePolicyTools(attention);
  try {
    assert.deepEqual(await invoke(tools, 'list_mimi_source_policies', {}), []);
    const policy = {
      id: 'boss-daxiang', source: 'daxiang:*', kinds: ['command'] as const,
      actor: 'boss-*', conversation: 'leadership-*',
      access: 'work' as const,
      instructions: ['优先处理，完成后只汇报结论和风险'],
    };
    assert.deepEqual(await invoke(tools, 'upsert_mimi_source_policy', policy), {
      policy, created: true,
    });

    const matched = attention.decide(event(), new Date('2026-07-15T12:00:00Z'));
    const unmatched = attention.decide(event({
      id: 'mail-1', externalId: 'mail-1', source: 'mail:inbox', actor: { id: 'boss-001' },
    }), new Date('2026-07-15T12:00:00Z'));
    assert.equal(matched.action, 'run');
    assert.equal(unmatched.action, 'run');
    if (matched.action === 'run') assert.match(matched.run.options?.hostInstructions ?? '', /只汇报结论和风险/);
    if (unmatched.action === 'run') {
      assert.doesNotMatch(unmatched.run.options?.hostInstructions ?? '', /只汇报结论和风险/);
    }

    const updated = { ...policy, instructions: ['先检查项目状态，再直接完成可执行事项'] };
    assert.deepEqual(await invoke(tools, 'upsert_mimi_source_policy', updated), {
      policy: updated, created: false,
    });
    assert.deepEqual(await invoke(tools, 'list_mimi_source_policies', {}), [updated]);
    assert.deepEqual(await invoke(tools, 'remove_mimi_source_policy', { id: policy.id }), {
      id: policy.id, removed: true,
    });
    assert.deepEqual(await invoke(tools, 'remove_mimi_source_policy', { id: policy.id }), {
      id: policy.id, removed: false,
    });
  } finally {
    store.close();
  }
});

test('legacy source policy writes default to reply, serialize, and reject duplicate stable ids', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-source-policy-concurrent-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  try {
    await Promise.all([
      attention.upsertSourcePolicy({ id: 'mail', source: 'mail:*', instructions: ['重要邮件先处理'] }),
      attention.upsertSourcePolicy({ id: 'news', source: 'radar:*', instructions: ['只提炼事实与影响'] }),
    ]);
    assert.deepEqual(attention.listSourcePolicies().map((policy) => ({ id: policy.id, access: policy.access })), [
      { id: 'mail', access: 'reply' },
      { id: 'news', access: 'reply' },
    ]);

    const persisted = JSON.parse(await readFile(configFile, 'utf8')) as {
      decisionPolicy: { sourcePolicies: unknown[] };
    };
    persisted.decisionPolicy.sourcePolicies.push({
      id: 'mail', source: 'messages', instructions: ['重复 ID'],
    });
    await writeFile(configFile, `${JSON.stringify(persisted, null, 2)}\n`);
    await assert.rejects(attention.reload(), /duplicate source policy id: mail/);
    assert.deepEqual(attention.listSourcePolicies().map((policy) => policy.id), ['mail', 'news']);
  } finally {
    store.close();
  }
});

test('source policy writes are ledgered while listing remains read-only', () => {
  const tools = createMimiSourcePolicyTools({} as AttentionEngine);
  assert.equal(isSideEffectTool('list_mimi_source_policies'), false);
  assert.equal(isSideEffectTool('upsert_mimi_source_policy'), true);
  assert.equal(isSideEffectTool('remove_mimi_source_policy'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['list_mimi_source_policies']);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['upsert_mimi_source_policy', 'remove_mimi_source_policy']);
});
