import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  type: string;
  id?: string;
  ok?: boolean;
  kind?: string;
  priority?: number;
  externalId?: string;
  conversation?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
}

async function waitFor(messages: Message[], predicate: (message: Message) => boolean, timeoutMs = 5_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`message timed out: ${JSON.stringify(messages)}`);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('file radar emits bounded metadata events and exposes scan actions without following symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-file-radar-'));
  const inbox = path.join(root, 'inbox');
  const nested = path.join(inbox, 'nested');
  const tooDeep = path.join(nested, 'deep');
  const outside = path.join(root, 'outside.pdf');
  await mkdir(tooDeep, { recursive: true });
  await writeFile(path.join(inbox, 'Report.PDF'), 'report content must not enter events');
  await writeFile(path.join(inbox, '.hidden.pdf'), 'hidden');
  await writeFile(path.join(nested, 'slides.pptx'), 'slides');
  await writeFile(path.join(nested, 'ignored.txt'), 'text');
  await writeFile(path.join(tooDeep, 'too-deep.pdf'), 'deep');
  await writeFile(outside, 'outside');
  await symlink(outside, path.join(inbox, 'linked.pdf'));
  const old = path.join(inbox, 'old.pdf');
  await writeFile(old, 'old');
  const oldTime = new Date(Date.now() - 3_600_000);
  await utimes(old, oldTime, oldTime);

  const configFile = path.join(root, 'files.json');
  await writeFile(configFile, JSON.stringify({
    version: 1,
    pollIntervalMs: 1000,
    lookbackMinutes: 10,
    maxEventsPerPoll: 20,
    maxScanEntries: 100,
    watches: [{
      id: 'drop', path: 'inbox', recursive: true, maxDepth: 1, ignoreHidden: true,
      extensions: ['pdf', '.pptx'], kind: 'alert', priority: 88,
    }],
  }));

  const connector = fileURLToPath(new URL('../examples/connectors/file-radar-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: { ...process.env, MIMI_FILE_RADAR_CONFIG: configFile, FILE_RADAR_POLL_INTERVAL_MS: '1000' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
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
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const call = async (id: string, action: string, target: string, payload: unknown): Promise<Message> => {
    child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
    return waitFor(messages, (message) => message.id === id);
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(messages.some((message) => message.type === 'event'), false);
    const report = await waitFor(messages, (message) => message.payload?.relativePath === 'Report.PDF');
    const slides = await waitFor(messages, (message) => message.payload?.relativePath === path.join('nested', 'slides.pptx'));
    assert.equal(report.kind, 'alert');
    assert.equal(report.priority, 88);
    assert.equal(report.payload?.type, 'file_activity');
    assert.equal(report.payload?.activity, 'created_or_modified');
    assert.equal(report.payload?.path, path.join(inbox, 'Report.PDF'));
    assert.equal(report.payload?.content, undefined);
    assert.equal(report.conversation?.id, 'file-watch-drop');
    assert.match(report.externalId ?? '', /^file:drop:[0-9a-f]{32}$/);
    assert.match(slides.externalId ?? '', /^file:drop:[0-9a-f]{32}$/);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const emittedPaths = messages.filter((message) => message.type === 'event').map((message) => message.payload?.relativePath);
    assert.ok(!emittedPaths.includes('.hidden.pdf'));
    assert.ok(!emittedPaths.includes('linked.pdf'));
    assert.ok(!emittedPaths.includes('old.pdf'));
    assert.ok(!emittedPaths.includes(path.join('nested', 'ignored.txt')));
    assert.ok(!emittedPaths.includes(path.join('nested', 'deep', 'too-deep.pdf')));

    const watches = await call('watches-1', 'watches', 'all', {});
    assert.deepEqual((watches.result?.watches as Array<Record<string, unknown>>)[0], {
      id: 'drop', path: inbox, recursive: true, maxDepth: 1, ignoreHidden: true,
      extensions: ['.pdf', '.pptx'], kind: 'alert', priority: 88,
    });

    const recent = await call('recent-1', 'recent_files', 'drop', { limit: 1, hours: 1 });
    assert.equal((recent.result?.files as unknown[]).length, 1);
    assert.equal(recent.result?.truncated, true);

    const firstId = report.externalId;
    const firstCount = messages.filter((message) => message.externalId === firstId).length;
    await waitFor(messages, () => messages.filter((message) => message.externalId === firstId).length > firstCount, 3_000);

    const changedTime = new Date(Date.now() + 5_000);
    await utimes(path.join(inbox, 'Report.PDF'), changedTime, changedTime);
    const beforeChange = messages.length;
    const firstScan = await call('scan-1', 'scan_now', 'drop', {});
    assert.equal(firstScan.ok, true);
    const scanned = await call('scan-2', 'scan_now', 'drop', {});
    assert.equal(scanned.ok, true);
    assert.equal(scanned.result?.emitted, 2);
    assert.equal(scanned.result?.pendingStability, 0);
    const changed = await waitFor(messages, (message) =>
      messages.indexOf(message) >= beforeChange && message.payload?.relativePath === 'Report.PDF' && message.externalId !== firstId);
    assert.match(changed.externalId ?? '', /^file:drop:[0-9a-f]{32}$/);

    const badLimit = await call('bad-limit', 'recent_files', 'drop', { limit: 201 });
    assert.equal(badLimit.ok, false);
    assert.match(badLimit.error ?? '', /between 1 and 200/);
    const missing = await call('missing', 'watches', 'missing', {});
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /watch not found/);
    const unknown = await call('unknown', 'delete_files', 'drop', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});
