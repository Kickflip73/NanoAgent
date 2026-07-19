import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import { AttentionEngine } from '../src/daemon/attention.js';
import type { ConnectorManager } from '../src/daemon/connectors.js';
import { createMimiCommandHostTools, createMimiHostTools } from '../src/daemon/host-tools.js';
import { MimiStore } from '../src/daemon/store.js';

test('CLI tool discovery uses the same complete host-tool composition as owner command runs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-host-tool-catalog-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const connectors = {} as ConnectorManager;
  try {
    const names = createMimiCommandHostTools(store, attention, connectors, 'owner')
      .map((tool) => tool.name);
    for (const expected of [
      'inspect_mimi_activity',
      'list_mimi_attention_rules',
      'request_mimi_briefing',
      'list_mimi_people',
      'list_mimi_routines',
      'schedule_mimi_follow_up',
      'inspect_mimi_session_activity',
      'get_mimi_settings',
      'list_mimi_source_policies',
      'list_mimi_standing_orders',
      'inspect_mimi_capabilities',
      'connector_action',
    ]) assert.ok(names.includes(expected), expected);
    assert.equal(new Set(names).size, names.length);
    assert.ok(!names.includes('finish_mimi_silently'));
  } finally {
    store.close();
  }
});

test('a confirmed explicit send to the reply route suppresses duplicate final delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-host-route-send-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  const timestamp = new Date().toISOString();
  const deliveryControl = { suppressed: false };
  const connectors = {
    executeAction: async () => ({ sent: true, messageId: 'remote-1' }),
  } as unknown as ConnectorManager;
  try {
    const action = createMimiHostTools({
      store,
      attention,
      connectors,
      event: {
        id: 'qq-event', externalId: 'qq-event', source: 'qq', kind: 'command', trust: 'owner',
        payload: { text: 'hello' }, occurredAt: timestamp, receivedAt: timestamp,
        priority: 100, profileId: 'owner', status: 'running', attempts: 1,
        notBefore: timestamp, createdAt: timestamp, updatedAt: timestamp,
      },
      deliveryControl,
      replyRoute: { channel: 'connector:qq', target: 'private:123' },
      sessionId: 'owner',
    }).find((tool) => tool.name === 'connector_action');
    assert.ok(action && 'invoke' in action);
    await action.invoke(new RunContext({}), JSON.stringify({
      connector: 'qq', action: 'send_message', target: 'private:123',
      payloadJson: '{"text":"one reply"}',
    }));
    assert.deepEqual(deliveryControl, {
      suppressed: true,
      reason: '已通过同一 Connector 会话显式发送回复，抑制重复最终投递',
    });
  } finally {
    store.close();
  }
});
