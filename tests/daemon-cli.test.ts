import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { daemonHelp, runDaemonCommand } from '../src/daemon/cli.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';

const config: AppConfig = {
  provider: 'openai', workspaceRoot: '/tmp/workspace', dataRoot: '/tmp/data',
  daemonDataRoot: '/tmp/mimi-cli-test', skillsRoot: '/tmp/skills', mcpConfig: '/tmp/mcp.json',
  historyLimit: 40, maxTurns: 200,
};

test('daemon maintenance help exposes diagnostics without advertising alternate startup paths', async () => {
  assert.match(daemonHelp(), /mimi daemon attention/);
  assert.match(daemonHelp(), /mimi daemon doctor/);
  assert.match(daemonHelp(), /mimi daemon diagnostics/);
  assert.match(daemonHelp(), /mimi daemon backup/);
  assert.match(daemonHelp(), /mimi daemon restore/);
  assert.doesNotMatch(daemonHelp(), /daemon (?:init|run|start|install)(?:\s|$)/);
  let output = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runDaemonCommand(config, ['help']);
  } finally {
    process.stdout.write = write;
  }
  assert.match(output, /daemon digest/);
  assert.match(output, /daemon connectors/);
  await assert.rejects(runDaemonCommand(config, ['submit']), /请提供要提交的任务/);
  await assert.rejects(runDaemonCommand(config, ['schedule', 'every', 'tomorrow', 'task']), /周期格式/);
  await assert.rejects(runDaemonCommand(config, ['not-a-command']), /未知 MimiAgent 命令/);
});

test('daemon connectors command requests capability status and reload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cli-connectors-'));
  const localConfig = { ...config, daemonDataRoot: root };
  const methods: string[] = [];
  const server = new MimiIpcServer(path.join(root, 'mimi.sock'), async (method, params) => {
    methods.push(method);
    assert.deepEqual(params, {});
    return [{ id: 'fixture', online: true, actions: [{ name: 'send_message' }] }];
  });
  await server.start();
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    await runDaemonCommand(localConfig, ['connectors']);
    await runDaemonCommand(localConfig, ['connectors', 'reload']);
  } finally {
    process.stdout.write = write;
    await server.close();
  }
  assert.deepEqual(methods, ['connectors.list', 'connectors.reload']);
});

test('daemon schedule list drains every bounded summary page', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cli-schedules-'));
  const localConfig = { ...config, daemonDataRoot: root };
  const offsets: number[] = [];
  const revisions: Array<string | undefined> = [];
  const server = new MimiIpcServer(path.join(root, 'mimi.sock'), (_method, params) => {
    const request = params as { offset: number; revision?: string };
    const offset = Number(request.offset);
    offsets.push(offset);
    revisions.push(request.revision);
    return offset === 0
      ? { items: [{ id: 'schedule-1' }], nextOffset: 1, revision: 'revision-1', total: 2 }
      : { items: [{ id: 'schedule-2' }], revision: 'revision-1', total: 2 };
  });
  await server.start();
  let stdout = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await runDaemonCommand(localConfig, ['schedule', 'list']);
  } finally {
    process.stdout.write = write;
    await server.close();
  }
  assert.deepEqual(offsets, [0, 1]);
  assert.deepEqual(revisions, [undefined, 'revision-1']);
  assert.deepEqual(JSON.parse(stdout), [{ id: 'schedule-1' }, { id: 'schedule-2' }]);
});
