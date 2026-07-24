#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS desktop connector.
 * Uses JXA/System Events and /usr/bin/open without a shell or npm dependencies.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const osascript = process.env.MACOS_OSASCRIPT || '/usr/bin/osascript';
const openCommand = process.env.MACOS_OPEN_BIN || '/usr/bin/open';
const commandTimeoutMs = numberEnv('MACOS_DESKTOP_COMMAND_TIMEOUT_MS', 20_000, 100, 120_000);
const clipboardPollDefaultMs = numberEnv('MACOS_DESKTOP_CLIPBOARD_POLL_MS', 0, 250, 86_400_000, true);
const clipboardEventChars = numberEnv('MACOS_DESKTOP_CLIPBOARD_EVENT_CHARS', 8_000, 100, 40_000);
const clipboardStateFile = absolutePath(
  process.env.MACOS_DESKTOP_STATE_FILE || defaultDaemonStateFile('desktop-clipboard.json'),
  'MACOS_DESKTOP_STATE_FILE',
);

function defaultDaemonStateFile(name) {
  const configured = process.env.MIMI_DAEMON_DATA_DIR;
  if (configured) return path.join(expandHome(configured), name);
  return path.join(os.homedir(), '.mimi-agent', 'daemon', name);
}

const ACTIONS = new Set([
  'desktop_context',
  'frontmost_app',
  'list_apps',
  'list_windows',
  'activate_app',
  'open_item',
  'clipboard_read',
  'clipboard_write',
  'clipboard_watch_status',
  'clipboard_watch_start',
  'clipboard_watch_stop',
  'keyboard_type',
  'keyboard_key',
  'click_menu',
]);
const MODIFIERS = new Set(['command', 'option', 'control', 'shift', 'function']);

const ACTION_SCRIPT = String.raw`
function json(value) { return JSON.stringify(value); }
function payload(raw) {
  var value = JSON.parse(raw || '{}');
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('payload must be an object');
  return value;
}
function safe(getter, fallback) {
  try {
    var value = getter();
    return value === undefined || value === null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}
function processes(se) { return se.applicationProcesses(); }
function frontmost(se) {
  var matches = se.applicationProcesses.whose({ frontmost: true })();
  if (!matches.length) throw new Error('frontmost application is unavailable');
  return matches[0];
}
function processFor(se, target) {
  if (target === 'frontmost' || target === '*' || target === 'all') return frontmost(se);
  var all = processes(se);
  for (var i = 0; i < all.length; i += 1) {
    var name = String(safe(function() { return all[i].name(); }, ''));
    var bundle = String(safe(function() { return all[i].bundleIdentifier(); }, ''));
    if (name === target || bundle === target) return all[i];
  }
  throw new Error('application process not found: ' + target);
}
function windowItem(window, index) {
  var position = safe(function() { return window.position(); }, []);
  var size = safe(function() { return window.size(); }, []);
  return {
    index: index,
    title: String(safe(function() { return window.name(); }, '')),
    role: String(safe(function() { return window.role(); }, '')),
    subrole: String(safe(function() { return window.subrole(); }, '')),
    position: Array.isArray(position) ? position.map(Number) : [],
    size: Array.isArray(size) ? size.map(Number) : [],
    visible: Boolean(safe(function() { return window.visible(); }, true))
  };
}
function windowsFor(process, limit) {
  var windows = safe(function() { return process.windows(); }, []);
  var result = [];
  for (var i = 0; i < windows.length && result.length < limit; i += 1) result.push(windowItem(windows[i], i));
  return { windows: result, truncated: windows.length > result.length };
}
function processItem(process) {
  return {
    name: String(safe(function() { return process.name(); }, '')),
    bundleIdentifier: String(safe(function() { return process.bundleIdentifier(); }, '')),
    pid: Number(safe(function() { return process.unixId(); }, 0)),
    frontmost: Boolean(safe(function() { return process.frontmost(); }, false)),
    visible: Boolean(safe(function() { return process.visible(); }, true)),
    backgroundOnly: Boolean(safe(function() { return process.backgroundOnly(); }, false))
  };
}
function clipboard(maxChars) {
  var current = Application.currentApplication();
  current.includeStandardAdditions = true;
  var raw = current.theClipboard();
  if (raw === undefined || raw === null) return { text: '', charCount: 0, truncated: false };
  var text = String(raw);
  return { text: text.slice(0, maxChars), charCount: text.length, truncated: text.length > maxChars };
}
function modifierOptions(values) { return values && values.length ? { using: values } : {}; }
function run(argv) {
  var action = argv[0];
  var target = argv[1];
  var p = payload(argv[2]);
  var se = Application('System Events');
  if (action === 'desktop_context') {
    var contextProcess = frontmost(se);
    var context = { app: processItem(contextProcess) };
    var contextWindows = windowsFor(contextProcess, p.windowLimit);
    context.windows = contextWindows.windows;
    context.windowsTruncated = contextWindows.truncated;
    if (p.includeClipboard) context.clipboard = clipboard(p.clipboardChars);
    return json(context);
  }
  if (action === 'frontmost_app') return json(processItem(frontmost(se)));
  if (action === 'list_apps') {
    var all = processes(se);
    var apps = [];
    var matching = 0;
    for (var i = 0; i < all.length; i += 1) {
      var item = processItem(all[i]);
      if (!p.includeBackground && item.backgroundOnly) continue;
      matching += 1;
      if (apps.length < p.limit) apps.push(item);
    }
    return json({ apps: apps, truncated: matching > apps.length });
  }
  if (action === 'list_windows') {
    var windowProcess = processFor(se, target);
    var windowResult = windowsFor(windowProcess, p.limit);
    return json({ app: processItem(windowProcess), windows: windowResult.windows, truncated: windowResult.truncated });
  }
  if (action === 'activate_app') {
    Application(target).activate();
    return json({ activated: true, application: target });
  }
  if (action === 'clipboard_read') return json(clipboard(p.maxChars));
  if (action === 'clipboard_write') {
    var current = Application.currentApplication();
    current.includeStandardAdditions = true;
    current.setTheClipboardTo(p.text);
    return json({ written: true, charCount: p.text.length });
  }
  if (action === 'keyboard_type') {
    var typeProcess = processFor(se, target);
    typeProcess.frontmost = true;
    se.keystroke(p.text, modifierOptions(p.modifiers));
    return json({ typed: true, application: String(typeProcess.name()), charCount: p.text.length });
  }
  if (action === 'keyboard_key') {
    var keyProcess = processFor(se, target);
    keyProcess.frontmost = true;
    se.keyCode(p.keyCode, modifierOptions(p.modifiers));
    return json({ pressed: true, application: String(keyProcess.name()), keyCode: p.keyCode });
  }
  if (action === 'click_menu') {
    var menuProcess = processFor(se, target);
    menuProcess.frontmost = true;
    var bars = menuProcess.menuBars();
    if (!bars.length) throw new Error('application has no menu bar: ' + target);
    var menuBarItem = bars[0].menuBarItems.byName(p.menu);
    if (!menuBarItem.exists()) throw new Error('menu not found: ' + p.menu);
    var menus = menuBarItem.menus();
    if (!menus.length) throw new Error('menu has no items: ' + p.menu);
    var menuItem = menus[0].menuItems.byName(p.item);
    if (!menuItem.exists()) throw new Error('menu item not found: ' + p.item);
    menuItem.click();
    return json({ clicked: true, application: String(menuProcess.name()), menu: p.menu, item: p.item });
  }
  throw new Error('unsupported action: ' + action);
}`;

function numberEnv(name, fallback, minimum, maximum, allowZero = false) {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  if ((allowZero && value === 0) || (Number.isInteger(value) && value >= minimum && value <= maximum)) return value;
  process.stderr.write(`[macos-desktop] invalid ${name}; using ${fallback}\n`);
  return fallback;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
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

function integer(value, label, minimum, maximum, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function modifiers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) throw new Error('payload.modifiers must contain at most 5 items');
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string' || !MODIFIERS.has(item)) throw new Error(`unsupported modifier: ${String(item)}`);
    return `${item} down`;
  }))];
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function absolutePath(value, label) {
  const expanded = expandHome(boundedString(value, label, 4_000, true));
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(expanded);
}

function openTarget(value) {
  const target = expandHome(boundedString(value, 'target', 4_000, true));
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return target;
  if (!path.isAbsolute(target)) throw new Error('open_item target must be an absolute path or URL');
  return path.normalize(target);
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  boundedString(target, 'target', 4_000, true);
  const payload = payloadObject(rawPayload);
  if (action === 'desktop_context') {
    if (!['all', '*', 'frontmost'].includes(target)) throw new Error('desktop_context target must be all');
    return {
      windowLimit: integer(payload.windowLimit, 'payload.windowLimit', 1, 100, 20),
      includeClipboard: payload.includeClipboard === true,
      clipboardChars: integer(payload.clipboardChars, 'payload.clipboardChars', 1, 20_000, 2_000),
    };
  }
  if (action === 'frontmost_app') {
    if (!['all', '*', 'frontmost'].includes(target)) throw new Error('frontmost_app target must be all');
    return {};
  }
  if (action === 'list_apps') {
    if (!['all', '*'].includes(target)) throw new Error('list_apps target must be all');
    return { limit: integer(payload.limit, 'payload.limit', 1, 500, 100), includeBackground: payload.includeBackground === true };
  }
  if (action === 'list_windows') return { limit: integer(payload.limit, 'payload.limit', 1, 100, 50) };
  if (action === 'activate_app') return {};
  if (action === 'open_item') {
    const application = payload.application === undefined
      ? undefined
      : boundedString(payload.application, 'payload.application', 500, true);
    if (application?.startsWith('-')) throw new Error('payload.application must not start with -');
    return {
      item: openTarget(target),
      application,
    };
  }
  if (action === 'clipboard_read') {
    if (!['clipboard', 'all', '*'].includes(target)) throw new Error('clipboard_read target must be clipboard');
    return { maxChars: integer(payload.maxChars, 'payload.maxChars', 1, 100_000, 40_000) };
  }
  if (action === 'clipboard_write') {
    if (!['clipboard', 'all', '*'].includes(target)) throw new Error('clipboard_write target must be clipboard');
    return { text: boundedString(payload.text, 'payload.text', 100_000) };
  }
  if (action === 'clipboard_watch_status' || action === 'clipboard_watch_stop') {
    if (!['clipboard', 'all', '*'].includes(target)) throw new Error(`${action} target must be clipboard`);
    return {};
  }
  if (action === 'clipboard_watch_start') {
    if (!['clipboard', 'all', '*'].includes(target)) throw new Error('clipboard_watch_start target must be clipboard');
    return {
      pollIntervalMs: integer(
        payload.pollIntervalMs,
        'payload.pollIntervalMs',
        250,
        86_400_000,
        clipboardPollDefaultMs > 0 ? clipboardPollDefaultMs : 2_000,
      ),
    };
  }
  if (action === 'keyboard_type') {
    return { text: boundedString(payload.text, 'payload.text', 20_000, true), modifiers: modifiers(payload.modifiers) };
  }
  if (action === 'keyboard_key') {
    return { keyCode: integer(payload.keyCode, 'payload.keyCode', 0, 255), modifiers: modifiers(payload.modifiers) };
  }
  return {
    menu: boundedString(payload.menu, 'payload.menu', 500, true),
    item: boundedString(payload.item, 'payload.item', 500, true),
  };
}

async function runJxa(action, target, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(osascript, ['-l', 'JavaScript', '-e', ACTION_SCRIPT, action, target, JSON.stringify(payload)], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, commandTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > 1_000_000) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`osascript timed out after ${commandTimeoutMs}ms`));
      if (overflow) return reject(new Error('osascript output exceeds 1000000 bytes'));
      if (code !== 0) return reject(new Error((stderr || `osascript exited code=${code} signal=${signal || 'none'}`).trim()));
      try {
        resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
      } catch {
        reject(new Error(`osascript returned invalid JSON: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

async function runOpen(item, application) {
  return new Promise((resolve, reject) => {
    const args = application ? ['-a', application, item] : [item];
    const child = spawn(openCommand, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, commandTimeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`open timed out after ${commandTimeoutMs}ms`));
      if (code !== 0) return reject(new Error((stderr || `open exited code=${code} signal=${signal || 'none'}`).trim()));
      resolve({ opened: true, item, application });
    });
  });
}

function clipboardHash(text) {
  return createHash('sha256').update(text).digest('hex');
}

let clipboardBaseline = false;
let lastClipboardHash = '';
function rememberClipboard(text) {
  clipboardBaseline = true;
  lastClipboardHash = clipboardHash(text);
}

let clipboardPollMs = 0;
let pollTimer;
let clipboardWatchGeneration = 0;
let clipboardMutation = Promise.resolve();

function clipboardWatchStatus() {
  return { enabled: clipboardPollMs > 0, pollIntervalMs: clipboardPollMs };
}

async function readClipboardPollMs() {
  try {
    const value = JSON.parse(await readFile(clipboardStateFile, 'utf8'));
    if (
      !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'pollIntervalMs')
      || !Number.isInteger(value.pollIntervalMs)
      || (value.pollIntervalMs !== 0 && (value.pollIntervalMs < 250 || value.pollIntervalMs > 86_400_000))
    ) throw new Error('state must contain only pollIntervalMs=0 or an integer from 250 to 86400000');
    await chmod(clipboardStateFile, 0o600);
    return value.pollIntervalMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    process.stderr.write(`[macos-desktop] cannot read clipboard watch state; using environment default: ${errorText(error)}\n`);
    return undefined;
  }
}

async function persistClipboardPollMs(pollIntervalMs) {
  const directory = path.dirname(clipboardStateFile);
  const temporary = `${clipboardStateFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify({ pollIntervalMs })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, clipboardStateFile);
    await chmod(clipboardStateFile, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function configureClipboardWatch(pollIntervalMs) {
  const wasEnabled = clipboardPollMs > 0;
  clipboardWatchGeneration += 1;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  clipboardPollMs = pollIntervalMs;
  if (pollIntervalMs === 0) return;
  if (!wasEnabled) clipboardBaseline = false;
  void pollClipboard();
  pollTimer = setInterval(() => void pollClipboard(), pollIntervalMs);
  pollTimer.unref();
}

function mutateClipboardWatch(pollIntervalMs) {
  const operation = clipboardMutation.then(async () => {
    await persistClipboardPollMs(pollIntervalMs);
    configureClipboardWatch(pollIntervalMs);
    return clipboardWatchStatus();
  });
  clipboardMutation = operation.catch(() => undefined);
  return operation;
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const payload = validate(message.action, message.target, message.payload);
  await clipboardInitialization;
  if (message.action === 'clipboard_watch_status') {
    return { type: 'action_result', id: message.id, ok: true, result: clipboardWatchStatus() };
  }
  if (message.action === 'clipboard_watch_start') {
    return { type: 'action_result', id: message.id, ok: true, result: await mutateClipboardWatch(payload.pollIntervalMs) };
  }
  if (message.action === 'clipboard_watch_stop') {
    return { type: 'action_result', id: message.id, ok: true, result: await mutateClipboardWatch(0) };
  }
  if (message.action === 'open_item') {
    const result = await runOpen(payload.item, payload.application);
    return { type: 'action_result', id: message.id, ok: true, result };
  }
  // A poll already reading the pre-write clipboard must not publish its late
  // result after MimiAgent starts a self-write.
  if (message.action === 'clipboard_write') clipboardWatchGeneration += 1;
  const result = await runJxa(message.action, message.target, payload);
  if (message.action === 'clipboard_write') rememberClipboard(payload.text);
  return { type: 'action_result', id: message.id, ok: true, result };
}

let polling = false;
let lastPollError = '';
async function pollClipboard() {
  if (polling || clipboardPollMs === 0) return;
  const generation = clipboardWatchGeneration;
  polling = true;
  try {
    const result = await runJxa('clipboard_read', 'clipboard', { maxChars: 100_000 });
    if (generation !== clipboardWatchGeneration || clipboardPollMs === 0) return;
    const text = typeof result?.text === 'string' ? result.text : '';
    const hash = clipboardHash(text);
    lastPollError = '';
    if (!clipboardBaseline) {
      clipboardBaseline = true;
      lastClipboardHash = hash;
      return;
    }
    if (hash === lastClipboardHash) return;
    lastClipboardHash = hash;
    const now = new Date().toISOString();
    write({
      type: 'event',
      externalId: `clipboard:${hash.slice(0, 24)}:${Date.now()}`,
      kind: 'ambient',
      priority: 45,
      occurredAt: now,
      payload: {
        type: 'clipboard_changed',
        text: text.slice(0, clipboardEventChars),
        charCount: Number(result?.charCount ?? text.length),
        truncated: Boolean(result?.truncated) || text.length > clipboardEventChars,
      },
    });
  } catch (error) {
    const message = errorText(error);
    if (message !== lastPollError) process.stderr.write(`[macos-desktop] clipboard poll failed: ${message}\n`);
    lastPollError = message;
  } finally {
    polling = false;
  }
}

const clipboardInitialization = (async () => {
  configureClipboardWatch(await readClipboardPollMs() ?? clipboardPollDefaultMs);
})();

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-desktop] input exceeded 1MB; resetting buffer\n');
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

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (pollTimer) clearInterval(pollTimer);
    process.exit(0);
  });
}
