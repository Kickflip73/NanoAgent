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

async function waitFor(messages: Message[], id: string): Promise<Message> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const message = messages.find((item) => item.id === id);
    if (message) return message;
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

test('macOS browser connector uses argv-only bounded actions for Safari and Chrome', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-browser-connector-'));
  const actionLog = path.join(root, 'action.json');
  const openLog = path.join(root, 'open.json');
  const mockOsascript = path.join(root, 'mock-osascript.mjs');
  const mockOpen = path.join(root, 'mock-open.mjs');
  await writeFile(mockOsascript, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const marker = process.argv.indexOf('-e');
new Function(process.argv[marker + 1]);
const [action, target, rawPayload] = process.argv.slice(marker + 2);
const payload = JSON.parse(rawPayload);
writeFileSync(${JSON.stringify(actionLog)}, JSON.stringify({ action, target, payload }));
if (target === 'chrome:9:9') setTimeout(() => {}, 10000);
else if (target === 'chrome:8:8') { process.stderr.write('browser failed intentionally'); process.exit(7); }
else if (target === 'chrome:7:7') process.stdout.write('not json');
else if (target === 'chrome:6:6') process.stdout.write('x'.repeat(1000001));
else if (action === 'list_tabs') process.stdout.write(JSON.stringify({ tabs: [{ ref: 'safari:1:1', title: 'Inbox', url: 'https://example.com', active: true }], total: 1, truncated: false, unavailable: [], untrusted: true }));
else if (action === 'page_text') process.stdout.write(JSON.stringify({ ref: target, text: 'outside page text'.slice(0, payload.maxChars), charCount: 17, truncated: payload.maxChars < 17, untrusted: true }));
else if (action === 'execute_javascript') process.stdout.write(JSON.stringify({ ref: target, value: payload.script, valueType: 'string', truncated: false, untrusted: true }));
else process.stdout.write(JSON.stringify({ action, target, payload }));
`);
  await writeFile(mockOpen, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(openLog)}, JSON.stringify(process.argv.slice(2)));
`);
  await Promise.all([chmod(mockOsascript, 0o755), chmod(mockOpen, 0o755)]);

  const connector = fileURLToPath(new URL('../examples/connectors/macos-browser-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: {
      ...process.env,
      MACOS_OSASCRIPT: mockOsascript,
      MACOS_OPEN_BIN: mockOpen,
      MACOS_BROWSER_COMMAND_TIMEOUT_MS: '8000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages: Message[] = [];
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line) messages.push(JSON.parse(line) as Message);
    }
  });
  const call = async (id: string, action: string, target: string, payload: unknown): Promise<Message> => {
    child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
    return waitFor(messages, id);
  };

  try {
    const listed = await call('list', 'list_tabs', 'all', { limit: 5 });
    assert.equal(listed.ok, true, listed.error);
    assert.equal(listed.result?.untrusted, true);
    assert.equal((listed.result?.tabs as unknown[]).length, 1);

    const active = await call('active', 'active_tab', 'chrome', {});
    assert.deepEqual(active.result, { action: 'active_tab', target: 'chrome', payload: {} });
    const hostileUrl = 'https://example.com/?q=$(touch%20/tmp/browser-never-runs)';
    const opened = await call('open', 'open_tab', 'safari', { url: hostileUrl, active: false });
    assert.deepEqual(opened.result, { opened: true, browser: 'safari', url: hostileUrl, active: false });
    assert.deepEqual(JSON.parse(await readFile(openLog, 'utf8')), ['-g', '-a', 'Safari', hostileUrl]);

    const navigated = await call('navigate', 'navigate_tab', 'chrome:1:2', { url: hostileUrl });
    assert.deepEqual(navigated.result, { action: 'navigate_tab', target: 'chrome:1:2', payload: { url: hostileUrl } });
    const hostileScript = 'document.body.innerText; $(touch /tmp/browser-script-never-runs)';
    const executed = await call('script', 'execute_javascript', 'safari:1:1', { script: hostileScript, maxResultChars: 123 });
    assert.equal(executed.result?.value, hostileScript);
    assert.deepEqual(JSON.parse(await readFile(actionLog, 'utf8')), {
      action: 'execute_javascript', target: 'safari:1:1', payload: { script: hostileScript, maxResultChars: 123 },
    });
    const text = await call('text', 'page_text', 'chrome:1:1', { maxChars: 7 });
    assert.deepEqual(text.result, { ref: 'chrome:1:1', text: 'outside', charCount: 17, truncated: true, untrusted: true });
    for (const action of ['activate_tab', 'close_tab', 'reload_tab']) {
      const result = await call(action, action, 'safari:2:3', {});
      assert.deepEqual(result.result, { action, target: 'safari:2:3', payload: {} });
    }

    const badBrowser = await call('bad-browser', 'list_tabs', 'firefox', {});
    assert.equal(badBrowser.ok, false);
    assert.match(badBrowser.error ?? '', /all, safari, or chrome/);
    const badRef = await call('bad-ref', 'close_tab', 'chrome:0:1', {});
    assert.equal(badRef.ok, false);
    assert.match(badRef.error ?? '', /tab ref/);
    const badUrl = await call('bad-url', 'navigate_tab', 'chrome:1:1', { url: 'file:///etc/passwd' });
    assert.equal(badUrl.ok, false);
    assert.match(badUrl.error ?? '', /http or https/);
    const longScript = await call('long-script', 'execute_javascript', 'chrome:1:1', { script: 'x'.repeat(40_001) });
    assert.equal(longScript.ok, false);
    assert.match(longScript.error ?? '', /at most 40000/);
    const failure = await call('failure', 'close_tab', 'chrome:8:8', {});
    assert.equal(failure.ok, false);
    assert.match(failure.error ?? '', /failed intentionally/);
    const invalidJson = await call('invalid-json', 'close_tab', 'chrome:7:7', {});
    assert.equal(invalidJson.ok, false);
    assert.match(invalidJson.error ?? '', /invalid JSON/);
    const overflow = await call('overflow', 'close_tab', 'chrome:6:6', {});
    assert.equal(overflow.ok, false);
    assert.match(overflow.error ?? '', /exceeds 1000000 bytes/);
    const timeout = await call('timeout', 'close_tab', 'chrome:9:9', {});
    assert.equal(timeout.ok, false);
    assert.match(timeout.error ?? '', /timed out/);
  } finally {
    await stop(child);
  }
});
