import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { OutboxDeliveryCoordinator } from '../src/daemon/dispatcher-delivery.js';
import {
  NotifierRegistry,
  PermanentDeliveryError,
  UncertainDeliveryError,
  type NotificationSink,
} from '../src/daemon/notifier.js';
import { MimiStore } from '../src/daemon/store.js';

async function fixture(name: string, sink: NotificationSink) {
  const root = await mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const notifier = new NotifierRegistry();
  notifier.register('connector:test', sink);
  const delivery = new OutboxDeliveryCoordinator(store, notifier, `${name}-worker`);
  const now = new Date();
  const authority = store.appendEvent({
    id: `${name}-authority`,
    externalId: `${name}-authority`,
    source: 'local-cli',
    type: 'command.received',
    trust: 'owner',
    payload: { prompt: 'deliver result' },
    profileId: 'owner',
    occurredAt: now.toISOString(),
    receivedAt: now.toISOString(),
  }).event;
  const task = store.enqueueTask({
    id: `${name}-task`,
    type: 'background',
    idempotencyKey: `${name}-task`,
    authorityEventId: authority.id,
    profileId: 'owner',
    sessionKey: `${name}-session`,
    objective: { objective: 'deliver result' },
    executor: 'session_actor',
    workspaceAccess: 'none',
    priority: 50,
    notBefore: now.toISOString(),
    maxAttempts: 3,
  });
  const claimed = store.claimTaskById(task.id, 'fixture-worker', 60_000, now)!;
  const attempt = store.beginTaskAttempt(
    task.id,
    'fixture-worker',
    task.sessionKey!,
    'fixture-worker',
    now,
  );
  store.completeTask(
    task.id,
    'fixture-worker',
    { answer: 'done' },
    attempt.id,
    now,
    {
      route: { channel: 'connector:test', target: 'owner' },
      payload: { text: 'done' },
    },
  );
  const outgoing = store.listOutbox()[0]!;
  return { store, delivery, outgoing };
}

test('dispatcher confirms successful Outbox delivery exactly once', async () => {
  let calls = 0;
  const { store, delivery, outgoing } = await fixture('dispatcher-delivery-success', {
    async deliver() {
      calls += 1;
    },
  });
  try {
    assert.equal(await delivery.deliverOne(), true);
    assert.equal(calls, 1);
    assert.equal(store.getOutbox(outgoing.id)?.status, 'sent');
    assert.equal(await delivery.deliverOne(), false);
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});

test('dispatcher retries only delivery failures known to be safe to replay', async () => {
  const { store, delivery, outgoing } = await fixture('dispatcher-delivery-retry', {
    async deliver() {
      throw new Error('temporary connector outage');
    },
  });
  try {
    assert.equal(await delivery.deliverOne(), true);
    const failed = store.getOutbox(outgoing.id)!;
    assert.equal(failed.status, 'pending');
    assert.equal(failed.attempts, 1);
    assert.match(failed.error!, /temporary connector outage/);
    assert.ok(failed.notBefore > outgoing.notBefore);
  } finally {
    store.close();
  }
});

test('dispatcher dead-letters uncertain and permanent delivery failures without replay', async () => {
  for (const [name, error] of [
    ['uncertain', new UncertainDeliveryError('connection ended after dispatch')],
    ['permanent', new PermanentDeliveryError('recipient does not exist')],
  ] as const) {
    const { store, delivery, outgoing } = await fixture(`dispatcher-delivery-${name}`, {
      async deliver() {
        throw error;
      },
    });
    try {
      assert.equal(await delivery.deliverOne(), true);
      const failed = store.getOutbox(outgoing.id)!;
      assert.equal(failed.status, 'dead_letter');
      assert.equal(failed.attempts, 1);
      assert.match(failed.error!, new RegExp(error.message));
      assert.equal(store.listOutbox().some((message) => (
        message.channel === 'system' && message.status === 'pending'
      )), true);
    } finally {
      store.close();
    }
  }
});

test('dispatcher leaves a confirmed delivery fenced when local acknowledgement fails', async () => {
  let calls = 0;
  const { store, delivery, outgoing } = await fixture('dispatcher-delivery-ack-failure', {
    async deliver() {
      calls += 1;
    },
  });
  const originalComplete = store.completeOutbox.bind(store);
  store.completeOutbox = () => {
    throw new Error('database fsync failed');
  };
  try {
    assert.equal(await delivery.deliverOne(), true);
    assert.equal(calls, 1);
    const fenced = store.getOutbox(outgoing.id)!;
    assert.equal(fenced.status, 'sending');
    assert.ok(fenced.leaseUntil);

    store.completeOutbox = originalComplete;
    store.claimOutbox('recovery-worker', 60_000, new Date(Date.parse(fenced.leaseUntil!) + 1));
    const recovered = store.getOutbox(outgoing.id)!;
    assert.equal(recovered.status, 'dead_letter');
    assert.match(recovered.error!, /结果不确定/);
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});
