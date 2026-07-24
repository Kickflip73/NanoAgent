import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ConnectorManager } from '../src/daemon/connectors.js';
import { NotifierRegistry } from '../src/daemon/notifier.js';
import { MimiStore } from '../src/daemon/store.js';

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timed out');
}

test('marks an online Connector stale after its declared readiness heartbeat expires', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-freshness-'));
  const database = path.join(root, 'mimi.db');
  const configFile = path.join(root, 'connectors.json');
  await mkdir(root, { recursive: true });
  await writeFile(configFile, JSON.stringify({
    connectors: {
      heartbeat: {
        command: process.execPath,
        args: ['-e', [
          "process.stdout.write(JSON.stringify({type:'status',inbound:'ready',outbound:'ready',freshForMs:1000})+'\\n');",
          'setInterval(() => {}, 60000);',
        ].join('')],
        restart: false,
        healthEvents: false,
      },
    },
  }));
  const store = new MimiStore(database);
  const manager = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  manager.start();
  try {
    await waitUntil(() => Boolean(manager.listCapabilities()[0]?.readiness.reportedAt));
    const initial = manager.listCapabilities()[0]!;
    assert.equal(initial.online, true);
    assert.equal(initial.readiness.stale, false);
    assert.match(initial.readiness.reportedAt ?? '', /^20\d\d-/);
    assert.match(initial.readiness.freshUntil ?? '', /^20\d\d-/);

    const now = Date.now;
    Date.now = () => now() + 2_000;
    try {
      assert.equal(manager.listCapabilities()[0]?.readiness.stale, true);
    } finally {
      Date.now = now;
    }
  } finally {
    await manager.stop();
    store.close();
  }
});
