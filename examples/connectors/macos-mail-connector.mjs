#!/usr/bin/env node

/**
 * MimiAgent ↔ Apple Mail connector.
 * Uses JXA through osascript and keeps credentials inside Mail/Keychain.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const osascript = process.env.MACOS_MAIL_OSASCRIPT || '/usr/bin/osascript';
const pollIntervalMs = integerEnv('MACOS_MAIL_POLL_INTERVAL_MS', 120_000, 0, 86_400_000);
const maxUnread = integerEnv('MACOS_MAIL_MAX_UNREAD', 20, 1, 100);
const bodyChars = integerEnv('MACOS_MAIL_BODY_CHARS', 4_000, 0, 50_000);
const account = process.env.MACOS_MAIL_ACCOUNT || '*';
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const ACTIONS = new Set([
  'list_unread',
  'search_messages',
  'search_mailbox_messages',
  'read_message',
  'list_mailboxes',
  'list_attachments',
  'save_attachment',
  'send_message',
  'reply_message',
  'mark_read',
  'set_flagged',
  'move_message',
  'delete_message',
  'create_draft',
]);

const MAIL_SCRIPT = String.raw`
function json(value) { return JSON.stringify(value); }
function parse(raw) {
  var value = JSON.parse(raw || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('payload must be an object');
  return value;
}
function iso(value) { return value ? new Date(value).toISOString() : null; }
function string(value) { return value === null || value === undefined ? '' : String(value); }
function messageKey(message) {
  var header = string(message.messageId());
  return header || 'local:' + string(message.id());
}
function accountName(message) {
  try { return string(message.mailbox().account().name()); } catch (_) { return ''; }
}
function mailboxPath(mailbox) {
  var result = [];
  var current = mailbox;
  for (var depth = 0; current && depth < 20; depth += 1) {
    var name = '';
    try { name = string(current.name()); } catch (_) { break; }
    if (name) result.unshift(name);
    try { current = current.container(); } catch (_) { current = null; }
  }
  return result;
}
function attachmentInfo(attachment) {
  return {
    id: string(attachment.id()), name: string(attachment.name()),
    mimeType: string(attachment.mimeType()), size: Number(attachment.fileSize() || 0),
    downloaded: Boolean(attachment.downloaded())
  };
}
function messageAttachments(message) {
  return message.mailAttachments().slice(0, 50).map(attachmentInfo);
}
function messageInfo(message, includeBody, limit) {
  var content = includeBody ? string(message.content()).slice(0, limit) : '';
  return {
    id: messageKey(message), localId: string(message.id()), account: accountName(message),
    sender: string(message.sender()), subject: string(message.subject()),
    receivedAt: iso(message.dateReceived()), sentAt: iso(message.dateSent()),
    read: Boolean(message.readStatus()), flagged: Boolean(message.flaggedStatus()),
    flagIndex: Number(message.flagIndex()), deleted: Boolean(message.deletedStatus()),
    mailboxPath: mailboxPath(message.mailbox()), size: Number(message.messageSize() || 0),
    body: content, attachments: messageAttachments(message)
  };
}
function inboxMessages(app) { return app.inbox().messages(); }
function findMessage(app, key, p) {
  var messages = p && p.source
    ? findMailbox(app, p.source.account, p.source.path).messages()
    : inboxMessages(app);
  for (var i = 0; i < messages.length; i += 1) {
    if (messageKey(messages[i]) === key || string(messages[i].id()) === key) return messages[i];
  }
  throw new Error('message not found in ' + (p && p.source ? 'selected mailbox: ' : 'inbox: ') + key);
}
function findAttachment(message, id) {
  var attachments = message.mailAttachments();
  for (var i = 0; i < attachments.length; i += 1) {
    if (string(attachments[i].id()) === id) return attachments[i];
  }
  throw new Error('attachment not found: ' + id);
}
function unread(app, account, limit, includeBody, bodyLimit) {
  var messages = inboxMessages(app).filter(function(message) {
    return !message.readStatus() && (account === '*' || accountName(message) === account);
  });
  messages.sort(function(a, b) { return new Date(b.dateReceived()) - new Date(a.dateReceived()); });
  return messages.slice(0, limit).map(function(message) { return messageInfo(message, includeBody, bodyLimit); });
}
function searchMessages(app, account, p, bodyLimit) {
  var query = string(p.query).toLowerCase();
  var source = p.mailboxPath ? findMailbox(app, account, p.mailboxPath).messages() : inboxMessages(app);
  var messages = source.filter(function(message) {
    if (account !== '*' && accountName(message) !== account) return false;
    if (typeof p.read === 'boolean' && Boolean(message.readStatus()) !== p.read) return false;
    if (typeof p.flagged === 'boolean' && Boolean(message.flaggedStatus()) !== p.flagged) return false;
    if (!query) return true;
    return (string(message.sender()) + '\n' + string(message.subject())).toLowerCase().indexOf(query) !== -1;
  });
  messages.sort(function(a, b) { return new Date(b.dateReceived()) - new Date(a.dateReceived()); });
  return messages.slice(0, Number(p.limit || 20)).map(function(message) {
    return messageInfo(message, p.includeBody === true, bodyLimit);
  });
}
function mailboxChildren(mailbox) {
  try { return mailbox.mailboxes(); } catch (_) { return []; }
}
function appendMailboxes(mailbox, account, parentPath, output, limit) {
  if (output.length >= limit) return;
  var path = parentPath.concat([string(mailbox.name())]);
  output.push({ account: account, path: path, unreadCount: Number(mailbox.unreadCount() || 0) });
  if (path.length >= 20) return;
  var children = mailboxChildren(mailbox);
  for (var i = 0; i < children.length && output.length < limit; i += 1) {
    appendMailboxes(children[i], account, path, output, limit);
  }
}
function findAccount(app, name) {
  var matches = app.accounts().filter(function(candidate) { return string(candidate.name()) === name; });
  if (matches.length === 0) throw new Error('mail account not found: ' + name);
  if (matches.length > 1) throw new Error('mail account is ambiguous: ' + name);
  return matches[0];
}
function listMailboxes(app, requested, limit) {
  var accounts = requested === '*' ? app.accounts() : [findAccount(app, requested)];
  var output = [];
  for (var i = 0; i < accounts.length && output.length < limit; i += 1) {
    var name = string(accounts[i].name());
    var roots = accounts[i].mailboxes();
    for (var j = 0; j < roots.length && output.length < limit; j += 1) {
      appendMailboxes(roots[j], name, [], output, limit);
    }
  }
  return output;
}
function oneMailbox(candidates, name) {
  var matches = candidates.filter(function(candidate) { return string(candidate.name()) === name; });
  if (matches.length === 0) throw new Error('mailbox path not found at: ' + name);
  if (matches.length > 1) throw new Error('mailbox path is ambiguous at: ' + name);
  return matches[0];
}
function findMailbox(app, account, path) {
  var owner = findAccount(app, account);
  var current = oneMailbox(owner.mailboxes(), path[0]);
  for (var i = 1; i < path.length; i += 1) current = oneMailbox(mailboxChildren(current), path[i]);
  return current;
}
function addRecipients(app, outgoing, kind, addresses) {
  addresses.forEach(function(address) {
    if (kind === 'to') outgoing.toRecipients.push(app.ToRecipient({ address: address }));
    else if (kind === 'cc') outgoing.ccRecipients.push(app.CcRecipient({ address: address }));
    else outgoing.bccRecipients.push(app.BccRecipient({ address: address }));
  });
}
function addAttachments(app, outgoing, files) {
  (files || []).forEach(function(file) {
    outgoing.content.attachments.push(app.Attachment({ fileName: Path(file) }));
  });
}
function compose(app, target, p) {
  var outgoing = app.OutgoingMessage({
    visible: false, subject: string(p.subject), content: string(p.body)
  });
  app.outgoingMessages.push(outgoing);
  addRecipients(app, outgoing, 'to', [target].concat(p.to || []));
  addRecipients(app, outgoing, 'cc', p.cc || []);
  addRecipients(app, outgoing, 'bcc', p.bcc || []);
  addAttachments(app, outgoing, p.attachments || []);
  if (p.sender) outgoing.sender = p.sender;
  return outgoing;
}
function run(argv) {
  var action = argv[0];
  var target = argv[1];
  var p = parse(argv[2]);
  var bodyLimit = Number(argv[3] || 4000);
  var app = Application('Mail');
  if (action === 'list_unread') {
    return json({ messages: unread(app, target, Number(p.limit || 20), p.includeBody === true, bodyLimit) });
  }
  if (action === 'search_messages' || action === 'search_mailbox_messages') {
    return json({ messages: searchMessages(app, target, p, bodyLimit) });
  }
  if (action === 'read_message') {
    var read = findMessage(app, target, p);
    if (p.markRead === true) read.readStatus = true;
    return json({ message: messageInfo(read, true, bodyLimit) });
  }
  if (action === 'list_attachments') {
    var attachmentMessage = findMessage(app, target, p);
    return json({ messageId: target, attachments: messageAttachments(attachmentMessage) });
  }
  if (action === 'list_mailboxes') {
    return json({ mailboxes: listMailboxes(app, target, Number(p.limit || 200)) });
  }
  if (action === 'save_attachment') {
    var saveMessage = findMessage(app, target, p);
    var attachment = findAttachment(saveMessage, p.attachmentId);
    app.save(attachment, { in: Path(p.outputPath) });
    return json({ saved: true, messageId: target, attachment: attachmentInfo(attachment), path: p.outputPath });
  }
  if (action === 'send_message') {
    var outgoing = compose(app, target, p);
    return json({ sent: Boolean(app.send(outgoing)), recipient: target, attachmentCount: (p.attachments || []).length });
  }
  if (action === 'create_draft') {
    var draft = compose(app, target, p);
    app.save(draft);
    return json({ drafted: true, id: string(draft.id()), recipient: target, attachmentCount: (p.attachments || []).length });
  }
  if (action === 'reply_message') {
    var original = findMessage(app, target, p);
    var reply = app.reply(original, { openingWindow: false, replyToAll: p.replyAll === true });
    var quoted = string(reply.content());
    reply.content = string(p.body) + (quoted ? '\n\n' + quoted : '');
    addAttachments(app, reply, p.attachments || []);
    return json({
      sent: Boolean(app.send(reply)), messageId: target, replyAll: p.replyAll === true,
      attachmentCount: (p.attachments || []).length
    });
  }
  if (action === 'mark_read') {
    var marked = findMessage(app, target, p);
    marked.readStatus = p.read !== false;
    return json({ messageId: target, read: p.read !== false });
  }
  if (action === 'set_flagged') {
    var flagged = findMessage(app, target, p);
    flagged.flaggedStatus = p.flagged;
    flagged.flagIndex = p.flagged ? p.color : -1;
    return json({ messageId: target, flagged: p.flagged, flagIndex: p.flagged ? p.color : -1 });
  }
  if (action === 'move_message') {
    var moving = findMessage(app, target, p);
    var destination = findMailbox(app, p.destinationAccount, p.destinationPath);
    app.move(moving, { to: destination });
    return json({
      moved: true, messageId: target,
      destination: { account: p.destinationAccount, path: p.destinationPath }
    });
  }
  if (action === 'delete_message') {
    var deleting = findMessage(app, target, p);
    app.delete(deleting);
    return json({ deleted: true, messageId: target });
  }
  throw new Error('unsupported action: ' + action);
}`;

const POLL_SCRIPT = String.raw`
function string(value) { return value === null || value === undefined ? '' : String(value); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function key(message) { return string(message.messageId()) || 'local:' + string(message.id()); }
function accountName(message) {
  try { return string(message.mailbox().account().name()); } catch (_) { return ''; }
}
function run(argv) {
  var account = argv[1];
  var limit = Number(argv[2]);
  var bodyLimit = Number(argv[3]);
  var app = Application('Mail');
  var messages = app.inbox().messages().filter(function(message) {
    return !message.readStatus() && (account === '*' || accountName(message) === account);
  });
  messages.sort(function(a, b) { return new Date(b.dateReceived()) - new Date(a.dateReceived()); });
  return JSON.stringify({ messages: messages.slice(0, limit).map(function(message) {
    return {
      id: key(message), account: accountName(message), sender: string(message.sender()),
      subject: string(message.subject()), receivedAt: iso(message.dateReceived()),
      size: Number(message.messageSize() || 0), preview: string(message.content()).slice(0, bodyLimit),
      attachmentCount: message.mailAttachments().length
    };
  }) });
}`;

function integerEnv(name, fallback, minimum, maximum) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    process.stderr.write(`[macos-mail] invalid ${name}; using ${fallback}\n`);
    return fallback;
  }
  return value;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runJxa(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(osascript, ['-l', 'JavaScript', '-e', script, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('exit', (code, signal) => finish(() => {
      if (code !== 0) {
        reject(new Error((stderr || `osascript exited code=${code} signal=${signal || 'none'}`).trim()));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
      } catch {
        reject(new Error(`osascript returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    }));
  });
}

function payloadObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object');
  return value;
}

function boundedString(value, label, maximum, required = false) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
    throw new Error(`${label} must be ${required ? 'a non-empty ' : 'a '}string with at most ${maximum} characters`);
  }
  return value;
}

function address(value, label) {
  const candidate = boundedString(value, label, 500, true).trim();
  const email = candidate.match(/<([^<>\s@]+@[^<>\s@]+)>$/)?.[1] ?? candidate;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${label} must be an email address`);
  return candidate;
}

function addresses(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} must contain at most 20 addresses`);
  return value.map((item, index) => address(item, `${label}[${index}]`));
}

function attachmentPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('payload.attachments must contain at most 20 paths');
  return value.map((item, index) => {
    const file = boundedString(item, `payload.attachments[${index}]`, 4096, true);
    if (!path.isAbsolute(file)) throw new Error(`payload.attachments[${index}] must be an absolute path`);
    return file;
  });
}

function mailboxPathInput(value, label = 'payload.destinationPath') {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new Error(`${label} must contain between 1 and 20 mailbox names`);
  }
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, 255, true));
}

function sourceLocator(payload) {
  if (payload.source === undefined) return {};
  if (!payload.source || typeof payload.source !== 'object' || Array.isArray(payload.source)) {
    throw new Error('payload.source must be an object');
  }
  return { source: {
    account: boundedString(payload.source.account, 'payload.source.account', 500, true),
    path: mailboxPathInput(payload.source.path, 'payload.source.path'),
  } };
}

async function validateAttachmentFiles(files) {
  let total = 0;
  for (const [index, file] of files.entries()) {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`payload.attachments[${index}] must be a regular file`);
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`payload.attachments[${index}] exceeds 25MB`);
    total += info.size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('payload.attachments exceed 50MB in total');
  }
}

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  boundedString(target, 'target', 500, true);
  const payload = payloadObject(rawPayload);
  if (action === 'list_unread') {
    const limit = payload.limit === undefined ? maxUnread : Number(payload.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('payload.limit must be between 1 and 100');
    return { limit, includeBody: payload.includeBody === true };
  }
  if (action === 'search_messages' || action === 'search_mailbox_messages') {
    const limit = payload.limit === undefined ? 20 : Number(payload.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('payload.limit must be between 1 and 100');
    if (payload.read !== undefined && typeof payload.read !== 'boolean') throw new Error('payload.read must be a boolean');
    if (payload.flagged !== undefined && typeof payload.flagged !== 'boolean') throw new Error('payload.flagged must be a boolean');
    const result = {
      query: boundedString(payload.query ?? '', 'payload.query', 500),
      limit,
      includeBody: payload.includeBody === true,
    };
    if (action === 'search_mailbox_messages' && payload.mailboxPath === undefined) {
      throw new Error('search_mailbox_messages requires payload.mailboxPath');
    }
    if (payload.mailboxPath !== undefined) {
      if (target === '*') throw new Error('search_messages with payload.mailboxPath requires an exact account target');
      result.mailboxPath = mailboxPathInput(payload.mailboxPath, 'payload.mailboxPath');
    }
    if (payload.read !== undefined) result.read = payload.read;
    if (payload.flagged !== undefined) result.flagged = payload.flagged;
    return result;
  }
  if (action === 'read_message') return { markRead: payload.markRead === true, ...sourceLocator(payload) };
  if (action === 'list_mailboxes') {
    const limit = payload.limit === undefined ? 200 : Number(payload.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('payload.limit must be between 1 and 200');
    return { limit };
  }
  if (action === 'list_attachments') return sourceLocator(payload);
  if (action === 'save_attachment') {
    const outputPath = boundedString(payload.outputPath, 'payload.outputPath', 4096, true);
    if (!path.isAbsolute(outputPath)) throw new Error('payload.outputPath must be an absolute path');
    return {
      attachmentId: boundedString(payload.attachmentId, 'payload.attachmentId', 1000, true),
      outputPath,
      overwrite: payload.overwrite === true,
      ...sourceLocator(payload),
    };
  }
  if (action === 'mark_read') return { read: payload.read !== false, ...sourceLocator(payload) };
  if (action === 'set_flagged') {
    if (typeof payload.flagged !== 'boolean') throw new Error('payload.flagged must be a boolean');
    const color = payload.color === undefined ? 0 : Number(payload.color);
    if (!Number.isInteger(color) || color < 0 || color > 6) throw new Error('payload.color must be between 0 and 6');
    return { flagged: payload.flagged, color, ...sourceLocator(payload) };
  }
  if (action === 'move_message') {
    return {
      destinationAccount: boundedString(payload.destinationAccount, 'payload.destinationAccount', 500, true),
      destinationPath: mailboxPathInput(payload.destinationPath),
      ...sourceLocator(payload),
    };
  }
  if (action === 'delete_message') return sourceLocator(payload);
  if (action === 'reply_message') {
    return {
      body: boundedString(payload.body, 'payload.body', 40_000, true),
      replyAll: payload.replyAll === true,
      attachments: attachmentPaths(payload.attachments),
      ...sourceLocator(payload),
    };
  }
  const result = {
    subject: boundedString(payload.subject, 'payload.subject', 998, true),
    body: boundedString(payload.body ?? '', 'payload.body', 40_000),
    to: addresses(payload.to, 'payload.to'),
    cc: addresses(payload.cc, 'payload.cc'),
    bcc: addresses(payload.bcc, 'payload.bcc'),
    attachments: attachmentPaths(payload.attachments),
  };
  if (payload.sender !== undefined) result.sender = address(payload.sender, 'payload.sender');
  return result;
}

async function saveAttachment(messageId, payload) {
  const outputPath = payload.outputPath;
  const parent = path.dirname(outputPath);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw new Error('payload.outputPath parent must be a real directory');
  if (!payload.overwrite && await pathExists(outputPath)) throw new Error('payload.outputPath already exists');
  const temporary = path.join(parent, `.mimi-mail-${process.pid}-${randomUUID()}.part`);
  try {
    const result = await runJxa(MAIL_SCRIPT, [
      'save_attachment', messageId,
      JSON.stringify({ attachmentId: payload.attachmentId, outputPath: temporary, source: payload.source }), String(bodyChars),
    ]);
    const temporaryInfo = await lstat(temporary);
    if (!temporaryInfo.isFile()) throw new Error('Mail did not save a regular attachment file');
    await chmod(temporary, 0o600);
    if (payload.overwrite) {
      await rename(temporary, outputPath);
    } else {
      try {
        await link(temporary, outputPath);
      } catch (error) {
        if (error?.code === 'EEXIST') throw new Error('payload.outputPath already exists');
        throw error;
      }
      await rm(temporary, { force: true });
    }
    const metadata = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    return { ...metadata, path: outputPath };
  } finally {
    await rm(temporary, { force: true });
  }
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type === 'deliver') {
    const raw = typeof message.payload === 'string' ? { subject: 'MimiAgent', body: message.payload } : message.payload;
    const target = address(message.target, 'deliver.target');
    const payload = validate('send_message', target, {
      subject: raw?.subject ?? 'MimiAgent', body: raw?.body ?? raw?.text ?? '',
      to: raw?.to, cc: raw?.cc, bcc: raw?.bcc, sender: raw?.sender, attachments: raw?.attachments,
    });
    await validateAttachmentFiles(payload.attachments);
    await runJxa(MAIL_SCRIPT, ['send_message', target, JSON.stringify(payload), String(bodyChars)]);
    return { type: 'delivery_ack', id: message.id, ok: true };
  }
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const payload = validate(message.action, message.target, message.payload);
  if (message.action === 'save_attachment') {
    return { type: 'action_result', id: message.id, ok: true, result: await saveAttachment(message.target, payload) };
  }
  if ('attachments' in payload) await validateAttachmentFiles(payload.attachments);
  const target = ['send_message', 'create_draft'].includes(message.action)
    ? address(message.target, 'action.target')
    : message.target;
  const result = await runJxa(MAIL_SCRIPT, [message.action, target, JSON.stringify(payload), String(bodyChars)]);
  return { type: 'action_result', id: message.id, ok: true, result };
}

function actorId(sender) {
  const value = String(sender || 'unknown');
  return (value.match(/<([^<>\s@]+@[^<>\s@]+)>/)?.[1] ?? value).slice(0, 500);
}

function normalizedSubject(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim().slice(0, 998);
}

function threadId(message) {
  const subject = normalizedSubject(message.subject).toLocaleLowerCase();
  return `mail-thread-${hash(`${actorId(message.sender)}:${subject}`).slice(0, 16)}`;
}

let polling = false;
async function poll() {
  if (polling || pollIntervalMs === 0) return;
  polling = true;
  try {
    const result = await runJxa(POLL_SCRIPT, ['__poll__', account, String(maxUnread), String(bodyChars)]);
    for (const message of Array.isArray(result?.messages) ? result.messages : []) {
      const id = String(message.id || `local:${hash(JSON.stringify(message))}`);
      const conversationId = threadId(message);
      write({
        type: 'event', externalId: `mail:${hash(id)}`, kind: 'alert', priority: 75,
        occurredAt: message.receivedAt,
        actor: { id: actorId(message.sender), displayName: String(message.sender || '') },
        conversation: { id: conversationId },
        payload: {
          type: 'unread_mail',
          ...message,
          threadId: conversationId,
          threadSubject: normalizedSubject(message.subject),
        },
      });
    }
  } catch (error) {
    process.stderr.write(`[macos-mail] poll failed: ${errorText(error)}\n`);
  } finally {
    polling = false;
  }
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-mail] input exceeded 1MB; resetting buffer\n');
    input = '';
    return;
  }
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        write(await execute(message));
      } catch (error) {
        write({
          type: message?.type === 'action' ? 'action_result' : 'delivery_ack',
          id: message?.id ?? 'invalid', ok: false, error: errorText(error),
        });
      }
    })();
  }
});

let timer;
if (pollIntervalMs > 0) {
  void poll();
  timer = setInterval(() => void poll(), pollIntervalMs);
  timer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (timer) clearInterval(timer);
    process.exit(0);
  });
}
