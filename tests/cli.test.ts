import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MimiIpcServer } from '../src/daemon/ipc.js';
import { DAEMON_PROTOCOL_VERSION, type StoredEvent } from '../src/daemon/types.js';

test('prints MimiAgent help and version without requiring an API key', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mimi-cli-help-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  for (const directory of [
    workspace,
    home,
    path.join(workspace, '.mimi-agent'),
    path.join(workspace, '.mimi-agent'),
    path.join(home, '.mimi-agent', 'daemon'),
    path.join(home, '.mimi-agent', 'mimi'),
  ]) mkdirSync(directory, { recursive: true });
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.DEEPSEEK_API_KEY;
  environment.DOTENV_CONFIG_PATH = '/dev/null';
  environment.HOME = home;
  environment.MIMI_WORKSPACE = workspace;

  const help = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--help'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });
  const version = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--version'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });
  const daemonHelp = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'daemon', '--help'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /MimiAgent - 全天候个人 Agent/);
  assert.match(help.stdout, /mimi "任务"/);
  assert.match(help.stdout, /后台服务会自动启动/);
  assert.match(help.stdout, /mimi daemon --help/);
  assert.doesNotMatch(help.stdout, /mimi-agent|mimi-agent|standalone/);
  assert.doesNotMatch(help.stdout, /daemon (?:run|start|install)(?:\s|$)/);
  assert.doesNotMatch(help.stderr, /ExperimentalWarning|node:sqlite/);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
  assert.doesNotMatch(version.stderr, /ExperimentalWarning|node:sqlite/);
  assert.equal(daemonHelp.status, 0, daemonHelp.stderr);
  assert.match(daemonHelp.stdout, /MimiAgent 后台维护/);
  assert.match(daemonHelp.stdout, /mimi daemon status/);
  assert.doesNotMatch(daemonHelp.stdout, /mimi-agent|mimi-agent|standalone/);
  assert.doesNotMatch(daemonHelp.stdout, /daemon (?:run|start|install)(?:\s|$)/);
  assert.doesNotMatch(daemonHelp.stderr, /ExperimentalWarning|node:sqlite/);
});

test('default one-shot CLI talks to the running MimiHost instead of creating a second Agent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-cli-host-'));
  const socket = path.join(root, 'mimi.sock');
  const now = new Date().toISOString();
  const queued: StoredEvent = {
    id: '7007bd4e-e902-4357-8083-8e80b270572c', externalId: 'external', source: 'local-cli',
    kind: 'command', trust: 'owner', payload: { prompt: '同一个 MimiAgent' }, occurredAt: now,
    receivedAt: now, priority: 100, profileId: 'owner', status: 'queued', attempts: 0,
    notBefore: now, createdAt: now, updatedAt: now,
  };
  const methods: string[] = [];
  const server = new MimiIpcServer(socket, (method) => {
    methods.push(method);
    if (method === 'status') return {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      permissionMode: 'trusted',
      pid: 123, startedAt: now, workerId: 'worker',
      workspaceRoot: process.cwd(),
      activeHostMutations: 0,
      events: { queued: 0, running: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
      outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 }, enabledSchedules: 0,
    };
    if (method === 'submit') return { event: queued, inserted: true };
    if (method === 'chat.snapshot') return {
      sessionId: 'mimi-owner-test', provider: 'openai', model: 'fixture', mode: '标准', outputLevel: 'answer',
      workspaceRoot: process.cwd(), contextUsed: 0, contextWindow: 10_000, turns: [],
    };
    if (method === 'event.stream') return {
      events: [{ sequence: 1, eventId: queued.id, kind: 'answer', text: '统一会话已生效' }],
      event: { ...queued, status: 'completed', result: { answer: '统一会话已生效' } },
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MIMI_DATA_DIR: path.join(root, 'runtime'),
    MIMI_DAEMON_DATA_DIR: root,
    DOTENV_CONFIG_PATH: '/dev/null',
  };
  delete environment.OPENAI_API_KEY;
  delete environment.DEEPSEEK_API_KEY;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '同一个', 'MimiAgent'], {
      cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), '统一会话已生效');
    assert.deepEqual(methods, ['status', 'chat.snapshot', 'submit', 'event.stream']);
  } finally {
    await server.close();
  }
});
