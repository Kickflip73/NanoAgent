import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rotateDaemonLogs } from '../src/daemon/log-maintenance.js';

test('rotates oversized daemon logs before restart and keeps a bounded history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-log-rotation-'));
  const stdoutLog = path.join(root, 'mimi.out.log');
  const stderrLog = path.join(root, 'mimi.err.log');
  await writeFile(stdoutLog, 'new-stdout');
  await writeFile(`${stdoutLog}.1`, 'old-stdout');
  await writeFile(`${stdoutLog}.2`, 'expired-stdout');
  await writeFile(stderrLog, 'small');

  const result = await rotateDaemonLogs({ stdoutLog, stderrLog }, 6, 2);

  assert.deepEqual(result, [
    { file: 'stdout', rotated: true, previousBytes: Buffer.byteLength('new-stdout') },
    { file: 'stderr', rotated: false, previousBytes: Buffer.byteLength('small') },
  ]);
  assert.equal(await readFile(stdoutLog, 'utf8'), '');
  assert.equal(await readFile(`${stdoutLog}.1`, 'utf8'), 'new-stdout');
  assert.equal(await readFile(`${stdoutLog}.2`, 'utf8'), 'old-stdout');
  assert.equal((await stat(stdoutLog)).mode & 0o777, 0o600);
  assert.equal((await stat(`${stdoutLog}.1`)).mode & 0o777, 0o600);
  assert.equal(await readFile(stderrLog, 'utf8'), 'small');
});

test('rejects unsafe daemon log rotation bounds', async () => {
  await assert.rejects(
    rotateDaemonLogs({ stdoutLog: '/tmp/unused-out', stderrLog: '/tmp/unused-err' }, 0),
    /正安全整数/,
  );
  await assert.rejects(
    rotateDaemonLogs({ stdoutLog: '/tmp/unused-out', stderrLog: '/tmp/unused-err' }, 1, 21),
    /1 到 20/,
  );
});
