import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { createMimiStandingOrderTools } from '../src/daemon/standing-order-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((tool) => tool.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

function event(): StoredEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id: 'mail-1', externalId: 'mail-1', source: 'mail:inbox', kind: 'command', trust: 'system',
    payload: { text: 'Can you handle this?' }, occurredAt: timestamp, receivedAt: timestamp,
    priority: 80, profileId: 'owner', status: 'running', attempts: 1, notBefore: timestamp,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

test('standing order tools update privileged substitute decisions immediately and idempotently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-standing-orders-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  const tools = createMimiStandingOrderTools(attention);
  try {
    assert.deepEqual(await invoke(tools, 'list_mimi_standing_orders', {}), []);
    assert.deepEqual(await invoke(tools, 'add_mimi_standing_order', {
      instruction: '  能直接完成的事项就代我完成，完成后简要汇报  ',
    }), {
      instruction: '能直接完成的事项就代我完成，完成后简要汇报', added: true,
    });
    assert.deepEqual(await invoke(tools, 'add_mimi_standing_order', {
      instruction: '能直接完成的事项就代我完成，完成后简要汇报',
    }), {
      instruction: '能直接完成的事项就代我完成，完成后简要汇报', added: false,
    });
    const decision = attention.decide(event(), new Date('2026-07-15T12:00:00Z'));
    assert.equal(decision.action, 'run');
    if (decision.action === 'run') {
      assert.match(decision.run.options?.hostInstructions ?? '', /能直接完成的事项就代我完成/);
    }
    assert.deepEqual(await invoke(tools, 'remove_mimi_standing_order', {
      instruction: '能直接完成的事项就代我完成，完成后简要汇报',
    }), {
      instruction: '能直接完成的事项就代我完成，完成后简要汇报', removed: true,
    });
    assert.deepEqual(await invoke(tools, 'remove_mimi_standing_order', {
      instruction: '能直接完成的事项就代我完成，完成后简要汇报',
    }), {
      instruction: '能直接完成的事项就代我完成，完成后简要汇报', removed: false,
    });
    assert.deepEqual(attention.listStandingOrders(), []);
    const persisted = JSON.parse(await readFile(configFile, 'utf8')) as {
      decisionPolicy: { standingOrders: string[] };
    };
    assert.deepEqual(persisted.decisionPolicy.standingOrders, []);
  } finally {
    store.close();
  }
});

test('concurrent standing order additions serialize without loss', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-standing-orders-concurrent-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  try {
    await Promise.all([
      attention.addStandingOrder('涉及承诺时先检查日历'),
      attention.addStandingOrder('重要消息先处理再汇报'),
    ]);
    assert.deepEqual(attention.listStandingOrders(), [
      '涉及承诺时先检查日历', '重要消息先处理再汇报',
    ]);
  } finally {
    store.close();
  }
});

test('standing order writes are ledgered and bounded while listing stays read-only', async () => {
  const tools = createMimiStandingOrderTools({} as AttentionEngine);
  assert.equal(isSideEffectTool('list_mimi_standing_orders'), false);
  assert.equal(isSideEffectTool('add_mimi_standing_order'), true);
  assert.equal(isSideEffectTool('remove_mimi_standing_order'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['list_mimi_standing_orders']);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['add_mimi_standing_order', 'remove_mimi_standing_order']);

  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-standing-orders-bounds-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  try {
    const result = await invoke(createMimiStandingOrderTools(attention), 'add_mimi_standing_order', {
      instruction: 'x'.repeat(1_001),
    });
    assert.match(String(result), /Invalid input|error/i);
    assert.deepEqual(attention.listStandingOrders(), []);
  } finally {
    store.close();
  }
});
