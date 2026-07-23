import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

interface ProtocolMessage {
  type: string;
  id?: string;
  ok?: boolean;
  externalId?: string;
  result?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  error?: string;
}

interface MockState {
  clipboard: string;
  reads: number;
}

async function waitFor(
  messages: ProtocolMessage[],
  predicate: (message: ProtocolMessage) => boolean,
  timeoutMs = 12_000,
): Promise<ProtocolMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`message timed out: ${JSON.stringify(messages)}`);
}

async function readState(file: string): Promise<MockState> {
  return JSON.parse(await readFile(file, 'utf8')) as MockState;
}

async function waitForState(file: string, predicate: (state: MockState) => boolean): Promise<MockState> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const state = await readState(file);
      if (predicate(state)) return state;
    } catch {
      // The mock may be replacing its tiny state file between reads.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('mock state timed out');
}

async function setClipboard(file: string, clipboard: string): Promise<void> {
  const current = await readState(file);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...current, clipboard }));
  await rename(temporary, file);
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

test('macOS desktop connector controls apps with argv-only actions and bounded clipboard events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-desktop-connector-'));
  const stateFile = path.join(root, 'state.json');
  const openLog = path.join(root, 'open.json');
  const mockOsascript = path.join(root, 'mock-osascript.mjs');
  const mockOpen = path.join(root, 'mock-open.mjs');
  const watchStateFile = path.join(root, '.mimi-agent', 'daemon', 'desktop-clipboard.json');
  await writeFile(stateFile, JSON.stringify({ clipboard: 'existing clipboard', reads: 0 }));
  await writeFile(mockOsascript, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const stateFile = ${JSON.stringify(stateFile)};
const marker = process.argv.indexOf('-e');
new Function(process.argv[marker + 1]);
const args = process.argv.slice(marker + 2);
const action = args[0];
const target = args[1];
const payload = JSON.parse(args[2] || '{}');
if (target === 'Hang') setTimeout(() => {}, 10000);
else if (target === 'Fail') { process.stderr.write('desktop action failed intentionally'); process.exit(7); }
else if (action === 'clipboard_read') {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.reads += 1;
  writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({
    text: state.clipboard.slice(0, payload.maxChars),
    charCount: state.clipboard.length,
    truncated: state.clipboard.length > payload.maxChars
  }));
} else if (action === 'clipboard_write') {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  state.clipboard = payload.text;
  writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ written: true, charCount: payload.text.length }));
} else {
  process.stdout.write(JSON.stringify({ action, target, payload }));
}
`);
  await writeFile(mockOpen, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const openLog = ${JSON.stringify(openLog)};
const args = process.argv.slice(2);
if (args.at(-1) === 'fail:open') { process.stderr.write('open failed intentionally'); process.exit(9); }
writeFileSync(openLog, JSON.stringify(args));
`);
  await Promise.all([chmod(mockOsascript, 0o755), chmod(mockOpen, 0o755)]);

  const connector = fileURLToPath(new URL('../examples/connectors/macos-desktop-connector.mjs', import.meta.url));
  const connectorEnv = {
      ...process.env,
      HOME: root,
      MACOS_OSASCRIPT: mockOsascript,
      MACOS_OPEN_BIN: mockOpen,
      MACOS_DESKTOP_COMMAND_TIMEOUT_MS: '8000',
      MACOS_DESKTOP_CLIPBOARD_POLL_MS: '1000',
      MACOS_DESKTOP_CLIPBOARD_EVENT_CHARS: '100',
  };
  const child = spawn(process.execPath, [connector], {
    env: connectorEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: ProtocolMessage[] = [];
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
      if (line) messages.push(JSON.parse(line) as ProtocolMessage);
    }
  });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const call = async (id: string, action: string, target: string, payload: unknown): Promise<ProtocolMessage> => {
    child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
    return waitFor(messages, (message) => message.id === id);
  };

  try {
    const baseline = await waitForState(stateFile, (state) => state.reads >= 1);
    assert.equal(messages.filter((message) => message.type === 'event').length, 0);
    const watchStatus = await call('watch-status', 'clipboard_watch_status', 'clipboard', {});
    assert.deepEqual(watchStatus.result, { enabled: true, pollIntervalMs: 1_000 });
    const stoppedWatch = await call('watch-stop', 'clipboard_watch_stop', 'clipboard', {});
    assert.deepEqual(stoppedWatch.result, { enabled: false, pollIntervalMs: 0 });
    assert.deepEqual(JSON.parse(await readFile(watchStateFile, 'utf8')), { pollIntervalMs: 0 });
    const readsBeforeWatchRestart = (await readState(stateFile)).reads;
    const startedWatch = await call('watch-start', 'clipboard_watch_start', 'clipboard', { pollIntervalMs: 750 });
    assert.deepEqual(startedWatch.result, { enabled: true, pollIntervalMs: 750 });
    assert.deepEqual(JSON.parse(await readFile(watchStateFile, 'utf8')), { pollIntervalMs: 750 });
    assert.equal((await stat(watchStateFile)).mode & 0o777, 0o600);
    await waitForState(stateFile, (state) => state.reads > readsBeforeWatchRestart);

    const externalClipboard = `outside text; $(touch /tmp/desktop-never-runs); ${'x'.repeat(120)}`;
    await setClipboard(stateFile, externalClipboard);
    const clipboardEvent = await waitFor(messages, (message) => message.payload?.type === 'clipboard_changed');
    assert.match(clipboardEvent.externalId ?? '', /^clipboard:[0-9a-f]{24}:\d+$/);
    assert.equal(clipboardEvent.payload?.text, externalClipboard.slice(0, 100));
    assert.equal(clipboardEvent.payload?.charCount, externalClipboard.length);
    assert.equal(clipboardEvent.payload?.truncated, true);

    const context = await call('context-1', 'desktop_context', 'all', {
      windowLimit: 7, includeClipboard: true, clipboardChars: 100,
    });
    assert.deepEqual(context.result, {
      action: 'desktop_context', target: 'all',
      payload: { windowLimit: 7, includeClipboard: true, clipboardChars: 100 },
    });
    const apps = await call('apps-1', 'list_apps', 'all', { limit: 3, includeBackground: true });
    assert.deepEqual(apps.result?.payload, { limit: 3, includeBackground: true });
    const windows = await call('windows-1', 'list_windows', 'com.example.App', { limit: 4 });
    assert.deepEqual(windows.result?.payload, { limit: 4 });

    const hostileText = 'hello "desktop"; $(touch /tmp/desktop-keyboard-never-runs)';
    const typed = await call('type-1', 'keyboard_type', 'frontmost', {
      text: hostileText, modifiers: ['command', 'shift', 'command'],
    });
    assert.deepEqual(typed.result, {
      action: 'keyboard_type', target: 'frontmost',
      payload: { text: hostileText, modifiers: ['command down', 'shift down'] },
    });
    const key = await call('key-1', 'keyboard_key', 'Finder', { keyCode: 36, modifiers: ['option'] });
    assert.deepEqual(key.result?.payload, { keyCode: 36, modifiers: ['option down'] });
    const menu = await call('menu-1', 'click_menu', 'Finder', { menu: 'File', item: 'New Window' });
    assert.deepEqual(menu.result?.payload, { menu: 'File', item: 'New Window' });

    const hostileUrl = 'https://example.com/?q=$(touch%20/tmp/desktop-open-never-runs)';
    const hostileApplication = 'Safari; $(touch /tmp/desktop-app-never-runs)';
    const opened = await call('open-1', 'open_item', hostileUrl, { application: hostileApplication });
    assert.equal(opened.ok, true, opened.error);
    assert.deepEqual(opened.result, { opened: true, item: hostileUrl, application: hostileApplication });
    assert.deepEqual(JSON.parse(await readFile(openLog, 'utf8')), ['-a', hostileApplication, hostileUrl]);

    const read = await call('clipboard-read-1', 'clipboard_read', 'clipboard', { maxChars: 10 });
    assert.equal(read.result?.text, externalClipboard.slice(0, 10));
    const eventCount = messages.filter((message) => message.type === 'event').length;
    const readsBeforeWrite = (await readState(stateFile)).reads;
    const writtenText = 'MimiAgent wrote this';
    const written = await call('clipboard-write-1', 'clipboard_write', 'clipboard', { text: writtenText });
    assert.deepEqual(written.result, { written: true, charCount: writtenText.length });
    await waitForState(stateFile, (state) => state.reads > readsBeforeWrite && state.clipboard === writtenText);
    assert.equal(messages.filter((message) => message.type === 'event').length, eventCount);

    const relative = await call('relative-1', 'open_item', 'relative/file.txt', {});
    assert.equal(relative.ok, false);
    assert.match(relative.error ?? '', /absolute path or URL/);
    const optionInjection = await call('open-option-1', 'open_item', 'https://example.com', { application: '--args' });
    assert.equal(optionInjection.ok, false);
    assert.match(optionInjection.error ?? '', /must not start with/);
    const badModifier = await call('modifier-1', 'keyboard_type', 'frontmost', { text: 'x', modifiers: ['super'] });
    assert.equal(badModifier.ok, false);
    assert.match(badModifier.error ?? '', /unsupported modifier/);
    const badKey = await call('key-2', 'keyboard_key', 'frontmost', { keyCode: 999 });
    assert.equal(badKey.ok, false);
    assert.match(badKey.error ?? '', /between 0 and 255/);
    const missingMenu = await call('menu-2', 'click_menu', 'Finder', { menu: 'File' });
    assert.equal(missingMenu.ok, false);
    assert.match(missingMenu.error ?? '', /payload.item/);
    const failed = await call('failure-1', 'activate_app', 'Fail', {});
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /failed intentionally/);
    const timedOut = await call('timeout-1', 'activate_app', 'Hang', {});
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error ?? '', /timed out after 8000ms/);
    const unknown = await call('unknown-1', 'move_mouse', 'frontmost', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);
    assert.ok(baseline.reads >= 1);
    assert.ok(stderr === '' || stderr === '[macos-desktop] clipboard poll failed: osascript timed out after 8000ms\n');

    const finalStop = await call('watch-stop-final', 'clipboard_watch_stop', 'clipboard', {});
    assert.deepEqual(finalStop.result, { enabled: false, pollIntervalMs: 0 });
    await stop(child);
    const restarted = spawn(process.execPath, [connector], { env: connectorEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const restartedMessages: ProtocolMessage[] = [];
    let restartedStdout = '';
    restarted.stdout.setEncoding('utf8');
    restarted.stdout.on('data', (chunk: string) => {
      restartedStdout += chunk;
      while (restartedStdout.includes('\n')) {
        const newline = restartedStdout.indexOf('\n');
        const line = restartedStdout.slice(0, newline).trim();
        restartedStdout = restartedStdout.slice(newline + 1);
        if (line) restartedMessages.push(JSON.parse(line) as ProtocolMessage);
      }
    });
    try {
      restarted.stdin.write(`${JSON.stringify({
        type: 'action', id: 'restarted-status', action: 'clipboard_watch_status', target: 'clipboard', payload: {},
      })}\n`);
      const restored = await waitFor(restartedMessages, (message) => message.id === 'restarted-status');
      assert.deepEqual(restored.result, { enabled: false, pollIntervalMs: 0 });
    } finally {
      await stop(restarted);
    }
  } finally {
    await stop(child);
  }
});

test('macOS desktop state loads from the canonical MimiAgent daemon directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-desktop-state-'));
  const stateFile = path.join(root, '.mimi-agent', 'daemon', 'desktop-clipboard.json');
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ pollIntervalMs: 750 }));
  const mockOsascript = path.join(root, 'mock-osascript.mjs');
  await writeFile(mockOsascript, `#!/usr/bin/env node
const marker = process.argv.indexOf('-e');
const action = process.argv[marker + 2];
if (action === 'clipboard_read') process.stdout.write(JSON.stringify({ text: '', charCount: 0, truncated: false }));
else process.stdout.write('{}');
`);
  await chmod(mockOsascript, 0o755);
  const connector = fileURLToPath(new URL('../examples/connectors/macos-desktop-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: { ...process.env, HOME: root, MACOS_OSASCRIPT: mockOsascript },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: ProtocolMessage[] = [];
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as ProtocolMessage);
    }
  });
  try {
    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'state-status', action: 'clipboard_watch_status', target: 'clipboard', payload: {},
    })}\n`);
    const status = await waitFor(messages, (message) => message.id === 'state-status');
    assert.deepEqual(status.result, { enabled: true, pollIntervalMs: 750 });
  } finally {
    await stop(child);
  }
});
