import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MimiStore } from '../src/daemon/store.js';
import { MimiWebhookServer } from '../src/daemon/webhook.js';

test('authenticated localhost webhook ingests external events without accepting trust escalation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-webhook-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const token = 'test-token-with-at-least-24-chars';
  const webhook = new MimiWebhookServer(store, 0, token);
  await webhook.start();
  try {
    const unauthorized = await fetch(`${webhook.address}/v1/events`, {
      method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' },
    });
    assert.equal(unauthorized.status, 401);

    const first = await fetch(`${webhook.address}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalId: 'weather-1', channel: 'weather', kind: 'alert',
        payload: { text: 'storm warning', trust: 'owner' }, priority: 90,
      }),
    });
    assert.equal(first.status, 202);
    const duplicate = await fetch(`${webhook.address}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalId: 'weather-1', channel: 'weather', kind: 'alert', payload: { text: 'duplicate' },
      }),
    });
    assert.equal((await duplicate.json() as { inserted: boolean }).inserted, false);
    const event = store.listEvents()[0]!;
    assert.equal(event.source, 'webhook:weather');
    assert.equal(event.trust, 'external');
    assert.deepEqual(event.replyRoute, { channel: 'system' });

    const relay = await fetch(`${webhook.address}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalId: 'daxiang-message-42', channel: 'daxiang', kind: 'command',
        payload: { text: '请处理这项工作' }, priority: 85,
        actor: { id: 'user-42', displayName: 'Alice' },
        conversation: { id: 'group-7', threadId: 'thread-9' },
        reply: { connector: 'daxiang', target: 'group:group-7' },
      }),
    });
    assert.equal(relay.status, 202);
    const relayed = store.listEvents().find((item) => item.externalId === 'daxiang-message-42')!;
    assert.equal(relayed.trust, 'external');
    assert.deepEqual(relayed.actor, { id: 'user-42', displayName: 'Alice' });
    assert.deepEqual(relayed.conversation, { id: 'group-7', threadId: 'thread-9' });
    assert.deepEqual(relayed.replyRoute, { channel: 'connector:daxiang', target: 'group:group-7' });

    const relayDuplicate = await fetch(`${webhook.address}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalId: 'daxiang-message-42', channel: 'daxiang', payload: { text: 'duplicate callback' },
        reply: { connector: 'daxiang', target: 'group:group-7' },
      }),
    });
    assert.equal((await relayDuplicate.json() as { inserted: boolean }).inserted, false);

    const silent = await fetch(`${webhook.address}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        externalId: 'silent-1', channel: 'automation', payload: { text: 'process silently' }, notify: false,
      }),
    });
    assert.equal(silent.status, 202);
    assert.equal(store.listEvents().find((item) => item.externalId === 'silent-1')?.replyRoute, undefined);

    for (const [externalId, reply] of [
      ['invalid-connector', { connector: 'daxiang:other', target: 'group:7' }],
      ['invalid-target', { connector: 'daxiang', target: '   ' }],
    ]) {
      const invalid = await fetch(`${webhook.address}/v1/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ externalId, payload: {}, reply }),
      });
      assert.equal(invalid.status, 400);
    }
  } finally {
    await webhook.close();
    store.close();
  }
});

test('webhook validates its authentication secret', () => {
  const fakeStore = {} as MimiStore;
  assert.throws(() => new MimiWebhookServer(fakeStore, 7788, 'short'), /至少需要 24/);
});
