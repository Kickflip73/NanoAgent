import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandHandler, type CommandTarget } from '../src/commands.js';
import { MimiChatClient, RemoteCommandTarget } from '../src/daemon/chat-client.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';
import type { AppConfig } from '../src/config.js';

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
