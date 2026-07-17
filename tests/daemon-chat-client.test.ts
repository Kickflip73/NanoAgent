import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.js';
import { CommandHandler } from '../src/commands.js';
import {
  eventAnswer,
  eventEffects,
  MimiChatClient,
  RemoteCommandTarget,
  renderChatHistory,
  runMimiCli,
  synchronizeRemoteRuntimeEffects,
} from '../src/daemon/chat-client.js';
import { MimiIpcServer } from '../src/daemon/ipc.js';
import { createMimiMemoryContentChunk, createMimiMemoryPage } from '../src/daemon/service.js';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonStatus,
  type MimiChatSnapshot,
  type StoredEvent,
} from '../src/daemon/types.js';
import type { Memory } from '../src/core/memory.js';

function config(root: string): AppConfig {
  return {
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, 'data'),
    daemonDataRoot: path.join(root, 'mimi'), skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'), historyLimit: 40, maxTurns: 200,
  };
}

function event(status: StoredEvent['status'] = 'completed'): StoredEvent {
  const now = new Date().toISOString();
  return {
    id: '4c177243-5ce8-42c8-b8fa-d14947ebd653', externalId: 'external', source: 'local-cli',
    kind: 'command', trust: 'owner', payload: { prompt: '继续刚才的任务' }, occurredAt: now,
    receivedAt: now, priority: 100, profileId: 'owner', status, attempts: 1, notBefore: now,
    result: { answer: '来自同一个 Mimi Session 的回答' }, createdAt: now, updatedAt: now,
  };
}

test('Mimi chat client uses the daemon owner Session for status and canonical history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-client-'));
  const localConfig = config(root);
  const calls: Array<{ method: string; params: unknown }> = [];
  const status: DaemonStatus = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    permissionMode: 'trusted',
    pid: 42, startedAt: new Date().toISOString(), workerId: 'worker',
    workspaceRoot: root,
    activeHostMutations: 0,
    events: { queued: 0, running: 0, paused: 0, blocked: 0, completed: 1, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 }, enabledSchedules: 0,
  };
  const snapshot: MimiChatSnapshot = {
    sessionId: 'mimi-owner-4c1029697ee35871', provider: 'openai', model: 'fixture', mode: '标准',
    outputLevel: 'tools', workspaceRoot: root,
    contextUsed: 100, contextWindow: 10_000,
    plan: [],
    items: [
      { role: 'user', content: '继续刚才的任务' },
      { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '已有回答' }] },
    ],
    recovery: {
      runId: 'run-recovery', status: 'interrupted', input: '未完成输入', phase: '模型执行中',
      lastEvent: '正在读取项目', nextAction: '继续当前任务',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  };
  const server = new MimiIpcServer(path.join(localConfig.daemonDataRoot!, 'mimi.sock'), (method, params) => {
    calls.push({ method, params });
    if (method === 'status') return status;
    if (method === 'chat.snapshot') return snapshot;
    if (method === 'chat.invoke') return ['fixture', 'fixture-large'];
    if (method === 'submit') return { event: event('queued'), inserted: true };
    if (method === 'event.stream') return {
      events: [
        {
          sequence: 1, eventId: event().id, kind: 'status', tone: 'tool', title: 'run_shell',
          detail: '{"command":"pwd"}', next: '正在执行 run_shell',
        },
        { sequence: 2, eventId: event().id, kind: 'answer', text: '来自同一个 Mimi Session 的回答' },
      ],
      event: event(),
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient(localConfig, async (_config, current) => current);
    assert.equal((await client.connect()).pid, 42);
    assert.equal((await client.snapshot(30, snapshot.sessionId)).sessionId, snapshot.sessionId);
    assert.deepEqual(await client.invoke('models', undefined, snapshot.sessionId), ['fixture', 'fixture-large']);
    const accepted = await client.submit('继续刚才的任务', snapshot.sessionId);
    assert.equal(accepted.eventId, event().id);
    assert.equal(accepted.inserted, true);
    const streamed: string[] = [];
    const completed = await client.wait(accepted.eventId, undefined, (item) => {
      if (item.kind === 'status') streamed.push(item.title);
      else if (item.kind !== 'plan') streamed.push(item.text);
    });
    assert.equal(eventAnswer(completed), '来自同一个 Mimi Session 的回答');
    assert.deepEqual(streamed, ['run_shell', '来自同一个 Mimi Session 的回答']);
  } finally {
    await server.close();
  }
  assert.deepEqual(calls.map(({ method }) => method), ['status', 'chat.snapshot', 'chat.invoke', 'submit', 'event.stream']);
  assert.deepEqual(calls[2]?.params, {
    operation: 'models', profileId: 'owner', sessionKey: snapshot.sessionId,
  });
  assert.deepEqual(calls[3]?.params, {
    text: '继续刚才的任务', source: 'local-cli', trust: 'owner', profileId: 'owner', sessionKey: snapshot.sessionId,
    eventId: (calls[3]?.params as { eventId: string }).eventId,
    externalId: `local-cli:${(calls[3]?.params as { eventId: string }).eventId}`,
  });
  const history = renderChatHistory(snapshot, false);
  assert.match(history, /继续刚才的任务/);
  assert.match(history, /已有回答/);
  assert.match(history, /正在读取项目/);
  assert.match(history, /\/resume 继续/);
});

test('Mimi chat client drains every byte-bounded page before returning a terminal event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-pages-'));
  const localConfig = config(root);
  let page = 0;
  const server = new MimiIpcServer(path.join(localConfig.daemonDataRoot!, 'mimi.sock'), (method, params) => {
    if (method !== 'event.stream') throw new Error(`unexpected method: ${method}`);
    page += 1;
    const after = (params as { after: number }).after;
    if (page === 1) {
      assert.equal(after, 0);
      return {
        events: [{ sequence: 1, eventId: event().id, kind: 'answer', text: '第一段' }],
        event: event('completed'), nextSequence: 1, hasMore: true,
      };
    }
    assert.equal(after, 1);
    return {
      events: [{ sequence: 2, eventId: event().id, kind: 'answer', text: '第二段' }],
      event: event('completed'), nextSequence: 2, hasMore: false,
    };
  });
  await server.start();
  try {
    const streamed: string[] = [];
    const completed = await new MimiChatClient(localConfig).wait(event().id, undefined, (item) => {
      if (item.kind === 'answer') streamed.push(item.text);
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(streamed, ['第一段', '第二段']);
    assert.equal(page, 2);
  } finally {
    await server.close();
  }
});

test('Mimi chat client reconnects after a transient Unix socket disconnect and resumes its stream cursor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-reconnect-'));
  const localConfig = config(root);
  const socketPath = path.join(localConfig.daemonDataRoot!, 'mimi.sock');
  await mkdir(path.dirname(socketPath), { recursive: true });
  const status: DaemonStatus = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    permissionMode: 'trusted',
    pid: 42,
    startedAt: new Date().toISOString(),
    workerId: 'worker',
    workspaceRoot: root,
    activeHostMutations: 0,
    events: { queued: 0, running: 1, paused: 0, blocked: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 },
    enabledSchedules: 0,
  };
  const methods: string[] = [];
  const streamCursors: number[] = [];
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount += 1;
    if (connectionCount === 2) {
      // Drop one real IPC connection before it can write. Node reports EPIPE to the client.
      socket.destroy();
      return;
    }
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      input += chunk;
      const lineEnd = input.indexOf('\n');
      if (lineEnd < 0) return;
      const request = JSON.parse(input.slice(0, lineEnd)) as {
        id: string;
        method: string;
        params?: { after?: number };
      };
      methods.push(request.method);
      let result: unknown;
      if (request.method === 'status') {
        result = status;
      } else if (request.method === 'event.stream') {
        const after = request.params?.after ?? 0;
        streamCursors.push(after);
        result = after === 0
          ? {
              events: [{ sequence: 7, eventId: event().id, kind: 'answer', text: '第一段' }],
              event: event('running'),
              nextSequence: 7,
              hasMore: false,
            }
          : {
              events: [{ sequence: 8, eventId: event().id, kind: 'answer', text: '第二段' }],
              event: event('completed'),
              nextSequence: 8,
              hasMore: false,
            };
      } else {
        throw new Error(`unexpected method: ${request.method}`);
      }
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    const streamed: string[] = [];
    const client = new MimiChatClient(localConfig, async (_config, current) => current);
    const completed = await client.wait(event().id, undefined, (item) => {
      if (item.kind === 'answer') streamed.push(item.text);
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(streamed, ['第一段', '第二段']);
    assert.deepEqual(methods, ['event.stream', 'status', 'event.stream']);
    assert.deepEqual(streamCursors, [0, 7]);
    assert.equal(connectionCount, 4);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('chat submit reconciles a lost response without creating a second event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-submit-reconcile-'));
  const localConfig = config(root);
  let accepted: StoredEvent | undefined;
  let submitCalls = 0;
  const server = new MimiIpcServer(
    path.join(localConfig.daemonDataRoot!, 'mimi.sock'),
    async (method, params) => {
      if (method === 'submit') {
        submitCalls += 1;
        const request = params as { eventId: string; externalId: string; text: string };
        accepted = {
          ...event('queued'), id: request.eventId, externalId: request.externalId,
          payload: { prompt: request.text },
        };
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { event: accepted, inserted: true };
      }
      if (method === 'event.get') return accepted;
      throw new Error(`unexpected method: ${method}`);
    },
  );
  await server.start();
  try {
    const client = new MimiChatClient(localConfig, undefined, { submitTimeoutMs: 20 });
    const result = await client.submit('只发送一次', 'owner-session');
    assert.equal(result.eventId, accepted?.id);
    assert.equal(result.inserted, true);
    assert.equal(submitCalls, 1);
  } finally {
    await server.close();
  }
});

test('chat submit retries the same idempotent event after consecutive IPC timeouts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-submit-retry-'));
  const localConfig = config(root);
  let submitCalls = 0;
  const eventIds: string[] = [];
  const server = new MimiIpcServer(
    path.join(localConfig.daemonDataRoot!, 'mimi.sock'),
    async (method, params) => {
      if (method === 'event.get') return undefined;
      if (method !== 'submit') throw new Error(`unexpected method: ${method}`);
      submitCalls += 1;
      const request = params as { eventId: string; externalId: string };
      eventIds.push(request.eventId);
      if (submitCalls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return {
        event: { ...event('queued'), id: request.eventId, externalId: request.externalId },
        inserted: true,
      };
    },
  );
  await server.start();
  try {
    const client = new MimiChatClient(localConfig, async (_config, current) => current, {
      submitTimeoutMs: 10,
      submitRetryDeadlineMs: 1_000,
    });
    const accepted = await client.submit('超时后继续', 'owner-session');
    assert.equal(accepted.eventId, eventIds[0]);
    assert.equal(submitCalls, 2);
    assert.equal(new Set(eventIds).size, 1);
  } finally {
    await server.close();
  }
});

test('remote command target uses narrow daemon RPCs for background task management', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-tasks-'));
  const localConfig = config(root);
  const taskId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const calls: Array<{ method: string; params: unknown }> = [];
  const task = {
    taskId,
    status: 'running',
    objective: '在后台完成大型项目',
    strategy: 'team',
    sessionId: `mimi-task-${taskId}`,
    originSessionId: 'owner-session',
    depth: 1,
    attempts: 1,
    createdAt: '2026-07-16T01:00:00.000Z',
    updatedAt: '2026-07-16T01:05:00.000Z',
  };
  const server = new MimiIpcServer(path.join(localConfig.daemonDataRoot!, 'mimi.sock'), (method, params) => {
    calls.push({ method, params });
    if (method === 'tasks.list') return [task];
    if (method === 'tasks.get') return task;
    if (method === 'tasks.cancel') return { state: 'cancelled' };
    if (method === 'tasks.pause') return { state: 'paused' };
    if (method === 'tasks.resume') return { state: 'resumed' };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const target = new RemoteCommandTarget(new MimiChatClient(localConfig), 'owner-session');
    assert.deepEqual(await target.listBackgroundTasks(7), [task]);
    assert.deepEqual(await target.inspectBackgroundTask(taskId), task);
    assert.deepEqual(await target.cancelBackgroundTask(taskId, 'owner changed direction'), { state: 'cancelled' });
    assert.deepEqual(await target.pauseBackgroundTask(taskId, 'wait for dependency'), { state: 'paused' });
    assert.deepEqual(await target.resumeBackgroundTask(taskId, 'dependency is ready'), { state: 'resumed' });
  } finally {
    await server.close();
  }
  assert.deepEqual(calls, [
    { method: 'tasks.list', params: { limit: 7 } },
    { method: 'tasks.get', params: { id: taskId } },
    { method: 'tasks.cancel', params: { id: taskId, reason: 'owner changed direction' } },
    { method: 'tasks.pause', params: { id: taskId, reason: 'wait for dependency' } },
    { method: 'tasks.resume', params: { id: taskId, context: 'dependency is ready' } },
  ]);
});

test('remote command target reconstructs every revision-checked memory page', async () => {
  const calls: unknown[] = [];
  const client = {
    invoke: async (operation: string, value: unknown) => {
      assert.equal(operation, 'memories.page');
      calls.push(value);
      const request = value as { offset: number; revision?: string };
      if (request.offset === 0) return {
        items: [{
          index: 0, id: 'm1', type: 'fact', content: 'first', contentBytes: 5, contentTruncated: false,
          createdAt: '2026-07-15T00:00:00.000Z', recordedAt: '2026-07-15T00:00:00.000Z',
        }],
        nextOffset: 1,
        revision: 'revision-1',
        total: 2,
      };
      return {
        items: [{
          index: 1, id: 'm2', type: 'todo', content: 'second', contentBytes: 6, contentTruncated: false,
          createdAt: '2026-07-15T00:00:00.000Z', recordedAt: '2026-07-15T00:00:00.000Z',
        }],
        revision: 'revision-1',
        total: 2,
      };
    },
  } as unknown as MimiChatClient;
  const target = new RemoteCommandTarget(client, 'owner-session');

  assert.deepEqual((await target.listMemories()).map((memory) => memory.id), ['m1', 'm2']);
  assert.deepEqual(calls, [
    { offset: 0, revision: undefined },
    { offset: 1, revision: 'revision-1' },
  ]);
});

test('remote command target reconstructs oversized legacy memory content without silent truncation', async () => {
  const content = 'legacy:' + '界'.repeat(40_000);
  const memories: Memory[] = [{
    id: 'legacy-memory', type: 'fact', content,
    createdAt: '2026-07-15T00:00:00.000Z', confirmedAt: '2026-07-15T00:00:00.000Z',
  }];
  const client = {
    invoke: async (operation: string, value: unknown) => {
      const request = value as { index?: number; id?: string; offset?: number; revision?: string };
      if (operation === 'memories.page') {
        return createMimiMemoryPage(memories, request.offset, request.revision);
      }
      if (operation === 'memory.content') {
        return createMimiMemoryContentChunk(
          memories,
          request.index!,
          request.id!,
          request.offset,
          request.revision,
        );
      }
      throw new Error(`unexpected operation: ${operation}`);
    },
  } as unknown as MimiChatClient;

  const listed = await new RemoteCommandTarget(client, 'owner-session').listMemories();
  assert.equal(listed[0]?.content, content);
  assert.equal((listed[0] as { contentTruncated?: boolean }).contentTruncated, false);
});

test('one-shot daemon CLI honors MIMI_SESSION when selecting its initial Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-session-'));
  const localConfig = config(root);
  const calls: Array<{ method: string; params: unknown }> = [];
  const previousMimi = process.env.MIMI_SESSION;
  const previousAgent = process.env.AGENT_SESSION;
  process.env.MIMI_SESSION = 'preferred-session';
  process.env.AGENT_SESSION = 'legacy-session';
  const status: DaemonStatus = {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    permissionMode: 'trusted',
    pid: 42, startedAt: new Date().toISOString(), workerId: 'worker', workspaceRoot: root,
    activeHostMutations: 0,
    events: { queued: 0, running: 0, paused: 0, blocked: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 }, enabledSchedules: 0,
  };
  const server = new MimiIpcServer(path.join(localConfig.daemonDataRoot!, 'mimi.sock'), (method, params) => {
    calls.push({ method, params });
    if (method === 'status') return status;
    if (method === 'chat.snapshot') return {
      sessionId: (params as { sessionKey: string }).sessionKey,
      provider: 'openai', model: 'fixture', mode: '标准', outputLevel: 'answer', workspaceRoot: root,
      contextUsed: 0, contextWindow: 10_000, plan: [], items: [],
    } satisfies MimiChatSnapshot;
    if (method === 'submit') return { event: event('queued'), inserted: true };
    if (method === 'event.stream') return { events: [], event: event('completed') };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    await runMimiCli(
      localConfig,
      ['测试指定会话'],
      '0.0.0',
      async (_config, current) => current,
    );
  } finally {
    await server.close();
    if (previousMimi === undefined) delete process.env.MIMI_SESSION;
    else process.env.MIMI_SESSION = previousMimi;
    if (previousAgent === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousAgent;
  }
  assert.deepEqual(calls[1], {
    method: 'chat.snapshot',
    params: { profileId: 'owner', limit: 30, sessionKey: 'preferred-session' },
  });
  assert.equal(calls[2]?.method, 'submit');
  assert.partialDeepStrictEqual(calls[2]?.params, {
    text: '测试指定会话', source: 'local-cli', trust: 'owner', profileId: 'owner',
    sessionKey: 'preferred-session',
  });
  const submitted = calls[2]?.params as { eventId?: string; externalId?: string };
  assert.match(submitted.eventId ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(submitted.externalId, `local-cli:${submitted.eventId}`);
});

test('Mimi chat client adopts the running daemon workspace when none was explicitly configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-adopt-'));
  const daemonWorkspace = path.join(root, 'daemon-workspace');
  const localWorkspace = path.join(root, 'local-workspace');
  const localConfig = config(localWorkspace);
  localConfig.daemonDataRoot = path.join(root, 'daemon-state');
  const socket = path.join(localConfig.daemonDataRoot, 'mimi.sock');
  const methods: string[] = [];
  const previousMimi = process.env.MIMI_WORKSPACE;
  const previousAgent = process.env.AGENT_WORKSPACE;
  let reconciledConfig: AppConfig | undefined;
  delete process.env.MIMI_WORKSPACE;
  delete process.env.AGENT_WORKSPACE;
  const server = new MimiIpcServer(socket, (method) => {
    methods.push(method);
    if (method === 'status') return {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      permissionMode: 'trusted',
      pid: 42, startedAt: new Date().toISOString(), workerId: 'worker', workspaceRoot: daemonWorkspace,
      activeHostMutations: 0,
      events: { queued: 0, running: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
      outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 }, enabledSchedules: 0,
    };
    if (method === 'chat.snapshot') return {
      sessionId: 'owner-session', provider: 'openai', model: 'fixture', mode: '标准', outputLevel: 'answer',
      workspaceRoot: daemonWorkspace, contextUsed: 0, contextWindow: 10_000, plan: [], items: [],
    } satisfies MimiChatSnapshot;
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient(localConfig, async (candidate, status) => {
      reconciledConfig = candidate;
      return status;
    });
    assert.equal((await client.connect()).workspaceRoot, daemonWorkspace);
    assert.equal((await client.snapshot()).workspaceRoot, daemonWorkspace);
    assert.deepEqual(methods, ['status', 'chat.snapshot']);
    assert.equal(reconciledConfig?.workspaceRoot, daemonWorkspace);
    assert.equal(reconciledConfig?.dataRoot, path.join(daemonWorkspace, '.mimi-agent'));
  } finally {
    await server.close();
    if (previousMimi === undefined) delete process.env.MIMI_WORKSPACE;
    else process.env.MIMI_WORKSPACE = previousMimi;
    if (previousAgent === undefined) delete process.env.AGENT_WORKSPACE;
    else process.env.AGENT_WORKSPACE = previousAgent;
  }
});

test('Mimi chat client rejects a daemon owned by another explicitly configured workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-workspace-'));
  const daemonWorkspace = path.join(root, 'daemon-workspace');
  const localWorkspace = path.join(root, 'local-workspace');
  const localConfig = config(localWorkspace);
  localConfig.daemonDataRoot = path.join(root, 'daemon-state');
  const socket = path.join(localConfig.daemonDataRoot, 'mimi.sock');
  const methods: string[] = [];
  const previousMimi = process.env.MIMI_WORKSPACE;
  const previousAgent = process.env.AGENT_WORKSPACE;
  process.env.MIMI_WORKSPACE = localWorkspace;
  delete process.env.AGENT_WORKSPACE;
  const server = new MimiIpcServer(socket, (method) => {
    methods.push(method);
    if (method === 'status') return {
      pid: 42, startedAt: new Date().toISOString(), workerId: 'worker', workspaceRoot: daemonWorkspace,
      events: { queued: 0, running: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
      outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 }, enabledSchedules: 0,
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient(localConfig);
    await assert.rejects(
      client.connect(),
      (error: Error) => error.message.includes('后台工作区不一致')
        && error.message.includes(daemonWorkspace)
        && error.message.includes(localWorkspace)
        && error.message.includes('已拒绝连接'),
    );
    assert.deepEqual(methods, ['status']);
  } finally {
    await server.close();
    if (previousMimi === undefined) delete process.env.MIMI_WORKSPACE;
    else process.env.MIMI_WORKSPACE = previousMimi;
    if (previousAgent === undefined) delete process.env.AGENT_WORKSPACE;
    else process.env.AGENT_WORKSPACE = previousAgent;
  }
});

test('Mimi chat client upgrades an idle legacy daemon with the adopted Host workspace config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-adopt-upgrade-'));
  const daemonWorkspace = path.join(root, 'daemon-workspace');
  const localWorkspace = path.join(root, 'local-workspace');
  const localConfig = config(localWorkspace);
  localConfig.daemonDataRoot = path.join(root, 'daemon-state');
  const socket = path.join(localConfig.daemonDataRoot, 'mimi.sock');
  const previousMimi = process.env.MIMI_WORKSPACE;
  const previousAgent = process.env.AGENT_WORKSPACE;
  let reconciledConfig: AppConfig | undefined;
  delete process.env.MIMI_WORKSPACE;
  delete process.env.AGENT_WORKSPACE;
  const legacy: DaemonStatus = {
    protocolVersion: DAEMON_PROTOCOL_VERSION - 1,
    permissionMode: 'trusted',
    pid: 42,
    startedAt: new Date().toISOString(),
    workerId: 'legacy-worker',
    workspaceRoot: daemonWorkspace,
    activeHostMutations: 0,
    events: { queued: 0, running: 0, paused: 0, blocked: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
    outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 },
    enabledSchedules: 0,
  };
  const server = new MimiIpcServer(socket, (method) => {
    if (method === 'status') return legacy;
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient(localConfig, async (candidate, current) => {
      reconciledConfig = candidate;
      assert.equal(current.protocolVersion, DAEMON_PROTOCOL_VERSION - 1);
      return {
        ...legacy,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        workerId: 'current-worker',
      };
    });
    assert.equal((await client.connect()).workerId, 'current-worker');
    assert.equal(reconciledConfig?.workspaceRoot, daemonWorkspace);
    assert.equal(reconciledConfig?.dataRoot, path.join(daemonWorkspace, '.mimi-agent'));
  } finally {
    await server.close();
    if (previousMimi === undefined) delete process.env.MIMI_WORKSPACE;
    else process.env.MIMI_WORKSPACE = previousMimi;
    if (previousAgent === undefined) delete process.env.AGENT_WORKSPACE;
    else process.env.AGENT_WORKSPACE = previousAgent;
  }
});

test('Mimi chat client does not stop a busy legacy daemon during protocol upgrade', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-protocol-busy-'));
  const localConfig = config(root);
  const methods: string[] = [];
  const server = new MimiIpcServer(path.join(localConfig.daemonDataRoot!, 'mimi.sock'), (method) => {
    methods.push(method);
    if (method === 'status') return {
      pid: 42, startedAt: new Date().toISOString(), workerId: 'legacy-worker', workspaceRoot: root,
      activeEventId: 'event-in-flight',
      events: { queued: 0, running: 1, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
      outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 }, enabledSchedules: 0,
    };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    await assert.rejects(
      new MimiChatClient(localConfig).connect(),
      /后台需要升级.*仍有活动任务.*等待任务完成后重试/,
    );
    assert.deepEqual(methods, ['status']);
  } finally {
    await server.close();
  }
});

test('/exit detaches an active CLI wait without cancelling the accepted background event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-detach-'));
  const localConfig = config(root);
  const calls: Array<{ method: string; params: unknown }> = [];
  let markStreamStarted!: () => void;
  const streamStarted = new Promise<void>((resolve) => { markStreamStarted = resolve; });
  const server = new MimiIpcServer(path.join(localConfig.daemonDataRoot!, 'mimi.sock'), (method, params) => {
    calls.push({ method, params });
    if (method === 'submit') return { event: event('queued'), inserted: true };
    if (method === 'event.stream') {
      markStreamStarted();
      return new Promise((resolve) => setTimeout(() => resolve({ events: [], event: event('running') }), 50));
    }
    if (method === 'event.cancel') return { state: 'cancelled' };
    throw new Error(`unexpected method: ${method}`);
  });
  await server.start();
  try {
    const client = new MimiChatClient(localConfig);
    const accepted = await client.submit('keep running after exit', 'owner-session');
    const detached = new AbortController();
    const waiting = client.wait(accepted.eventId, detached.signal);
    await streamStarted;
    detached.abort(new Error('终端已退出；MimiAgent 任务继续在后台执行'));
    await assert.rejects(waiting, /任务继续在后台执行/);
    assert.equal(calls.some(({ method }) => method === 'event.cancel'), false);

    assert.deepEqual(await client.cancel(accepted.eventId, '用户按下 Esc 取消任务'), { state: 'cancelled' });
    assert.deepEqual(calls.at(-1), {
      method: 'event.cancel',
      params: { id: accepted.eventId, reason: '用户按下 Esc 取消任务' },
    });
  } finally {
    await server.close();
  }
});

test('Mimi chat answer surfaces terminal errors instead of inventing a reply', () => {
  const failed = event('dead_letter');
  failed.result = undefined;
  failed.error = 'provider unavailable';
  assert.throws(() => eventAnswer(failed), /provider unavailable/);
});

test('remote CLI applies validated RuntimeEffects and synchronizes Session UI state', async () => {
  const completed = event();
  completed.result = {
    answer: '已切换',
    effects: [
      { type: 'model_changed', model: 'fixture-next' },
      { type: 'session_changed', sessionId: 'new-session' },
      { type: 'exit_requested' },
    ],
  };
  const effects = eventEffects(completed);
  const target = new RemoteCommandTarget({} as MimiChatClient, 'owner-session');
  const calls: string[] = [];
  await synchronizeRemoteRuntimeEffects(target, effects, {
    restoreSession: async () => { calls.push('restore'); },
    resetSession: async () => { calls.push('reset'); },
    close: () => { calls.push('close'); },
  });
  assert.equal(target.currentSessionId, 'new-session');
  assert.deepEqual(calls, ['restore', 'close']);

  await synchronizeRemoteRuntimeEffects(target, [{ type: 'session_cleared', sessionId: 'new-session' }], {
    restoreSession: async () => { calls.push('restore'); },
    resetSession: async () => { calls.push('reset'); },
    close: () => { calls.push('close'); },
  });
  assert.deepEqual(calls, ['restore', 'close', 'reset']);

  completed.result = { answer: 'bad', effects: [{ type: 'session_changed', sessionId: '../escape' }] };
  assert.throws(() => eventEffects(completed));
});

test('chat client reconstructs complete Session history from bounded IPC chunks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-chat-history-'));
  const localConfig = config(root);
  const source = JSON.stringify([
    { role: 'user', content: 'first' },
    { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
    { role: 'assistant', content: 'last' },
  ]);
  const requests: number[] = [];
  const server = new MimiIpcServer(path.join(localConfig.daemonDataRoot!, 'mimi.sock'), (method, params) => {
    if (method !== 'chat.history') throw new Error(`unexpected method: ${method}`);
    const request = params as { offset: number; revision?: string };
    requests.push(request.offset);
    if (request.revision && request.revision !== 'revision') throw new Error('revision mismatch');
    const end = Math.min(source.length, request.offset + 17);
    return {
      chunk: source.slice(request.offset, end), revision: 'revision', totalCharacters: source.length,
      nextOffset: end < source.length ? end : undefined,
    };
  });
  await server.start();
  try {
    const items = await new MimiChatClient(localConfig).history('owner-session');
    assert.equal(items.length, 3);
    assert.deepEqual(items[0], { role: 'user', content: 'first' });
    assert.ok(requests.length > 1);
  } finally {
    await server.close();
  }
});

test('remote CLI uses the shared CommandHandler and invokes real command operations', async () => {
  const calls: Array<{
    operation: string;
    value?: string;
    sessionKey?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }> = [];
  const outputs: string[] = [];
  const modelRuns: string[] = [];
  const currentSnapshot: MimiChatSnapshot = {
    sessionId: 'owner-session', provider: 'openai', model: 'fixture', mode: '标准', outputLevel: 'tools',
    workspaceRoot: '/workspace', contextUsed: 10, contextWindow: 10_000,
    plan: [],
    items: [{ role: 'user', content: 'canonical history' }],
  };
  const client = {
    snapshot: async () => currentSnapshot,
    history: async () => currentSnapshot.items,
    invoke: async (
      operation: string,
      value?: string,
      sessionKey?: string,
      timeoutMs?: number,
      signal?: AbortSignal,
    ) => {
      calls.push({ operation, value, sessionKey, timeoutMs, signal });
      if (operation === 'runtime') return {
        provider: 'openai', model: 'fixture', mode: { id: 'general', label: '标准' }, outputLevel: 'tools',
        sessionId: sessionKey, workspaceRoot: '/workspace', maxTurns: 200, skillCount: 0, memoryCount: 0,
        mcpServers: [], team: { total: 0, completed: 0, running: 0 }, guidanceFiles: [],
      };
      if (operation === 'models') return ['fixture', 'fixture-next'];
      if (operation === 'modes') return [
        { id: 'general', label: '标准', description: 'general' },
        { id: 'plan', label: '计划', description: 'read only' },
      ];
      if (operation === 'index') return { indexed: 1, target: value };
      if (operation === 'clear' || operation === 'model.set' || operation === 'mode.set') return {};
      throw new Error(`unexpected operation: ${operation}`);
    },
  } as unknown as MimiChatClient;
  const target = new RemoteCommandTarget(client, 'owner-session');
  const commands = new CommandHandler(target, async (input) => { modelRuns.push(input); }, {
    write: (text) => outputs.push(text),
  });
  const indexAbort = new AbortController();

  assert.equal(await commands.execute('/status'), 'handled');
  assert.equal(await commands.execute('/history'), 'handled');
  assert.equal(await commands.execute('/index docs', indexAbort.signal), 'handled');
  assert.equal(await commands.execute('/model fixture-next'), 'handled');
  assert.equal(await commands.execute('/mode plan'), 'handled');
  assert.equal(await commands.execute('/clear'), 'handled');
  commands.remember('retry this exact input');
  assert.equal(await commands.execute('/retry'), 'handled');

  assert.match(outputs.join('\n'), /canonical history/);
  assert.deepEqual(modelRuns, ['retry this exact input']);
  assert.ok(calls.some((call) => call.operation === 'index'
    && call.value === 'docs'
    && call.timeoutMs === 20 * 60_000
    && call.signal === indexAbort.signal));
  assert.ok(calls.some((call) => call.operation === 'model.set' && call.value === 'fixture-next'));
  assert.ok(calls.some((call) => call.operation === 'mode.set' && call.value === 'plan'));
  assert.ok(calls.some((call) => call.operation === 'clear'));
});
