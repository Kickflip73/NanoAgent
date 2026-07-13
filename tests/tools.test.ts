import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLocalFile, runShellCommand, writeLocalFile } from '../src/tools.js';

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

test('runs shell commands in the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  const result = await runShellCommand(root, 'pwd', 5);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), await realpath(root));
});
