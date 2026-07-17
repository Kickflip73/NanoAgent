import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  type: string;
  id?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

async function waitFor(messages: Message[], id: string, timeoutMs = 5_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((message) => message.id === id);
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

test('macOS Notes connector exposes bounded search, read and explicit note mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-notes-connector-'));
  const mock = path.join(root, 'mock-osascript.mjs');
  await writeFile(mock, `#!/usr/bin/env node
const marker = process.argv.indexOf('-e');
const args = process.argv.slice(marker + 2);
const payload = JSON.parse(args[2] || '{}');
if (args[0] === 'list_folders') {
  process.stdout.write(JSON.stringify({ accounts: [{ id: 'account-1', name: 'iCloud', folders: [{ id: 'folder-1', name: 'Work' }] }] }));
} else if (args[0] === 'search_notes') {
  process.stdout.write(JSON.stringify({ notes: [
    { id: 'note-1', title: 'Weekly plan', preview: 'Ship MimiAgent', passwordProtected: false },
    { id: 'note-2', title: 'Weekly review', preview: 'Progress', passwordProtected: false }
  ].slice(0, payload.limit), scanned: 2, truncated: false }));
} else if (args[0] === 'read_note') {
  process.stdout.write(JSON.stringify({ note: { id: args[1], title: 'Weekly plan', bodyFormat: payload.bodyFormat, body: 'Ship MimiAgent' } }));
} else {
  process.stdout.write(JSON.stringify({ action: args[0], target: args[1], payload }));
}
`);
  await chmod(mock, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-notes-connector.mjs', import.meta.url));
  const source = await readFile(connector, 'utf8');
  const prefix = 'const NOTES_SCRIPT = String.raw`';
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf('`;', start);
  assert.ok(start >= prefix.length && end > start);
  assert.doesNotThrow(() => new Function(source.slice(start, end)));

  const child = spawn(process.execPath, [connector], {
    env: { ...process.env, MACOS_NOTES_OSASCRIPT: mock },
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
    return waitFor(messages, id);
  };

  try {
    const folders = await call('folders-1', 'list_folders', 'all', {});
    assert.equal((folders.result?.accounts as Array<Record<string, unknown>>)[0]?.name, 'iCloud');

    const searched = await call('search-1', 'search_notes', 'weekly', { limit: 2, scanLimit: 100, folderId: 'folder-1' });
    assert.equal((searched.result?.notes as unknown[]).length, 2);
    assert.equal(searched.result?.scanned, 2);

    const read = await call('read-1', 'read_note', 'note-1', { bodyFormat: 'html', bodyChars: 1234 });
    assert.equal((read.result?.note as Record<string, unknown>).bodyFormat, 'html');

    const hostile = '<script>never()</script>; $(touch /tmp/notes-never-runs) `whoami`';
    const created = await call('create-1', 'create_note', 'default', {
      title: 'Meeting "Q3"', body: hostile,
    });
    assert.equal(created.ok, true);
    assert.equal((created.result?.payload as Record<string, unknown>).body, hostile);
    assert.equal((created.result?.payload as Record<string, unknown>).bodyFormat, 'plain');

    const updated = await call('update-1', 'update_note', 'note-1', {
      title: 'Weekly plan v2', body: '<b>Ready</b>', bodyFormat: 'html',
    });
    assert.equal((updated.result?.payload as Record<string, unknown>).bodyFormat, 'html');
    assert.equal((updated.result?.payload as Record<string, unknown>).body, '<b>Ready</b>');

    const appended = await call('append-1', 'append_note', 'note-1', {
      body: 'Next item', separator: '\n---\n',
    });
    assert.equal((appended.result?.payload as Record<string, unknown>).separator, '\n---\n');

    const badFormat = await call('bad-format', 'read_note', 'note-1', { bodyFormat: 'markdown' });
    assert.equal(badFormat.ok, false);
    assert.match(badFormat.error ?? '', /plain or html/);
    const badLimit = await call('bad-limit', 'search_notes', '*', { limit: 101 });
    assert.equal(badLimit.ok, false);
    assert.match(badLimit.error ?? '', /between 1 and 100/);
    const emptyUpdate = await call('empty-update', 'update_note', 'note-1', {});
    assert.equal(emptyUpdate.ok, false);
    assert.match(emptyUpdate.error ?? '', /requires title or body/);
    const emptyAppend = await call('empty-append', 'append_note', 'note-1', { body: '' });
    assert.equal(emptyAppend.ok, false);
    assert.match(emptyAppend.error ?? '', /non-empty/);
    const unknown = await call('unknown-1', 'delete_note', 'note-1', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});
