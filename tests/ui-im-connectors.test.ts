import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function invokeConnectorMessages(
  script: string,
  message: object,
  logFile: string,
  mock: string,
): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MIMI_OSASCRIPT_BIN: mock,
        MOCK_ARGS_FILE: logFile,
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`connector exited ${code}`));
      resolve(output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>));
    });
    child.stdin.end(`${JSON.stringify(message)}\n`);
  });
}

async function invokeConnector(script: string, message: object, logFile: string, mock: string): Promise<Record<string, unknown>> {
  const values = await invokeConnectorMessages(script, message, logFile, mock);
  const result = values.find((value) => value.type === 'action_result');
  if (!result) throw new Error('connector did not return action_result');
  return result;
}

test('UI IM fallbacks pass recipient and message as osascript argv and report unconfirmed delivery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nano-ui-im-'));
  const mock = path.join(root, 'mock-osascript.mjs');
  await writeFile(mock, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.MOCK_ARGS_FILE, JSON.stringify(args) + '\\n');\nif (args.some((arg) => arg.includes('return focusedTitle'))) console.log(args.at(-1));\nif (args.some((arg) => arg.includes('return "sent"'))) console.log('sent');\n`, 'utf8');
  await chmod(mock, 0o755);

  try {
    for (const fixture of [
      { script: 'examples/connectors/qq-applescript-connector.mjs', target: 'private:user"quoted' },
      { script: 'examples/connectors/daxiang-applescript-connector.mjs', target: 'single:user"quoted' },
      { script: 'examples/connectors/wechat-applescript-connector.mjs', target: 'contact:user"quoted' },
    ]) {
      const logFile = path.join(root, `${path.basename(fixture.script)}.json`);
      const result = await invokeConnector(fixture.script, {
        type: 'action', id: fixture.script, action: 'send_message', target: fixture.target,
        payload: { text: 'hello "world"\nend tell' },
      }, logFile, mock);
      const calls = (await readFile(logFile, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as string[]);
      const args = calls.slice().reverse().find((call: string[]) => {
        const index = call.indexOf('--');
        return index > 0 && call[index + 2] === 'hello "world"\nend tell';
      });
      assert.ok(args, JSON.stringify(calls));
      const separator = args.indexOf('--');

      assert.ok(separator > 0);
      assert.equal(args[separator + 1], 'user"quoted');
      assert.equal(args[separator + 2], 'hello "world"\nend tell');
      assert.ok(!args.slice(0, separator).some((arg: string) => arg.includes('hello "world"')));
      assert.equal((result.result as Record<string, unknown>).sent, true);
      assert.equal((result.result as Record<string, unknown>).transport, 'ui-automation');
      assert.equal((result.result as Record<string, unknown>).deliveryConfirmed, false);
      if (fixture.script.includes('wechat')) {
        const sendScript = calls.flatMap((call) => call).find((arg) => arg.includes('return "sent"'));
        assert.ok(sendScript);
        assert.match(sendScript, /repeat 20 times/);
        assert.match(sendScript, /message editor did not clear; send result is uncertain/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WeChat fallback is outbound-ready before the app starts because send activates it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mimi-wechat-cold-start-'));
  const mock = path.join(root, 'mock-osascript.mjs');
  const logFile = path.join(root, 'calls.json');
  await writeFile(mock, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_ARGS_FILE, JSON.stringify(args) + '\\n');
const script = args[1] || '';
if (script.includes('set accessibilityReady')) console.log('true\\tfalse');
if (script.includes('return focusedTitle')) console.log(args.at(-1));
if (script.includes('return "sent"')) console.log('sent');
`, 'utf8');
  await chmod(mock, 0o755);

  try {
    const values = await invokeConnectorMessages('examples/connectors/wechat-applescript-connector.mjs', {
      type: 'action', id: 'wechat-cold-start', action: 'send_message', target: 'contact:friend',
      payload: { text: 'hello' },
    }, logFile, mock);
    const initialStatus = values.find((value) => value.type === 'status');
    const result = values.find((value) => value.type === 'action_result');
    assert.deepEqual(initialStatus, {
      type: 'status', inbound: 'unavailable', outbound: 'ready', deliveryConfirmed: false,
    });
    assert.equal(result?.ok, true);
    const calls = (await readFile(logFile, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as string[]);
    const resolveScript = calls
      .flatMap((args) => args)
      .find((arg) => arg.includes('tell application "WeChat" to activate'));
    assert.ok(resolveScript);
    assert.equal(resolveScript.match(/repeat 40 times/g)?.length, 3);
    assert.match(resolveScript, /WeChat did not finish launching/);
    assert.match(resolveScript, /WeChat main window did not become available/);
    assert.match(resolveScript, /WeChat search field did not become available/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('WeChat fallback marks an unverified send as uncertain instead of successful', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mimi-wechat-uncertain-'));
  const mock = path.join(root, 'mock-osascript.mjs');
  const logFile = path.join(root, 'calls.json');
  await writeFile(mock, `#!/usr/bin/env node
const args = process.argv.slice(2);
const script = args[1] || '';
if (script.includes('set accessibilityReady')) console.log('true\\ttrue');
if (script.includes('return focusedTitle')) console.log(args.at(-1));
`, 'utf8');
  await chmod(mock, 0o755);

  try {
    const values = await invokeConnectorMessages('examples/connectors/wechat-applescript-connector.mjs', {
      type: 'deliver', id: 'wechat-uncertain', target: 'contact:friend', payload: { text: 'hello' },
      deadlineAt: Date.now() + 10_000,
    }, logFile, mock);
    const result = values.find((value) => value.type === 'delivery_ack');
    assert.deepEqual(result, {
      type: 'delivery_ack', id: 'wechat-uncertain', ok: false,
      uncertain: true, error: 'WeChat send result is uncertain',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
