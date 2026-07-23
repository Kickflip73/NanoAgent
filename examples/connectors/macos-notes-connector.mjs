#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS Notes connector.
 * Action-only, dependency-free access through the Notes.app JXA dictionary.
 */

import { spawn } from 'node:child_process';

const ACTIONS = new Set([
  'list_folders', 'search_notes', 'read_note', 'create_note', 'update_note', 'append_note',
]);
const osascript = process.env.MACOS_NOTES_OSASCRIPT || '/usr/bin/osascript';

const NOTES_SCRIPT = String.raw`
function string(value) { return value === null || value === undefined ? '' : String(value); }
function iso(value) { return value ? new Date(value).toISOString() : null; }
function escapeHtml(value) {
  return string(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/\r?\n/g, '<br>');
}
function render(value, format) { return format === 'html' ? string(value) : escapeHtml(value); }
function folderInfo(folder) {
  var parent = null;
  try {
    var container = folder.container();
    parent = { id: string(container.id()).slice(0, 1000), name: string(container.name()).slice(0, 1000) };
  } catch (_) {}
  return { id: string(folder.id()).slice(0, 1000), name: string(folder.name()).slice(0, 1000), shared: Boolean(folder.shared()), container: parent };
}
function attachments(note) {
  try {
    return note.attachments().slice(0, 20).map(function(item) {
      return {
        id: string(item.id()).slice(0, 1000), name: string(item.name()).slice(0, 1000), shared: Boolean(item.shared()),
        createdAt: iso(item.creationDate()), modifiedAt: iso(item.modificationDate())
      };
    });
  } catch (_) { return []; }
}
function noteInfo(note, detail, format, bodyLimit) {
  var folder = null;
  try { folder = folderInfo(note.container()); } catch (_) {}
  var result = {
    id: string(note.id()).slice(0, 1000), title: string(note.name()).slice(0, 1000), folder: folder,
    createdAt: iso(note.creationDate()), modifiedAt: iso(note.modificationDate()),
    passwordProtected: Boolean(note.passwordProtected()), shared: Boolean(note.shared()),
    attachments: detail ? attachments(note) : []
  };
  if (!detail) {
    try { result.preview = string(note.plaintext()).slice(0, 2000); } catch (_) { result.preview = ''; }
    return result;
  }
  if (result.passwordProtected) return result;
  try {
    result.bodyFormat = format;
    result.body = string(format === 'html' ? note.body() : note.plaintext()).slice(0, bodyLimit);
  } catch (error) { result.bodyError = string(error); }
  return result;
}
function findNote(app, id) {
  var notes = app.notes();
  for (var i = 0; i < notes.length; i += 1) if (string(notes[i].id()) === id) return notes[i];
  throw new Error('note not found: ' + id);
}
function findFolder(app, id) {
  if (id === 'default') return app.defaultAccount().defaultFolder();
  var folders = app.folders();
  for (var i = 0; i < folders.length; i += 1) if (string(folders[i].id()) === id) return folders[i];
  throw new Error('folder not found: ' + id);
}
function run(argv) {
  var action = argv[0];
  var target = argv[1];
  var payload = JSON.parse(argv[2] || '{}');
  var app = Application('Notes');
  if (action === 'list_folders') {
    var accounts = app.accounts().filter(function(account) {
      return target === 'all' || target === '*' || string(account.id()) === target || string(account.name()) === target;
    }).slice(0, 50);
    if (!accounts.length) throw new Error('account not found: ' + target);
    return JSON.stringify({ accounts: accounts.map(function(account) {
      return {
        id: string(account.id()).slice(0, 1000), name: string(account.name()).slice(0, 1000),
        folders: account.folders().slice(0, 200).map(folderInfo)
      };
    }) });
  }
  if (action === 'search_notes') {
    var query = target === '*' ? '' : target.toLocaleLowerCase();
    var notes = app.notes();
    var matches = [];
    var scanned = Math.min(notes.length, payload.scanLimit);
    for (var i = 0; i < scanned; i += 1) {
      var note = notes[i];
      var info = noteInfo(note, false, 'plain', 2000);
      if (payload.folderId && (!info.folder || info.folder.id !== payload.folderId)) continue;
      var haystack = (info.title + '\n' + info.preview).toLocaleLowerCase();
      if (!query || haystack.indexOf(query) >= 0) matches.push(info);
    }
    matches.sort(function(a, b) { return Date.parse(b.modifiedAt || 0) - Date.parse(a.modifiedAt || 0); });
    return JSON.stringify({ notes: matches.slice(0, payload.limit), scanned: scanned, truncated: notes.length > scanned || matches.length > payload.limit });
  }
  if (action === 'read_note') {
    return JSON.stringify({ note: noteInfo(findNote(app, target), true, payload.bodyFormat, payload.bodyChars) });
  }
  if (action === 'create_note') {
    var folder = findFolder(app, target);
    var created = app.Note({ name: payload.title, body: render(payload.body, payload.bodyFormat) });
    folder.notes.push(created);
    return JSON.stringify({ created: true, note: noteInfo(created, true, payload.bodyFormat, payload.bodyChars) });
  }
  if (action === 'update_note') {
    var updated = findNote(app, target);
    if (Object.prototype.hasOwnProperty.call(payload, 'title')) updated.name = payload.title;
    if (Object.prototype.hasOwnProperty.call(payload, 'body')) updated.body = render(payload.body, payload.bodyFormat);
    return JSON.stringify({ updated: true, note: noteInfo(updated, true, payload.bodyFormat, payload.bodyChars) });
  }
  if (action === 'append_note') {
    var appended = findNote(app, target);
    if (Boolean(appended.passwordProtected())) throw new Error('cannot append to a password-protected note');
    appended.body = string(appended.body()) + render(payload.separator, 'plain') + render(payload.body, payload.bodyFormat);
    return JSON.stringify({ appended: true, note: noteInfo(appended, true, payload.bodyFormat, payload.bodyChars) });
  }
  throw new Error('unsupported action: ' + action);
}`;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function runJxa(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(osascript, ['-l', 'JavaScript', '-e', NOTES_SCRIPT, ...args], {
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

function format(value) {
  const result = value ?? 'plain';
  if (!['plain', 'html'].includes(result)) throw new Error('payload.bodyFormat must be plain or html');
  return result;
}

function integer(value, label, minimum, maximum, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  boundedString(target, 'target', 1000, true);
  const payload = payloadObject(rawPayload);
  if (action === 'list_folders') return {};
  if (action === 'search_notes') {
    const result = {
      limit: integer(payload.limit, 'payload.limit', 1, 100, 20),
      scanLimit: integer(payload.scanLimit, 'payload.scanLimit', 1, 5000, 1000),
    };
    if (payload.folderId !== undefined) result.folderId = boundedString(payload.folderId, 'payload.folderId', 1000, true);
    return result;
  }
  if (action === 'read_note') {
    return {
      bodyFormat: format(payload.bodyFormat),
      bodyChars: integer(payload.bodyChars, 'payload.bodyChars', 1, 50_000, 50_000),
    };
  }
  const bodyFormat = format(payload.bodyFormat);
  const bodyChars = integer(payload.bodyChars, 'payload.bodyChars', 1, 50_000, 50_000);
  if (action === 'create_note') {
    return {
      title: boundedString(payload.title, 'payload.title', 1000, true),
      body: boundedString(payload.body ?? '', 'payload.body', 40_000),
      bodyFormat, bodyChars,
    };
  }
  if (action === 'update_note') {
    const result = { bodyFormat, bodyChars };
    if (payload.title !== undefined) result.title = boundedString(payload.title, 'payload.title', 1000, true);
    if (payload.body !== undefined) result.body = boundedString(payload.body, 'payload.body', 40_000);
    if (result.title === undefined && result.body === undefined) throw new Error('update_note requires title or body');
    return result;
  }
  return {
    body: boundedString(payload.body, 'payload.body', 40_000, true),
    separator: boundedString(payload.separator ?? '\n\n', 'payload.separator', 1000),
    bodyFormat, bodyChars,
  };
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const payload = validate(message.action, message.target, message.payload);
  const result = await runJxa([message.action, message.target, JSON.stringify(payload)]);
  return { type: 'action_result', id: message.id, ok: true, result };
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-notes] input exceeded 1MB; resetting buffer\n');
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
        write({ type: 'action_result', id: message?.id ?? 'invalid', ok: false, error: errorText(error) });
      }
    })();
  }
});
