import assert from 'node:assert/strict';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import {
  createMimiDeliveryTools,
  type MimiDeliveryControl,
} from '../src/daemon/delivery-tools.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

function event(kind: StoredEvent['kind']): StoredEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id: 'event-1', externalId: 'event-1', source: 'attention:routine', kind, trust: 'owner',
    payload: { prompt: 'check status' }, occurredAt: timestamp, receivedAt: timestamp,
    priority: 60, profileId: 'owner', status: 'running', attempts: 1, notBefore: timestamp,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

async function invoke(tool: Tool, input: unknown): Promise<unknown> {
  assert.ok('invoke' in tool && typeof tool.invoke === 'function');
  return tool.invoke(new RunContext({}), JSON.stringify(input));
}

test('delivery control is available only to autonomous non-command runs', async () => {
  const control: MimiDeliveryControl = { suppressed: false };
  assert.deepEqual(createMimiDeliveryTools(event('command'), control), []);
  const tools = createMimiDeliveryTools(event('schedule'), control);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'finish_mimi_silently');
  assert.deepEqual(await invoke(tools[0]!, { reason: '没有新变化或需要 owner 关注的事项' }), {
    suppressed: true, reason: '没有新变化或需要 owner 关注的事项',
  });
  assert.deepEqual(control, { suppressed: true, reason: '没有新变化或需要 owner 关注的事项' });

  const nextAttempt: MimiDeliveryControl = { suppressed: false };
  assert.equal(createMimiDeliveryTools(event('schedule'), nextAttempt).length, 1);
  assert.deepEqual(nextAttempt, { suppressed: false });
});

test('silent completion validates its reason and remains a non-side-effect control tool', async () => {
  const control: MimiDeliveryControl = { suppressed: false };
  const tool = createMimiDeliveryTools(event('alert'), control)[0]!;
  assert.match(String(await invoke(tool, { reason: 'x'.repeat(501) })), /Invalid input|error/i);
  assert.deepEqual(control, { suppressed: false });
  assert.equal(isSideEffectTool('finish_mimi_silently'), false);
  assert.deepEqual(toolsForRunPolicy([tool], {
    allowedCapabilities: ['delivery-control'], allowSideEffects: false,
  }).map((item) => item.name), ['finish_mimi_silently']);
  assert.deepEqual(toolsForRunPolicy([tool], {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }), []);
});
