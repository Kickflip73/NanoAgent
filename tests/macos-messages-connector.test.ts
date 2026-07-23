import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  type: string;
  id?: string;
  ok?: boolean;
  kind?: string;
  priority?: number;
  externalId?: string;
  replyTarget?: string;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  inbound?: string;
  outbound?: string;
  deliveryConfirmed?: boolean;
}

async function waitFor(messages: Message[], predicate: (message: Message) => boolean, timeoutMs = 15_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`message timed out: ${JSON.stringify(messages)}`);
}

async function waitForText(read: () => string, pattern: RegExp, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (pattern.test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`text timed out: ${read()}`);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

function createMessagesDatabase(file: string, attachmentFile: string): void {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE message (guid TEXT, text TEXT, handle_id INTEGER, service TEXT, date INTEGER, is_from_me INTEGER);
    CREATE TABLE chat (guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    CREATE TABLE attachment (
      guid TEXT, filename TEXT, mime_type TEXT, total_bytes INTEGER, transfer_state INTEGER
    );
  `);
  const appleNanoseconds = (timestamp: number) => BigInt(timestamp - Date.UTC(2001, 0, 1)) * 1_000_000n;
  database.prepare('INSERT INTO handle(ROWID, id) VALUES (?, ?)').run(1, '+15551234567');
  database.prepare('INSERT INTO chat(ROWID, guid, chat_identifier, display_name, service_name) VALUES (?, ?, ?, ?, ?)')
    .run(1, 'iMessage;+;chat-fixture', '+15551234567', 'Alice', 'iMessage');
  database.prepare('INSERT INTO chat_handle_join(chat_id, handle_id) VALUES (?, ?)').run(1, 1);
  const insert = database.prepare('INSERT INTO message(ROWID, guid, text, handle_id, service, date, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(1, 'message-old-outgoing', 'Earlier reply', 1, 'iMessage', appleNanoseconds(Date.now() - 120_000), 1);
  insert.run(2, 'message-incoming-1', 'Can MimiAgent handle this?', 1, 'iMessage', appleNanoseconds(Date.now() - 60_000), 0);
  insert.run(3, 'message-incoming-2', null, 1, 'iMessage', appleNanoseconds(Date.now() - 30_000), 0);
  for (const messageId of [1, 2, 3]) {
    database.prepare('INSERT INTO chat_message_join(chat_id, message_id) VALUES (?, ?)').run(1, messageId);
  }
  database.prepare('INSERT INTO message_attachment_join(message_id, attachment_id) VALUES (?, ?)').run(3, 10);
  database.prepare(`
    INSERT INTO attachment(ROWID, guid, filename, mime_type, total_bytes, transfer_state)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(10, 'attachment-guid-1', attachmentFile, 'image/png', 24, 5);
  database.close();
}

test('macOS Messages connector reads a bounded fixture and sends through JXA without database writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-messages-connector-'));
  const databaseFile = path.join(root, 'chat.db');
  const attachmentFile = path.join(root, 'incoming-image.png');
  await writeFile(attachmentFile, 'fixture attachment bytes');
  createMessagesDatabase(databaseFile, attachmentFile);
  const mock = path.join(root, 'mock-osascript.mjs');
  await writeFile(mock, `#!/usr/bin/env node
const marker = process.argv.indexOf('-e');
const args = process.argv.slice(marker + 2);
process.stdout.write(JSON.stringify({ sent: true, target: args[0], payload: JSON.parse(args[1] || '{}') }));
`);
  await chmod(mock, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-messages-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_MESSAGES_DB: databaseFile,
      MACOS_MESSAGES_OSASCRIPT: mock,
      MACOS_MESSAGES_POLL_INTERVAL_MS: '1000',
      MACOS_MESSAGES_MAX_EVENTS: '10',
      MACOS_MESSAGES_LOOKBACK_HOURS: '24',
    },
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
    const ready = await waitFor(messages, (message) => message.type === 'status');
    assert.deepEqual(ready, { type: 'status', inbound: 'ready', outbound: 'unknown' });
    const textEvent = await waitFor(messages, (message) => message.payload?.id === 'message-incoming-1');
    const attachmentEvent = await waitFor(messages, (message) => message.payload?.id === 'message-incoming-2');
    assert.equal(textEvent.kind, 'alert');
    assert.equal(textEvent.priority, 80);
    assert.equal(textEvent.payload?.text, 'Can MimiAgent handle this?');
    assert.equal(textEvent.replyTarget, 'iMessage;+;chat-fixture');
    assert.match(String(textEvent.externalId), /^message:[0-9a-f]{32}$/);
    assert.equal(attachmentEvent.payload?.text, '[Attachment or rich message]');
    assert.equal(attachmentEvent.payload?.attachmentCount, 1);

    const attachments = await call('attachments-1', 'list_attachments', 'message-incoming-2', {});
    assert.deepEqual(attachments.result, {
      messageId: 'message-incoming-2',
      attachments: [{
        id: 'attachment-guid-1', localId: '10', name: 'incoming-image.png', mimeType: 'image/png',
        declaredBytes: 24, transferState: '5', localPath: attachmentFile, available: true,
        actualBytes: 24,
      }],
    });

    const savedPath = path.join(root, 'saved-image.png');
    const saved = await call('save-1', 'save_attachment', 'message-incoming-2', {
      attachmentId: 'attachment-guid-1', outputPath: savedPath,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.result?.path, savedPath);
    assert.equal(await readFile(savedPath, 'utf8'), 'fixture attachment bytes');
    assert.equal((await stat(savedPath)).mode & 0o777, 0o600);
    const noClobber = await call('save-2', 'save_attachment', 'message-incoming-2', {
      attachmentId: 'attachment-guid-1', outputPath: savedPath,
    });
    assert.equal(noClobber.ok, false);
    assert.match(noClobber.error ?? '', /already exists/);
    const overwritten = await call('save-3', 'save_attachment', 'message-incoming-2', {
      attachmentId: '10', outputPath: savedPath, overwrite: true,
    });
    assert.equal(overwritten.ok, true);

    const chats = await call('chats-1', 'list_chats', 'all', { limit: 10 });
    const listed = chats.result?.chats as Array<Record<string, unknown>>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, 'iMessage;+;chat-fixture');
    assert.deepEqual(listed[0]?.participants, ['+15551234567']);

    const recent = await call('recent-1', 'recent_messages', 'iMessage;+;chat-fixture', { limit: 10 });
    const history = recent.result?.messages as Array<Record<string, unknown>>;
    assert.deepEqual(history.map((message) => message.id), [
      'message-old-outgoing', 'message-incoming-1', 'message-incoming-2',
    ]);
    assert.equal(history[0]?.fromMe, true);

    const hostile = 'Hello; $(touch /tmp/messages-never-runs) `whoami`';
    const outgoingFile = path.join(root, 'outgoing.pdf');
    await writeFile(outgoingFile, 'outgoing bytes');
    const outgoingLink = path.join(root, 'outgoing-link.pdf');
    await symlink(outgoingFile, outgoingLink);
    const sent = await call('send-1', 'send_message', '+15551234567', {
      text: hostile, attachments: [outgoingFile],
    });
    assert.equal(sent.ok, true);
    assert.ok(messages.some((message) => message.type === 'status'
      && message.inbound === 'ready' && message.outbound === 'ready'
      && message.deliveryConfirmed === true));
    assert.equal(sent.result?.target, '+15551234567');
    assert.deepEqual(sent.result?.payload, { text: hostile, attachments: [outgoingFile] });
    const attachmentOnly = await call('send-2', 'send_message', '+15551234567', { attachments: [outgoingFile] });
    assert.equal(attachmentOnly.ok, true);
    assert.deepEqual(attachmentOnly.result?.payload, { text: '', attachments: [outgoingFile] });

    child.stdin.write(`${JSON.stringify({
      type: 'deliver', id: 'delivery-1', target: 'iMessage;+;chat-fixture',
      payload: { text: 'Done', attachments: [outgoingFile] },
    })}\n`);
    assert.deepEqual(await waitFor(messages, (message) => message.id === 'delivery-1'), {
      type: 'delivery_ack', id: 'delivery-1', ok: true,
    });

    const invalid = await call('invalid-1', 'send_message', '+15551234567', { text: '' });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? '', /non-empty text or attachments/);
    const linked = await call('linked-1', 'send_message', '+15551234567', { attachments: [outgoingLink] });
    assert.equal(linked.ok, false);
    assert.match(linked.error ?? '', /regular file/);
    const relativeSave = await call('save-relative', 'save_attachment', 'message-incoming-2', {
      attachmentId: 'attachment-guid-1', outputPath: 'saved.png',
    });
    assert.equal(relativeSave.ok, false);
    assert.match(relativeSave.error ?? '', /absolute path/);
    const unknown = await call('unknown-1', 'delete_chat', 'x', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);

    const firstCount = messages.filter((message) => message.externalId === textEvent.externalId).length;
    await waitFor(messages, () => messages.filter((message) => message.externalId === textEvent.externalId).length > firstCount, 3_000);
    assert.doesNotMatch(stderr, /poll failed/);
  } finally {
    await stop(child);
  }

  const invalidFile = path.join(root, 'invalid.db');
  const invalidDatabase = new DatabaseSync(invalidFile);
  invalidDatabase.exec('CREATE TABLE message(guid TEXT)');
  invalidDatabase.close();
  const broken = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_MESSAGES_DB: invalidFile,
      MACOS_MESSAGES_OSASCRIPT: mock,
      MACOS_MESSAGES_POLL_INTERVAL_MS: '1000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let brokenStderr = '';
  broken.stderr.setEncoding('utf8');
  broken.stderr.on('data', (chunk: string) => { brokenStderr += chunk; });
  try {
    await waitForText(() => brokenStderr, /missing columns|missing table/);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal((brokenStderr.match(/poll failed:/g) ?? []).length, 1);
  } finally {
    await stop(broken);
  }
});

test('Messages JXA sends text and explicit files to one resolved destination', async () => {
  const connector = fileURLToPath(new URL('../examples/connectors/macos-messages-connector.mjs', import.meta.url));
  const source = await readFile(connector, 'utf8');
  const match = /const SEND_SCRIPT = String\.raw`([\s\S]*?)`;\n\nfunction integerEnv/.exec(source);
  assert.ok(match?.[1]);
  const chat = { id: () => 'iMessage;+;chat-1', name: () => 'Family' };
  const calls: Array<{ value: unknown; options: unknown }> = [];
  const app = {
    chats: () => [chat],
    participants: () => [],
    send: (value: unknown, options: unknown) => { calls.push({ value, options }); },
  };
  const Application = (name: string) => { assert.equal(name, 'Messages'); return app; };
  const Path = (value: string) => ({ path: value });
  const factory = new Function('Application', 'Path', `${match[1]}; return run;`) as (
    application: typeof Application,
    pathValue: typeof Path,
  ) => (argv: string[]) => string;
  const run = factory(Application, Path);
  assert.deepEqual(JSON.parse(run(['iMessage;+;chat-1', JSON.stringify({
    text: 'Photo', attachments: ['/tmp/photo.jpg', '/tmp/report.pdf'],
  })])), {
    sent: true, target: 'iMessage;+;chat-1', textSent: true, attachmentCount: 2,
  });
  assert.deepEqual(calls, [
    { value: 'Photo', options: { to: chat } },
    { value: { path: '/tmp/photo.jpg' }, options: { to: chat } },
    { value: { path: '/tmp/report.pdf' }, options: { to: chat } },
  ]);
});
