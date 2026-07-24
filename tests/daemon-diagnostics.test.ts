import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { mimiPaths } from '../src/daemon/client-runtime.js';
import {
  buildRedactedDiagnosticBundle,
  writeRedactedDiagnosticBundle,
} from '../src/daemon/diagnostics.js';
import type { MimiDoctorReport } from '../src/daemon/service.js';

test('diagnostic bundle exposes bounded health and capacity metadata without private content', async () => {
  const secret = 'private-target-and-token';
  const root = await mkdtemp(path.join(os.tmpdir(), `mimi-diagnostics-${secret}-`));
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: path.join(root, 'workspace'),
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 200,
    securityProfile: 'safe',
    permissionMode: 'read-only',
  };
  const paths = mimiPaths(config);
  await mkdir(path.dirname(paths.database), { recursive: true });
  await mkdir(path.join(config.dataRoot, 'memory', 'profiles'), { recursive: true });
  await writeFile(paths.database, 'database-bytes');
  await writeFile(paths.stdoutLog, 'stdout');
  await writeFile(path.join(config.dataRoot, 'memory', 'profiles', 'private.md'), secret);
  const health: NonNullable<MimiDoctorReport['daemon']['health']> = {
    state: 'degraded',
    checkedAt: '2026-07-24T00:00:00.000Z',
    risks: [{
      code: 'connector_offline',
      severity: 'warning',
      message: `Connector ${secret} offline`,
      nextAction: `send to ${secret}`,
    }],
    backlog: {
      tasks: 2,
      outbox: 1,
      digest: 3,
      taskDeadLetters: 0,
      outboxDeadLetters: 0,
    },
    connectors: {
      enabled: 1,
      online: 0,
      ready: 0,
      offline: [secret],
      unavailable: [],
      stale: [],
      unknown: [],
    },
  };
  const doctor: MimiDoctorReport = {
    ready: false,
    platform: process.platform,
    node: process.version,
    provider: { id: 'openai', configured: true },
    paths,
    connectors: {
      configured: true,
      total: 1,
      enabled: [secret],
      missingScripts: [path.join(root, secret, 'connector.mjs')],
      runtime: {
        online: [],
        offline: [secret],
        inboundReady: [],
        outboundReady: [],
        unavailable: [],
      },
    },
    systemBinaries: [{ path: path.join(root, secret), available: true }],
    daemon: {
      running: true,
      status: {
        protocolVersion: 9,
        buildVersion: 'fixture',
        permissionMode: 'read-only',
        pid: 123,
        startedAt: '2026-07-24T00:00:00.000Z',
        workerId: secret,
        workspaceRoot: path.join(root, secret),
        activeHostMutations: 0,
        events: { total: 7 },
        tasks: {
          queued: 2, running: 0, paused: 0, blocked: 0, completed: 5,
          failed: 0, cancelled: 0, dead_letter: 0,
        },
        outbox: { pending: 1, sending: 0, sent: 4, dead_letter: 0, archived: 0 },
        enabledSchedules: 0,
        health,
      },
      health,
    },
    launchAgent: { installed: false, file: path.join(root, secret, 'agent.plist') },
    computer: {
      configured: true,
      backend: 'cua',
      ready: false,
      diagnostics: { token: secret },
    },
    issues: [`Event body: ${secret}`],
    nextActions: [`message ${secret}`],
  };

  const bundle = await buildRedactedDiagnosticBundle(config, doctor);
  const serialized = JSON.stringify(bundle);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(bundle.daemon.health?.connectors.offline, 1);
  assert.equal(bundle.daemon.health?.backlog.digest, 3);
  assert.equal(bundle.storage.database.bytes, Buffer.byteLength('database-bytes'));
  assert.equal(bundle.storage.memory.files, 1);
  assert.equal(bundle.storage.memory.bytes, Buffer.byteLength(secret));
  assert.equal(bundle.storage.capacity.state, 'ok');

  const output = path.join(root, 'bundle.json');
  assert.equal(await writeRedactedDiagnosticBundle(output, bundle), output);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), bundle);
  await assert.rejects(writeRedactedDiagnosticBundle(output, bundle), { code: 'EEXIST' });
});
