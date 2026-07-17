import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RunContext, type Tool } from '@openai/agents';
import {
  connectorCapabilitySnapshot,
  createConnectorActionTool,
  createConnectorCapabilityTool,
  createConnectorEnabledTool,
  createConnectorReloadTool,
} from '../src/daemon/connector-action-tool.js';
import { connectorEventPriority, ConnectorManager, parseConnectorConfig } from '../src/daemon/connectors.js';
import { NotifierRegistry, UncertainDeliveryError } from '../src/daemon/notifier.js';
import { MimiStore } from '../src/daemon/store.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timed out');
}

async function invoke(tool: Tool, input: unknown): Promise<unknown> {
  assert.ok('invoke' in tool);
  return tool.invoke(new RunContext({}), JSON.stringify(input));
}

test('authenticated owner commands from connectors enter the urgent direct-command lane', () => {
  assert.equal(connectorEventPriority('owner', 'command', undefined), 100);
  assert.equal(connectorEventPriority('owner', 'command', 5), 100);
  assert.equal(connectorEventPriority('owner', 'alert', 5), 5);
  assert.equal(connectorEventPriority('external', 'command', 5), 5);
  assert.equal(connectorEventPriority('external', 'command', Number.NaN), 50);
});

test('packaged macOS system connector declares schema-valid system provenance', async () => {
  const templateFile = fileURLToPath(new URL('../mimi.connectors.example.json', import.meta.url));
  const config = parseConnectorConfig(JSON.parse(await readFile(templateFile, 'utf8')) as unknown);
  const system = config.connectors['macos-system'];
  assert.ok(system);
  assert.equal(system.source, 'macos-system');
  assert.equal(system.trust, 'system');
});

test('stdio connectors ingest events, isolate environment secrets and acknowledge outbox delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-'));
  const fixture = fileURLToPath(new URL('./fixtures/connector-fixture.mjs', import.meta.url));
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, JSON.stringify({ connectors: {
    fixture: {
      command: process.execPath,
      args: [fixture],
      envAllowlist: ['CONNECTOR_TEST_ALLOWED'],
      source: 'fixture-source',
      trust: 'external',
      restart: false,
      actions: { send_message: { description: 'Send one fixture message' } },
    },
  } }));
  const previousAllowed = process.env.CONNECTOR_TEST_ALLOWED;
  const previousSecret = process.env.CONNECTOR_TEST_SECRET;
  process.env.CONNECTOR_TEST_ALLOWED = 'visible';
  process.env.CONNECTOR_TEST_SECRET = 'must-not-leak';
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const notifier = new NotifierRegistry();
    const connectors = await ConnectorManager.load(configFile, store, notifier);
  try {
    assert.equal(connectors.size, 1);
    assert.deepEqual(connectors.listCapabilities(), [{
      id: 'fixture', enabled: true, online: false, source: 'fixture-source', trust: 'external',
      readiness: { inbound: 'unavailable', outbound: 'unavailable' },
      actions: [{ name: 'send_message', description: 'Send one fixture message' }],
    }]);
    const capabilityTool = createConnectorCapabilityTool(connectors);
    assert.equal((await invoke(capabilityTool, {}) as { configFile: string }).configFile, configFile);
    assert.equal((await invoke(capabilityTool, {}) as { online: number }).online, 0);
    const exactCapability = await invoke(capabilityTool, { connector: 'fixture' }) as {
      total: number;
      connectors: Array<{ id: string }>;
    };
    assert.equal(exactCapability.total, 1);
    assert.deepEqual(exactCapability.connectors.map((connector) => connector.id), ['fixture']);
    assert.equal((await invoke(capabilityTool, { connector: 'missing' }) as { total: number }).total, 0);
    connectors.start();
    await waitUntil(() => store.listEvents().length === 1);
    const event = store.listEvents()[0]!;
    assert.equal(event.source, 'fixture-source');
    assert.equal(event.trust, 'external');
    assert.deepEqual(event.payload, { allowed: 'visible', leakedSecret: false });
    assert.deepEqual(event.replyRoute, { channel: 'connector:fixture', target: 'fixture-user' });
    await waitUntil(() => connectors.listCapabilities()[0]?.online === true);
    await waitUntil(() => connectors.listCapabilities()[0]?.readiness.inbound === 'ready');
    assert.equal((await invoke(capabilityTool, {}) as { online: number }).online, 1);
    assert.deepEqual(connectors.listCapabilities()[0]?.readiness, {
      inbound: 'ready', outbound: 'ready', deliveryConfirmed: true,
    });
    const actionTool = createConnectorActionTool(connectors);
    const actionDescription = String((actionTool as Tool & { description: string }).description);
    assert.match(actionDescription, /inspect_mimi_capabilities/);
    assert.doesNotMatch(actionDescription, /fixture\.send_message/);
    const actionResult = await invoke(actionTool, {
      connector: 'fixture', action: 'send_message', target: 'fixture-user',
      payloadJson: JSON.stringify({ text: 'hello' }),
    }) as Record<string, unknown>;
    assert.match(String(actionResult.requestId), /^[0-9a-f-]{36}$/);
    assert.equal(actionResult.operationId, actionResult.requestId);
    assert.equal(actionResult.outcome, 'confirmed');
    assert.equal(actionResult.tool, 'connector_action');
    assert.equal(actionResult.action, 'send_message');
    assert.equal(actionResult.target, 'fixture-user');
    assert.deepEqual(actionResult.payload, { text: 'hello' });
    assert.match(String(await invoke(actionTool, {
      connector: 'fixture', action: 'send_message', target: 'fixture-user', payloadJson: '{',
    })), /payloadJson/);
    await assert.rejects(connectors.executeAction({
      connector: 'fixture', action: 'delete_everything', target: 'fixture-user', payload: {},
    }), /未声明 action/);
    await assert.rejects(connectors.executeAction({
      connector: 'missing', action: 'send_message', target: 'fixture-user', payload: {},
    }), /未找到 Connector/);
    await assert.rejects(connectors.executeAction({
      connector: 'fixture', action: 'send_message', target: 'uncertain', payload: {},
    }), (error: unknown) => error instanceof UncertainDeliveryError);

    const claimed = store.claimEvent('worker', 60_000, new Date('2099-01-01T00:00:00.000Z'))!;
    store.completeEvent(claimed.id, 'worker', { answer: 'ok' }, 'completed', {
      route: claimed.replyRoute!, payload: { text: 'reply' },
    });
    const outgoing = store.claimOutbox('worker', 30_000, new Date('2099-01-01T00:00:01.000Z'))!;
    await notifier.deliver(outgoing);
    store.completeOutbox(outgoing.id, 'worker');
    assert.equal(store.listOutbox()[0]?.status, 'sent');
    await assert.rejects(notifier.deliver({
      ...outgoing, id: 'uncertain-delivery', target: 'uncertain', status: 'pending', attempts: 0,
    }), (error: unknown) => error instanceof UncertainDeliveryError);

    await assert.rejects(connectors.executeAction({
      connector: 'fixture', action: 'send_message', target: 'exit', payload: {},
    }), /不会自动重放/);
    await waitUntil(() => connectors.listCapabilities()[0]?.online === false);
    await connectors.stop();
    assert.equal(connectors.listCapabilities()[0]?.online, false);
    assert.equal((await invoke(capabilityTool, {}) as { online: number }).online, 0);
    await assert.rejects(connectors.executeAction({
      connector: 'fixture', action: 'send_message', target: 'fixture-user', payload: {},
    }), /不在线/);
  } finally {
    await connectors.stop();
    store.close();
    if (previousAllowed === undefined) delete process.env.CONNECTOR_TEST_ALLOWED;
    else process.env.CONNECTOR_TEST_ALLOWED = previousAllowed;
    if (previousSecret === undefined) delete process.env.CONNECTOR_TEST_SECRET;
    else process.env.CONNECTOR_TEST_SECRET = previousSecret;
  }
});

test('connector action timeout terminates the process so a late side effect cannot keep running', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-timeout-'));
  const fixture = fileURLToPath(new URL('./fixtures/connector-fixture.mjs', import.meta.url));
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, JSON.stringify({ connectors: {
    fixture: {
      command: process.execPath,
      args: [fixture],
      restart: false,
      healthEvents: false,
      actionTimeoutMs: 1_000,
      actions: { send_message: { description: 'Send one fixture message' } },
    },
  } }));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const connectors = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  try {
    connectors.start();
    await waitUntil(() => connectors.listCapabilities()[0]?.online === true);
    await assert.rejects(connectors.executeAction({
      connector: 'fixture', action: 'send_message', target: 'hang', payload: {},
    }), /执行超时.*不会自动重放/);
    await waitUntil(() => connectors.listCapabilities()[0]?.online === false);
  } finally {
    await connectors.stop();
    store.close();
  }
});

test('connector capability snapshots bound large catalogs and remain read-only', () => {
  const capabilities = Array.from({ length: 60 }, (_, connectorIndex) => ({
    id: `connector-${connectorIndex}`,
    enabled: connectorIndex !== 0,
    online: connectorIndex % 2 === 0,
    readiness: {
      inbound: connectorIndex % 3 === 0 ? 'ready' as const : 'unknown' as const,
      outbound: connectorIndex % 4 === 0 ? 'ready' as const : 'unavailable' as const,
    },
    source: `source-${connectorIndex}`,
    trust: 'external' as const,
    actions: Array.from({ length: 3 }, (_, actionIndex) => ({
      name: `action-${actionIndex}`,
      description: `description-${'x'.repeat(400)}`,
    })),
  }));
  const connectors = {
    configPath: '/tmp/connectors.json', listCapabilities: () => capabilities,
  } as unknown as ConnectorManager;
  const snapshot = connectorCapabilitySnapshot(connectors);
  assert.equal(snapshot.total, 60);
  assert.equal(snapshot.enabled, 59);
  assert.equal(snapshot.online, 30);
  assert.equal(snapshot.inboundReady, 10);
  assert.equal(snapshot.outboundReady, 15);
  assert.equal(snapshot.actions, 180);
  assert.equal(snapshot.connectors.length, 50);
  assert.equal(snapshot.connectors.flatMap((connector) => connector.actions).length, 100);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.connectors.every((connector) => connector.actions.every((action) => action.description.length <= 300)));

  const exact = connectorCapabilitySnapshot(connectors, { connector: 'connector-42' });
  assert.equal(exact.total, 1);
  assert.equal(exact.actions, 3);
  assert.deepEqual(exact.connectors.map((connector) => connector.id), ['connector-42']);

  const queried = connectorCapabilitySnapshot(connectors, { query: 'connector-42' });
  assert.deepEqual(queried.connectors.map((connector) => connector.id), ['connector-42']);

  const capabilityTool = createConnectorCapabilityTool(connectors);
  assert.equal(isSideEffectTool(capabilityTool.name), false);
  assert.deepEqual(toolsForRunPolicy([capabilityTool], {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['inspect_mimi_capabilities']);
  const description = String((createConnectorActionTool(connectors) as Tool & { description: string }).description);
  assert.match(description, /inspect_mimi_capabilities/);
  assert.doesNotMatch(description, /connector-0\.action-0/);
  assert.doesNotMatch(description, /description-x/);
  assert.ok(description.length < 1_000);
});

test('connector reload validates before swap, refreshes actions and removes stale notification routes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-reload-'));
  const fixture = fileURLToPath(new URL('./fixtures/connector-fixture.mjs', import.meta.url));
  const configFile = path.join(root, 'connectors.json');
  const writeConfig = async (source: string, actions: Record<string, { description: string }>) => {
    await writeFile(configFile, JSON.stringify({ connectors: {
      fixture: {
        command: process.execPath,
        args: [fixture],
        source,
        restart: false,
        actions,
      },
    } }));
  };
  await writeConfig('before-reload', { old_action: { description: 'Old action' } });
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const notifier = new NotifierRegistry();
  const connectors = await ConnectorManager.load(configFile, store, notifier);
  try {
    connectors.start();
    await waitUntil(() => connectors.listCapabilities()[0]?.online === true);
    await writeFile(configFile, '{"connectors":{"fixture":{"command":3}}}');
    await assert.rejects(connectors.reload());
    assert.equal(connectors.listCapabilities()[0]?.source, 'before-reload');
    assert.equal(connectors.listCapabilities()[0]?.online, true);
    const unchanged = await connectors.executeAction({
      connector: 'fixture', action: 'old_action', target: 'fixture-user', payload: { value: 1 },
    }) as { action?: string };
    assert.equal(unchanged.action, 'old_action');

    await writeConfig('after-reload', { new_action: { description: 'New action' } });
    const reloadTool = createConnectorReloadTool(connectors);
    const reloaded = await invoke(reloadTool, {}) as {
      configFile: string;
      connectors: Array<{ source: string }>;
    };
    await waitUntil(() => connectors.listCapabilities()[0]?.online === true);
    assert.equal(reloaded.configFile, configFile);
    assert.equal(reloaded.connectors[0]?.source, 'after-reload');
    assert.deepEqual(connectors.listCapabilities()[0]?.actions, [
      { name: 'new_action', description: 'New action' },
    ]);
    await assert.rejects(connectors.executeAction({
      connector: 'fixture', action: 'old_action', target: 'fixture-user', payload: {},
    }), /未声明 action/);
    const changed = await connectors.executeAction({
      connector: 'fixture', action: 'new_action', target: 'fixture-user', payload: { value: 2 },
    }) as { action?: string };
    assert.equal(changed.action, 'new_action');
    assert.doesNotMatch(
      String((createConnectorActionTool(connectors) as Tool & { description: string }).description),
      /fixture\.new_action/,
    );

    const inFlight = connectors.executeAction({
      connector: 'fixture', action: 'new_action', target: 'delay', payload: { value: 3 },
    });
    const enabledTool = createConnectorEnabledTool(connectors);
    await assert.rejects(connectors.reload(), /进行中的投递或 action/);
    await assert.rejects(connectors.setEnabled('fixture', false), /进行中的投递或 action/);
    assert.notEqual((JSON.parse(await readFile(configFile, 'utf8')) as {
      connectors: { fixture: { enabled?: boolean } };
    }).connectors.fixture.enabled, false);
    assert.equal((await inFlight as { action?: string }).action, 'new_action');
    assert.equal(connectors.listCapabilities()[0]?.online, true);

    const disabled = await invoke(enabledTool, { connector: 'fixture', enabled: false }) as {
      changed: boolean; connector: { enabled: boolean; online: boolean };
    };
    assert.deepEqual(disabled, {
      changed: true,
      connector: {
        id: 'fixture', enabled: false, online: false, source: 'after-reload', trust: 'external',
        readiness: { inbound: 'unavailable', outbound: 'unavailable' },
        actions: [{ name: 'new_action', description: 'New action' }],
      },
    });
    assert.equal((JSON.parse(await readFile(configFile, 'utf8')) as {
      connectors: { fixture: { enabled: boolean } };
    }).connectors.fixture.enabled, false);
    assert.equal((await invoke(enabledTool, { connector: 'fixture', enabled: false }) as {
      changed: boolean;
    }).changed, false);
    const enabled = await invoke(enabledTool, { connector: 'fixture', enabled: true }) as {
      changed: boolean; connector: { enabled: boolean };
    };
    assert.equal(enabled.changed, true);
    assert.equal(enabled.connector.enabled, true);
    await waitUntil(() => connectors.listCapabilities()[0]?.online === true);
    await assert.rejects(connectors.setEnabled('missing', true), /未找到 Connector/);

    await writeFile(configFile, JSON.stringify({ connectors: {} }));
    assert.equal((await invoke(reloadTool, {}) as { total: number }).total, 0);
    assert.equal(connectors.size, 0);
    const now = new Date().toISOString();
    await assert.rejects(notifier.deliver({
      id: 'outbox-reload', eventId: 'event-reload', channel: 'connector:fixture', target: 'fixture-user',
      payload: { text: 'should not reach old process' }, status: 'pending', attempts: 0,
      notBefore: now, createdAt: now, updatedAt: now,
    }), /未配置通知通道/);
  } finally {
    await connectors.stop();
    store.close();
  }
});

test('connector reload and enabled tools are ledgered state mutations', () => {
  const tools = [
    createConnectorEnabledTool({} as ConnectorManager),
    createConnectorReloadTool({} as ConnectorManager),
  ];
  assert.ok(tools.every((tool) => isSideEffectTool(tool.name)));
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }), []);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((item) => item.name), ['set_mimi_connector_enabled', 'reload_mimi_connectors']);
});

test('connector health emits one outage and only reports recovery after a stable restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-health-'));
  const fixture = fileURLToPath(new URL('./fixtures/connector-health-fixture.mjs', import.meta.url));
  const marker = path.join(root, 'attempts.txt');
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, JSON.stringify({ connectors: {
    flaky: {
      command: process.execPath,
      args: [fixture, marker, '2'],
      source: 'flaky-source',
      restart: true,
      healthStabilityMs: 100,
    },
    silent: {
      command: path.join(root, 'missing-command'),
      restart: false,
      healthEvents: false,
    },
    disabled: {
      enabled: false,
      command: path.join(root, 'also-missing'),
    },
  } }));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const connectors = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  try {
    connectors.start();
    await waitUntil(() => store.listEvents().some((event) => (
      event.source === 'system:connector-health'
      && (event.payload as { connectorHealth?: { status?: string } }).connectorHealth?.status === 'recovered'
    )), 5_000);

    const healthEvents = store.listEvents().filter((event) => event.source === 'system:connector-health');
    assert.equal(Number(await readFile(marker, 'utf8')), 3);
    assert.equal(healthEvents.length, 2);
    const summarized = new Map(healthEvents.map((event) => {
      const health = (event.payload as { connectorHealth: { status: string } }).connectorHealth;
      return [health.status, {
        kind: event.kind,
        trust: event.trust,
        priority: event.priority,
        sessionKey: event.sessionKey,
        health,
      }];
    }));
    assert.deepEqual(summarized.get('offline'), {
      kind: 'alert', trust: 'system', priority: 90, sessionKey: 'mimi-connector-health-flaky',
      health: {
        connectorId: 'flaky', connectorSource: 'flaky-source', status: 'offline', automaticRestart: true,
        error: '退出 code=17 signal=none',
      },
    });
    assert.deepEqual(summarized.get('recovered'), {
      kind: 'alert', trust: 'system', priority: 75, sessionKey: 'mimi-connector-health-flaky',
      health: {
        connectorId: 'flaky', connectorSource: 'flaky-source', status: 'recovered', automaticRestart: true,
      },
    });

    await connectors.stop();
    assert.equal(store.listEvents().filter((event) => event.source === 'system:connector-health').length, 2);
  } finally {
    await connectors.stop();
    store.close();
  }
});

test('a connector start configuration failure becomes a health event instead of crashing the host', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-start-failure-'));
  const configFile = path.join(root, 'connectors.json');
  await writeFile(configFile, JSON.stringify({ connectors: {
    broken: {
      command: process.execPath,
      cwd: 'relative-directory',
      restart: false,
    },
    missing: {
      command: path.join(root, 'missing-command'),
      restart: false,
    },
    disabled: {
      enabled: false,
      command: process.execPath,
      cwd: 'also-relative',
    },
  } }));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const connectors = await ConnectorManager.load(configFile, store, new NotifierRegistry());
  try {
    assert.doesNotThrow(() => connectors.start());
    await waitUntil(() => store.listEvents().filter((event) => event.source === 'system:connector-health').length === 2);
    const events = store.listEvents().filter((event) => event.source === 'system:connector-health');
    const healthByConnector = new Map(events.map((event) => {
      const health = (event.payload as { connectorHealth: { connectorId: string } }).connectorHealth;
      return [health.connectorId, health];
    }));
    assert.deepEqual(healthByConnector.get('broken'), {
      connectorId: 'broken', connectorSource: 'connector:broken', status: 'offline', automaticRestart: false,
      error: '配置错误：cwd 必须是绝对路径',
    });
    assert.deepEqual(healthByConnector.get('missing'), {
      connectorId: 'missing', connectorSource: 'connector:missing', status: 'offline', automaticRestart: false,
      error: '进程错误 ENOENT',
    });
  } finally {
    await connectors.stop();
    store.close();
  }
});
