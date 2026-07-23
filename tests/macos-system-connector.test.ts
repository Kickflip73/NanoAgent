import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface ProtocolMessage {
  type: string;
  id?: string;
  ok?: boolean;
  kind?: string;
  priority?: number;
  externalId?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

async function waitFor(
  messages: ProtocolMessage[],
  predicate: (message: ProtocolMessage) => boolean,
  timeoutMs = 15_000,
): Promise<ProtocolMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = messages.find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`protocol message timed out: ${JSON.stringify(messages)}`);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

test('macOS system connector reports bounded snapshots and emits a critical battery edge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-system-connector-'));
  const mockPmset = path.join(root, 'mock-pmset.mjs');
  await writeFile(mockPmset, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') !== '-g batt') process.exit(17);
process.stdout.write("Now drawing from 'Battery Power'\\n -InternalBattery-0 (id=123)\\t9%; discharging; 0:45 remaining present: true\\n");
`);
  await chmod(mockPmset, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-system-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_SYSTEM_PMSET: mockPmset,
      MACOS_SYSTEM_COMMAND_TIMEOUT_MS: '30000',
      MACOS_SYSTEM_POLL_INTERVAL_MS: '1000',
      MACOS_SYSTEM_BATTERY_LOW_PERCENT: '20',
      MACOS_SYSTEM_BATTERY_CRITICAL_PERCENT: '10',
      MACOS_SYSTEM_DISK_MIN_PERCENT: '100',
      MACOS_SYSTEM_DISK_MIN_GB: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: ProtocolMessage[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as ProtocolMessage);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  try {
    const batteryEvent = await waitFor(messages, (message) => message.externalId?.startsWith('battery:critical:') === true);
    assert.equal(batteryEvent.type, 'event');
    assert.equal(batteryEvent.kind, 'alert');
    assert.equal(batteryEvent.priority, 100);
    assert.deepEqual(batteryEvent.payload, {
      type: 'battery_critical',
      battery: {
        available: true, percent: 9, powerSource: 'battery', state: 'discharging',
        charging: false, timeRemainingMinutes: 45,
      },
    });
    assert.equal(messages.some((message) => message.payload?.type === 'network_offline'), false);
    assert.equal(messages.some((message) => message.payload?.type === 'network_restored'), false);
    const storageEvent = await waitFor(messages, (message) => message.payload?.type === 'storage_low');
    assert.equal(storageEvent.kind, 'alert');
    assert.equal(storageEvent.priority, 90);
    assert.equal(typeof (storageEvent.payload?.storage as Record<string, unknown>).freeBytes, 'number');

    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'snapshot-1', action: 'system_snapshot', target: 'system', payload: {} })}\n`);
    const snapshot = await waitFor(messages, (message) => message.id === 'snapshot-1');
    assert.equal(snapshot.ok, true);
    assert.equal((snapshot.result?.battery as Record<string, unknown>).percent, 9);
    assert.equal(typeof (snapshot.result?.memory as Record<string, unknown>).freeBytes, 'number');
    assert.equal(typeof (snapshot.result?.network as Record<string, unknown>).online, 'boolean');
    assert.equal(typeof (snapshot.result?.storage as Record<string, unknown>).freeBytes, 'number');
    assert.ok(Array.isArray(snapshot.result?.loadAverage));

    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'battery-1', action: 'battery_status', target: 'battery', payload: {} })}\n`);
    const battery = await waitFor(messages, (message) => message.id === 'battery-1');
    assert.deepEqual(battery.result, {
      available: true, percent: 9, powerSource: 'battery', state: 'discharging',
      charging: false, timeRemainingMinutes: 45,
    });

    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'storage-1', action: 'storage_status', target: 'relative', payload: {} })}\n`);
    const invalidStorage = await waitFor(messages, (message) => message.id === 'storage-1');
    assert.equal(invalidStorage.ok, false);
    assert.match(invalidStorage.error ?? '', /absolute path/);

    child.stdin.write(`${JSON.stringify({ type: 'action', id: 'unknown-1', action: 'shutdown', target: 'system', payload: {} })}\n`);
    const unsupported = await waitFor(messages, (message) => message.id === 'unknown-1');
    assert.equal(unsupported.ok, false);
    assert.match(unsupported.error ?? '', /unsupported action/);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(messages.filter((message) => message.externalId?.startsWith('battery:critical:')).length, 1);
    assert.equal(messages.filter((message) => message.payload?.type === 'storage_low').length, 1);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});
