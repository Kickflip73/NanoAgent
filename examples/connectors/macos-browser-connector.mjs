#!/usr/bin/env node

/**
 * MimiAgent ↔ Safari/Google Chrome connector.
 * Uses each browser's installed JXA scripting interface without a shell or npm dependencies.
 */

import { spawn } from 'node:child_process';

const osascript = process.env.MACOS_OSASCRIPT || '/usr/bin/osascript';
const openCommand = process.env.MACOS_OPEN_BIN || '/usr/bin/open';
const commandTimeoutMs = numberEnv('MACOS_BROWSER_COMMAND_TIMEOUT_MS', 20_000, 100, 120_000);
const ACTIONS = new Set([
  'list_tabs',
  'active_tab',
  'open_tab',
  'navigate_tab',
  'activate_tab',
  'close_tab',
  'reload_tab',
  'page_text',
  'execute_javascript',
]);
const BROWSERS = {
  safari: { openApplication: 'Safari' },
  chrome: { openApplication: 'Google Chrome' },
};

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
function browserName(browser) { return browser === 'safari' ? 'Safari' : 'Google Chrome'; }
function appFor(browser) { return Application(browserName(browser)); }
function tabItem(browser, window, tab, windowIndex, tabIndex, activeIndex) {
  return {
    ref: browser + ':' + windowIndex + ':' + tabIndex,
    browser: browser,
    windowIndex: windowIndex,
    tabIndex: tabIndex,
    title: String(safe(function() { return browser === 'safari' ? tab.name() : tab.title(); }, '')),
    url: String(safe(function() { return tab.url(); }, '')),
    active: browser === 'safari'
      ? Boolean(safe(function() { return tab.visible(); }, tabIndex === activeIndex))
      : tabIndex === activeIndex,
    loading: browser === 'chrome' ? Boolean(safe(function() { return tab.loading(); }, false)) : undefined
  };
}
function list(browser, limit) {
  var app = appFor(browser);
  var windows = safe(function() { return app.windows(); }, []);
  var tabs = [];
  var total = 0;
  for (var wi = 0; wi < windows.length; wi += 1) {
    var window = windows[wi];
    var windowTabs = safe(function() { return window.tabs(); }, []);
    var activeIndex = browser === 'chrome'
      ? Number(safe(function() { return window.activeTabIndex(); }, 1))
      : Number(safe(function() { return window.currentTab().index(); }, 1));
    total += windowTabs.length;
    for (var ti = 0; ti < windowTabs.length && tabs.length < limit; ti += 1) {
      tabs.push(tabItem(browser, window, windowTabs[ti], wi + 1, ti + 1, activeIndex));
    }
  }
  return { tabs: tabs, total: total, truncated: total > tabs.length };
}
function resolve(ref) {
  var parts = ref.split(':');
  if (parts.length !== 3) throw new Error('invalid tab reference: ' + ref);
  var browser = parts[0];
  var windowIndex = Number(parts[1]);
  var tabIndex = Number(parts[2]);
  var app = appFor(browser);
  var windows = app.windows();
  if (windowIndex < 1 || windowIndex > windows.length) throw new Error('browser window no longer exists: ' + ref);
  var window = windows[windowIndex - 1];
  var tabs = window.tabs();
  if (tabIndex < 1 || tabIndex > tabs.length) throw new Error('browser tab no longer exists: ' + ref);
  return { browser: browser, app: app, window: window, tab: tabs[tabIndex - 1], windowIndex: windowIndex, tabIndex: tabIndex };
}
function active(browser) {
  var app = appFor(browser);
  var windows = app.windows();
  if (!windows.length) throw new Error(browserName(browser) + ' has no windows');
  var window = windows[0];
  var tabIndex = browser === 'chrome' ? Number(window.activeTabIndex()) : Number(window.currentTab().index());
  var tabs = window.tabs();
  if (!tabs.length) throw new Error(browserName(browser) + ' has no tabs');
  return tabItem(browser, window, tabs[tabIndex - 1], 1, tabIndex, tabIndex);
}
function execute(target, script) {
  return target.browser === 'safari'
    ? target.app.doJavaScript(script, { in: target.tab })
    : target.tab.execute({ javascript: script });
}
function boundedResult(value, maxChars) {
  if (value === undefined) return { value: null, valueType: 'undefined', truncated: false };
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return { value: value, valueType: value === null ? 'null' : typeof value, truncated: false };
  }
  if (typeof value === 'string') {
    return { value: value.slice(0, maxChars), valueType: 'string', charCount: value.length, truncated: value.length > maxChars };
  }
  var encoded;
  try { encoded = JSON.stringify(value); } catch (_) { encoded = String(value); }
  if (encoded === undefined) encoded = String(value);
  if (encoded.length <= maxChars) {
    try { return { value: JSON.parse(encoded), valueType: 'json', charCount: encoded.length, truncated: false }; } catch (_) {}
  }
  return { value: encoded.slice(0, maxChars), valueType: 'serialized', charCount: encoded.length, truncated: encoded.length > maxChars };
}
function run(argv) {
  var action = argv[0];
  var target = argv[1];
  var p = payload(argv[2]);
  if (action === 'list_tabs') {
    var browsers = target === 'all' ? ['safari', 'chrome'] : [target];
    var combined = [];
    var total = 0;
    var unavailable = [];
    for (var i = 0; i < browsers.length; i += 1) {
      try {
        var remaining = Math.max(0, p.limit - combined.length);
        var result = list(browsers[i], remaining);
        combined = combined.concat(result.tabs);
        total += result.total;
      } catch (error) {
        unavailable.push({ browser: browsers[i], error: String(error.message || error) });
      }
    }
    return json({ tabs: combined, total: total, truncated: total > combined.length, unavailable: unavailable, untrusted: true });
  }
  if (action === 'active_tab') return json({ tab: active(target), untrusted: true });
  var resolved = resolve(target);
  if (action === 'navigate_tab') {
    resolved.tab.url = p.url;
    return json({ navigated: true, ref: target, url: p.url });
  }
  if (action === 'activate_tab') {
    if (resolved.browser === 'safari') resolved.window.currentTab = resolved.tab;
    else resolved.window.activeTabIndex = resolved.tabIndex;
    resolved.app.activate();
    return json({ activated: true, ref: target });
  }
  if (action === 'close_tab') {
    resolved.tab.close();
    return json({ closed: true, ref: target });
  }
  if (action === 'reload_tab') {
    if (resolved.browser === 'safari') resolved.tab.url = String(resolved.tab.url());
    else resolved.tab.reload();
    return json({ reloaded: true, ref: target });
  }
  if (action === 'page_text') {
    var text = resolved.browser === 'safari'
      ? String(safe(function() { return resolved.tab.text(); }, ''))
      : String(execute(resolved, 'document.body ? document.body.innerText : ""') || '');
    return json({ ref: target, url: String(safe(function() { return resolved.tab.url(); }, '')), text: text.slice(0, p.maxChars), charCount: text.length, truncated: text.length > p.maxChars, untrusted: true });
  }
  if (action === 'execute_javascript') {
    var execution = boundedResult(execute(resolved, p.script), p.maxResultChars);
    execution.ref = target;
    execution.url = String(safe(function() { return resolved.tab.url(); }, ''));
    execution.untrusted = true;
    return json(execution);
  }
  throw new Error('unsupported action: ' + action);
}`;

function numberEnv(name, fallback, minimum, maximum) {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
  process.stderr.write(`[macos-browser] invalid ${name}; using ${fallback}\n`);
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
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function browser(value, allowAll = false) {
  if (value === 'safari' || value === 'chrome' || (allowAll && value === 'all')) return value;
  throw new Error(`target must be ${allowAll ? 'all, safari, or chrome' : 'safari or chrome'}`);
}

function tabRef(value) {
  const match = /^(safari|chrome):([1-9]\d{0,5}):([1-9]\d{0,5})$/.exec(value);
  if (!match) throw new Error('target must be a tab ref like safari:1:1 or chrome:1:1');
  return value;
}

function url(value) {
  const parsed = boundedString(value, 'payload.url', 8_000, true);
  try {
    const protocol = new URL(parsed).protocol;
    if (!['http:', 'https:'].includes(protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new Error('payload.url must be an absolute http or https URL');
  }
  return parsed;
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  const payload = payloadObject(rawPayload);
  if (action === 'list_tabs') return { target: browser(target, true), payload: { limit: integer(payload.limit, 'payload.limit', 1, 500, 100) } };
  if (action === 'active_tab') return { target: browser(target), payload: {} };
  if (action === 'open_tab') return { target: browser(target), payload: { url: url(payload.url), active: payload.active !== false } };
  const ref = tabRef(target);
  if (action === 'navigate_tab') return { target: ref, payload: { url: url(payload.url) } };
  if (action === 'page_text') return { target: ref, payload: { maxChars: integer(payload.maxChars, 'payload.maxChars', 1, 200_000, 40_000) } };
  if (action === 'execute_javascript') {
    return {
      target: ref,
      payload: {
        script: boundedString(payload.script, 'payload.script', 40_000, true),
        maxResultChars: integer(payload.maxResultChars, 'payload.maxResultChars', 1, 500_000, 100_000),
      },
    };
  }
  return { target: ref, payload: {} };
}

function runProcess(command, args, output = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', output ? 'pipe' : 'ignore', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, commandTimeoutMs);
    if (output) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > 1_000_000) { overflow = true; child.kill('SIGKILL'); return; }
        stdout += chunk;
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`command timed out after ${commandTimeoutMs}ms`));
      if (overflow) return reject(new Error('command output exceeds 1000000 bytes'));
      if (code !== 0) return reject(new Error((stderr || `command exited code=${code} signal=${signal || 'none'}`).trim()));
      resolve(stdout);
    });
  });
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const valid = validate(message.action, message.target, message.payload);
  if (message.action === 'open_tab') {
    const descriptor = BROWSERS[valid.target];
    const args = valid.payload.active
      ? ['-a', descriptor.openApplication, valid.payload.url]
      : ['-g', '-a', descriptor.openApplication, valid.payload.url];
    await runProcess(openCommand, args, false);
    return { type: 'action_result', id: message.id, ok: true, result: { opened: true, browser: valid.target, url: valid.payload.url, active: valid.payload.active } };
  }
  const stdout = await runProcess(osascript, ['-l', 'JavaScript', '-e', ACTION_SCRIPT, message.action, valid.target, JSON.stringify(valid.payload)]);
  let result;
  try { result = stdout.trim() ? JSON.parse(stdout.trim()) : null; }
  catch { throw new Error(`osascript returned invalid JSON: ${stdout.slice(0, 500)}`); }
  return { type: 'action_result', id: message.id, ok: true, result };
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-browser] input exceeded 1MB; resetting buffer\n');
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

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
