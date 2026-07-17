import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { createBackgroundTaskTools } from '../src/daemon/task-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { isSideEffectTool } from '../src/runtime/tool-policy.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';

function ownerEvent(): StoredEvent {
  const timestamp = new Date().toISOString();
  return {
    id: '11111111-1111-4111-8111-111111111111',
    externalId: 'owner-command',
    source: 'local-cli',
    kind: 'command',
    trust: 'owner',
    payload: { prompt: 'build it in background' },
    occurredAt: timestamp,
    receivedAt: timestamp,
    priority: 100,
    profileId: 'owner',
    sessionKey: 'conversation-a',
    status: 'running',
    attempts: 1,
    notBefore: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function invoke(tools: Tool[], name: string, input: unknown, callId = 'tool-call'): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected);
  return selected.invoke(
    new RunContext({}),
    JSON.stringify(input),
    { toolCall: { callId } } as never,
  );
}

test('delegate_background_task durably creates an isolated task Session and returns immediately', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-task-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createBackgroundTaskTools({
      store,
      event: ownerEvent(),
      sessionId: 'conversation-a',
    });
    const accepted = await invoke(tools, 'delegate_background_task', {
      objective: '构建并验证一个大型游戏项目',
      successCriteria: '测试通过并给出产物路径',
      strategy: 'team',
      workspaceAccess: 'read',
      priority: 80,
    }) as { taskId: string; sessionId: string; status: string; accepted: boolean; workspaceAccess: string };

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.status, 'queued');
    assert.equal(accepted.workspaceAccess, 'read');
    assert.match(accepted.sessionId, /^mimi-task-/);
    const task = store.getEvent(accepted.taskId)!;
    assert.equal(task.executionLane, 'task');
    assert.equal(task.originSessionKey, 'conversation-a');
    assert.equal(task.parentEventId, ownerEvent().id);
    assert.equal(task.rootEventId, ownerEvent().id);
    assert.equal(task.taskDepth, 1);
    assert.equal((task.payload as { workspaceAccess: string }).workspaceAccess, 'read');
    assert.equal(task.replyRoute?.channel, 'system');
    assert.equal(store.listBackgroundTasks()[0]?.id, accepted.taskId);
    assert.equal(isSideEffectTool('delegate_background_task'), true);
  } finally {
    store.close();
  }
});

test('background tasks can select Codex without changing the default Mimi executor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-codex-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createBackgroundTaskTools({ store, event: ownerEvent(), sessionId: 'conversation-a' });
    const codex = await invoke(tools, 'delegate_background_task', {
      objective: '让 Codex 修改并验证代码', executor: 'codex', successCriteria: '测试通过',
    }) as { taskId: string; executor: string };
    const normal = await invoke(tools, 'delegate_background_task', {
      objective: '让 Mimi 检查文档',
    }) as { taskId: string; executor: string };
    assert.equal(codex.executor, 'codex');
    assert.equal((store.getEvent(codex.taskId)?.payload as { executor?: string }).executor, 'codex');
    assert.equal(normal.executor, 'mimi');
    assert.equal((store.getEvent(normal.taskId)?.payload as { executor?: string }).executor, 'mimi');
  } finally {
    store.close();
  }
});

test('semantic execution ledger prevents a retried delegation from creating duplicate tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-task-ledger-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const ledger = new ExecutionLedger(path.join(root, 'ledger.json'));
    const tools = withExecutionLedger(createBackgroundTaskTools({
      store,
      event: ownerEvent(),
      sessionId: 'conversation-a',
    }), ledger, () => ({
      sessionId: 'conversation-a',
      runId: `event:${ownerEvent().id}`,
      semanticCallIds: true,
    }));
    const input = { objective: 'do one long task', strategy: 'single' };
    const first = await invoke(tools, 'delegate_background_task', input, 'sdk-call-a') as { taskId: string };
    const replay = await invoke(tools, 'delegate_background_task', input, 'sdk-call-b') as { taskId: string };
    assert.equal(replay.taskId, first.taskId);
    assert.equal(store.listBackgroundTasks().length, 1);
    assert.equal(
      (store.getEvent(first.taskId)?.payload as { workspaceAccess: string }).workspaceAccess,
      'write',
    );
  } finally {
    store.close();
  }
});

test('a Task lane exposes only request_background_task_input and cannot create or manage durable tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-task-depth-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const event = { ...ownerEvent(), taskDepth: 1, executionLane: 'task' as const };
    store.enqueueEvent({ ...event, status: undefined } as never);
    const tools = createBackgroundTaskTools({ store, event, sessionId: 'task-session' });
    assert.deepEqual(tools.map((candidate) => candidate.name), []);
    const inputTools = createBackgroundTaskTools({
      store,
      event,
      sessionId: 'task-session',
      block: () => undefined,
    });
    assert.deepEqual(inputTools.map((candidate) => candidate.name), ['request_background_task_input']);
  } finally {
    store.close();
  }
});

test('background task management tools pause and resume durable queued work with bounded context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-task-pause-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createBackgroundTaskTools({ store, event: ownerEvent(), sessionId: 'conversation-a' });
    const accepted = await invoke(tools, 'delegate_background_task', {
      objective: '等待依赖后完成构建',
      strategy: 'single',
    }) as { taskId: string };
    const paused = await invoke(tools, 'pause_background_task', {
      taskId: accepted.taskId,
      reason: '依赖尚未准备好',
    }) as { state: string };
    assert.equal(paused.state, 'paused');
    assert.equal(store.getEvent(accepted.taskId)?.status, 'paused');

    const resumed = await invoke(tools, 'resume_background_task', {
      taskId: accepted.taskId,
      context: '依赖已经就绪，请继续验证',
    }) as { state: string };
    assert.equal(resumed.state, 'resumed');
    const task = store.getEvent(accepted.taskId)!;
    assert.equal(task.status, 'queued');
    assert.match((task.payload as { prompt: string }).prompt, /依赖已经就绪，请继续验证/);
    assert.equal(isSideEffectTool('pause_background_task'), true);
    assert.equal(isSideEffectTool('resume_background_task'), true);
  } finally {
    store.close();
  }
});

test('running background task pause reports a request until the worker reaches a safe boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-task-running-pause-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createBackgroundTaskTools({
      store,
      event: ownerEvent(),
      sessionId: 'conversation-a',
      pause: () => ({ state: 'pause_requested' }),
    });
    const accepted = await invoke(tools, 'delegate_background_task', {
      objective: '在安全边界暂停',
    }) as { taskId: string };
    assert.ok(store.claimEventById(accepted.taskId, 'fixture-worker'));
    const paused = await invoke(tools, 'pause_background_task', {
      taskId: accepted.taskId,
    }) as { state: string };
    assert.equal(paused.state, 'pause_requested');
    assert.equal(store.getEvent(accepted.taskId)?.status, 'running');
  } finally {
    store.close();
  }
});

test('a running task can request user input through an in-run block control without mutating the store directly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-task-block-control-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const requests: Array<{ question: string; reason?: string }> = [];
  try {
    const event = { ...ownerEvent(), executionLane: 'task' as const, taskDepth: 1 };
    const tools = createBackgroundTaskTools({
      store,
      event,
      sessionId: 'task-session',
      block: (request) => requests.push(request),
    });
    assert.equal(tools.some((candidate) => candidate.name === 'request_background_task_input'), true);
    assert.deepEqual(tools.map((candidate) => candidate.name), ['request_background_task_input']);
    const result = await invoke(tools, 'request_background_task_input', {
      question: '请选择发布目标：测试环境还是生产环境？',
      reason: '不同目标会产生不同外部副作用',
    }) as { accepted: boolean };
    assert.equal(result.accepted, true);
    assert.deepEqual(requests, [{
      question: '请选择发布目标：测试环境还是生产环境？',
      reason: '不同目标会产生不同外部副作用',
    }]);
    assert.equal(store.listBackgroundTasks().length, 0);
    assert.equal(isSideEffectTool('request_background_task_input'), true);

    const foregroundTools = createBackgroundTaskTools({ store, event: ownerEvent(), sessionId: 'conversation-a' });
    assert.equal(foregroundTools.some((candidate) => candidate.name === 'request_background_task_input'), false);
  } finally {
    store.close();
  }
});

test('one foreground Event cannot directly delegate more than eight background tasks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-background-task-width-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createBackgroundTaskTools({ store, event: ownerEvent(), sessionId: 'conversation-a' });
    for (let index = 0; index < 8; index += 1) {
      await invoke(tools, 'delegate_background_task', {
        objective: `完成独立后台子任务 ${index + 1}`,
        strategy: 'single',
      }, `delegate-${index}`);
    }
    assert.equal(store.backgroundTaskChildCount(ownerEvent().id), 8);
    const rejected = await invoke(tools, 'delegate_background_task', {
      objective: '第九个直接后台子任务',
      strategy: 'single',
    }, 'delegate-ninth');
    assert.match(JSON.stringify(rejected), /最多可直接委派 8 个/);
    assert.equal(store.backgroundTaskChildCount(ownerEvent().id), 8);
  } finally {
    store.close();
  }
});
