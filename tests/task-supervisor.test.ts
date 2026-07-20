import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { MimiAgent } from '../src/runtime/mimi-agent.js';
import { configureAgentRuntime } from '../src/runtime/bootstrap.js';
import { RunContext, type Tool } from '@openai/agents';
import { MimiStore } from '../src/daemon/store.js';
import {
  defaultTaskWorkerEntry,
  TaskProcessSupervisor,
  taskWorkerExecArgv,
  taskWorkerEnvironment,
} from '../src/daemon/task-supervisor.js';
import {
  taskWorkerControlSchema,
  taskWorkerInitSchema,
  taskWorkerOutputSchema,
  restrictedTaskShellEnvironment,
  withTaskProviderCredential,
} from '../src/daemon/worker-protocol.js';
import type { EventEnvelope } from '../src/daemon/types.js';

const inheritedOpenAiApiKey = process.env.OPENAI_API_KEY;
before(() => { process.env.OPENAI_API_KEY = 'task-worker-test-provider-key'; });
after(() => {
  if (inheritedOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = inheritedOpenAiApiKey;
});

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function backgroundTask(
  id: string,
  sequence: number,
  workspaceAccess: 'read' | 'write' = 'write',
): EventEnvelope {
  const timestamp = new Date().toISOString();
  return {
    id,
    externalId: `background-task-${sequence}`,
    source: 'test',
    kind: 'command',
    trust: 'owner',
    payload: { prompt: `execute background task ${sequence}`, workspaceAccess },
    occurredAt: timestamp,
    receivedAt: timestamp,
    priority: 70,
    profileId: 'owner',
    sessionKey: `mimi-task-${id}`,
    executionLane: 'task',
  };
}

test('task worker protocol strictly validates init and observable worker output', () => {
  const taskId = randomUUID();
  const workerToken = randomBytes(32).toString('base64url');
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: '/tmp/workspace',
    dataRoot: '/tmp/data',
    daemonDataRoot: '/tmp/daemon',
    skillsRoot: '/tmp/skills',
    mcpConfig: '/tmp/mcp.json',
    historyLimit: 40,
    maxTurns: 20,
    sessionMaxConcurrency: 2,
  };
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken,
    workspaceAccess: 'write',
    enableMcp: true,
    providerCredential: { provider: 'openai', apiKey: 'task-provider-key' },
    mcpEnvironment: {},
    config,
  }).success, true);
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken,
    workspaceAccess: 'write',
    enableMcp: true,
    providerCredential: { provider: 'openai', apiKey: 'task-provider-key' },
    mcpEnvironment: {},
    config,
    unexpected: true,
  }).success, false);
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken: 'guessable',
    workspaceAccess: 'write',
    enableMcp: true,
    providerCredential: { provider: 'openai', apiKey: 'task-provider-key' },
    mcpEnvironment: {},
    config,
  }).success, false);
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken,
    workspaceAccess: 'write',
    enableMcp: false,
    providerCredential: { provider: 'deepseek', apiKey: 'deepseek-provider-key' },
    embeddingCredential: { provider: 'openai', apiKey: 'openai-embedding-key' },
    mcpEnvironment: {},
    config: { ...config, provider: 'deepseek' },
  }).success, true);
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken,
    workspaceAccess: 'read',
    enableMcp: true,
    providerCredential: { provider: 'openai', apiKey: 'task-provider-key' },
    mcpEnvironment: {},
    config,
  }).success, false);
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken,
    workspaceAccess: 'write',
    enableMcp: false,
    providerCredential: { provider: 'openai', apiKey: 'task-provider-key' },
    mcpEnvironment: { MCP_TASK_SECRET: 'must-not-travel' },
    config,
  }).success, false);
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken,
    workspaceAccess: 'write',
    enableMcp: true,
    providerCredential: { provider: 'deepseek', apiKey: 'wrong-provider-key' },
    mcpEnvironment: {},
    config,
  }).success, false);
  assert.equal(taskWorkerInitSchema.safeParse({
    type: 'init',
    taskId,
    database: '/tmp/mimi.db',
    assistantConfig: '/tmp/MIMI.md',
    socket: '/tmp/mimi.sock',
    workerToken,
    workspaceAccess: 'write',
    enableMcp: true,
    providerCredential: { provider: 'openai', apiKey: 'task-provider-key', extra: true },
    mcpEnvironment: {},
    config,
  }).success, false);
  assert.equal(taskWorkerOutputSchema.safeParse({
    type: 'started',
    taskId,
    workerId: 'fixture-worker',
    pid: process.pid,
  }).success, true);
  assert.equal(taskWorkerOutputSchema.safeParse({
    type: 'heartbeat',
    taskId,
    at: 'not-a-timestamp',
  }).success, false);
  assert.equal(taskWorkerControlSchema.safeParse({
    type: 'pause',
    taskId,
    reason: 'wait for dependency',
  }).success, true);
  assert.equal(taskWorkerControlSchema.safeParse({
    type: 'pause',
    taskId,
    reason: '',
  }).success, false);
});

test('task supervisor pauses, resumes, and cancels a real child-process task', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-control-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const taskId = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-fixture.mjs', import.meta.url));
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
  });

  try {
    store.enqueueEvent(backgroundTask(taskId, 1));
    supervisor.start();
    await waitUntil(
      () => store.getEvent(taskId)?.status === 'running' && supervisor.status()[0]?.workerId !== undefined,
      'task worker did not claim the task',
    );
    const firstPid = supervisor.status()[0]!.pid;
    assert.deepEqual(supervisor.pause(taskId, 'dependency is unavailable'), { state: 'pause_requested' });
    await waitUntil(
      () => store.getEvent(taskId)?.status === 'paused' && supervisor.status().length === 0,
      'task worker did not pause at the control boundary',
    );
    assert.equal(store.getEvent(taskId)?.attempts, 0);

    store.resumeBackgroundTask(taskId, 'dependency is ready');
    await waitUntil(
      () => store.getEvent(taskId)?.status === 'running'
        && supervisor.status()[0]?.workerId !== undefined
        && supervisor.status()[0]?.pid !== firstPid,
      'resumed task did not get a fresh worker process',
    );
    assert.deepEqual(supervisor.cancel(taskId, 'owner cancelled resumed work'), { state: 'cancelled' });
    await waitUntil(
      () => store.getEvent(taskId)?.status === 'archived' && supervisor.status().length === 0,
      'task worker did not cancel the resumed task',
    );
    assert.match(store.getEvent(taskId)?.error ?? '', /owner cancelled/);
  } finally {
    await supervisor.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor durably accepts controls when worker IPC is unavailable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-durable-control-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const cancelId = randomUUID();
  const pauseId = randomUUID();
  const pauseRaceId = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  });

  try {
    store.enqueueEvent(backgroundTask(cancelId, 101));
    store.enqueueEvent(backgroundTask(pauseId, 102));
    store.enqueueEvent(backgroundTask(pauseRaceId, 103));
    const claimedAt = new Date();
    store.claimEventById(cancelId, 'lost-worker-cancel', 1_000, claimedAt);
    store.claimEventById(pauseId, 'lost-worker-pause', 1_000, claimedAt);

    const supervisorWorkers = (supervisor as unknown as { workers: Map<string, unknown> }).workers;
    supervisorWorkers.set(cancelId, {
      child: {
        connected: true,
        send: () => { throw new Error('simulated closed IPC channel'); },
      },
    });
    assert.deepEqual(supervisor.cancel(cancelId, 'cancel survives lost IPC'), { state: 'cancelled' });
    supervisorWorkers.delete(cancelId);
    assert.equal(store.getEvent(cancelId)?.taskControl, 'cancel');
    assert.deepEqual(supervisor.pause(pauseId, 'pause survives lost IPC'), { state: 'pause_requested' });
    assert.equal(store.getEvent(pauseId)?.taskControl, 'pause');

    const pauseQueuedEvent = store.pauseQueuedEvent.bind(store);
    store.pauseQueuedEvent = ((id, reason, at) => {
      if (id === pauseRaceId) {
        store.claimEventById(id, 'worker-that-won-queue-race', 1_000, claimedAt);
        throw new Error('queued state changed');
      }
      return pauseQueuedEvent(id, reason, at);
    }) as MimiStore['pauseQueuedEvent'];
    assert.deepEqual(supervisor.pause(pauseRaceId, 'pause survives queued-to-running race'), {
      state: 'pause_requested',
    });
    assert.equal(store.getEvent(pauseRaceId)?.taskControl, 'pause');
    store.pauseQueuedEvent = pauseQueuedEvent;
    await supervisor.stop();
    store.close();

    const restarted = new MimiStore(database);
    try {
      assert.deepEqual(restarted.readyBackgroundTasks(10, new Date(claimedAt.getTime() + 1_001)), []);
      assert.equal(restarted.getEvent(cancelId)?.status, 'archived');
      assert.equal(restarted.getEvent(cancelId)?.error, 'cancel survives lost IPC');
      assert.equal(restarted.getEvent(pauseId)?.status, 'paused');
      assert.equal(restarted.getEvent(pauseId)?.error, 'pause survives lost IPC');
      assert.equal(restarted.getEvent(pauseRaceId)?.status, 'paused');
      assert.equal(restarted.getEvent(pauseRaceId)?.error, 'pause survives queued-to-running race');
    } finally {
      restarted.close();
    }
  } finally {
    await supervisor.stop();
    try {
      store.close();
    } catch {
      // The restart path already closed this handle.
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('task worker entry follows source/dist extensions and environment redaction is surgical', () => {
  assert.equal(
    defaultTaskWorkerEntry('file:///tmp/src/daemon/task-supervisor.ts'),
    '/tmp/src/daemon/task-worker-entry.ts',
  );
  assert.equal(
    defaultTaskWorkerEntry('file:///tmp/dist/daemon/task-supervisor.js'),
    '/tmp/dist/daemon/task-worker-entry.js',
  );
  assert.deepEqual(taskWorkerEnvironment({
    OPENAI_API_KEY: 'model-secret',
    CONNECTOR_TOKEN: 'connector-secret',
    MIMI_DAEMON_DATA_DIR: '/tmp/daemon',
    DOTENV_CONFIG_PATH: '/tmp/mimi.env',
    MIMI_WORKSPACE: '/tmp/workspace',
    NODE_OPTIONS: '--env-file=/tmp/mimi.env',
    PATH: '/usr/bin',
  }, ['CONNECTOR_TOKEN']), {
    PATH: '/usr/bin',
  });
  assert.deepEqual(restrictedTaskShellEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    LANG: 'zh_CN.UTF-8',
    OPENAI_API_KEY: 'model-secret',
    ACCESS_TOKEN: 'token-secret',
    DB_PASSWORD: 'password-secret',
    SESSION_COOKIE: 'cookie-secret',
    HTTP_AUTHORIZATION: 'auth-secret',
    DATABASE_URL: 'postgres://secret',
    REDIS_URL: 'redis://secret',
    SENTRY_DSN: 'https://secret@sentry.invalid/1',
    MIMI_ENV_FILE: '/tmp/secret.env',
    MIMI_DAEMON_DATA_DIR: '/tmp/daemon',
    MIMI_DAEMON_SOCKET: '/tmp/mimi.sock',
    DOTENV_CONFIG_PATH: '/tmp/secret.env',
    MIMI_CONNECTORS_CONFIG: '/tmp/connectors.json',
    MIMI_ASSISTANT_CONFIG: '/tmp/assistant.json',
    MIMI_MCP_CONFIG: '/tmp/mcp.json',
    MIMI_SKILLS_DIR: '/tmp/skills',
    MIMI_WORKSPACE: '/tmp/workspace',
    AGENT_WORKSPACE: '/tmp/workspace',
    NODE_OPTIONS: '--require dotenv/config',
  }), {
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    LANG: 'zh_CN.UTF-8',
  });
  assert.deepEqual(taskWorkerExecArgv([
    '--import', 'tsx',
    '--env-file', '/tmp/mimi.env',
    '--env-file-if-exists=/tmp/fallback.env',
    '--require', 'dotenv/config',
    '--require=/tmp/node_modules/dotenv/config.js',
    '--enable-source-maps',
  ]), [
    '--import', 'tsx',
    '--enable-source-maps',
  ]);
});

test('provider credential exists only during bounded task runtime initialization', async () => {
  const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
  const observed = await withTaskProviderCredential({
    provider: 'openai',
    apiKey: 'temporary-task-provider-key',
  }, async () => environment.OPENAI_API_KEY, environment);
  assert.equal(observed, 'temporary-task-provider-key');
  assert.equal(environment.OPENAI_API_KEY, undefined);

  environment.DEEPSEEK_API_KEY = 'previous-value';
  await assert.rejects(withTaskProviderCredential({
    provider: 'deepseek',
    apiKey: 'temporary-deepseek-key',
  }, async () => {
    assert.equal(environment.DEEPSEEK_API_KEY, 'temporary-deepseek-key');
    throw new Error('initialization failed');
  }, environment), /initialization failed/);
  assert.equal(environment.DEEPSEEK_API_KEY, 'previous-value');
});

test('a DeepSeek task receives a bounded OpenAI embedding credential without ambient key leakage', {
  timeout: 5_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-deepseek-task-credentials-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const taskId = randomUUID();
  const config: AppConfig = {
    provider: 'deepseek',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-fixture.mjs', import.meta.url));
  const capture = path.join(root, 'worker-init');
  const previous = {
    capture: process.env.TASK_WORKER_INIT_CAPTURE,
    deepseek: process.env.DEEPSEEK_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  const deepseekKey = 'bounded-deepseek-provider-secret';
  const embeddingKey = 'bounded-openai-embedding-secret';
  process.env.TASK_WORKER_INIT_CAPTURE = capture;
  process.env.DEEPSEEK_API_KEY = deepseekKey;
  process.env.OPENAI_API_KEY = embeddingKey;
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
  });

  try {
    store.enqueueEvent(backgroundTask(taskId, 1));
    supervisor.start();
    await waitUntil(() => supervisor.status()[0]?.workerId !== undefined, 'DeepSeek fixture did not start');
    const raw = await readFile(path.join(capture, `${taskId}.json`), 'utf8');
    const captured = JSON.parse(raw) as {
      provider: string;
      providerCredentialPresent: boolean;
      embeddingCredentialPresent: boolean;
      workerEnvironmentProviderKey?: string;
    };
    assert.equal(captured.provider, 'deepseek');
    assert.equal(captured.providerCredentialPresent, true);
    assert.equal(captured.embeddingCredentialPresent, true);
    assert.equal(captured.workerEnvironmentProviderKey, undefined);
    assert.equal(raw.includes(deepseekKey), false);
    assert.equal(raw.includes(embeddingKey), false);
  } finally {
    await supervisor.stop();
    store.close();
    if (previous.capture === undefined) delete process.env.TASK_WORKER_INIT_CAPTURE;
    else process.env.TASK_WORKER_INIT_CAPTURE = previous.capture;
    if (previous.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.deepseek;
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
    await rm(root, { recursive: true, force: true });
  }
});

test('a read Task initializes without a provider secret in steady-state and scopes reads to its workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-read-task-runtime-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await writeFile(path.join(workspace, 'inside.txt'), 'INSIDE');
  await writeFile(path.join(outside, 'outside.txt'), 'OUTSIDE');
  await symlink(outside, path.join(workspace, 'escape'));
  const mcpMarker = path.join(root, 'read-task-mcp-must-not-start.txt');
  const mcpConfig = path.join(workspace, 'mcp.json');
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { forbidden: {
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)}, 'started')`],
  } } }));
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: workspace,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig,
    trustedWorkspaceMcp: workspace,
    historyLimit: 40,
    maxTurns: 20,
    permissionMode: 'trusted',
  };
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let agent: MimiAgent | undefined;
  try {
    agent = await withTaskProviderCredential({
      provider: 'openai',
      apiKey: 'temporary-agent-initialization-key',
    }, async () => {
      configureAgentRuntime(config);
      return MimiAgent.create(config, 'mimi-read-task-test', {
        protectRuntimePathsFromShell: true,
        shellEnvironment: restrictedTaskShellEnvironment(process.env),
        shellDetachedProcessGroup: false,
        restrictReadsToWorkspace: true,
        enableMcp: false,
        releaseMcpEnvironmentAfterConnect: true,
      });
    });
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    await assert.rejects(access(mcpMarker), /ENOENT/);
    const tools = (agent as unknown as { tools: Tool[] }).tools;
    const invoke = async (requestedPath: string) => {
      const read = tools.find((candidate) => candidate.name === 'read_file');
      assert.ok(read && 'invoke' in read);
      return String(await read.invoke(new RunContext({}), JSON.stringify({ path: requestedPath })));
    };
    assert.match(await invoke('inside.txt'), /INSIDE/);
    assert.match(await invoke(path.join(outside, 'outside.txt')), /读取路径不能超出当前工作区/);
    assert.match(await invoke('escape/outside.txt'), /符号链接.*读取范围/);
  } finally {
    await agent?.close();
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('an owner write Task connects a trusted MCP through its one-shot explicit environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-write-task-mcp-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const marker = path.join(root, 'mcp-environment.json');
  const fixture = fileURLToPath(new URL('./fixtures/mcp-environment-fixture.mjs', import.meta.url));
  const mcpConfig = path.join(workspace, 'mcp.json');
  const mcpSecret = 'owner-write-explicit-mcp-secret';
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { explicit: {
    command: process.execPath,
    args: [fixture, marker],
    allowedEnv: ['MCP_TASK_SECRET'],
    env: { INJECTED_MCP_TOKEN: '${MCP_TASK_SECRET}' },
  } } }));
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: workspace,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig,
    trustedWorkspaceMcp: workspace,
    historyLimit: 40,
    maxTurns: 20,
    permissionMode: 'trusted',
  };
  const previousProvider = process.env.OPENAI_API_KEY;
  const previousMcp = process.env.MCP_TASK_SECRET;
  delete process.env.OPENAI_API_KEY;
  delete process.env.MCP_TASK_SECRET;
  const mcpEnvironment: Record<string, string> = { MCP_TASK_SECRET: mcpSecret };
  let agent: MimiAgent | undefined;
  try {
    agent = await withTaskProviderCredential({
      provider: 'openai',
      apiKey: 'temporary-write-task-provider-key',
    }, async () => {
      configureAgentRuntime(config);
      return MimiAgent.create(config, 'mimi-write-task-mcp-test', {
        protectRuntimePathsFromShell: true,
        shellEnvironment: restrictedTaskShellEnvironment(process.env),
        shellDetachedProcessGroup: false,
        mcpEnvironment,
        enableMcp: true,
        releaseMcpEnvironmentAfterConnect: true,
      });
    });
    for (const name of Object.keys(mcpEnvironment)) mcpEnvironment[name] = '';
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.MCP_TASK_SECRET, undefined);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      injected: mcpSecret,
    });
  } finally {
    await agent?.close();
    if (previousProvider === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousProvider;
    if (previousMcp === undefined) delete process.env.MCP_TASK_SECRET;
    else process.env.MCP_TASK_SECRET = previousMcp;
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor runs two queued tasks in distinct OS child processes and stops them cleanly', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const taskIds = [randomUUID(), randomUUID()];
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
    sessionMaxConcurrency: 2,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-fixture.mjs', import.meta.url));
  const capture = path.join(root, 'worker-init');
  const previousCapture = process.env.TASK_WORKER_INIT_CAPTURE;
  const previousSecret = process.env.CONNECTOR_TEST_SECRET;
  process.env.TASK_WORKER_INIT_CAPTURE = capture;
  process.env.CONNECTOR_TEST_SECRET = 'must-not-enter-task-worker';
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 2,
    pollMs: 25,
    workerEntry: fixture,
    redactEnvironmentKeys: ['CONNECTOR_TEST_SECRET'],
  });

  try {
    taskIds.forEach((taskId, index) => {
      assert.equal(store.enqueueEvent(backgroundTask(taskId, index + 1, 'read')).inserted, true);
    });
    supervisor.start();

    await waitUntil(
      () => supervisor.status().length === 2
        && supervisor.status().every((worker) => worker.workerId && worker.heartbeatAt),
      'two observable task worker processes did not start',
    );
    const workers = supervisor.status();
    const pids = workers.map((worker) => worker.pid);
    assert.deepEqual(new Set(workers.map((worker) => worker.taskId)), new Set(taskIds));
    assert.equal(pids.every((pid): pid is number => typeof pid === 'number' && pid > 0), true);
    assert.equal(new Set(pids).size, 2);
    assert.equal(pids.includes(process.pid), false);
    assert.equal(workers.every((worker) => worker.workerId === `fixture-${worker.pid}`), true);
    assert.equal(workers.every((worker) => worker.workspaceAccess === 'read'), true);
    assert.equal(workers.every((worker) => Number.isFinite(Date.parse(worker.spawnedAt))), true);

    const captured = await Promise.all(taskIds.map(async (taskId) => (
      JSON.parse(await readFile(path.join(capture, `${taskId}.json`), 'utf8')) as {
        taskId: string;
        socket: string;
        workerToken: string;
        workspaceAccess: string;
        provider?: string;
        providerCredentialPresent?: boolean;
        workerEnvironmentProviderKey?: string;
        redactedSecret?: string;
      }
    )));
    for (const init of captured) {
      assert.equal(init.socket, path.join(root, 'mimi.sock'));
      assert.equal(init.workerToken.length, 43);
      assert.equal(init.workspaceAccess, 'read');
      assert.equal(init.provider, 'openai');
      assert.equal(init.providerCredentialPresent, true);
      assert.equal(init.workerEnvironmentProviderKey, undefined);
      assert.equal(init.redactedSecret, undefined);
      assert.equal(supervisor.authorizeWorker(init.taskId, init.workerToken), true);
      assert.equal(supervisor.authorizeWorker(init.taskId, randomBytes(32).toString('base64url')), false);
      assert.equal(JSON.stringify(workers).includes(init.workerToken), false);
    }

    await supervisor.stop();
    assert.deepEqual(supervisor.status(), []);
  } finally {
    await supervisor.stop();
    store.close();
    if (previousCapture === undefined) delete process.env.TASK_WORKER_INIT_CAPTURE;
    else process.env.TASK_WORKER_INIT_CAPTURE = previousCapture;
    if (previousSecret === undefined) delete process.env.CONNECTOR_TEST_SECRET;
    else process.env.CONNECTOR_TEST_SECRET = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor survives a transient store fault and launches work on the next pump', {
  timeout: 5_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-pump-recovery-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const taskId = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-fixture.mjs', import.meta.url));
  const originalReady = store.readyBackgroundTasks.bind(store);
  let readyCalls = 0;
  store.readyBackgroundTasks = ((limit, at) => {
    readyCalls += 1;
    if (readyCalls === 1) throw new Error('simulated transient SQLite fault');
    return originalReady(limit, at);
  }) as MimiStore['readyBackgroundTasks'];
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
  });

  try {
    store.enqueueEvent(backgroundTask(taskId, 1, 'read'));
    supervisor.start();
    await waitUntil(
      () => supervisor.status()[0]?.workerId !== undefined,
      'task supervisor did not recover after a transient store fault',
    );
    assert.ok(readyCalls >= 2);
    assert.equal(supervisor.status()[0]?.taskId, taskId);
  } finally {
    await supervisor.stop();
    store.readyBackgroundTasks = originalReady;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor sends MCP secrets only to write tasks with a verified owner conversation root', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-mcp-bundle-'));
  const database = path.join(root, 'mimi.db');
  const mcpConfig = path.join(root, 'mcp.json');
  const store = new MimiStore(database);
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig,
    trustedWorkspaceMcp: root,
    historyLimit: 40,
    maxTurns: 20,
  };
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { trusted: {
    command: process.execPath,
    allowedEnv: ['MCP_TASK_VALUE', 'PATH'],
    env: { TOKEN: '${MCP_TASK_VALUE}' },
  } } }));
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-fixture.mjs', import.meta.url));
  const capture = path.join(root, 'worker-init');
  const secret = 'owner-write-task-mcp-secret';
  const inheritedPath = process.env.PATH;
  assert.ok(inheritedPath);
  const previousCapture = process.env.TASK_WORKER_INIT_CAPTURE;
  const previousSecret = process.env.MCP_TASK_VALUE;
  process.env.TASK_WORKER_INIT_CAPTURE = capture;
  process.env.MCP_TASK_VALUE = secret;
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
  });

  const ownerRootId = randomUUID();
  const externalRootId = randomUUID();
  const ownerRoot = backgroundTask(ownerRootId, 100);
  ownerRoot.executionLane = 'conversation';
  ownerRoot.sessionKey = 'owner-conversation-root';
  ownerRoot.trust = 'owner';
  const externalRoot = backgroundTask(externalRootId, 101);
  externalRoot.executionLane = 'conversation';
  externalRoot.sessionKey = 'external-conversation-root';
  externalRoot.trust = 'external';
  store.enqueueEvent(ownerRoot);
  store.enqueueEvent(externalRoot);
  const cases = [
    { label: 'owner-write', access: 'write' as const, rootId: ownerRootId, taskTrust: 'external' as const, allowed: true },
    { label: 'owner-read', access: 'read' as const, rootId: ownerRootId, taskTrust: 'owner' as const, allowed: false },
    { label: 'external-write', access: 'write' as const, rootId: externalRootId, taskTrust: 'owner' as const, allowed: false },
    { label: 'missing-root', access: 'write' as const, taskTrust: 'owner' as const, allowed: false },
  ];

  try {
    supervisor.start();
    for (const [index, candidate] of cases.entries()) {
      const taskId = randomUUID();
      const task = backgroundTask(taskId, 200 + index, candidate.access);
      task.trust = candidate.taskTrust;
      if (candidate.rootId) {
        task.parentEventId = candidate.rootId;
        task.rootEventId = candidate.rootId;
      }
      store.enqueueEvent(task);
      await waitUntil(
        () => supervisor.status()[0]?.taskId === taskId && supervisor.status()[0]?.workerId !== undefined,
        `${candidate.label} fixture did not start`,
      );
      const raw = await readFile(path.join(capture, `${taskId}.json`), 'utf8');
      const captured = JSON.parse(raw) as {
        workerToken: string;
        enableMcp: boolean;
        mcpEnvironmentNames: string[];
        mcpEnvironmentDigest: string;
        workerEnvironmentMcpValue?: string;
        workerEnvironmentPathPresent: boolean;
      };
      const expectedEnvironment: Record<string, string> = candidate.allowed
        ? { MCP_TASK_VALUE: secret, PATH: inheritedPath }
        : {};
      assert.equal(captured.enableMcp, candidate.allowed);
      assert.deepEqual(captured.mcpEnvironmentNames, Object.keys(expectedEnvironment));
      assert.equal(
        captured.mcpEnvironmentDigest,
        createHash('sha256').update(JSON.stringify(expectedEnvironment)).digest('hex'),
      );
      assert.equal(captured.workerEnvironmentMcpValue, undefined);
      assert.equal(captured.workerEnvironmentPathPresent, true);
      assert.equal(supervisor.authorizeWorker(taskId, captured.workerToken), true);
      assert.equal(supervisor.authorizeWorkerAction(taskId, captured.workerToken), candidate.allowed);
      assert.equal(raw.includes(secret), false);
      assert.deepEqual(supervisor.cancel(taskId), { state: 'cancelled' });
      await waitUntil(() => supervisor.status().length === 0, `${candidate.label} fixture did not stop`);
    }
  } finally {
    await supervisor.stop();
    store.close();
    if (previousCapture === undefined) delete process.env.TASK_WORKER_INIT_CAPTURE;
    else process.env.TASK_WORKER_INIT_CAPTURE = previousCapture;
    if (previousSecret === undefined) delete process.env.MCP_TASK_VALUE;
    else process.env.MCP_TASK_VALUE = previousSecret;
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor reaps a frozen startup and does not leave a worker slot occupied', { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-frozen-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const taskId = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-frozen-fixture.mjs', import.meta.url));
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
    workerStartTimeoutMs: 100,
    workerKillGraceMs: 100,
    workerShutdownTimeoutMs: 100,
  });

  try {
    assert.equal(store.enqueueEvent(backgroundTask(taskId, 1)).inserted, true);
    supervisor.start();
    await waitUntil(() => supervisor.status()[0]?.pid !== undefined, 'frozen worker did not start');
    const firstPid = supervisor.status()[0]!.pid;
    await waitUntil(
      () => supervisor.status()[0]?.pid !== undefined && supervisor.status()[0]?.pid !== firstPid,
      'frozen task worker was not reaped and replaced',
      2_000,
    );
    assert.equal(store.getEvent(taskId)?.attempts, 1);
  } finally {
    await supervisor.stop();
    assert.deepEqual(supervisor.status(), []);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor kills the whole POSIX worker group after the worker is SIGKILLed', {
  timeout: 5_000,
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-orphan-'));
  const database = path.join(root, 'mimi.db');
  const marker = path.join(root, 'orphan-marker.txt');
  const store = new MimiStore(database);
  const taskId = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-orphan-fixture.mjs', import.meta.url));
  const previousMarker = process.env.TASK_WORKER_ORPHAN_MARKER;
  process.env.TASK_WORKER_ORPHAN_MARKER = marker;
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
    workerKillGraceMs: 100,
    workerShutdownTimeoutMs: 100,
  });

  try {
    store.enqueueEvent(backgroundTask(taskId, 1));
    supervisor.start();
    await waitUntil(
      () => supervisor.status()[0]?.workerId?.startsWith('orphan-fixture-') === true,
      'orphan fixture did not start',
    );
    const pid = supervisor.status()[0]!.pid!;
    process.kill(pid, 'SIGSTOP');
    const stopping = supervisor.stop();
    process.kill(pid, 'SIGKILL');
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(access(marker), /ENOENT/);
  } finally {
    await supervisor.stop();
    store.close();
    if (previousMarker === undefined) delete process.env.TASK_WORKER_ORPHAN_MARKER;
    else process.env.TASK_WORKER_ORPHAN_MARKER = previousMarker;
    await rm(root, { recursive: true, force: true });
  }
});

test('task worker authorization rejects a matching token after its lease expires', { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-lease-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const taskId = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-fixture.mjs', import.meta.url));
  const capture = path.join(root, 'worker-init');
  const previousCapture = process.env.TASK_WORKER_INIT_CAPTURE;
  process.env.TASK_WORKER_INIT_CAPTURE = capture;
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 1_000,
    workerEntry: fixture,
  });

  try {
    store.enqueueEvent(backgroundTask(taskId, 1));
    supervisor.start();
    await waitUntil(
      () => store.getEvent(taskId)?.status === 'running' && supervisor.status()[0]?.workerId !== undefined,
      'lease fixture did not claim the task',
    );
    const init = JSON.parse(await readFile(path.join(capture, `${taskId}.json`), 'utf8')) as {
      workerToken: string;
    };
    assert.equal(supervisor.authorizeWorker(taskId, init.workerToken), true);
    const control = new DatabaseSync(database, { timeout: 5_000 });
    try {
      control.prepare('UPDATE events SET lease_until = ? WHERE id = ?')
        .run(new Date(0).toISOString(), taskId);
    } finally {
      control.close();
    }
    assert.equal(supervisor.authorizeWorker(taskId, init.workerToken), false);
  } finally {
    await supervisor.stop();
    store.close();
    if (previousCapture === undefined) delete process.env.TASK_WORKER_INIT_CAPTURE;
    else process.env.TASK_WORKER_INIT_CAPTURE = previousCapture;
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor persists pre-claim worker exits with backoff and dead-letters after five attempts', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-crash-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const taskId = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-exit-fixture.mjs', import.meta.url));
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
  });

  try {
    store.enqueueEvent(backgroundTask(taskId, 1));
    supervisor.start();
    await waitUntil(
      () => store.getEvent(taskId)?.attempts === 1 && supervisor.status().length === 0,
      'pre-claim worker exit was not persisted',
    );
    const firstRetryAt = Date.parse(store.getEvent(taskId)!.notBefore);
    assert.equal(store.getEvent(taskId)?.status, 'queued');
    assert.equal(firstRetryAt > Date.now(), true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(store.getEvent(taskId)?.attempts, 1, 'worker restarted before durable retry time');

    const databaseControl = new DatabaseSync(database, { timeout: 5_000 });
    try {
      for (let expectedAttempts = 2; expectedAttempts <= 5; expectedAttempts += 1) {
        databaseControl.prepare('UPDATE events SET not_before = ? WHERE id = ?')
          .run(new Date(0).toISOString(), taskId);
        await waitUntil(
          () => store.getEvent(taskId)?.attempts === expectedAttempts && supervisor.status().length === 0,
          `worker exit attempt ${expectedAttempts} was not persisted`,
        );
      }
    } finally {
      databaseControl.close();
    }
    assert.equal(store.getEvent(taskId)?.status, 'dead_letter');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(store.getEvent(taskId)?.attempts, 5);
    assert.deepEqual(supervisor.status(), []);
  } finally {
    await supervisor.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('task supervisor gives write tasks exclusive workspace access while read tasks share it', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-supervisor-access-'));
  const database = path.join(root, 'mimi.db');
  const store = new MimiStore(database);
  const writeFirst = randomUUID();
  const readTasks = [randomUUID(), randomUUID()];
  const writeLast = randomUUID();
  const config: AppConfig = {
    provider: 'openai',
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'daemon'),
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  const fixture = fileURLToPath(new URL('./fixtures/task-worker-fixture.mjs', import.meta.url));
  const supervisor = new TaskProcessSupervisor(store, config, {
    database,
    assistantConfig: path.join(root, 'MIMI.md'),
    socket: path.join(root, 'mimi.sock'),
  }, {
    maxWorkers: 3,
    pollMs: 25,
    workerEntry: fixture,
  });

  try {
    store.enqueueEvent(backgroundTask(writeFirst, 1, 'write'));
    readTasks.forEach((taskId, index) => store.enqueueEvent(backgroundTask(taskId, index + 2, 'read')));
    supervisor.start();
    await waitUntil(
      () => supervisor.status().length === 1 && supervisor.status()[0]?.taskId === writeFirst,
      'first write task did not receive exclusive access',
    );
    assert.equal(supervisor.status()[0]?.workspaceAccess, 'write');
    assert.deepEqual(supervisor.cancel(writeFirst), { state: 'cancelled' });
    await waitUntil(
      () => supervisor.status().length === 2
        && supervisor.status().every((worker) => worker.workspaceAccess === 'read'),
      'read tasks did not share workspace access',
    );

    store.enqueueEvent(backgroundTask(writeLast, 4, 'write'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(store.getEvent(writeLast)?.status, 'queued');
    assert.equal(supervisor.status().some((worker) => worker.taskId === writeLast), false);

    for (const taskId of readTasks) assert.deepEqual(supervisor.cancel(taskId), { state: 'cancelled' });
    await waitUntil(
      () => supervisor.status().length === 1 && supervisor.status()[0]?.taskId === writeLast,
      'waiting write task did not start after readers drained',
    );
    assert.equal(supervisor.status()[0]?.workspaceAccess, 'write');
  } finally {
    await supervisor.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
