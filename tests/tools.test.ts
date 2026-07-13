import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  editLocalFile,
  moveLocalFile,
  readLocalFile,
  requestUrl,
  runShellCommand,
  searchLocalFiles,
  writeLocalFile,
} from '../src/tools.js';

test('reads files using relative and absolute paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  const target = path.join(root, 'note.txt');
  await writeFile(target, '你好，Agent');

  assert.equal(await readLocalFile(root, 'note.txt'), '你好，Agent');
  assert.equal(await readLocalFile('/', target), '你好，Agent');
});

test('creates parent directories and writes files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  await writeLocalFile(root, 'output/note.txt', 'done');

  assert.equal(await readFile(path.join(root, 'output/note.txt'), 'utf8'), 'done');
});

test('edits, searches and moves local files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  await writeFile(path.join(root, 'note.txt'), 'NanoAgent uses TypeScript.');

  assert.deepEqual(
    await editLocalFile(root, 'note.txt', 'TypeScript', 'Node.js'),
    { path: path.join(root, 'note.txt'), replacements: 1 },
  );
  const matches = await searchLocalFiles(root, 'Node.js');
  assert.equal(matches[0]?.path, 'note.txt');
  assert.equal(matches[0]?.line, 1);
  assert.deepEqual(
    await moveLocalFile(root, 'note.txt', 'docs/moved.txt'),
    { from: path.join(root, 'note.txt'), to: path.join(root, 'docs/moved.txt') },
  );
  assert.equal(await readFile(path.join(root, 'docs/moved.txt'), 'utf8'), 'NanoAgent uses Node.js.');
});

test('sends HTTP requests with the dedicated tool helper', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ method: request.method, ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const result = await requestUrl(`http://127.0.0.1:${address.port}/health`, 'GET', {}, undefined, 5);
    assert.equal(result.status, 200);
    assert.match(result.body, /"ok":true/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('runs shell commands in the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  const result = await runShellCommand(root, 'pwd', 5);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), await realpath(root));
});

test('stops a running shell tool when the Agent task is aborted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runShellCommand(root, 'sleep 10', 30, controller.signal);
  setTimeout(() => controller.abort(), 30);
  const result = await running;

  assert.equal(result.exitCode, 1);
  assert.ok(Date.now() - startedAt < 2_000);
});
