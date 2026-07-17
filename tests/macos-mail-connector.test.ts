import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface Message {
  type: string;
  id?: string;
  ok?: boolean;
  externalId?: string;
  kind?: string;
  priority?: number;
  payload?: Record<string, unknown>;
  actor?: Record<string, unknown>;
  conversation?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
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

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

test('macOS Mail connector polls unread mail and exposes bounded explicit mail actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-mail-connector-'));
  const mock = path.join(root, 'mock-osascript.mjs');
  await writeFile(mock, `#!/usr/bin/env node
import fs from 'node:fs';
const marker = process.argv.indexOf('-e');
const args = process.argv.slice(marker + 2);
if (args[0] === '__poll__') {
  process.stdout.write(JSON.stringify({ messages: [{
    id: '<mail-1@example.test>', account: 'Work', sender: 'Alice <alice@example.test>',
    subject: 'Quarterly plan', receivedAt: '2026-07-15T08:00:00.000Z', size: 1234,
    preview: 'Please review the attached plan.'
  }] }));
} else {
  const payload = JSON.parse(args[2] || '{}');
  if (args[0] === 'save_attachment') fs.writeFileSync(payload.outputPath, 'fixture attachment bytes');
  process.stdout.write(JSON.stringify({ action: args[0], target: args[1], payload }));
}
`);
  await chmod(mock, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-mail-connector.mjs', import.meta.url));
  const source = await readFile(connector, 'utf8');
  for (const name of ['MAIL_SCRIPT', 'POLL_SCRIPT']) {
    const prefix = `const ${name} = String.raw\``;
    const start = source.indexOf(prefix) + prefix.length;
    const end = source.indexOf('`;', start);
    assert.ok(start >= prefix.length && end > start);
    assert.doesNotThrow(() => new Function(source.slice(start, end)));
  }

  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_MAIL_OSASCRIPT: mock,
      MACOS_MAIL_POLL_INTERVAL_MS: '1000',
      MACOS_MAIL_MAX_UNREAD: '10',
      MACOS_MAIL_BODY_CHARS: '2000',
      MACOS_MAIL_ACCOUNT: '*',
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
    const historicalSource = { account: 'Work', path: ['Archive', '2026'] };
    const outgoingAttachment = path.join(root, 'report.pdf');
    await writeFile(outgoingAttachment, 'report bytes');
    const attachmentSymlink = path.join(root, 'report-link.pdf');
    await symlink(outgoingAttachment, attachmentSymlink);
    const event = await waitFor(messages, (message) => message.type === 'event');
    assert.equal(event.payload?.type, 'unread_mail');
    assert.equal(event.kind, 'alert');
    assert.equal(event.priority, 75);
    assert.equal(event.payload?.subject, 'Quarterly plan');
    assert.equal(event.payload?.threadSubject, 'Quarterly plan');
    assert.equal(event.actor?.id, 'alice@example.test');
    assert.match(String(event.conversation?.id), /^mail-thread-[0-9a-f]{16}$/);
    assert.equal(event.payload?.threadId, event.conversation?.id);
    assert.match(String(event.externalId), /^mail:[0-9a-f]{32}$/);

    const listed = await call('list-1', 'list_unread', '*', { limit: 5, includeBody: true });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.result?.payload, { limit: 5, includeBody: true });

    const read = await call('read-1', 'read_message', '<mail-1@example.test>', {
      markRead: true, source: historicalSource,
    });
    assert.deepEqual(read.result?.payload, { markRead: true, source: historicalSource });

    const searched = await call('search-1', 'search_mailbox_messages', 'Work', {
      query: 'Alice; $(never-run)', read: false, flagged: true, limit: 12, includeBody: true,
      mailboxPath: ['Archive', '2026'],
    });
    assert.deepEqual(searched.result?.payload, {
      query: 'Alice; $(never-run)', read: false, flagged: true, limit: 12, includeBody: true,
      mailboxPath: ['Archive', '2026'],
    });
    const wildcardMailbox = await call('search-wildcard', 'search_messages', '*', { mailboxPath: ['Archive'] });
    assert.equal(wildcardMailbox.ok, false);
    assert.match(String(wildcardMailbox.error), /exact account/);
    const mailboxes = await call('mailboxes-1', 'list_mailboxes', 'Work', { limit: 50 });
    assert.deepEqual(mailboxes.result?.payload, { limit: 50 });

    const hostileBody = 'Status; $(touch /tmp/mail-never-runs) `whoami`';
    const sent = await call('send-1', 'send_message', 'boss@example.test', {
      subject: 'Status "Q3"', body: hostileBody, cc: ['team@example.test'], attachments: [outgoingAttachment],
    });
    assert.equal(sent.result?.target, 'boss@example.test');
    assert.equal((sent.result?.payload as Record<string, unknown>).body, hostileBody);
    assert.deepEqual((sent.result?.payload as Record<string, unknown>).cc, ['team@example.test']);
    assert.deepEqual((sent.result?.payload as Record<string, unknown>).attachments, [outgoingAttachment]);

    const replied = await call('reply-1', 'reply_message', '<mail-1@example.test>', {
      body: 'Approved', replyAll: true, attachments: [outgoingAttachment], source: historicalSource,
    });
    assert.deepEqual(replied.result?.payload, {
      body: 'Approved', replyAll: true, attachments: [outgoingAttachment], source: historicalSource,
    });

    const marked = await call('mark-1', 'mark_read', '<mail-1@example.test>', { read: false, source: historicalSource });
    assert.deepEqual(marked.result?.payload, { read: false, source: historicalSource });

    const flagged = await call('flag-1', 'set_flagged', '<mail-1@example.test>', {
      flagged: true, color: 3, source: historicalSource,
    });
    assert.deepEqual(flagged.result?.payload, { flagged: true, color: 3, source: historicalSource });
    const moved = await call('move-1', 'move_message', '<mail-1@example.test>', {
      destinationAccount: 'Work', destinationPath: ['Archive', '2026'], source: historicalSource,
    });
    assert.deepEqual(moved.result?.payload, {
      destinationAccount: 'Work', destinationPath: ['Archive', '2026'], source: historicalSource,
    });
    const deleted = await call('delete-1', 'delete_message', '<mail-1@example.test>', { source: historicalSource });
    assert.equal(deleted.result?.action, 'delete_message');
    assert.deepEqual(deleted.result?.payload, { source: historicalSource });

    const drafted = await call('draft-1', 'create_draft', 'friend@example.test', { subject: 'Hello', body: 'Later' });
    assert.equal(drafted.result?.action, 'create_draft');

    const listedAttachments = await call('attachments-1', 'list_attachments', '<mail-1@example.test>', {
      source: historicalSource,
    });
    assert.equal(listedAttachments.result?.action, 'list_attachments');
    assert.deepEqual(listedAttachments.result?.payload, { source: historicalSource });

    const savedPath = path.join(root, 'saved-report.pdf');
    const saved = await call('save-attachment-1', 'save_attachment', '<mail-1@example.test>', {
      attachmentId: 'attachment-1', outputPath: savedPath, source: historicalSource,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.result?.path, savedPath);
    assert.deepEqual((saved.result?.payload as Record<string, unknown>).source, historicalSource);
    assert.equal(await readFile(savedPath, 'utf8'), 'fixture attachment bytes');
    assert.equal((await stat(savedPath)).mode & 0o777, 0o600);
    const noClobber = await call('save-attachment-2', 'save_attachment', '<mail-1@example.test>', {
      attachmentId: 'attachment-1', outputPath: savedPath,
    });
    assert.equal(noClobber.ok, false);
    assert.match(noClobber.error ?? '', /already exists/);
    const overwritten = await call('save-attachment-3', 'save_attachment', '<mail-1@example.test>', {
      attachmentId: 'attachment-1', outputPath: savedPath, overwrite: true,
    });
    assert.equal(overwritten.ok, true);

    const relativeSave = await call('save-relative', 'save_attachment', '<mail-1@example.test>', {
      attachmentId: 'attachment-1', outputPath: 'relative.pdf',
    });
    assert.equal(relativeSave.ok, false);
    assert.match(relativeSave.error ?? '', /absolute path/);
    const linkedAttachment = await call('send-symlink', 'send_message', 'boss@example.test', {
      subject: 'No links', attachments: [attachmentSymlink],
    });
    assert.equal(linkedAttachment.ok, false);
    assert.match(linkedAttachment.error ?? '', /regular file/);
    const invalidColor = await call('flag-color', 'set_flagged', '<mail-1@example.test>', { flagged: true, color: 7 });
    assert.equal(invalidColor.ok, false);
    assert.match(invalidColor.error ?? '', /between 0 and 6/);
    const emptyDestination = await call('move-empty', 'move_message', '<mail-1@example.test>', {
      destinationAccount: 'Work', destinationPath: [],
    });
    assert.equal(emptyDestination.ok, false);
    assert.match(emptyDestination.error ?? '', /between 1 and 20/);
    const missingMailboxPath = await call('search-no-path', 'search_mailbox_messages', 'Work', {});
    assert.equal(missingMailboxPath.ok, false);
    assert.match(missingMailboxPath.error ?? '', /requires payload\.mailboxPath/);
    const invalidSource = await call('source-empty', 'read_message', '<mail-1@example.test>', {
      source: { account: 'Work', path: [] },
    });
    assert.equal(invalidSource.ok, false);
    assert.match(invalidSource.error ?? '', /payload\.source\.path/);

    child.stdin.write(`${JSON.stringify({
      type: 'deliver', id: 'delivery-1', target: 'owner@example.test', payload: { subject: 'MimiAgent', text: 'Done' },
    })}\n`);
    assert.deepEqual(await waitFor(messages, (message) => message.id === 'delivery-1'), {
      type: 'delivery_ack', id: 'delivery-1', ok: true,
    });

    const invalid = await call('invalid-1', 'send_message', 'not-an-email', { subject: 'x', body: 'y' });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error ?? '', /email address/);
    const unknown = await call('unknown-1', 'delete_mailbox', 'x', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);

    const firstEventCount = messages.filter((message) => message.externalId === event.externalId).length;
    await waitFor(messages, () => messages.filter((message) => message.externalId === event.externalId).length > firstEventCount, 3_000);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});

interface FakeOutgoing {
  content: (() => string) & { attachments: unknown[] };
  toRecipients: unknown[];
  ccRecipients: unknown[];
  bccRecipients: unknown[];
  id: () => number;
  sender?: string;
}

function fakeOutgoing(initial = ''): FakeOutgoing {
  let text = initial;
  const content = (() => text) as FakeOutgoing['content'];
  content.attachments = [];
  const outgoing = {
    toRecipients: [], ccRecipients: [], bccRecipients: [], id: () => 42,
  } as unknown as FakeOutgoing;
  Object.defineProperty(outgoing, 'content', {
    configurable: true,
    get: () => content,
    set: (value: unknown) => { text = String(value); },
  });
  return outgoing;
}

test('Mail JXA attachment actions use stable ids and attach explicit paths', async () => {
  const connector = fileURLToPath(new URL('../examples/connectors/macos-mail-connector.mjs', import.meta.url));
  const source = await readFile(connector, 'utf8');
  const prefix = 'const MAIL_SCRIPT = String.raw`';
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf('`;', start);
  assert.ok(start >= prefix.length && end > start);
  const script = source.slice(start, end);

  const attachment = {
    id: () => 'attachment-1', name: () => '../report.pdf', mimeType: () => 'application/pdf',
    fileSize: () => 1234, downloaded: () => true,
  };
  const message = {
    messageId: () => '<mail-1@example.test>', id: () => 7,
    mailbox: () => ({ account: () => ({ name: () => 'Work' }) }),
    sender: () => 'Alice <alice@example.test>', subject: () => 'Report',
    dateReceived: () => new Date('2026-07-15T08:00:00.000Z'),
    dateSent: () => new Date('2026-07-15T07:59:00.000Z'), readStatus: () => false,
    messageSize: () => 2345, content: () => 'See attachment', mailAttachments: () => [attachment],
  };
  const saved: Array<{ item: unknown; options: unknown }> = [];
  const sent: FakeOutgoing[] = [];
  const outgoingMessages: FakeOutgoing[] = [];
  const mailApp = {
    inbox: () => ({ messages: () => [message] }),
    outgoingMessages,
    OutgoingMessage: (properties: { content?: string }) => fakeOutgoing(properties.content),
    ToRecipient: (value: unknown) => value,
    CcRecipient: (value: unknown) => value,
    BccRecipient: (value: unknown) => value,
    Attachment: (value: unknown) => value,
    save: (item: unknown, options: unknown) => { saved.push({ item, options }); return true; },
    send: (item: FakeOutgoing) => { sent.push(item); return true; },
    reply: () => fakeOutgoing('quoted body'),
  };
  const Application = (name: string) => {
    assert.equal(name, 'Mail');
    return mailApp;
  };
  const Path = (value: string) => ({ path: value });
  const factory = new Function('Application', 'Path', `${script}; return run;`) as (
    application: typeof Application,
    pathValue: typeof Path,
  ) => (argv: string[]) => string;
  const run = factory(Application, Path);

  assert.deepEqual(JSON.parse(run(['list_attachments', '<mail-1@example.test>', '{}', '4000'])), {
    messageId: '<mail-1@example.test>',
    attachments: [{
      id: 'attachment-1', name: '../report.pdf', mimeType: 'application/pdf', size: 1234, downloaded: true,
    }],
  });
  const temporary = '/tmp/explicit-random.part';
  assert.deepEqual(JSON.parse(run(['save_attachment', '<mail-1@example.test>', JSON.stringify({
    attachmentId: 'attachment-1', outputPath: temporary,
  }), '4000'])), {
    saved: true, messageId: '<mail-1@example.test>',
    attachment: { id: 'attachment-1', name: '../report.pdf', mimeType: 'application/pdf', size: 1234, downloaded: true },
    path: temporary,
  });
  assert.deepEqual(saved, [{ item: attachment, options: { in: { path: temporary } } }]);
  assert.throws(() => run(['save_attachment', '<mail-1@example.test>', JSON.stringify({
    attachmentId: 'missing', outputPath: temporary,
  }), '4000']), /attachment not found/);

  const outgoingPath = '/tmp/report.pdf';
  const sendResult = JSON.parse(run(['send_message', 'boss@example.test', JSON.stringify({
    subject: 'Report', body: 'Attached', to: [], cc: [], bcc: [], attachments: [outgoingPath],
  }), '4000'])) as { sent: boolean; attachmentCount: number };
  assert.deepEqual(sendResult, { sent: true, recipient: 'boss@example.test', attachmentCount: 1 });
  assert.deepEqual(sent[0]?.content.attachments, [{ fileName: { path: outgoingPath } }]);

  const replyResult = JSON.parse(run(['reply_message', '<mail-1@example.test>', JSON.stringify({
    body: 'Updated file', replyAll: true, attachments: [outgoingPath],
  }), '4000'])) as { sent: boolean; attachmentCount: number };
  assert.equal(replyResult.sent, true);
  assert.equal(replyResult.attachmentCount, 1);
  assert.deepEqual(sent[1]?.content.attachments, [{ fileName: { path: outgoingPath } }]);
});

interface FakeMailbox {
  name: () => string;
  unreadCount: () => number;
  mailboxes: () => FakeMailbox[];
  account: () => { name: () => string };
  container: () => FakeMailbox | null;
  messages: () => Array<Record<string, unknown>>;
}

function fakeMailbox(
  name: string,
  accountName: string,
  unreadCount: number,
  children: FakeMailbox[] = [],
  parent: FakeMailbox | null = null,
): FakeMailbox {
  const mailbox: FakeMailbox = {
    name: () => name,
    unreadCount: () => unreadCount,
    mailboxes: () => children,
    account: () => ({ name: () => accountName }),
    container: () => parent,
    messages: () => [],
  };
  for (const child of children) child.container = () => mailbox;
  return mailbox;
}

function fakeInboxMessage(
  id: string,
  sender: string,
  subject: string,
  receivedAt: string,
  mailbox: FakeMailbox,
  initial: { read: boolean; flagged: boolean; flagIndex: number },
) {
  let read = initial.read;
  let flagged = initial.flagged;
  let flagIndex = initial.flagIndex;
  const message = {
    messageId: () => id,
    id: () => Number(id.replace(/\D/g, '')) || 1,
    mailbox: () => mailbox,
    sender: () => sender,
    subject: () => subject,
    dateReceived: () => new Date(receivedAt),
    dateSent: () => new Date(receivedAt),
    deletedStatus: () => false,
    messageSize: () => 512,
    content: () => `Body for ${subject}`,
    mailAttachments: () => [],
  } as Record<string, unknown>;
  Object.defineProperties(message, {
    readStatus: { configurable: true, get: () => () => read, set: (value: unknown) => { read = Boolean(value); } },
    flaggedStatus: { configurable: true, get: () => () => flagged, set: (value: unknown) => { flagged = Boolean(value); } },
    flagIndex: { configurable: true, get: () => () => flagIndex, set: (value: unknown) => { flagIndex = Number(value); } },
  });
  return message;
}

test('Mail JXA searches and organizes inbox and historical messages through explicit mailbox paths', async () => {
  const connector = fileURLToPath(new URL('../examples/connectors/macos-mail-connector.mjs', import.meta.url));
  const source = await readFile(connector, 'utf8');
  const prefix = 'const MAIL_SCRIPT = String.raw`';
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf('`;', start);
  const script = source.slice(start, end);

  const archive2026 = fakeMailbox('2026', 'Work', 0);
  const archive = fakeMailbox('Archive', 'Work', 2, [archive2026]);
  const inboxMailbox = fakeMailbox('Inbox', 'Work', 5);
  const projects = fakeMailbox('Projects', 'Work', 1);
  const account = { name: () => 'Work', mailboxes: () => [inboxMailbox, archive, projects] };
  const alice = fakeInboxMessage(
    '<mail-101@example.test>', 'Alice <alice@example.test>', 'Quarterly Plan',
    '2026-07-15T08:00:00.000Z', inboxMailbox, { read: false, flagged: false, flagIndex: -1 },
  );
  const bob = fakeInboxMessage(
    '<mail-102@example.test>', 'Bob <bob@example.test>', 'Lunch',
    '2026-07-15T07:00:00.000Z', inboxMailbox, { read: true, flagged: true, flagIndex: 2 },
  );
  const archived = fakeInboxMessage(
    '<mail-099@example.test>', 'Legal <legal@example.test>', 'Signed Contract',
    '2026-06-01T07:00:00.000Z', archive2026, { read: true, flagged: false, flagIndex: -1 },
  );
  archive2026.messages = () => [archived];
  const moved: Array<{ message: unknown; destination: unknown }> = [];
  const deleted: unknown[] = [];
  const app = {
    inbox: () => ({ messages: () => [bob, alice] }),
    accounts: () => [account],
    move: (message: unknown, options: { to: unknown }) => { moved.push({ message, destination: options.to }); },
    delete: (message: unknown) => { deleted.push(message); },
  };
  const Application = (name: string) => { assert.equal(name, 'Mail'); return app; };
  const factory = new Function('Application', 'Path', `${script}; return run;`) as (
    application: typeof Application,
    pathValue: (value: string) => string,
  ) => (argv: string[]) => string;
  const run = factory(Application, (value) => value);

  const search = JSON.parse(run(['search_messages', 'Work', JSON.stringify({
    query: 'alice', read: false, flagged: false, limit: 10, includeBody: true,
  }), '2000'])) as { messages: Array<Record<string, unknown>> };
  assert.equal(search.messages.length, 1);
  assert.equal(search.messages[0]?.id, '<mail-101@example.test>');
  assert.deepEqual(search.messages[0]?.mailboxPath, ['Inbox']);
  assert.equal(search.messages[0]?.body, 'Body for Quarterly Plan');

  const history = JSON.parse(run(['search_mailbox_messages', 'Work', JSON.stringify({
    query: 'contract', mailboxPath: ['Archive', '2026'], limit: 10, includeBody: true,
  }), '2000'])) as { messages: Array<Record<string, unknown>> };
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0]?.id, '<mail-099@example.test>');
  assert.deepEqual(history.messages[0]?.mailboxPath, ['Archive', '2026']);
  assert.equal(history.messages[0]?.body, 'Body for Signed Contract');

  const historicalRead = JSON.parse(run(['read_message', '<mail-099@example.test>', JSON.stringify({
    markRead: false, source: { account: 'Work', path: ['Archive', '2026'] },
  }), '2000'])) as { message: Record<string, unknown> };
  assert.equal(historicalRead.message.id, '<mail-099@example.test>');
  assert.deepEqual(JSON.parse(run(['set_flagged', '<mail-099@example.test>', JSON.stringify({
    flagged: true, color: 5, source: { account: 'Work', path: ['Archive', '2026'] },
  }), '2000'])), { messageId: '<mail-099@example.test>', flagged: true, flagIndex: 5 });
  assert.equal((archived.flaggedStatus as () => boolean)(), true);

  assert.deepEqual(JSON.parse(run(['list_mailboxes', 'Work', '{"limit":10}', '2000'])), {
    mailboxes: [
      { account: 'Work', path: ['Inbox'], unreadCount: 5 },
      { account: 'Work', path: ['Archive'], unreadCount: 2 },
      { account: 'Work', path: ['Archive', '2026'], unreadCount: 0 },
      { account: 'Work', path: ['Projects'], unreadCount: 1 },
    ],
  });

  assert.deepEqual(JSON.parse(run(['set_flagged', '<mail-101@example.test>', JSON.stringify({
    flagged: true, color: 4,
  }), '2000'])), { messageId: '<mail-101@example.test>', flagged: true, flagIndex: 4 });
  assert.equal((alice.flaggedStatus as () => boolean)(), true);
  assert.equal((alice.flagIndex as () => number)(), 4);

  assert.deepEqual(JSON.parse(run(['move_message', '<mail-101@example.test>', JSON.stringify({
    destinationAccount: 'Work', destinationPath: ['Archive', '2026'],
  }), '2000'])), {
    moved: true, messageId: '<mail-101@example.test>',
    destination: { account: 'Work', path: ['Archive', '2026'] },
  });
  assert.deepEqual(moved, [{ message: alice, destination: archive2026 }]);

  assert.deepEqual(JSON.parse(run(['delete_message', '<mail-102@example.test>', '{}', '2000'])), {
    deleted: true, messageId: '<mail-102@example.test>',
  });
  assert.deepEqual(deleted, [bob]);

  const duplicate = fakeMailbox('2026', 'Work', 0);
  archive.mailboxes = () => [archive2026, duplicate];
  assert.throws(() => run(['move_message', '<mail-101@example.test>', JSON.stringify({
    destinationAccount: 'Work', destinationPath: ['Archive', '2026'],
  }), '2000']), /ambiguous/);
  assert.throws(() => run(['read_message', '<mail-099@example.test>', JSON.stringify({
    source: { account: 'Work', path: ['Archive', '2026'] },
  }), '2000']), /ambiguous/);
});
