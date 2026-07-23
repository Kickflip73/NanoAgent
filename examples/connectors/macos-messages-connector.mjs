#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS Messages connector.
 * Reads chat.db with a read-only SQLite connection and sends through JXA.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, lstatSync } from 'node:fs';
import { chmod, copyFile, link, lstat, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databaseFile = process.env.MACOS_MESSAGES_DB || path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const osascript = process.env.MACOS_MESSAGES_OSASCRIPT || '/usr/bin/osascript';
const pollIntervalMs = integerEnv('MACOS_MESSAGES_POLL_INTERVAL_MS', 30_000, 0, 86_400_000);
const maxEvents = integerEnv('MACOS_MESSAGES_MAX_EVENTS', 50, 1, 200);
const lookbackHours = integerEnv('MACOS_MESSAGES_LOOKBACK_HOURS', 24, 1, 720);
const scanLimit = Math.min(1_000, maxEvents * 5);
const ACTIONS = new Set(['list_chats', 'recent_messages', 'list_attachments', 'save_attachment', 'send_message']);
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 500 * 1024 * 1024;

const SEND_SCRIPT = String.raw`
function string(value) { return value === null || value === undefined ? '' : String(value); }
function run(argv) {
  var target = argv[0];
  var payload = JSON.parse(argv[1] || '{}');
  var app = Application('Messages');
  var destination = null;
  var chats = app.chats();
  for (var i = 0; i < chats.length && !destination; i += 1) {
    if (string(chats[i].id()) === target || string(chats[i].name()) === target) destination = chats[i];
  }
  if (!destination) {
    var participants = app.participants();
    for (var j = 0; j < participants.length && !destination; j += 1) {
      if (string(participants[j].handle()) === target || string(participants[j].id()) === target) destination = participants[j];
    }
  }
  if (!destination) throw new Error('chat or participant not found: ' + target);
  var textSent = typeof payload.text === 'string' && payload.text.length > 0;
  if (textSent) app.send(payload.text, { to: destination });
  var attachments = payload.attachments || [];
  for (var k = 0; k < attachments.length; k += 1) app.send(Path(attachments[k]), { to: destination });
  return JSON.stringify({ sent: true, target: target, textSent: textSent, attachmentCount: attachments.length });
}`;

function integerEnv(name, fallback, minimum, maximum) {
  if (process.env[name] === undefined) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    process.stderr.write(`[macos-messages] invalid ${name}; using ${fallback}\n`);
    return fallback;
  }
  return value;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let readiness = { inbound: 'unknown', outbound: 'unknown' };
function updateReadiness(patch) {
  const next = { ...readiness, ...patch };
  if (next.inbound === readiness.inbound && next.outbound === readiness.outbound
    && next.deliveryConfirmed === readiness.deliveryConfirmed) return;
  readiness = next;
  write({ type: 'status', ...readiness });
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name)));
}

function validateSchema(database) {
  const required = {
    message: ['guid', 'text', 'handle_id', 'service', 'date', 'is_from_me'],
    chat: ['guid', 'chat_identifier', 'display_name', 'service_name'],
    handle: ['id'],
    chat_message_join: ['chat_id', 'message_id'],
    chat_handle_join: ['chat_id', 'handle_id'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const actual = tableColumns(database, table);
    if (!actual.size) throw new Error(`Messages database missing table: ${table}`);
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length) throw new Error(`Messages database ${table} missing columns: ${missing.join(', ')}`);
  }
}

function databaseError(error) {
  const reason = errorText(error);
  if (/authorization denied|unable to open|SQLITE_CANTOPEN/i.test(reason)) {
    return new Error(`cannot read ${databaseFile}; grant Full Disk Access to the Node/Terminal process running MimiAgent (${reason})`);
  }
  return error instanceof Error ? error : new Error(reason);
}

function withDatabase(callback) {
  let database;
  try {
    database = new DatabaseSync(databaseFile, { readOnly: true });
    validateSchema(database);
    return callback(database);
  } catch (error) {
    throw databaseError(error);
  } finally {
    database?.close();
  }
}

function bigStatement(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement;
}

function appleDate(value) {
  if (value === null || value === undefined) return undefined;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  const milliseconds = Math.abs(numeric) >= 1e14
    ? numeric / 1e6
    : Math.abs(numeric) >= 1e11 ? numeric : numeric * 1_000;
  const date = new Date(APPLE_EPOCH_MS + milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function normalizedMessage(row) {
  const attachmentCount = Number(row.attachment_count || 0);
  const content = typeof row.text === 'string' && row.text.trim()
    ? row.text.slice(0, 40_000)
    : attachmentCount > 0 ? '[Attachment or rich message]' : '[Non-text message]';
  return {
    id: String(row.guid || `local:${row.local_id}`),
    localId: String(row.local_id),
    chatId: String(row.chat_guid),
    chatIdentifier: String(row.chat_identifier || ''),
    chatName: String(row.display_name || ''),
    sender: String(row.sender || ''),
    service: String(row.service || row.service_name || ''),
    receivedAt: appleDate(row.date),
    fromMe: Number(row.is_from_me) === 1,
    text: content,
    attachmentCount,
  };
}

function attachmentLayout(database) {
  const join = tableColumns(database, 'message_attachment_join');
  const attachment = tableColumns(database, 'attachment');
  const missingJoin = ['message_id', 'attachment_id'].filter((column) => !join.has(column));
  const missingAttachment = ['filename'].filter((column) => !attachment.has(column));
  if (!attachment.size) throw new Error('Messages database missing table: attachment');
  if (missingJoin.length) throw new Error(`Messages database message_attachment_join missing columns: ${missingJoin.join(', ')}`);
  if (missingAttachment.length) throw new Error(`Messages database attachment missing columns: ${missingAttachment.join(', ')}`);
  return { attachment };
}

function attachmentFile(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const expanded = value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : undefined;
}

function fileAvailability(file) {
  if (!file) return { available: false };
  try {
    const info = lstatSync(file);
    return { available: info.isFile(), actualBytes: info.isFile() ? info.size : undefined };
  } catch {
    return { available: false };
  }
}

function attachmentItem(row) {
  const localPath = attachmentFile(row.filename);
  const availability = fileAvailability(localPath);
  return {
    id: String(row.guid || `local:${row.local_id}`),
    localId: String(row.local_id),
    name: localPath ? path.basename(localPath) : String(row.filename || ''),
    mimeType: row.mime_type === null || row.mime_type === undefined ? '' : String(row.mime_type),
    declaredBytes: Number(row.total_bytes || 0),
    transferState: row.transfer_state === null || row.transfer_state === undefined ? '' : String(row.transfer_state),
    localPath: localPath || null,
    ...availability,
  };
}

function attachmentSelect(database) {
  const { attachment } = attachmentLayout(database);
  const optional = (column) => attachment.has(column) ? `a.${column}` : 'NULL';
  return `
    SELECT a.ROWID AS local_id, ${optional('guid')} AS guid, a.filename,
           ${optional('mime_type')} AS mime_type, ${optional('total_bytes')} AS total_bytes,
           ${optional('transfer_state')} AS transfer_state
      FROM attachment a
      JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
      JOIN message m ON m.ROWID = maj.message_id
     WHERE m.guid = ? OR CAST(m.ROWID AS TEXT) = ?
  ORDER BY a.ROWID
     LIMIT ?`;
}

function listAttachments(messageId, limit = 50) {
  return withDatabase((database) => database.prepare(attachmentSelect(database))
    .all(messageId, messageId, limit)
    .map(attachmentItem));
}

function attachmentExpression(database) {
  const columns = tableColumns(database, 'message_attachment_join');
  return columns.has('message_id')
    ? '(SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = m.ROWID)'
    : '0';
}

function messageSelect(database, where = '') {
  return `
    SELECT m.ROWID AS local_id, m.guid, m.text, m.date, m.is_from_me, m.service,
           h.id AS sender, c.guid AS chat_guid, c.chat_identifier, c.display_name, c.service_name,
           ${attachmentExpression(database)} AS attachment_count
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
 LEFT JOIN handle h ON h.ROWID = m.handle_id
     ${where}
  ORDER BY m.date DESC
     LIMIT ?`;
}

function latestIncoming(limit) {
  return withDatabase((database) => {
    const statement = bigStatement(database, messageSelect(database, 'WHERE m.is_from_me = 0'));
    return statement.all(limit).map(normalizedMessage);
  });
}

function recentMessages(target, limit) {
  return withDatabase((database) => {
    const statement = bigStatement(database, messageSelect(
      database,
      'WHERE c.guid = ? OR c.chat_identifier = ?',
    ));
    return statement.all(target, target, limit).map(normalizedMessage).reverse();
  });
}

function listChats(limit) {
  return withDatabase((database) => {
    const statement = bigStatement(database, `
      SELECT c.ROWID AS local_id, c.guid, c.chat_identifier, c.display_name, c.service_name,
             MAX(m.date) AS last_date, COUNT(DISTINCT m.ROWID) AS message_count,
             GROUP_CONCAT(DISTINCT h.id) AS participants
        FROM chat c
   LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
   LEFT JOIN message m ON m.ROWID = cmj.message_id
   LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
   LEFT JOIN handle h ON h.ROWID = chj.handle_id
    GROUP BY c.ROWID
    ORDER BY last_date DESC
       LIMIT ?`);
    return statement.all(limit).map((row) => ({
      id: String(row.guid), localId: String(row.local_id),
      identifier: String(row.chat_identifier || ''), name: String(row.display_name || ''),
      service: String(row.service_name || ''), lastMessageAt: appleDate(row.last_date),
      messageCount: Number(row.message_count || 0),
      participants: String(row.participants || '').split(',').filter(Boolean),
    }));
  });
}

async function runJxa(target, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(osascript, ['-l', 'JavaScript', '-e', SEND_SCRIPT, target, JSON.stringify(payload)], {
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
        const result = stdout.trim() ? JSON.parse(stdout.trim()) : null;
        updateReadiness({ outbound: 'ready', deliveryConfirmed: true });
        resolve(result);
      } catch {
        reject(new Error(`osascript returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    }));
  });
}

function boundedTarget(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000) {
    throw new Error(`${label} must be a non-empty string with at most 1000 characters`);
  }
  return value.trim();
}

function payloadObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object');
  return value;
}

function limitValue(value, fallback = 50) {
  const limit = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('payload.limit must be between 1 and 200');
  return limit;
}

function attachmentLimit(value) {
  const limit = value === undefined ? 50 : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('payload.limit must be between 1 and 50');
  return limit;
}

function boundedText(value, label, required = false) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > 40_000) {
    throw new Error(`${label} must be ${required ? 'a non-empty ' : 'a '}string with at most 40000 characters`);
  }
  return value;
}

function attachmentPaths(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('payload.attachments must contain at most 20 paths');
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item || item.length > 4_096 || !path.isAbsolute(item)) {
      throw new Error(`payload.attachments[${index}] must be an absolute path with at most 4096 characters`);
    }
    return path.normalize(item);
  });
}

async function validateAttachmentFiles(files) {
  let total = 0;
  for (const [index, file] of files.entries()) {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error(`payload.attachments[${index}] must be a regular file`);
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`payload.attachments[${index}] exceeds 250MB`);
    total += info.size;
    if (total > MAX_TOTAL_ATTACHMENT_BYTES) throw new Error('payload.attachments exceed 500MB in total');
  }
}

function sendPayload(rawPayload, label = 'payload') {
  const payload = payloadObject(rawPayload);
  const text = boundedText(payload.text ?? '', `${label}.text`);
  const attachments = attachmentPaths(payload.attachments);
  if (!text.trim() && attachments.length === 0) throw new Error(`${label} must contain non-empty text or attachments`);
  return { text, attachments };
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

function savePayload(rawPayload) {
  const payload = payloadObject(rawPayload);
  const attachmentId = boundedTarget(payload.attachmentId, 'payload.attachmentId');
  if (typeof payload.outputPath !== 'string' || !payload.outputPath || payload.outputPath.length > 4_096 || !path.isAbsolute(payload.outputPath)) {
    throw new Error('payload.outputPath must be an absolute path with at most 4096 characters');
  }
  return { attachmentId, outputPath: path.normalize(payload.outputPath), overwrite: payload.overwrite === true };
}

async function saveAttachment(messageId, payload) {
  const attachment = listAttachments(messageId, 50).find((item) => item.id === payload.attachmentId || item.localId === payload.attachmentId);
  if (!attachment) throw new Error(`attachment not found for message: ${payload.attachmentId}`);
  if (!attachment.localPath || !attachment.available) throw new Error('attachment is not available as a local regular file');
  const sourceInfo = await lstat(attachment.localPath);
  if (!sourceInfo.isFile()) throw new Error('attachment source must be a regular file');
  if (sourceInfo.size > MAX_ATTACHMENT_BYTES) throw new Error('attachment exceeds 250MB');
  const parent = path.dirname(payload.outputPath);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory()) throw new Error('payload.outputPath parent must be a real directory');
  if (!payload.overwrite && await pathExists(payload.outputPath)) throw new Error('payload.outputPath already exists');
  const temporary = path.join(parent, `.mimi-messages-${process.pid}-${randomUUID()}.part`);
  try {
    await copyFile(attachment.localPath, temporary, fsConstants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    if (payload.overwrite) {
      await rename(temporary, payload.outputPath);
    } else {
      try {
        await link(temporary, payload.outputPath);
      } catch (error) {
        if (error?.code === 'EEXIST') throw new Error('payload.outputPath already exists');
        throw error;
      }
      await rm(temporary, { force: true });
    }
    return { saved: true, messageId, attachment: { ...attachment, localPath: undefined }, path: payload.outputPath, bytes: sourceInfo.size };
  } finally {
    await rm(temporary, { force: true });
  }
}

async function action(message) {
  if (!ACTIONS.has(message.action)) throw new Error(`unsupported action: ${String(message.action)}`);
  const target = boundedTarget(message.target, 'action.target');
  const payload = payloadObject(message.payload);
  if (message.action === 'list_chats') {
    if (!['all', '*'].includes(target)) throw new Error('list_chats target must be all or *');
    return { chats: listChats(limitValue(payload.limit)) };
  }
  if (message.action === 'recent_messages') {
    return { messages: recentMessages(target, limitValue(payload.limit)) };
  }
  if (message.action === 'list_attachments') {
    return { messageId: target, attachments: listAttachments(target, attachmentLimit(payload.limit)) };
  }
  if (message.action === 'save_attachment') return saveAttachment(target, savePayload(payload));
  const outgoing = sendPayload(payload);
  await validateAttachmentFiles(outgoing.attachments);
  return runJxa(target, outgoing);
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type === 'deliver') {
    const target = boundedTarget(message.target, 'deliver.target');
    const payload = typeof message.payload === 'string' ? { text: message.payload } : message.payload;
    const outgoing = sendPayload(payload, 'deliver payload');
    await validateAttachmentFiles(outgoing.attachments);
    await runJxa(target, outgoing);
    return { type: 'delivery_ack', id: message.id, ok: true };
  }
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  return { type: 'action_result', id: message.id, ok: true, result: await action(message) };
}

let polling = false;
let lastPollError = '';
async function poll() {
  if (polling || pollIntervalMs === 0) return;
  polling = true;
  try {
    const cutoff = Date.now() - lookbackHours * 3_600_000;
    const messages = latestIncoming(scanLimit)
      .filter((message) => !message.receivedAt || Date.parse(message.receivedAt) >= cutoff)
      .slice(0, maxEvents)
      .reverse();
    for (const message of messages) {
      write({
        type: 'event', externalId: `message:${hash(message.id)}`, kind: 'alert', priority: 80,
        occurredAt: message.receivedAt,
        actor: { id: String(message.sender || message.chatIdentifier || 'unknown').slice(0, 500) },
        conversation: { id: `messages-${hash(message.chatId).slice(0, 16)}`, threadId: message.chatId },
        replyTarget: message.chatId,
        payload: { type: 'incoming_message', ...message },
      });
    }
    updateReadiness({ inbound: 'ready' });
    lastPollError = '';
  } catch (error) {
    const reason = errorText(error);
    updateReadiness({ inbound: 'unavailable' });
    if (reason !== lastPollError) process.stderr.write(`[macos-messages] poll failed: ${reason}\n`);
    lastPollError = reason;
  } finally {
    polling = false;
  }
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-messages] input exceeded 1MB; resetting buffer\n');
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
