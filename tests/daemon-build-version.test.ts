import assert from 'node:assert/strict';
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeMimiBuildVersion,
  daemonProtocolAction,
  MIMI_BUILD_VERSION,
} from '../src/daemon/client-runtime.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from '../src/daemon/types.js';

test('daemon build identity is stable across reinstall timestamps and changes with runtime content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-build-version-'));
  const runtimeRoot = path.join(root, 'dist');
  const daemonRoot = path.join(runtimeRoot, 'daemon');
  const modulePath = path.join(daemonRoot, 'client-runtime.js');
  const otherModule = path.join(runtimeRoot, 'index.js');
  await mkdir(daemonRoot, { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  await writeFile(modulePath, 'export const runtime = true;\n');
  await writeFile(otherModule, 'export const entry = true;\n');

  const initial = computeMimiBuildVersion(modulePath);
  const later = new Date(Date.now() + 60_000);
  await utimes(modulePath, later, later);
  await utimes(otherModule, later, later);
  assert.equal(computeMimiBuildVersion(modulePath), initial);

  await writeFile(otherModule, 'export const entry = false;\n');
  assert.notEqual(computeMimiBuildVersion(modulePath), initial);
});

test('a compatible busy daemon remains usable until a build upgrade is safe', () => {
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: `${MIMI_BUILD_VERSION}-different`,
    permissionMode: 'trusted',
    tasks: { running: 1 },
  } as DaemonStatus;

  assert.equal(daemonProtocolAction(status, 'trusted'), 'reuse');
  assert.throws(
    () => daemonProtocolAction({ ...status, permissionMode: 'workspace' }, 'trusted'),
    /执行档位/,
  );
});
