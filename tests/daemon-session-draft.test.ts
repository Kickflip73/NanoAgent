import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandHandler, type CommandTarget } from '../src/commands.js';
import { MimiChatClient, RemoteCommandTarget } from '../src/daemon/chat-client.js';
import { MIMI_BUILD_VERSION } from '../src/daemon/client-runtime.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from '../src/daemon/types.js';
import type { AppConfig } from '../src/config.js';

test('CLI adopts a running daemon workspace even when local workspace is explicitly configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-adopt-'));
  const localWorkspace = path.join(root, 'local');
  const daemonWorkspace = path.join(root, 'daemon-workspace');
  const socket = path.join(root, 'mimi.sock');
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot: daemonWorkspace,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method) => {
    if (method === 'status') return status;
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: path.join(localWorkspace, '.mimi-agent'),
      daemonDataRoot: root,
      workspaceRoot: localWorkspace,
      skillsRoot: path.join(localWorkspace, 'skills'),
      mcpConfig: path.join(localWorkspace, 'mcp.json'),
      provider: 'openai',
      permissionMode: 'trusted',
    } as AppConfig;
    let reconciledWorkspace: string | undefined;
    const client = new MimiChatClient(config, async (daemonConfig) => {
      reconciledWorkspace = daemonConfig.workspaceRoot;
      return status;
    });

    assert.equal((await client.connect()).workspaceRoot, daemonWorkspace);
    assert.equal(reconciledWorkspace, daemonWorkspace);
  } finally {
    await server.close();
  }
});

test('CLI re-adopts the workspace when the daemon is replaced', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-replaced-'));
  const socket = path.join(root, 'mimi.sock');
  const initialWorkspace = path.join(root, 'initial');
  const replacementWorkspace = path.join(root, 'replacement');
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot: initialWorkspace,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method) => {
    if (method === 'status') return status;
    if (method === 'chat.snapshot') return {
      sessionId: 'existing', draft: false, workspaceRoot: replacementWorkspace,
      provider: 'openai', model: 'fixture', mode: '通用', outputLevel: 'tools',
      contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: root, daemonDataRoot: root, workspaceRoot: initialWorkspace,
      provider: 'openai', permissionMode: 'trusted',
    } as AppConfig;
    const client = new MimiChatClient(config, async () => status);

    await client.connect();
    assert.equal((await client.snapshot()).workspaceRoot, replacementWorkspace);
  } finally {
    await server.close();
  }
});

test('a draft bootstrap adopts the replacement daemon workspace shown in the banner', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-draft-workspace-replaced-'));
  const socket = path.join(root, 'mimi.sock');
  const initialWorkspace = path.join(root, 'initial');
  const replacementWorkspace = path.join(root, 'replacement');
  let status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot: initialWorkspace,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'status') return status;
    if (method === 'chat.bootstrap') return {
      sessionId: (params as { draftSessionId: string }).draftSessionId,
      draft: true, workspaceRoot: replacementWorkspace,
      provider: 'openai', model: 'fixture', mode: '通用', outputLevel: 'tools',
      contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: root, daemonDataRoot: root, workspaceRoot: initialWorkspace,
      provider: 'openai', permissionMode: 'trusted',
    } as AppConfig;
    let reconciledWorkspace: string | undefined;
    const client = new MimiChatClient(config, async (daemonConfig) => {
      reconciledWorkspace = daemonConfig.workspaceRoot;
      return status;
    });

    await client.connect();
    status = { ...status, workspaceRoot: replacementWorkspace };
    assert.equal((await client.bootstrap('replacement-draft')).workspaceRoot, replacementWorkspace);
    assert.equal((await client.connect()).workspaceRoot, replacementWorkspace);
    assert.equal(reconciledWorkspace, replacementWorkspace);
  } finally {
    await server.close();
  }
});

test('CLI restarts an unavailable daemon and retries a draft bootstrap', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-bootstrap-reconnect-'));
  const socket = path.join(root, 'mimi.sock');
  const workspaceRoot = path.join(root, 'workspace');
  const status = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    buildVersion: MIMI_BUILD_VERSION,
    permissionMode: 'trusted',
    workspaceRoot,
  } as DaemonStatus;
  const server = new MimiIpcServer(socket, (method, params) => {
    if (method === 'status') return status;
    if (method === 'chat.bootstrap') return {
      sessionId: (params as { draftSessionId: string }).draftSessionId,
      draft: true, workspaceRoot, provider: 'openai', model: 'fixture', mode: '通用',
      outputLevel: 'tools', contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    throw new Error(`unexpected method: ${method}`);
  });
  const config = {
    dataRoot: root, daemonDataRoot: root, workspaceRoot,
    provider: 'openai', permissionMode: 'trusted',
  } as AppConfig;
  let starts = 0;
  const client = new MimiChatClient(config, async () => status, {
    startDaemon: async () => {
      starts += 1;
      await server.start();
      return status;
    },
  });
  try {
    assert.equal((await client.bootstrap('reconnected-draft')).sessionId, 'reconnected-draft');
    assert.equal(starts, 1);
  } finally {
    await server.close();
  }
});

test('a new command prepares an in-memory draft instead of switching a real Session', async () => {
  const calls: string[] = [];
  const target = {
    currentSessionId: 'existing',
    sessionReady: true,
    prepareNewSession: async () => { calls.push('prepare'); },
    switchSession: async () => { calls.push('switch'); },
  } as unknown as CommandTarget;
  const handler = new CommandHandler(target, async () => undefined, {
    resetScreen: async () => { calls.push('reset'); },
    write: () => undefined,
  });

  assert.equal(await handler.execute('/new'), 'handled');
  assert.deepEqual(calls, ['prepare', 'reset']);
});

test('a draft can list and select an existing Session without materializing itself', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-draft-'));
  const socket = path.join(root, 'mimi.sock');
  const methods: string[] = [];
  const server = new MimiIpcServer(socket, (method, params) => {
    methods.push(method);
    if (method === 'chat.bootstrap') return {
      sessionId: (params as { draftSessionId: string }).draftSessionId,
      draft: true,
      workspaceRoot: root,
      provider: 'openai', model: 'fixture', mode: '通用', outputLevel: 'tools',
      contextUsed: 0, contextWindow: 10_000, items: [], plan: [],
    };
    if (method === 'chat.sessions') return [{
      id: 'existing', title: 'MimiAgent 会话管理', preview: '继续讨论',
      updatedAt: new Date(0).toISOString(), turns: 2, recoverable: false,
    }];
    if (method === 'chat.invoke') return { sessionId: 'existing' };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const config = {
      dataRoot: root,
      daemonDataRoot: root,
      workspaceRoot: root,
      provider: 'openai',
      permissionMode: 'trusted',
    } as AppConfig;
    const client = new MimiChatClient(config);
    const draft = await client.bootstrap('mimi-chat-draft');
    const target = new RemoteCommandTarget(client, draft.sessionId, false);

    assert.equal(target.sessionReady, false);
    assert.equal((await target.listSessionSummaries())[0]?.id, 'existing');
    assert.equal(target.sessionReady, false);
    await target.switchSession('existing');
    assert.equal(target.currentSessionId, 'existing');
    assert.equal(target.sessionReady, true);
    assert.deepEqual(methods, ['chat.bootstrap', 'chat.sessions', 'chat.sessions', 'chat.invoke']);
  } finally {
    await server.close();
  }
});

test('Session-bound commands do not materialize a draft', async () => {
  const output: string[] = [];
  const target = {
    currentSessionId: 'mimi-chat-draft',
    sessionReady: false,
    runtimeInfo: async () => { throw new Error('must not touch the draft Session'); },
  } as unknown as CommandTarget;
  const handler = new CommandHandler(target, async () => undefined, {
    write: (message) => { output.push(message); },
  });

  assert.equal(await handler.execute('/status'), 'handled');
  assert.match(output[0] ?? '', /发送第一条消息后才会创建 Session/);
});
