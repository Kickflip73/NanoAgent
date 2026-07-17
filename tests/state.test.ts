import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, chmod, mkdtemp, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { MemoryStore } from '../src/core/memory.js';
import { PlanStore } from '../src/core/plan.js';
import { FileSession, registerSessionRunOwner } from '../src/core/session.js';
import { AtomicJsonStore } from '../src/core/state-file.js';

const execFileAsync = promisify(execFile);

test('skips the atomic rename when a conditional state mutation is unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-state-noop-'));
  const file = path.join(root, 'state.json');
  const store = new AtomicJsonStore(file, { defaultValue: () => ({ count: 0 }) });
  await store.replace({ count: 1 });
  const before = await stat(file);

  const result = await store.updateWhen((value) => ({ result: value.count, changed: false }));
  const after = await stat(file);

  assert.equal(result, 1);
  assert.equal(after.ino, before.ino);
});

test('hardens permissions on an existing sensitive state file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-state-permissions-'));
  const file = path.join(root, 'state.json');
  await writeFile(file, '{"value":1}\n');
  await chmod(file, 0o644);
  const store = new AtomicJsonStore(file, { defaultValue: () => ({ value: 0 }) });

  assert.deepEqual(await store.read(), { value: 1 });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test('preserves concurrent memory writes across store instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-instances-'));
  const file = path.join(root, 'memories.json');
  const first = new MemoryStore(file);
  const second = new MemoryStore(file);

  await Promise.all([
    first.remember('first', 'fact'),
    second.remember('second', 'fact'),
  ]);

  assert.deepEqual((await first.list()).map((item) => item.content).sort(), ['first', 'second']);
});

test('preserves concurrent memory writes across processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-processes-'));
  const file = path.join(root, 'memories.json');
  const moduleUrl = pathToFileURL(path.resolve('src/core/memory.ts')).href;
  const writeMemory = (content: string) => execFileAsync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval',
    `import { MemoryStore } from ${JSON.stringify(moduleUrl)}; await new MemoryStore(${JSON.stringify(file)}).remember(${JSON.stringify(content)}, 'fact');`,
  ]);

  await Promise.all([writeMemory('process-one'), writeMemory('process-two')]);

  assert.deepEqual(
    (await new MemoryStore(file).list()).map((item) => item.content).sort(),
    ['process-one', 'process-two'],
  );
});

test('does not let a stale session instance overwrite newer state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-instances-'));
  const first = new FileSession(root, 'demo');
  const second = new FileSession(root, 'demo');
  await first.ensure();
  await second.addItems([{ role: 'user', content: 'second' }] as AgentInputItem[]);
  await first.addItems([{ role: 'user', content: 'first' }] as AgentInputItem[]);

  assert.deepEqual(
    (await new FileSession(root, 'demo').getItems()).map((item) => 'content' in item ? item.content : ''),
    ['second', 'first'],
  );
});

test('preserves concurrent plan writes from separate store instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-plan-instances-'));
  const file = path.join(root, 'plans.json');
  const first = new PlanStore(file, 'first');
  const second = new PlanStore(file, 'second');

  await Promise.all([
    first.update([{ id: 'a', description: 'first', status: 'running' }]),
    second.update([{ id: 'b', description: 'second', status: 'running' }]),
  ]);

  assert.equal((await first.get())[0]?.description, 'first');
  assert.equal((await second.get())[0]?.description, 'second');
});

test('isolates a corrupt session instead of breaking the whole session list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-corrupt-'));
  const valid = new FileSession(root, 'valid');
  await valid.addItems([{ role: 'user', content: 'still available' }] as AgentInputItem[]);
  await writeFile(path.join(root, 'broken.json'), '{not-json', 'utf8');

  const summaries = await FileSession.listSummaries(root);

  assert.deepEqual(summaries.map((item) => item.id), ['valid']);
  assert.ok((await readdir(root)).some((name) => name.startsWith('broken.json.corrupt-')));
});

test('quarantines corrupt shared state and continues from an empty store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-corrupt-'));
  const file = path.join(root, 'memories.json');
  await writeFile(file, '{broken', 'utf8');

  assert.deepEqual(await new MemoryStore(file).list(), []);
  assert.ok((await readdir(root)).some((name) => name.startsWith('memories.json.corrupt-')));
});

test('uses runId CAS so late callbacks cannot overwrite a newer run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-run-cas-'));
  const first = new FileSession(root, 'demo');
  const runA = await first.beginRun('A', 'run-a', 'owner-a');
  await first.failRun('A stopped', true, runA.runId);
  const second = new FileSession(root, 'demo');
  const runB = await second.beginRun('B', 'run-b', 'owner-b');

  await first.updateRunProgress('late A progress', undefined, runA.runId);
  await first.completeRun('late A complete', runA.runId);
  await first.failRun('late A failure', false, runA.runId);
  await first.recoverInterruptedRun(runA.runId);

  const checkpoint = await second.getCheckpoint();
  assert.equal(checkpoint?.runId, runB.runId);
  assert.equal(checkpoint?.status, 'running');
  assert.equal(checkpoint?.phase, '准备上下文');
});

test('clears only the terminal checkpoint owned by the expected runId', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-run-clear-cas-'));
  const session = new FileSession(root, 'demo');
  const runA = await session.beginRun('A', 'run-a', 'owner-a');
  await session.failRun('A cancelled', true, runA.runId);

  assert.equal(await session.clearRunCheckpoint(runA.runId), true);
  assert.equal(await session.getCheckpoint(), undefined);

  const runB = await session.beginRun('B', 'run-b', 'owner-b');
  assert.equal(await session.clearRunCheckpoint(runA.runId), false);
  assert.equal((await session.getCheckpoint())?.runId, runB.runId);
  assert.equal((await session.getCheckpoint())?.status, 'running');
});

test('does not reopen a completed run when a late failure arrives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-run-terminal-'));
  const session = new FileSession(root, 'demo');
  const run = await session.beginRun('ship', 'run-complete', 'owner');
  await session.completeRun('done', run.runId);
  await session.failRun('late failure', false, run.runId);

  assert.equal((await session.getCheckpoint())?.status, 'completed');
});

test('does not clear a Session owned by another live Run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-live-clear-'));
  const owner = 'live-clear-owner';
  const release = registerSessionRunOwner(owner);
  const active = new FileSession(root, 'demo');
  try {
    await active.beginRun('work', 'live-run', owner);
    let relatedCleanup = false;
    await assert.rejects(new FileSession(root, 'demo').clearSession(async () => {
      relatedCleanup = true;
    }), /仍有任务运行中/);
    assert.equal(relatedCleanup, false);
    assert.equal((await active.getCheckpoint())?.status, 'running');
  } finally {
    release();
  }
});

test('isolates a Session whose persisted transcript contains invalid items', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-invalid-items-'));
  const now = new Date().toISOString();
  await writeFile(path.join(root, 'broken.json'), JSON.stringify({
    id: 'broken', createdAt: now, updatedAt: now, items: [null],
  }));

  assert.deepEqual(await FileSession.listSummaries(root), []);
  assert.ok((await readdir(root)).some((name) => name.startsWith('broken.json.corrupt-')));
});

test('recovers an old incomplete lock but never evicts a lock owned by a live process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-state-lock-recovery-'));
  const file = path.join(root, 'state.json');
  const lock = `${file}.lock`;
  const store = new AtomicJsonStore(file, { defaultValue: () => ({ value: 0 }) });
  await writeFile(lock, '{incomplete');
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await store.replace({ value: 1 });
  await assert.rejects(access(lock), /ENOENT/);

  await writeFile(lock, JSON.stringify({ token: 'live', pid: process.pid, createdAt: 0 }));
  await utimes(lock, old, old);
  await assert.rejects(
    store.replace({ value: 2 }, AbortSignal.timeout(50)),
    /abort|timeout/i,
  );
  await access(lock);
});
