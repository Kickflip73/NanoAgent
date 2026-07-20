import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMimiChatSnapshot,
  createMimiHistoryChunk,
  createMimiMemoryPage,
  assertDaemonControlAuth,
  DaemonMutationGate,
  daemonHasActiveWork,
  daemonLaunchEnvironment,
  daemonProcessIsLive,
  daemonProtocolAction,
  daemonProtocolState,
  daemonSupervisorAction,
  daemonStartupMode,
  doctorMimi,
  initializeMimi,
  launchAgentProviderConfigured,
  launchAgentPlist,
  waitForAbort,
} from '../src/daemon/service.js';
import {
  controlTokenPathForSocket,
  ensureControlToken,
  mimiRpc,
  MimiIpcServer,
  readControlToken,
} from '../src/daemon/ipc.js';
import type { AppConfig } from '../src/config.js';
import type { MimiAgent } from '../src/agent.js';
import type { Memory } from '../src/core/memory.js';
import type { MimiHost } from '../src/runtime/mimi-host.js';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonStatus,
  type MimiActivitySnapshot,
} from '../src/daemon/types.js';

function testConfig(root: string): AppConfig {
  return {
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'mimi'), skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'), historyLimit: 40, maxTurns: 200,
  };
}

async function rawRpc(
  socketPath: string,
  method: string,
  params?: unknown,
  auth?: string,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let output = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.end(`${JSON.stringify({
        id: `raw-${method}`,
        method,
        params,
        ...(auth ? { auth } : {}),
      })}\n`);
    });
    socket.on('data', (chunk: string) => { output += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        resolve(JSON.parse(output.split('\n', 1)[0]!) as { ok: boolean; result?: unknown; error?: string });
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('daemon protocol decisions upgrade only idle legacy workers', () => {
  assert.equal(DAEMON_PROTOCOL_VERSION, 5);
  const current: DaemonStatus = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    pid: 123, startedAt: '2026-07-16T00:00:00.000Z', workerId: 'worker', workspaceRoot: '/workspace',
    permissionMode: 'trusted',
    activeHostMutations: 0,
    events: { queued: 0, running: 0, paused: 0, blocked: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 }, enabledSchedules: 0,
  };
  const legacy = { ...current, protocolVersion: undefined };
  const previousOwnerPolicy = { ...current, protocolVersion: 2 };
  const busyLegacy = {
    ...legacy,
    activeEventId: 'event-in-flight',
    events: { ...legacy.events, running: 1 },
  };

  assert.equal(daemonProtocolState(current), 'current');
  assert.equal(daemonProtocolState(legacy), 'legacy');
  assert.equal(daemonProtocolState(previousOwnerPolicy), 'legacy');
  assert.equal(daemonProtocolState({ protocolVersion: DAEMON_PROTOCOL_VERSION + 1 }), 'newer');
  assert.equal(daemonProtocolAction(current, 'trusted'), 'reuse');
  assert.equal(daemonProtocolAction(legacy, 'trusted'), 'upgrade');
  assert.equal(daemonProtocolAction(previousOwnerPolicy, 'trusted'), 'upgrade');
  assert.equal(daemonProtocolAction({ ...current, permissionMode: 'workspace' }, 'trusted'), 'upgrade');
  assert.equal(daemonHasActiveWork(busyLegacy), true);
  assert.equal(daemonHasActiveWork({
    ...legacy,
    activeHostMutations: 1,
  }), true);
  assert.throws(() => daemonProtocolAction(busyLegacy, 'trusted'), /仍有活动任务/);
  assert.throws(
    () => daemonProtocolAction({ ...busyLegacy, protocolVersion: DAEMON_PROTOCOL_VERSION, permissionMode: 'workspace' }, 'trusted'),
    /执行档位 workspace.*当前配置 trusted.*仍有活动任务/,
  );
  assert.throws(
    () => daemonProtocolAction({ ...current, protocolVersion: DAEMON_PROTOCOL_VERSION + 1 }, 'trusted'),
    /高于当前 CLI.*当前后台未被停止/,
  );
});

test('daemon control RPC rejects raw unauthenticated owner methods while normal mimiRpc authenticates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-control-auth-'));
  const socket = path.join(root, 'mimi.sock');
  await ensureControlToken(socket);
  const expected = await readControlToken(socket);
  assert.ok(expected);
  let submitted = 0;
  let shutdown = false;
  const server = new MimiIpcServer(socket, (method, _params, _signal, auth) => {
    assertDaemonControlAuth(expected, auth);
    if (method === 'status') return { protocolVersion: DAEMON_PROTOCOL_VERSION, ready: true };
    if (method === 'submit') return { inserted: ++submitted };
    if (method === 'shutdown') {
      shutdown = true;
      return { accepted: true };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    for (const method of ['status', 'submit', 'shutdown']) {
      const response = await rawRpc(socket, method, {});
      assert.equal(response.ok, false);
      assert.match(response.error ?? '', /控制认证失败/);
    }
    const wrong = expected === 'A'.repeat(43) ? 'B'.repeat(43) : 'A'.repeat(43);
    assert.equal((await rawRpc(socket, 'status', {}, wrong)).ok, false);
    assert.equal(submitted, 0);
    assert.equal(shutdown, false);

    const status = await mimiRpc<Record<string, unknown>>(socket, 'status');
    assert.equal(status.ready, true);
    assert.doesNotMatch(JSON.stringify(status), new RegExp(expected));
    assert.deepEqual(await mimiRpc(socket, 'submit', {}), { inserted: 1 });
    assert.deepEqual(await mimiRpc(socket, 'shutdown'), { accepted: true });
    assert.equal(shutdown, true);

    const tokenFile = controlTokenPathForSocket(socket);
    await rm(tokenFile);
    await assert.rejects(mimiRpc(socket, 'status'), /控制认证失败/);
    await writeFile(tokenFile, `${wrong}\n`, { mode: 0o600 });
    await assert.rejects(mimiRpc(socket, 'status'), /控制认证失败/);
  } finally {
    await server.close();
  }
});

test('daemon startup uses launchd whenever macOS can persist the service', () => {
  assert.equal(daemonStartupMode('darwin', true), 'launchd');
  assert.equal(daemonStartupMode('darwin', false), 'detached');
  assert.equal(daemonStartupMode('darwin', false, true), 'launchd');
  assert.equal(daemonStartupMode('linux', true), 'detached');
  assert.equal(daemonStartupMode('linux', false, true), 'detached');
});

test('daemon supervisor migration replaces only an idle detached worker', () => {
  const idle: DaemonStatus = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    permissionMode: 'trusted',
    pid: 123,
    startedAt: '2026-07-16T00:00:00.000Z',
    workerId: 'worker',
    workspaceRoot: '/workspace',
    activeHostMutations: 0,
    events: { queued: 0, running: 0, paused: 0, blocked: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 },
    enabledSchedules: 0,
  };
  const busy = {
    ...idle,
    activeEventId: 'event-in-flight',
    events: { ...idle.events, running: 1 },
  };

  assert.equal(daemonSupervisorAction(idle, 'launchd', false), 'migrate');
  assert.equal(daemonSupervisorAction(busy, 'launchd', false), 'reuse');
  assert.equal(daemonSupervisorAction(idle, 'launchd', true), 'reuse');
  assert.equal(daemonSupervisorAction(idle, 'detached', false), 'reuse');
});

test('daemon process liveness treats EPERM as live and ESRCH as exited', () => {
  assert.equal(daemonProcessIsLive(123, () => undefined), true);
  assert.equal(daemonProcessIsLive(123, () => {
    throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
  }), true);
  assert.equal(daemonProcessIsLive(123, () => {
    throw Object.assign(new Error('not found'), { code: 'ESRCH' });
  }), false);
});

test('daemon abort wait resolves when shutdown happened before the listener was attached', async () => {
  const controller = new AbortController();
  controller.abort();
  await waitForAbort(controller.signal);
});

test('daemon mutation gate blocks shutdown races and rejects work after shutdown starts', async () => {
  const gate = new DaemonMutationGate();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = gate.run(async () => {
    await blocked;
    return 'done';
  });

  assert.equal(gate.active, 1);
  assert.equal(gate.beginShutdown(), false);
  release();
  assert.equal(await operation, 'done');
  assert.equal(gate.active, 0);
  assert.equal(gate.beginShutdown(), true);
  await assert.rejects(gate.run(async () => 'late'), /正在关闭/);

  const signalGate = new DaemonMutationGate();
  let releaseSignal!: () => void;
  const signalBlock = new Promise<void>((resolve) => { releaseSignal = resolve; });
  const active = signalGate.run(async () => { await signalBlock; });
  let drained = false;
  const drain = signalGate.closeAndWait().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  await assert.rejects(signalGate.run(async () => undefined), /正在关闭/);
  releaseSignal();
  await active;
  await drain;
  assert.equal(drained, true);
});

test('launchd provider readiness requires the selected key in the persisted env file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-launchd-key-'));
  const environmentFile = path.join(root, '.env');
  const openai = testConfig(root);
  const deepseek = { ...openai, provider: 'deepseek' as const };

  await writeFile(environmentFile, 'OPENAI_API_KEY="persisted-openai"\n');
  assert.equal(await launchAgentProviderConfigured(openai, environmentFile), true);
  assert.equal(await launchAgentProviderConfigured(deepseek, environmentFile), false);

  await writeFile(environmentFile, 'DEEPSEEK_API_KEY=persisted-deepseek\n');
  assert.equal(await launchAgentProviderConfigured(openai, environmentFile), false);
  assert.equal(await launchAgentProviderConfigured(deepseek, environmentFile), true);
  assert.equal(await launchAgentProviderConfigured(openai, path.join(root, 'missing.env')), false);
});

test('memory pages traverse the maximum normal store without exceeding an IPC request frame', () => {
  const memories: Memory[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `memory-${index}`,
    type: 'fact',
    content: `${index}:` + '界'.repeat(1_995),
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    source: 'agent',
    sourceSessionId: 'owner-session',
    sourceActor: 'owner',
    recordedAt: '2026-07-15T00:00:00.000Z',
  }));
  const ids: string[] = [];
  let offset = 0;
  let revision: string | undefined;
  while (true) {
    const page = createMimiMemoryPage(memories, offset, revision);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024 * 1024);
    ids.push(...page.items.map((item) => item.id));
    revision = page.revision;
    if (page.nextOffset === undefined) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.deepEqual(ids, memories.map((memory) => memory.id));
  assert.throws(
    () => createMimiMemoryPage([{ ...memories[0]!, content: 'changed' }], 0, revision),
    /读取期间发生变化/,
  );
});

test('chat snapshot reads the requested canonical FileSession without switching the active Session', async () => {
  const calls: string[] = [];
  const now = new Date().toISOString();
  const items = [
    { role: 'user', content: 'CANONICAL_USER_INPUT' },
    { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-1', name: 'read_file', output: 'CANONICAL_TOOL_RESULT' },
    { role: 'assistant', content: 'CANONICAL_FULL_ANSWER' },
  ] as Awaited<ReturnType<MimiAgent['history']>>;
  const host = {
    currentSessionId: 'currently-active',
    snapshot: async (sessionId: string) => {
      calls.push(`snapshot:${sessionId}`);
      return {
        sessionId,
        summary: {
          id: sessionId, title: 'Requested Session', preview: 'canonical', updatedAt: now,
          turns: 1, recoverable: true,
        },
        items,
        plan: [{ id: 'inspect', description: '检查项目', status: 'running' as const }],
        recovery: {
          runId: 'run-1', status: 'interrupted' as const, input: 'CANONICAL_USER_INPUT',
          phase: '模型执行中', startedAt: now, updatedAt: now,
        },
        runtime: {
          provider: 'openai' as const,
          model: 'requested-model',
          mode: { id: 'plan' as const, label: '计划', description: '只读规划', instruction: 'read only' },
          outputLevel: 'trace' as const,
        },
        context: { estimatedTokens: 321, contextWindow: 64_000 },
      };
    },
    switchSession: async () => { throw new Error('snapshot must not switch Session'); },
    runtimeInfo: async () => { throw new Error('snapshot must not read mutable runtime state'); },
    contextInfo: async () => { throw new Error('snapshot must not read mutable context state'); },
  } as unknown as MimiHost;

  const snapshot = await createMimiChatSnapshot(host, 'requested-session', '/workspace');

  assert.deepEqual(calls, ['snapshot:requested-session']);
  assert.equal(host.currentSessionId, 'currently-active');
  assert.equal(snapshot.sessionId, 'requested-session');
  assert.equal(snapshot.workspaceRoot, '/workspace');
  assert.equal(snapshot.model, 'requested-model');
  assert.equal(snapshot.mode, '计划');
  assert.equal(snapshot.outputLevel, 'trace');
  assert.equal(snapshot.contextUsed, 321);
  assert.equal(snapshot.contextWindow, 64_000);
  assert.deepEqual(snapshot.items, [items[0], items[3]]);
  assert.deepEqual(snapshot.plan, [{ id: 'inspect', description: '检查项目', status: 'running' }]);
  assert.equal(snapshot.recovery?.status, 'interrupted');

  const history = await createMimiHistoryChunk(host, 'requested-session');
  assert.deepEqual(JSON.parse(history.chunk), items);
  assert.equal(history.nextOffset, undefined);
  assert.equal(history.revision.length, 64);
});

test('chat history chunks preserve oversized canonical items below the IPC line limit', async () => {
  const content = `BEGIN_${'历史'.repeat(180_000)}_END`;
  const items = [{ role: 'user', content }] as Awaited<ReturnType<MimiAgent['history']>>;
  const host = {
    snapshot: async () => ({ items }),
  } as unknown as Pick<MimiHost, 'snapshot'>;

  const first = await createMimiHistoryChunk(host, 'owner');
  assert.ok(first.nextOffset);
  const second = await createMimiHistoryChunk(host, 'owner', first.nextOffset, first.revision);
  assert.deepEqual(JSON.parse(first.chunk + second.chunk), items);
  assert.equal(second.nextOffset, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(first), 'utf8') < 1024 * 1024);
});

test('launchd service keeps secrets out of plist and escapes local paths', () => {
  const config: AppConfig = {
    provider: 'deepseek', workspaceRoot: '/tmp/work & life', dataRoot: '/tmp/data',
    daemonDataRoot: '/tmp/mimi', skillsRoot: '/tmp/skills', mcpConfig: '/tmp/mcp.json',
    historyLimit: 41, contextWindow: 128_000, outputReserve: 8_000, maxTurns: 201,
    teamMaxConcurrency: 3, permissionMode: 'workspace', trustedWorkspaceMcp: '/tmp/work & life',
  };
  const previous = process.env.OPENAI_API_KEY;
  const previousAssistant = process.env.MIMI_ASSISTANT_CONFIG;
  const previousEnvironmentFile = process.env.MIMI_ENV_FILE;
  process.env.OPENAI_API_KEY = 'must-not-appear';
  process.env.MIMI_ASSISTANT_CONFIG = '/tmp/personal & quiet.json';
  process.env.MIMI_ENV_FILE = './config/private.env';
  try {
    const plist = launchAgentPlist(config, '/tmp/mimi agent/index.js', ['--import', 'tsx']);
    assert.match(plist, /com\.mimiagent\.daemon/);
    assert.match(plist, /\/tmp\/work &amp; life/);
    assert.match(plist, /\/tmp\/mimi agent\/index\.js/);
    assert.doesNotMatch(plist, /must-not-appear/);
    assert.match(plist, /MIMI_ASSISTANT_CONFIG/);
    assert.match(plist, /\/tmp\/personal &amp; quiet\.json/);
    assert.match(plist, /MIMI_CONNECTORS_CONFIG/);
    assert.match(plist, /\/tmp\/mimi\/connectors\.json/);
    assert.match(plist, /MIMI_MCP_CONFIG/);
    assert.match(plist, /\/tmp\/mcp\.json/);
    assert.match(plist, /MIMI_TRUST_WORKSPACE_MCP/);
    assert.match(plist, /MIMI_CONTEXT_WINDOW/);
    assert.match(plist, /KeepAlive/);

    assert.deepEqual(daemonLaunchEnvironment(config), {
      MIMI_MODEL_PROVIDER: 'deepseek',
      MIMI_CONFIG_VERSION: '3',
      MIMI_WORKSPACE: '/tmp/work & life',
      AGENT_WORKSPACE: '/tmp/work & life',
      MIMI_DATA_DIR: '/tmp/data',
      MIMI_DAEMON_DATA_DIR: '/tmp/mimi',
      MIMI_DAEMON_SOCKET: '/tmp/mimi/mimi.sock',
      MIMI_SKILLS_DIR: '/tmp/skills',
      MIMI_MCP_CONFIG: '/tmp/mcp.json',
      MIMI_HISTORY_LIMIT: '41',
      MIMI_CONTEXT_WINDOW: '128000',
      MIMI_OUTPUT_TOKEN_RESERVE: '8000',
      MIMI_MAX_TURNS: '201',
      MIMI_TEAM_MAX_CONCURRENCY: '3',
      MIMI_PERMISSION_MODE: 'workspace',
      MIMI_TRUST_WORKSPACE_MCP: '/tmp/work & life',
      MIMI_SESSION: 'mimi-system',
      AGENT_SESSION: 'mimi-system',
      MIMI_CONNECTORS_CONFIG: '/tmp/mimi/connectors.json',
      MIMI_ASSISTANT_CONFIG: '/tmp/personal & quiet.json',
      MIMI_ENV_FILE: path.resolve('./config/private.env'),
      DOTENV_CONFIG_PATH: path.resolve('./config/private.env'),
    });
    assert.equal(
      daemonLaunchEnvironment({ ...config, permissionMode: undefined }).MIMI_PERMISSION_MODE,
      'trusted',
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    if (previousAssistant === undefined) delete process.env.MIMI_ASSISTANT_CONFIG;
    else process.env.MIMI_ASSISTANT_CONFIG = previousAssistant;
    if (previousEnvironmentFile === undefined) delete process.env.MIMI_ENV_FILE;
    else process.env.MIMI_ENV_FILE = previousEnvironmentFile;
  }
});

test('initializes absolute macOS connectors once without overwriting owner changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-initialize-'));
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = testConfig(root);
  const previousConnectors = process.env.MIMI_CONNECTORS_CONFIG;
  const previousAssistant = process.env.MIMI_ASSISTANT_CONFIG;
  delete process.env.MIMI_CONNECTORS_CONFIG;
  delete process.env.MIMI_ASSISTANT_CONFIG;
  try {
    const initialized = await initializeMimi(config, { platform: 'darwin', runtimeRoot });
    assert.equal(initialized.connectors.created, true);
    assert.equal(initialized.connectors.updatedActions, 0);
    assert.equal(initialized.assistant.created, true);
    assert.deepEqual(initialized.connectors.enabled.sort(), [
      'macos-browser', 'macos-contacts', 'macos-desktop', 'macos-life', 'macos-mail',
      'macos-messages', 'macos-notes', 'macos-screen', 'macos-shortcuts', 'macos-system', 'macos-voice',
    ]);
    assert.equal((await stat(initialized.connectors.file)).mode & 0o777, 0o600);
    assert.equal((await stat(initialized.assistant.file)).mode & 0o777, 0o600);
    const controlTokenFile = controlTokenPathForSocket(path.join(config.daemonDataRoot!, 'mimi.sock'));
    const controlToken = await readControlToken(path.join(config.daemonDataRoot!, 'mimi.sock'));
    assert.match(controlToken ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(controlTokenFile)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(initialized), new RegExp(controlToken!));
    const connectors = JSON.parse(await readFile(initialized.connectors.file, 'utf8')) as {
      connectors: Record<string, {
        enabled: boolean;
        source: string;
        trust: string;
        command: string;
        args: string[];
        envAllowlist: string[];
        deliveryTimeoutMs: number;
        actionTimeoutMs: number;
        syncTemplateActions: boolean;
        actions: Record<string, { description: string }>;
      }>;
    };
    for (const connector of Object.values(connectors.connectors)) {
      assert.equal(connector.command, process.execPath);
      assert.doesNotMatch(JSON.stringify(connector.args), /\/absolute\/path\/to\/(?:MimiAgent|MimiAgent)/);
      assert.ok(connector.args.every((argument) => !argument.endsWith('.mjs') || path.isAbsolute(argument)));
    }
    assert.equal(connectors.connectors.qq?.enabled, false);
    assert.equal(connectors.connectors['http-action']?.enabled, false);
    assert.equal(connectors.connectors.radar?.enabled, false);
    assert.equal(connectors.connectors['file-radar']?.trust, 'external');
    assert.equal(connectors.connectors['macos-system']?.source, 'macos-system');
    assert.equal(connectors.connectors['macos-system']?.trust, 'system');
    assert.equal(connectors.connectors['macos-life']?.trust, 'external');
    assert.equal(connectors.connectors['macos-mail']?.trust, 'external');
    assert.equal(connectors.connectors['macos-messages']?.trust, 'external');
    assert.equal(connectors.connectors['macos-desktop']?.trust, 'external');
    assert.equal(connectors.connectors['macos-voice']?.trust, 'external');
    assert.equal(connectors.connectors['macos-voice']?.deliveryTimeoutMs, 60_000);
    assert.ok(connectors.connectors['macos-voice']?.envAllowlist.includes('MACOS_VOICE_REPLY_MAX_CHARS'));
    assert.ok(connectors.connectors['macos-voice']?.envAllowlist.includes('MACOS_VOICE_REPLY_RATE'));
    assert.ok(connectors.connectors['macos-voice']?.envAllowlist.includes('MACOS_VOICE_STATE_FILE'));
    assert.ok(connectors.connectors['macos-desktop']?.envAllowlist.includes('MACOS_DESKTOP_STATE_FILE'));
    assert.ok(connectors.connectors['macos-desktop']?.actions.clipboard_watch_status);
    assert.ok(connectors.connectors['macos-desktop']?.actions.clipboard_watch_start);
    assert.ok(connectors.connectors['macos-desktop']?.actions.clipboard_watch_stop);
    assert.ok(connectors.connectors['macos-life']?.envAllowlist.includes('MACOS_LIFE_MAX_ITEMS'));
    assert.ok(connectors.connectors['macos-life']?.envAllowlist.includes('MACOS_LIFE_STATE_FILE'));

    connectors.connectors['macos-mail']!.enabled = false;
    connectors.connectors['macos-mail']!.syncTemplateActions = false;
    delete connectors.connectors['macos-mail']!.actions.delete_message;
    delete connectors.connectors['macos-messages']!.actions.save_attachment;
    connectors.connectors['macos-messages']!.actions.send_message!.description = 'Owner custom send description';
    connectors.connectors['macos-messages']!.envAllowlist = ['OWNER_MESSAGES_TOKEN'];
    connectors.connectors['macos-messages']!.actionTimeoutMs = 65_432;
    connectors.connectors['macos-messages']!.command = 'node';
    connectors.connectors['macos-mail']!.command = '/owner/custom-node';
    connectors.connectors['macos-notes']!.args = [path.join(root, 'custom-notes.mjs')];
    delete connectors.connectors['macos-notes']!.actions.append_note;
    const packagedSystemArgs = [...connectors.connectors['macos-system']!.args];
    connectors.connectors['macos-system']!.source = 'system';
    connectors.connectors['macos-system']!.trust = 'trusted';
    connectors.connectors['macos-system']!.args = [path.join(root, 'spoof', 'macos-system-connector.mjs')];
    await writeFile(initialized.connectors.file, `${JSON.stringify(connectors, null, 2)}\n`);
    const repeated = await initializeMimi(config, { platform: 'darwin', runtimeRoot });
    assert.equal(repeated.connectors.created, false);
    assert.equal(repeated.connectors.updatedActions, 1);
    assert.equal(repeated.assistant.created, false);
    assert.equal(repeated.connectors.enabled.includes('macos-mail'), false);
    const upgraded = JSON.parse(await readFile(initialized.connectors.file, 'utf8')) as typeof connectors;
    assert.ok(upgraded.connectors['macos-messages']!.actions.save_attachment);
    assert.equal(upgraded.connectors['macos-messages']!.actions.send_message!.description, 'Owner custom send description');
    assert.deepEqual(upgraded.connectors['macos-messages']!.envAllowlist, ['OWNER_MESSAGES_TOKEN']);
    assert.equal(upgraded.connectors['macos-messages']!.actionTimeoutMs, 65_432);
    assert.equal(upgraded.connectors['macos-messages']!.command, process.execPath);
    assert.equal(upgraded.connectors['macos-mail']!.command, '/owner/custom-node');
    assert.equal(upgraded.connectors['macos-mail']!.actions.delete_message, undefined);
    assert.equal(upgraded.connectors['macos-mail']!.enabled, false);
    assert.equal(upgraded.connectors['macos-notes']!.actions.append_note, undefined);
    assert.deepEqual(upgraded.connectors['macos-notes']!.args, [path.join(root, 'custom-notes.mjs')]);
    assert.equal(upgraded.connectors['macos-system']!.source, 'system');
    assert.equal(upgraded.connectors['macos-system']!.trust, 'trusted');

    upgraded.connectors['macos-system']!.args = packagedSystemArgs;
    await writeFile(initialized.connectors.file, `${JSON.stringify(upgraded, null, 2)}\n`);
    const canonicalUpgrade = await initializeMimi(config, { platform: 'darwin', runtimeRoot });
    assert.equal(canonicalUpgrade.connectors.updatedActions, 0);
    const canonical = JSON.parse(await readFile(initialized.connectors.file, 'utf8')) as typeof connectors;
    assert.equal(canonical.connectors['macos-system']!.source, 'macos-system');
    assert.equal(canonical.connectors['macos-system']!.trust, 'system');
    const beforeIdempotent = await readFile(initialized.connectors.file, 'utf8');
    const idempotent = await initializeMimi(config, { platform: 'darwin', runtimeRoot });
    assert.equal(idempotent.connectors.updatedActions, 0);
    assert.equal(await readFile(initialized.connectors.file, 'utf8'), beforeIdempotent);
    assert.equal(await readControlToken(path.join(config.daemonDataRoot!, 'mimi.sock')), controlToken);
  } finally {
    if (previousConnectors === undefined) delete process.env.MIMI_CONNECTORS_CONFIG;
    else process.env.MIMI_CONNECTORS_CONFIG = previousConnectors;
    if (previousAssistant === undefined) delete process.env.MIMI_ASSISTANT_CONFIG;
    else process.env.MIMI_ASSISTANT_CONFIG = previousAssistant;
  }
});

test('initialization disables known QQ and WeChat UI fallbacks when protocol bridges are enabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-legacy-im-migration-'));
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = testConfig(root);
  const initialized = await initializeMimi(config, { platform: 'darwin', runtimeRoot });
  const current = JSON.parse(await readFile(initialized.connectors.file, 'utf8')) as {
    connectors: Record<string, Record<string, unknown>>;
  };
  current.connectors.qq!.enabled = true;
  current.connectors['openclaw-weixin']!.enabled = true;
  current.connectors['openclaw-weixin']!.envAllowlist = ['OPENCLAW_BIN'];
  current.connectors['qq-applescript'] = {
    enabled: true, command: process.execPath,
    args: [path.join(runtimeRoot, 'examples/connectors/qq-applescript-connector.mjs')],
    source: 'qq', actions: {},
  };
  current.connectors['wechat-applescript'] = {
    enabled: true, command: process.execPath,
    args: [path.join(runtimeRoot, 'examples/connectors/wechat-applescript-connector.mjs')],
    source: 'wechat', actions: {},
  };
  await writeFile(initialized.connectors.file, `${JSON.stringify(current, null, 2)}\n`);

  await initializeMimi(config, { platform: 'darwin', runtimeRoot });
  const migrated = JSON.parse(await readFile(initialized.connectors.file, 'utf8')) as typeof current;
  assert.equal(migrated.connectors['qq-applescript']?.enabled, false);
  assert.equal(migrated.connectors['wechat-applescript']?.enabled, false);
  assert.equal(migrated.connectors.qq?.enabled, true);
  assert.equal(migrated.connectors['openclaw-weixin']?.enabled, true);
  assert.deepEqual(
    migrated.connectors['openclaw-weixin']?.envAllowlist,
    ['OPENCLAW_BIN', 'MIMI_DAEMON_SOCKET'],
  );
});

test('upgrades an existing macOS connector file with missing default connectors only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-connector-upgrade-'));
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = testConfig(root);
  const connectorFile = path.join(config.daemonDataRoot!, 'connectors.json');
  await mkdir(path.dirname(connectorFile), { recursive: true });
  await writeFile(connectorFile, JSON.stringify({
    connectors: {
      qq: {
        enabled: true,
        command: '/owner/custom-qq',
        args: [],
        source: 'owner-qq',
        trust: 'owner',
        actions: {},
      },
    },
  }));

  const initialized = await initializeMimi(config, { platform: 'darwin', runtimeRoot });
  const upgraded = JSON.parse(await readFile(connectorFile, 'utf8')) as {
    connectors: Record<string, {
      enabled: boolean;
      command: string;
      deliveryTimeoutMs: number;
      actionTimeoutMs: number;
    }>;
  };
  assert.equal(initialized.connectors.created, false);
  assert.equal(upgraded.connectors.qq?.command, '/owner/custom-qq');
  assert.equal(upgraded.connectors['wechat-applescript'], undefined);
  assert.equal(upgraded.connectors.radar, undefined);
  assert.equal(upgraded.connectors['openclaw-weixin'], undefined);
});

test('doctor reports configured local assets and an offline daemon without reading user state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-doctor-'));
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = testConfig(root);
  const previousKey = process.env.OPENAI_API_KEY;
  const previousConnectors = process.env.MIMI_CONNECTORS_CONFIG;
  const previousAssistant = process.env.MIMI_ASSISTANT_CONFIG;
  process.env.OPENAI_API_KEY = 'fixture-key';
  delete process.env.MIMI_CONNECTORS_CONFIG;
  delete process.env.MIMI_ASSISTANT_CONFIG;
  try {
    await initializeMimi(config, { platform: process.platform, runtimeRoot });
    const controlToken = await readControlToken(path.join(config.daemonDataRoot!, 'mimi.sock'));
    assert.ok(controlToken);
    const report = await doctorMimi(config);
    assert.equal(report.provider.configured, true);
    assert.equal(report.connectors.configured, true);
    assert.ok(report.connectors.total >= 15);
    assert.deepEqual(report.connectors.missingScripts, []);
    assert.equal(report.daemon.running, false);
    assert.equal(report.ready, false);
    assert.ok(report.issues.includes('MimiAgent 后台服务未运行'));
    assert.ok(report.nextActions.includes('运行 mimi，后台服务会自动启动'));
    assert.doesNotMatch(JSON.stringify(report), /fixture-key/);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(controlToken));
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousConnectors === undefined) delete process.env.MIMI_CONNECTORS_CONFIG;
    else process.env.MIMI_CONNECTORS_CONFIG = previousConnectors;
    if (previousAssistant === undefined) delete process.env.MIMI_ASSISTANT_CONFIG;
    else process.env.MIMI_ASSISTANT_CONFIG = previousAssistant;
  }
});

test('doctor includes live connector outages and durable dead letters in readiness', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-doctor-live-'));
  const runtimeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = testConfig(root);
  const previousKey = process.env.OPENAI_API_KEY;
  const previousConnectors = process.env.MIMI_CONNECTORS_CONFIG;
  const previousAssistant = process.env.MIMI_ASSISTANT_CONFIG;
  process.env.OPENAI_API_KEY = 'fixture-key';
  delete process.env.MIMI_CONNECTORS_CONFIG;
  delete process.env.MIMI_ASSISTANT_CONFIG;
  let server: MimiIpcServer | undefined;
  try {
    await initializeMimi(config, { platform: process.platform, runtimeRoot });
    const status: DaemonStatus = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      permissionMode: 'trusted',
      pid: 123,
      startedAt: '2026-07-15T00:00:00.000Z',
      workerId: 'worker',
      workspaceRoot: root,
      activeHostMutations: 0,
      events: { queued: 0, running: 0, paused: 0, blocked: 0, completed: 2, ignored: 0, digested: 0, dead_letter: 2, archived: 0 },
      outbox: { pending: 0, sending: 0, sent: 2, dead_letter: 1, archived: 0 },
      enabledSchedules: 1,
    };
    const activity: MimiActivitySnapshot = {
      generatedAt: '2026-07-15T00:01:00.000Z',
      needsAttention: true,
      workPending: 3,
      pendingDigest: 0,
      enabledSchedules: 1,
      events: status.events,
      outbox: status.outbox,
      recentEvents: [],
      recentRuns: [],
      recentDeliveries: [],
      recentTransitions: [],
    };
    server = new MimiIpcServer(path.join(config.daemonDataRoot!, 'mimi.sock'), (method) => {
      if (method === 'status') return status;
      if (method === 'connectors.list') return [
        { id: 'mail', enabled: true, online: false, readiness: { inbound: 'unavailable', outbound: 'unavailable' }, source: 'mail', trust: 'owner', actions: [] },
        { id: 'calendar', enabled: true, online: true, readiness: { inbound: 'ready', outbound: 'ready' }, source: 'calendar', trust: 'owner', actions: [] },
        { id: 'qq', enabled: false, online: false, readiness: { inbound: 'unavailable', outbound: 'unavailable' }, source: 'qq', trust: 'owner', actions: [] },
      ];
      if (method === 'activity.get') return activity;
      throw new Error(`unexpected method: ${method}`);
    });
    await server.start();

    const report = await doctorMimi(config);
    assert.equal(report.ready, false);
    assert.deepEqual(report.connectors.runtime, {
      online: ['calendar'], offline: ['mail'], inboundReady: ['calendar'], outboundReady: ['calendar'], unavailable: [],
    });
    assert.deepEqual(report.daemon.activity, {
      needsAttention: true,
      workPending: 3,
      eventDeadLetters: 2,
      outboxDeadLetters: 1,
    });
    assert.ok(report.issues.some((issue) => /Connector 离线.*mail/.test(issue)));
    assert.ok(report.issues.includes('2 个事件进入 dead letter'));
    assert.ok(report.issues.includes('1 个消息投递进入 dead letter'));
    assert.ok(report.nextActions.includes('mimi daemon connectors reload'));
    assert.ok(report.nextActions.includes('mimi daemon events'));
    assert.ok(report.nextActions.includes('mimi daemon outbox'));
  } finally {
    await server?.close();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousConnectors === undefined) delete process.env.MIMI_CONNECTORS_CONFIG;
    else process.env.MIMI_CONNECTORS_CONFIG = previousConnectors;
    if (previousAssistant === undefined) delete process.env.MIMI_ASSISTANT_CONFIG;
    else process.env.MIMI_ASSISTANT_CONFIG = previousAssistant;
  }
});
