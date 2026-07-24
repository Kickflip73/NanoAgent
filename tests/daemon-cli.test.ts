import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { daemonHelp, formatDaemonStatus, runDaemonCommand } from '../src/daemon/cli.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';
import { resolveDaemonWorkspaceConfig, stopMimiDaemon } from '../src/daemon/service.js';
import type { DaemonStatus } from '../src/daemon/types.js';

const config: AppConfig = {
  provider: 'openai', workspaceRoot: '/tmp/workspace', dataRoot: '/tmp/data',
  daemonDataRoot: '/tmp/mimi-cli-test', skillsRoot: '/tmp/skills', mcpConfig: '/tmp/mcp.json',
  historyLimit: 40, maxTurns: 200,
};

test('daemon help exposes one-command lifecycle and maintenance operations', async () => {
  assert.match(daemonHelp(), /mimi daemon start/);
  assert.match(daemonHelp(), /mimi daemon stop/);
  assert.match(daemonHelp(), /mimi daemon restart/);
  assert.match(daemonHelp(), /mimi daemon attention/);
  assert.match(daemonHelp(), /mimi daemon doctor/);
  assert.match(daemonHelp(), /mimi daemon diagnostics/);
  assert.match(daemonHelp(), /mimi daemon backup/);
  assert.match(daemonHelp(), /mimi daemon restore/);
  assert.doesNotMatch(daemonHelp(), /daemon (?:init|run|install)(?:\s|$)/);
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

test('daemon status presents an immediate human summary while preserving JSON mode', () => {
  const status = {
    protocolVersion: 9,
    buildVersion: '0.12.0+fixture',
    permissionMode: 'trusted',
    securityProfile: { label: 'Full Owner' },
    pid: 1234,
    startedAt: '2026-07-24T08:00:00.000Z',
    activeEventCount: 0,
    events: { total: 9 },
    tasks: {
      queued: 1, running: 0, paused: 0, blocked: 0, completed: 0,
      failed: 0, cancelled: 0, dead_letter: 0,
    },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 },
    enabledSchedules: 0,
    activeTaskCount: 0,
    taskWorkers: [],
    health: {
      state: 'ready',
      risks: [],
      connectors: {
        enabled: 1, online: 1, ready: 1, offline: [], unavailable: [], stale: [], unknown: [],
      },
    },
    connectorCount: 17,
    attention: {
      quiet: false,
      snooze: { active: false },
      pendingDigest: 0,
    },
    workspaceRoot: '/tmp/workspace',
  } as unknown as DaemonStatus;
  const rendered = formatDaemonStatus(status, Date.parse('2026-07-24T10:05:00.000Z'));
  assert.match(rendered, /状态\s+● 就绪/);
  assert.match(rendered, /PID 1234 · 已运行 2 小时 5 分钟/);
  assert.match(rendered, /Connector\s+已启用 1 · 在线 1 · 就绪 1 · 总配置 17/);
  assert.match(rendered, /任务\s+排队 1/);
  assert.match(rendered, /失败 0 · 死信 0/);
  assert.match(rendered, /没有需要处理的健康风险/);
  assert.match(rendered, /status --json/);
  assert.doesNotMatch(rendered, /"protocolVersion"/);
});

test('daemon status presents retained failures as attention rather than a crashed daemon', () => {
  const status = {
    protocolVersion: 9,
    buildVersion: '0.12.0+fixture',
    permissionMode: 'trusted',
    securityProfile: { label: 'Full Owner' },
    pid: 1234,
    startedAt: '2026-07-24T08:00:00.000Z',
    events: { total: 9 },
    tasks: {
      queued: 0, running: 0, paused: 0, blocked: 0, completed: 0,
      failed: 0, cancelled: 0, dead_letter: 2,
    },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 },
    enabledSchedules: 0,
    health: {
      state: 'unhealthy',
      risks: [{
        code: 'task_dead_letters',
        severity: 'warning',
        message: '2 个任务进入 dead letter',
        nextAction: 'mimi daemon tasks',
      }],
      connectors: {
        enabled: 1, online: 1, ready: 1, offline: [], unavailable: [], stale: [], unknown: [],
      },
    },
    connectorCount: 1,
    workspaceRoot: '/tmp/workspace',
  } as unknown as DaemonStatus;

  const rendered = formatDaemonStatus(status, Date.parse('2026-07-24T10:05:00.000Z'));
  assert.match(rendered, /状态\s+⚠ 需关注/);
  assert.doesNotMatch(rendered, /✕ 异常/);
  assert.match(rendered, /2 个任务进入 dead letter/);
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

test('daemon stop is idempotent when the background service is already offline', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cli-stop-'));
  assert.equal(await stopMimiDaemon({ ...config, daemonDataRoot: root }), false);
});

test('daemon lifecycle commands adopt and persist the running workspace globally', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cli-workspace-'));
  const daemonWorkspace = path.join(root, 'daemon-workspace');
  const localConfig = {
    ...config,
    workspaceRoot: path.join(root, 'unrelated-shell-directory'),
    dataRoot: path.join(root, 'unrelated-shell-directory', '.mimi-agent'),
    daemonDataRoot: root,
    skillsRoot: path.join(root, 'unrelated-shell-directory', 'skills'),
    mcpConfig: path.join(root, 'unrelated-shell-directory', 'mcp.json'),
  };
  const server = new MimiIpcServer(path.join(root, 'mimi.sock'), () => ({
    workspaceRoot: daemonWorkspace,
  }));
  await server.start();
  const live = await resolveDaemonWorkspaceConfig(localConfig);
  await server.close();
  const offline = await resolveDaemonWorkspaceConfig(localConfig);
  assert.equal(live.workspaceRoot, daemonWorkspace);
  assert.equal(offline.workspaceRoot, daemonWorkspace);
  assert.equal(offline.dataRoot, path.join(daemonWorkspace, '.mimi-agent'));
  assert.equal((await stat(path.join(root, 'workspace.json'))).mode & 0o777, 0o600);
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
