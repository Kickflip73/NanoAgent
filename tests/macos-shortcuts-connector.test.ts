import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

async function waitFor(messages: Message[], id: string, timeoutMs = 5_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find((message) => message.id === id);
    if (found) return found;
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

test('macOS Shortcuts connector lists and runs shortcuts with bounded argv-only IO', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'macos-shortcuts-connector-'));
  const mock = path.join(root, 'mock-shortcuts.mjs');
  await writeFile(mock, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'list') {
  process.stdout.write(args.includes('--folders') ? 'Home (folder-home)\\nWork (folder-work)\\n' : 'Morning (shortcut-1)\\nArchive (shortcut-2)\\n');
  process.exit(0);
}
const name = args[1];
if (name === 'Hang') setTimeout(() => {}, 10000);
else if (name === 'Fail') { process.stderr.write('shortcut failed intentionally'); process.exit(7); }
else if (name === 'Large') process.stdout.write('x'.repeat(1000));
else if (name === 'Binary') process.stdout.write(Buffer.from([0, 255, 1, 2]));
else {
  const inputPaths = [];
  let outputPath;
  let outputType;
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === '--input-path') inputPaths.push(args[++i]);
    else if (args[i] === '--output-path') outputPath = args[++i];
    else if (args[i] === '--output-type') outputType = args[++i];
  }
  const result = { name, args, inputPaths, inputs: inputPaths.map((file) => readFileSync(file).toString('base64')), outputPath, outputType };
  if (outputPath) writeFileSync(outputPath, JSON.stringify(result));
  else process.stdout.write(JSON.stringify(result));
}
`);
  await chmod(mock, 0o755);
  const existing = path.join(root, 'existing.txt');
  await writeFile(existing, 'existing input');
  const outputPath = path.join(root, 'shortcut-output.json');
  const connector = fileURLToPath(new URL('../examples/connectors/macos-shortcuts-connector.mjs', import.meta.url));
  const child = spawn(process.execPath, [connector], {
    env: { ...process.env, MACOS_SHORTCUTS_BIN: mock },
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
    return waitFor(messages, id, 7_000);
  };

  try {
    const listed = await call('list-1', 'list_shortcuts', 'Work', { limit: 1 });
    assert.deepEqual(listed.result?.items, ['Morning (shortcut-1)']);
    assert.equal(listed.result?.truncated, true);
    const folders = await call('folders-1', 'list_folders', 'all', {});
    assert.deepEqual(folders.result?.items, ['Home (folder-home)', 'Work (folder-work)']);

    const hostileName = 'Do "Work"; $(touch /tmp/shortcut-never-runs) `whoami`';
    const hostileInput = 'hello; $(touch /tmp/shortcut-input-never-runs)';
    const run = await call('run-1', 'run_shortcut', hostileName, {
      input: hostileInput, inputName: 'request.txt', inputPaths: [existing],
      outputType: 'public.utf8-plain-text', timeoutMs: 2000,
    });
    assert.equal(run.ok, true);
    const output = JSON.parse(String(run.result?.output)) as {
      name: string; args: string[]; inputPaths: string[]; inputs: string[]; outputType: string;
    };
    assert.equal(output.name, hostileName);
    assert.equal(Buffer.from(output.inputs[0] ?? '', 'base64').toString('utf8'), hostileInput);
    assert.equal(Buffer.from(output.inputs[1] ?? '', 'base64').toString('utf8'), 'existing input');
    assert.equal(output.outputType, 'public.utf8-plain-text');
    assert.ok(output.args.includes(hostileName));
    await assert.rejects(access(output.inputPaths[0] ?? ''), /ENOENT/);

    const binary = await call('binary-1', 'run_shortcut', 'Binary', { outputEncoding: 'base64' });
    assert.equal(binary.result?.output, Buffer.from([0, 255, 1, 2]).toString('base64'));
    assert.equal(binary.result?.outputBytes, 4);

    const fileOutput = await call('file-1', 'run_shortcut', 'Write File', {
      input: Buffer.from([1, 2, 3]).toString('base64'), inputEncoding: 'base64',
      outputPath, outputType: 'public.json',
    });
    assert.equal(fileOutput.result?.outputPath, outputPath);
    assert.equal(fileOutput.result?.output, undefined);
    const saved = JSON.parse(await readFile(outputPath, 'utf8')) as { inputs: string[]; outputType: string };
    assert.equal(saved.inputs[0], Buffer.from([1, 2, 3]).toString('base64'));
    assert.equal(saved.outputType, 'public.json');

    const failed = await call('fail-1', 'run_shortcut', 'Fail', {});
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /failed intentionally/);
    const overflow = await call('overflow-1', 'run_shortcut', 'Large', { maxOutputBytes: 100 });
    assert.equal(overflow.ok, false);
    assert.match(overflow.error ?? '', /output exceeds 100 bytes/);
    const timeout = await call('timeout-1', 'run_shortcut', 'Hang', { timeoutMs: 1000 });
    assert.equal(timeout.ok, false);
    assert.match(timeout.error ?? '', /timed out after 1000ms/);

    const relative = await call('relative-1', 'run_shortcut', 'Run', { inputPaths: ['relative.txt'] });
    assert.equal(relative.ok, false);
    assert.match(relative.error ?? '', /absolute path/);
    const badBase64 = await call('base64-1', 'run_shortcut', 'Run', { input: '***', inputEncoding: 'base64' });
    assert.equal(badBase64.ok, false);
    assert.match(badBase64.error ?? '', /valid padded base64/);
    const unknown = await call('unknown-1', 'edit_shortcut', 'Run', {});
    assert.equal(unknown.ok, false);
    assert.match(unknown.error ?? '', /unsupported action/);
    assert.equal(stderr, '');
  } finally {
    await stop(child);
  }
});
