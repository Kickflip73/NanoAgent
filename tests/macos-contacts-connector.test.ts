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

test('macOS Contacts connector resolves people and exposes bounded explicit mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-contacts-connector-'));
  const mock = path.join(root, 'mock-osascript.mjs');
  await writeFile(mock, `#!/usr/bin/env node
const marker = process.argv.indexOf('-e');
const args = process.argv.slice(marker + 2);
const payload = JSON.parse(args[2] || '{}');
if (args[0] === 'search_contacts') {
  process.stdout.write(JSON.stringify({ contacts: [
    { id: 'contact-1', name: 'Alice Zhang', emails: [{ label: 'work', value: 'alice@example.test' }], phones: [] },
    { id: 'contact-2', name: 'Alice Chen', emails: [], phones: [{ label: 'mobile', value: '+8613800000000' }] }
  ].slice(0, payload.limit) }));
} else if (args[0] === 'get_contact') {
  process.stdout.write(JSON.stringify({ contact: { id: args[1], name: 'Alice Zhang', note: 'Project owner' } }));
} else {
  process.stdout.write(JSON.stringify({ action: args[0], target: args[1], payload }));
}
`);
  await chmod(mock, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-contacts-connector.mjs', import.meta.url));
  const source = await readFile(connector, 'utf8');
  const prefix = 'const CONTACTS_SCRIPT = String.raw`';
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf('`;', start);
  assert.ok(start >= prefix.length && end > start);
  assert.doesNotThrow(() => new Function(source.slice(start, end)));

  const child = spawn(process.execPath, [connector], {
    env: { ...process.env, MACOS_CONTACTS_OSASCRIPT: mock },
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
    const found = await call('search-1', 'search_contacts', 'Alice', { limit: 2 });
    assert.equal(found.ok, true);
    assert.equal((found.result?.contacts as unknown[]).length, 2);
    assert.equal((found.result?.contacts as Array<Record<string, unknown>>)[0]?.id, 'contact-1');

    const detail = await call('get-1', 'get_contact', 'contact-1', {});
    assert.equal((detail.result?.contact as Record<string, unknown>).note, 'Project owner');

    const hostile = 'Lead; $(touch /tmp/contact-never-runs) `whoami`';
    const created = await call('create-1', 'create_contact', 'new', {
      firstName: '张', lastName: '三', organization: hostile,
      emails: [{ label: 'work', value: 'zhangsan@example.test' }],
      phones: [{ label: 'mobile', value: '+8613900000000' }],
    });
    assert.equal(created.ok, true);
    assert.equal((created.result?.payload as Record<string, unknown>).organization, hostile);
    assert.deepEqual((created.result?.payload as Record<string, unknown>).emails, [
      { label: 'work', value: 'zhangsan@example.test' },
    ]);

    const updated = await call('update-1', 'update_contact', 'contact-1', {
      jobTitle: 'Director', addPhones: [{ value: '010-12345678' }],
    });
    assert.equal((updated.result?.payload as Record<string, unknown>).jobTitle, 'Director');
    assert.deepEqual((updated.result?.payload as Record<string, unknown>).addPhones, [
      { label: 'other', value: '010-12345678' },
    ]);

    const badLimit = await call('bad-limit', 'search_contacts', '*', { limit: 101 });
    assert.equal(badLimit.ok, false);
    assert.match(badLimit.error ?? '', /between 1 and 100/);
    const emptyCreate = await call('empty-create', 'create_contact', 'new', {});
    assert.equal(emptyCreate.ok, false);
    assert.match(emptyCreate.error ?? '', /requires at least one/);
    const wrongTarget = await call('wrong-target', 'create_contact', 'contact-1', { firstName: 'A' });
    assert.equal(wrongTarget.ok, false);
    assert.match(wrongTarget.error ?? '', /target must be new/);
    const emptyUpdate = await call('empty-update', 'update_contact', 'contact-1', {});
    assert.equal(emptyUpdate.ok, false);
    assert.match(emptyUpdate.error ?? '', /requires at least one/);
    const unknown = await call('unknown-1', 'delete_contact', 'contact-1', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});
