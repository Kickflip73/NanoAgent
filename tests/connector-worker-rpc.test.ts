import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RunContext, type Tool } from '@openai/agents';
import type { AppConfig } from '../src/config.js';
import {
  createConnectorTaskHostTools,
  type ConnectorCapabilitySnapshot,
} from '../src/daemon/connector-action-tool.js';
import {
  connectorCapabilitySnapshotSchema,
  KernelConnectorRuntime,
  WORKER_CONNECTOR_ACTION_METHOD,
  WORKER_CONNECTOR_ACTION_TIMEOUT_MS,
  WORKER_CONNECTOR_INSPECT_METHOD,
  workerConnectorActionParamsSchema,
  workerConnectorInspectParamsSchema,
} from '../src/daemon/connector-worker-rpc.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';
import { MimiStore } from '../src/daemon/store.js';
import { TaskProcessSupervisor } from '../src/daemon/task-supervisor.js';
import type { EventEnvelope } from '../src/daemon/types.js';

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function taskEvent(
  id: string,
  executionLane: 'conversation' | 'task',
  workspaceAccess: 'read' | 'write' = 'read',
): EventEnvelope {
  const timestamp = new Date().toISOString();
  return {
    id,
    externalId: `connector-rpc-${id}`,
    source: executionLane === 'task' ? 'mimi:background-task' : 'test',
    kind: 'command',
    trust: 'owner',
    payload: executionLane === 'task'
      ? { prompt: 'inspect only', workspaceAccess }
      : { prompt: 'owner root' },
    occurredAt: timestamp,
    receivedAt: timestamp,
    priority: 70,
    profileId: 'owner',
    sessionKey: executionLane === 'task' ? `mimi-task-${id}` : `owner-${id}`,
    executionLane,
  };
}

async function invoke(tool: Tool, input: unknown): Promise<unknown> {
  assert.ok('invoke' in tool);
  return tool.invoke(new RunContext({}), JSON.stringify(input));
}

function snapshot(): ConnectorCapabilitySnapshot {
  return {
    configFile: '/tmp/connectors.json',
    total: 1,
    enabled: 1,
    online: 1,
    inboundReady: 1,
    outboundReady: 1,
    actions: 1,
    truncated: false,
    connectors: [{
      id: 'fixture',
      enabled: true,
      online: true,
      readiness: { inbound: 'ready', outbound: 'ready', deliveryConfirmed: true },
      source: 'fixture',
      actions: [{ name: 'send_message', description: 'Send a message' }],
    }],
  };
}

test('worker Connector RPC schemas are strict, bounded, and require an unguessable worker token', () => {
  const taskId = randomUUID();
  const workerToken = randomBytes(32).toString('base64url');
  assert.equal(workerConnectorInspectParamsSchema.safeParse({
    taskId,
    workerToken,
    filter: { query: 'wechat' },
  }).success, true);
  assert.equal(workerConnectorInspectParamsSchema.safeParse({
    taskId,
    workerToken,
    filter: {},
    unexpected: true,
  }).success, false);
  assert.equal(workerConnectorActionParamsSchema.safeParse({
    taskId,
    workerToken: 'guessable',
    request: { connector: 'fixture', action: 'send_message', target: 'owner', payload: {} },
  }).success, false);
  assert.equal(workerConnectorActionParamsSchema.safeParse({
    taskId,
    workerToken,
    request: { connector: 'fixture', action: 'send_message', target: 'owner' },
  }).success, false);

  const oversized = snapshot();
  oversized.connectors = Array.from({ length: 2 }, (_, index) => ({
    ...oversized.connectors[0]!,
    id: `fixture-${index}`,
    actions: Array.from({ length: 51 }, (__, actionIndex) => ({
      name: `action-${actionIndex}`,
      description: 'bounded',
    })),
  }));
  assert.equal(connectorCapabilitySnapshotSchema.safeParse(oversized).success, false);
  assert.ok(WORKER_CONNECTOR_ACTION_TIMEOUT_MS > 900_000);
});

test('task Connector runtime uses the kernel socket and exposes only inspect/action tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-worker-rpc-'));
  const socket = path.join(root, 'mimi.sock');
  const taskId = randomUUID();
  const workerToken = randomBytes(32).toString('base64url');
  await writeFile(path.join(root, 'control.token'), 'must-not-be-read\n', { mode: 0o600 });
  let actionCalls = 0;
  const server = new MimiIpcServer(socket, async (method, rawParams, signal, auth) => {
    assert.equal(auth, undefined);
    if (method === WORKER_CONNECTOR_INSPECT_METHOD) {
      const params = workerConnectorInspectParamsSchema.parse(rawParams);
      assert.equal(params.taskId, taskId);
      assert.equal(params.workerToken, workerToken);
      assert.deepEqual(params.filter, { connector: 'fixture' });
      return snapshot();
    }
    if (method === WORKER_CONNECTOR_ACTION_METHOD) {
      const params = workerConnectorActionParamsSchema.parse(rawParams);
      assert.equal(params.taskId, taskId);
      assert.equal(params.workerToken, workerToken);
      actionCalls += 1;
      if (params.request.target === 'wait-for-cancel') {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return { delivered: true, request: params.request };
    }
    throw new Error(`unexpected method ${method}`);
  });

  try {
    await server.start();
    const runtime = new KernelConnectorRuntime(socket, taskId, workerToken);
    const tools = createConnectorTaskHostTools(runtime);
    assert.deepEqual(tools.map((tool) => tool.name), [
      'inspect_mimi_capabilities',
      'connector_action',
    ]);
    assert.equal(tools.some((tool) => tool.name === 'reload_mimi_connectors'), false);
    assert.equal(tools.some((tool) => tool.name === 'set_mimi_connector_enabled'), false);

    assert.deepEqual(await invoke(tools[0]!, { connector: 'fixture' }), snapshot());
    const action = await invoke(tools[1]!, {
      connector: 'fixture',
      action: 'send_message',
      target: 'owner',
      payloadJson: JSON.stringify({ text: 'hello' }),
    }) as { delivered: boolean; request: { payload: unknown } };
    assert.equal(action.delivered, true);
    assert.deepEqual(action.request.payload, { text: 'hello' });
    assert.equal(actionCalls, 1);

    const controller = new AbortController();
    const waiting = runtime.executeAction({
      connector: 'fixture', action: 'send_message', target: 'wait-for-cancel', payload: {},
    }, controller.signal);
    controller.abort(new Error('task cancelled'));
    await assert.rejects(waiting, /task cancelled/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('kernel broker rejects Connector actions from a read Task with a valid worker token', {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-read-task-connector-rpc-'));
  const database = path.join(root, 'mimi.db');
  const socket = path.join(root, 'mimi.sock');
  const capture = path.join(root, 'worker-init');
  const store = new MimiStore(database);
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
    socket,
  }, {
    maxWorkers: 1,
    pollMs: 25,
    workerEntry: fixture,
  });
  let actionCalls = 0;
  const server = new MimiIpcServer(socket, (method, rawParams) => {
    if (method === WORKER_CONNECTOR_INSPECT_METHOD) {
      const params = workerConnectorInspectParamsSchema.parse(rawParams);
      if (!supervisor.authorizeWorker(params.taskId, params.workerToken)) {
        throw new Error('后台 Task worker 身份已失效');
      }
      return snapshot();
    }
    if (method === WORKER_CONNECTOR_ACTION_METHOD) {
      const params = workerConnectorActionParamsSchema.parse(rawParams);
      if (!supervisor.authorizeWorkerAction(params.taskId, params.workerToken)) {
        throw new Error('后台 Task worker 无权执行 Connector action');
      }
      actionCalls += 1;
      return { delivered: true };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const rootId = randomUUID();
  const taskId = randomUUID();
  const ownerRoot = taskEvent(rootId, 'conversation');
  const task = taskEvent(taskId, 'task', 'read');
  task.parentEventId = rootId;
  task.rootEventId = rootId;
  store.enqueueEvent(ownerRoot);
  store.enqueueEvent(task);
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousCapture = process.env.TASK_WORKER_INIT_CAPTURE;
  process.env.OPENAI_API_KEY = 'connector-rpc-test-provider-key';
  process.env.TASK_WORKER_INIT_CAPTURE = capture;

  try {
    await server.start();
    supervisor.start();
    await waitUntil(
      () => supervisor.status()[0]?.taskId === taskId
        && supervisor.status()[0]?.workerId !== undefined,
      'read Task worker did not start',
    );
    const init = JSON.parse(await readFile(path.join(capture, `${taskId}.json`), 'utf8')) as {
      workerToken: string;
    };
    const runtime = new KernelConnectorRuntime(socket, taskId, init.workerToken);
    assert.deepEqual(await runtime.inspectCapabilities({ connector: 'fixture' }), snapshot());
    await assert.rejects(runtime.executeAction({
      connector: 'fixture', action: 'send_message', target: 'owner', payload: { text: 'must not send' },
    }), /无权执行 Connector action/);
    assert.equal(actionCalls, 0);
  } finally {
    supervisor.cancel(taskId, 'test cleanup');
    await supervisor.stop();
    await server.close();
    store.close();
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousCapture === undefined) delete process.env.TASK_WORKER_INIT_CAPTURE;
    else process.env.TASK_WORKER_INIT_CAPTURE = previousCapture;
    await rm(root, { recursive: true, force: true });
  }
});
