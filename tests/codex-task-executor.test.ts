import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  codexExecutionEnvironment,
  CodexCliTaskExecutor,
  resolveCodexExecutable,
} from '../src/daemon/codex-task-executor.js';

test('Codex executor resolves the CLI from PATH before spawning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-path-'));
  const executable = path.join(root, 'codex');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o755);

  assert.equal(resolveCodexExecutable({ PATH: root }, 'linux'), executable);
  assert.equal(resolveCodexExecutable({ MIMI_CODEX_PATH: '/custom/codex', PATH: '' }, 'linux'), '/custom/codex');
});

test('Codex executor adds the current Node directory to a minimal daemon PATH', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-node-path-'));
  const executable = path.join(root, 'codex');
  await writeFile(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');
`);
  await chmod(executable, 0o755);
  const minimalEnvironment = { PATH: '/usr/bin:/bin' };
  const environment = codexExecutionEnvironment(executable, minimalEnvironment, process.execPath);
  assert.equal(environment.PATH?.split(path.delimiter)[0], path.dirname(process.execPath));

  const result = await new CodexCliTaskExecutor(
    executable,
    minimalEnvironment,
    process.execPath,
  ).execute({
    objective: 'work',
    workspaceRoot: root,
    workspaceAccess: 'read',
  });
  assert.equal(result.exitCode, 0);
});

test('Codex executor parses JSONL progress and returns the resumable thread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-executor-'));
  const fixture = path.join(root, 'codex-fixture.mjs');
  await writeFile(fixture, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'thread-123'})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'implemented and tested'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:4,output_tokens:2}})+'\\n');
`);
  await chmod(fixture, 0o755);
  const events: string[] = [];
  let pid: number | undefined;
  const outputJsonlPath = path.join(root, 'events.jsonl');
  const result = await new CodexCliTaskExecutor(fixture).execute({
    objective: '实现功能',
    successCriteria: '测试通过',
    workspaceRoot: root,
    workspaceAccess: 'write',
    outputJsonlPath,
    onStarted: (startedPid) => { pid = startedPid; },
    onProgress: (event) => { if (typeof event.type === 'string') events.push(event.type); },
  });
  assert.equal(result.threadId, 'thread-123');
  assert.equal(result.answer, 'implemented and tested');
  assert.equal(result.exitCode, 0);
  assert.equal(typeof pid, 'number');
  assert.match(await readFile(outputJsonlPath, 'utf8'), /thread\.started/);
  assert.deepEqual(events, ['thread.started', 'item.completed', 'turn.completed']);
});

test('Codex executor reports a missing CLI as its own terminal failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-missing-'));
  await assert.rejects(new CodexCliTaskExecutor(path.join(root, 'missing-codex')).execute({
    objective: 'work', workspaceRoot: root, workspaceAccess: 'read',
  }), (error: unknown) => (
    error instanceof Error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
    && /Codex CLI 不可用/.test(error.message)
  ));
});
