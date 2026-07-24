import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import {
  createMimiBackup,
  restoreMimiBackup,
  verifyMimiBackup,
} from '../src/daemon/backup.js';
import { mimiPaths } from '../src/daemon/client-runtime.js';
import { MimiStore } from '../src/daemon/store.js';

function fixtureConfig(root: string, name: string): AppConfig {
  return {
    provider: 'openai',
    workspaceRoot: path.join(root, `${name}-workspace`),
    dataRoot: path.join(root, `${name}-data`),
    daemonDataRoot: path.join(root, `${name}-daemon`),
    skillsRoot: path.join(root, `${name}-skills`),
    mcpConfig: path.join(root, `${name}-mcp.json`),
    historyLimit: 40,
    maxTurns: 200,
    securityProfile: 'safe',
    permissionMode: 'read-only',
  };
}

test('creates, verifies, and restores a bounded MimiAgent backup into blank roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-backup-'));
  const source = fixtureConfig(root, 'source');
  const sourcePaths = mimiPaths(source);
  await mkdir(sourcePaths.root, { recursive: true });
  const store = new MimiStore(sourcePaths.database);
  store.close();
  await mkdir(path.join(source.dataRoot, 'memory', 'profiles'), { recursive: true });
  await mkdir(path.join(source.dataRoot, 'sessions'), { recursive: true });
  await writeFile(path.join(source.dataRoot, 'memory', 'profiles', 'private.md'), 'durable memory');
  await writeFile(path.join(source.dataRoot, 'sessions', 'owner.json'), '{"items":[]}');
  await writeFile(path.join(source.dataRoot, 'plans.json'), '{"version":1,"sessions":{}}');
  await writeFile(sourcePaths.connectorsConfig, '{"version":1,"connectors":{}}');
  await writeFile(sourcePaths.assistantConfig, '{"version":1}');
  await writeFile(path.join(sourcePaths.root, 'control.token'), 'must-not-be-restored');
  await writeFile(sourcePaths.stdoutLog, 'must-not-be-backed-up');

  const backupDirectory = path.join(root, 'snapshot');
  const created = await createMimiBackup(source, backupDirectory);
  assert.equal(created.databaseIntegrity, 'ok');
  assert.equal(created.manifest.files.some((file) => file.path === 'daemon/mimi.db'), true);
  assert.equal(created.manifest.files.some((file) => file.path.includes('control.token')), false);
  assert.equal(created.manifest.files.some((file) => file.path.endsWith('.log')), false);
  assert.equal((await verifyMimiBackup(backupDirectory)).databaseIntegrity, 'ok');

  const destination = fixtureConfig(root, 'restored');
  const restored = await restoreMimiBackup(destination, backupDirectory);
  assert.equal(restored.filesRestored, created.manifest.files.length);
  assert.equal(
    await readFile(path.join(destination.dataRoot, 'memory', 'profiles', 'private.md'), 'utf8'),
    'durable memory',
  );
  assert.equal(
    await readFile(mimiPaths(destination).connectorsConfig, 'utf8'),
    '{"version":1,"connectors":{}}',
  );
  const restoredStore = new MimiStore(mimiPaths(destination).database);
  assert.equal(restoredStore.counts().events.total, 0);
  restoredStore.close();
  await assert.rejects(restoreMimiBackup(destination, backupDirectory), /空白数据目录/);

  const nestedDestination = { ...fixtureConfig(root, 'nested'), daemonDataRoot: undefined };
  const nested = await restoreMimiBackup(nestedDestination, backupDirectory);
  assert.equal(nested.daemonDataRoot, path.join(nestedDestination.dataRoot, 'mimi'));
  assert.equal(await readFile(mimiPaths(nestedDestination).assistantConfig, 'utf8'), '{"version":1}');

  await writeFile(path.join(backupDirectory, 'data', 'memory', 'profiles', 'private.md'), 'tampered');
  await assert.rejects(verifyMimiBackup(backupDirectory), /清单不一致/);
});

test('refuses recursive backups inside durable data roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-backup-containment-'));
  const config = fixtureConfig(root, 'source');
  await assert.rejects(
    createMimiBackup(config, path.join(config.dataRoot, 'backups', 'snapshot')),
    /不能位于 MimiAgent 数据目录内部/,
  );
});
