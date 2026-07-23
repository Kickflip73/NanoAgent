import assert from 'node:assert/strict';
import test from 'node:test';
import type { MimiAgent } from '../src/agent.js';
import { CommandHandler } from '../src/commands.js';
import { AGENT_MODES } from '../src/runtime/instructions.js';
import type { MemoryRef } from '../src/core/memory.js';

function fakeAgent(): MimiAgent {
  return {
    currentSessionId: 'demo',
    runtimeInfo: async () => ({
      provider: 'deepseek',
      model: 'deepseek-chat',
      mode: { id: 'general', label: '通用', description: '大多数任务', instruction: '' },
      sessionId: 'demo',
      sessionTitle: '讨论 MimiAgent',
      workspaceRoot: '/tmp/demo',
      maxTurns: 200,
      permissionMode: 'trusted',
      skillCount: 2,
      memoryCount: 1,
      mcpServers: [],
      guidanceFiles: [{ scope: 'project', path: '/tmp/demo/AGENTS.md', truncated: false }],
      team: { total: 0, pending: 0, running: 0, completed: 0, failed: 0 },
    }),
    listSessions: async () => ['demo'],
    listSessionSummaries: async () => [{
      id: 'demo',
      title: '讨论 MimiAgent',
      preview: '增加交互能力',
      updatedAt: new Date().toISOString(),
      turns: 2,
      recoverable: false,
    }],
    switchSession: async () => undefined,
    history: async () => [],
    clearSession: async () => undefined,
    listSkills: () => [{ name: 'review', description: 'Review code' }],
    reloadSkills: async () => ({ skills: [{ name: 'review', description: 'Review code' }], warnings: [] }),
    memoryList: async () => [{
      ref: { scope: 'private', id: 'm1', profileId: 'owner' }, title: 'Stack', summary: 'uses TS',
      kind: 'fact', status: 'active', confidence: 'user-confirmed', score: 1, sourceRefs: [], documentType: 'wiki',
    }],
    memorySearch: async () => [],
    memoryRead: async () => ({
      ref: { scope: 'private', id: 'm1', profileId: 'owner' },
      metadata: { schemaVersion: 1, id: 'm1', title: 'Stack', kind: 'fact', scope: 'private', profileId: 'owner', status: 'active', confidence: 'user-confirmed', aliases: [], tags: [], sourceRefs: [], validFrom: null, validUntil: null, supersedes: [], createdAt: '', updatedAt: '' },
      body: 'uses TS', digest: 'sha256:test',
    }),
    memoryForget: async (ref: MemoryRef) => ({ ref, forgotten: true, timestamp: '' }),
    memoryIngest: async () => ({ id: 'r1', operation: 'ingest', status: 'applied', digest: 'd', pageRefs: [] }),
    memoryCaptureRound: async () => ({ id: 'capture-1', operation: 'capture', status: 'applied', digest: 'd', pageRefs: [] }),
    memoryLint: async () => ({ valid: true, checked: 1, issues: [] }),
    memoryConflicts: async () => [],
    memoryAudit: async () => [{ id: 1, operation: 'capture', reasonCode: 'test', createdAt: '' }],
    memoryMaintain: async () => ({ created: [] }),
    memoryReindex: async () => ({ pages: 1, privatePages: 1, workspacePages: 0, conflicted: 0, stale: 0, fts5: true, degraded: false }),
    memoryStatus: async () => ({ pages: 1, privatePages: 1, workspacePages: 0, conflicted: 0, stale: 0, fts5: true, degraded: false }),
    currentPlan: async () => [{ id: '1', description: 'test', status: 'running' }],
    currentTeam: async () => [],
    currentGoal: async () => ({ objective: 'ship MimiAgent', status: 'active', createdAt: '', updatedAt: '' }),
    setGoal: async (objective: string) => ({ objective, status: 'active', createdAt: '', updatedAt: '' }),
    resumePrompt: async () => 'resume goal',
    availableModels: () => ['deepseek-chat', 'deepseek-reasoner'],
    switchModel: () => undefined,
    contextInfo: async () => ({ historyItems: 4, historyLimit: 40, estimatedTokens: 1200, contextWindow: 128000, memories: 1, planSteps: 1, goal: 'active' }),
    compactContext: async () => ({
      changed: true,
      archive: { coveredItems: 8, summary: 'summary', strategy: 'full', originalTokens: 2000, compactedTokens: 200, updatedAt: '' },
      message: '已归档 8 个历史条目。',
    }),
    availableModes: () => [
      { id: 'general', label: '通用', description: '大多数任务' },
      { id: 'ultra', label: 'Ultra Team', description: '大型任务' },
    ],
    switchMode: () => undefined,
    toolNames: ['read_file', 'run_shell'],
    mcpServerNames: [],
    mcpStatuses: () => [],
    reloadMcp: async () => [],
    guidanceInfo: async () => ({
      files: [{ scope: 'project', path: '/tmp/demo/AGENTS.md', content: 'Run tests.', truncated: false }],
      instructions: 'Run tests.',
    }),
  } as unknown as MimiAgent;
}

test('handles status and high-frequency inspection commands', async () => {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  const handler = new CommandHandler(fakeAgent(), async () => undefined);

  try {
    assert.equal(await handler.execute('/status'), 'handled');
    assert.equal(await handler.execute('/skills'), 'handled');
    assert.equal(await handler.execute('/memory list'), 'handled');
    assert.equal(await handler.execute('/memory capture'), 'handled');
    assert.equal(await handler.execute('/memory audit'), 'handled');
    assert.equal(await handler.execute('/memory maintain'), 'handled');
    assert.equal(await handler.execute('/plan'), 'handled');
    assert.equal(await handler.execute('/team'), 'handled');
    assert.equal(await handler.execute('/instructions'), 'handled');
    assert.match(output.join('\n'), /deepseek-chat/);
    assert.match(output.join('\n'), /Shell 可用/);
    assert.match(output.join('\n'), /Review code/);
    assert.match(output.join('\n'), /uses TS/);
    assert.match(output.join('\n'), /running/);
    assert.match(output.join('\n'), /AGENTS\.md/);
  } finally {
    console.log = original;
  }
});

test('status reports the effective Plan restriction instead of claiming Shell is available', async () => {
  const output: string[] = [];
  const originalLog = console.log;
  const agent = fakeAgent();
  const runtimeInfo = agent.runtimeInfo.bind(agent);
  agent.runtimeInfo = async () => ({
    ...await runtimeInfo(),
    mode: AGENT_MODES.find((mode) => mode.id === 'plan')!,
  });
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  try {
    assert.equal(await new CommandHandler(agent, async () => undefined).execute('/status'), 'handled');
    assert.match(output.join('\n'), /Shell 关闭/);
    assert.doesNotMatch(output.join('\n'), /Shell 可用/);
  } finally {
    console.log = originalLog;
  }
});

test('passes command cancellation to memory ingest', async () => {
  const agent = fakeAgent();
  let received: AbortSignal | undefined;
  agent.memoryIngest = async (_target: string, signal?: AbortSignal) => {
    received = signal;
    signal?.throwIfAborted();
    return { id: 'r', operation: 'ingest', status: 'applied', digest: 'd', pageRefs: [] };
  };
  const controller = new AbortController();
  controller.abort(new Error('stop index'));
  const handler = new CommandHandler(agent, async () => undefined, { write: () => undefined });

  await assert.rejects(handler.execute('/memory ingest knowledge/source.md', controller.signal), /stop index/);
  assert.equal(received, controller.signal);
});

test('retries the previous user input without sending slash commands to the model', async () => {
  const tasks: string[] = [];
  const original = console.log;
  console.log = () => undefined;
  const handler = new CommandHandler(fakeAgent(), async (input) => {
    tasks.push(input);
  });
  handler.remember('hello');

  try {
    assert.equal(await handler.execute('/retry'), 'handled');
    assert.deepEqual(tasks, ['hello']);
    assert.equal(await handler.execute('normal input'), 'pass');
    assert.equal(await handler.execute('/exit'), 'exit');
  } finally {
    console.log = original;
  }
});

test('keeps retry input isolated by session', async () => {
  const tasks: string[] = [];
  const messages: string[] = [];
  const agent = fakeAgent();
  const mutable = agent as unknown as { currentSessionId: string };
  const handler = new CommandHandler(agent, async (input) => { tasks.push(input); }, {
    write: (text) => messages.push(text),
  });

  mutable.currentSessionId = 'first';
  handler.remember('first message');
  mutable.currentSessionId = 'second';
  assert.equal(await handler.execute('/retry'), 'handled');
  assert.match(messages.at(-1) ?? '', /当前对话没有/);
  handler.remember('second message');
  await handler.execute('/retry');
  mutable.currentSessionId = 'first';
  await handler.execute('/retry');

  assert.deepEqual(tasks, ['second message', 'first message']);
});

test('selects sessions and restores their persisted transcript', async () => {
  const switched: string[] = [];
  let restores = 0;
  const agent = fakeAgent() as MimiAgent & { switchSession: (id: string) => Promise<void> };
  agent.switchSession = async (id) => { switched.push(id); };
  const handler = new CommandHandler(agent, async () => undefined, {
    restoreSession: () => { restores += 1; },
    selectSession: async () => 'demo',
  });

  assert.equal(await handler.execute('/sessions'), 'handled');
  assert.deepEqual(switched, ['demo']);
  assert.equal(restores, 1);

  assert.equal(await handler.execute('/switch archived'), 'handled');
  assert.deepEqual(switched, ['demo', 'archived']);
  assert.equal(restores, 2);
});

test('selects a model and exposes common runtime inspection commands', async () => {
  const switched: string[] = [];
  const output: string[] = [];
  const agent = fakeAgent() as MimiAgent & { switchModel: (name: string) => void };
  agent.switchModel = async (name) => { switched.push(name); };
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
    selectModel: async () => 'deepseek-reasoner',
  });

  assert.equal(await handler.execute('/model'), 'handled');
  assert.equal(await handler.execute('/context'), 'handled');
  assert.equal(await handler.execute('/compact'), 'handled');
  assert.equal(await handler.execute('/tools'), 'handled');
  assert.equal(await handler.execute('/mcp'), 'handled');
  assert.deepEqual(switched, ['deepseek-reasoner']);
  assert.match(output.join('\n'), /历史条目/);
  assert.match(output.join('\n'), /已归档 8 个历史条目/);
  assert.match(output.join('\n'), /run_shell/);
  assert.match(output.join('\n'), /MCP 未配置/);
});

test('selects a preset Agent mode', async () => {
  const switched: string[] = [];
  const agent = fakeAgent() as MimiAgent & { switchMode: (mode: string) => void };
  agent.switchMode = async (mode) => { switched.push(mode); };
  const handler = new CommandHandler(agent, async () => undefined, {
    write: () => undefined,
    selectMode: async () => 'ultra',
  });

  assert.equal(await handler.execute('/mode'), 'handled');
  assert.deepEqual(switched, ['ultra']);
});

test('switches terminal output detail level', async () => {
  let current: 'answer' | 'thinking' | 'tools' | 'trace' = 'tools';
  const handler = new CommandHandler(fakeAgent(), async () => undefined, {
    write: () => undefined,
    getOutputLevel: () => current,
    setOutputLevel: (level) => { current = level; },
    selectOutputLevel: async () => 'trace',
  });

  assert.equal(await handler.execute('/output'), 'handled');
  assert.equal(current, 'trace');
  await assert.rejects(handler.execute('/output everything'), /未知输出等级/);
});

test('sets and resumes a durable goal', async () => {
  const tasks: string[] = [];
  const output: string[] = [];
  const handler = new CommandHandler(fakeAgent(), async (input) => { tasks.push(input); }, {
    write: (text) => output.push(text),
  });

  assert.equal(await handler.execute('/goal 发布 MimiAgent'), 'handled');
  assert.equal(await handler.execute('/resume'), 'handled');
  assert.deepEqual(tasks, ['resume goal']);
  assert.match(output.join('\n'), /发布 MimiAgent/);
});

test('lists, inspects, and cancels durable background tasks from the shared CLI', async () => {
  const taskId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const output: string[] = [];
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const task = {
    taskId,
    status: 'running',
    objective: '构建大型游戏项目',
    strategy: 'team',
    workspaceAccess: 'write' as const,
    sessionId: `mimi-task-${taskId}`,
    originSessionId: 'demo',
    depth: 1,
    attempts: 1,
    createdAt: '2026-07-16T01:00:00.000Z',
    updatedAt: '2026-07-16T01:05:00.000Z',
    result: { progress: '已完成基础场景' },
    worker: {
      pid: 4821,
      workerId: 'task-worker-1',
      spawnedAt: '2026-07-16T01:00:01.000Z',
      heartbeatAt: '2026-07-16T01:05:01.000Z',
    },
    recentEvents: [
      {
        sequence: 4,
        kind: 'plan',
        steps: [
          { description: '创建基础场景', status: 'completed' },
          { description: '实现战斗系统', status: 'running' },
        ],
      },
      { sequence: 5, kind: 'status', title: 'run_shell', next: '正在执行 run_shell' },
    ],
  };
  const agent = Object.assign(fakeAgent(), {
    listBackgroundTasks: async (limit?: number) => {
      calls.push({ operation: 'list', value: limit });
      return [task];
    },
    inspectBackgroundTask: async (id: string) => {
      calls.push({ operation: 'inspect', value: id });
      return task;
    },
    cancelBackgroundTask: async (id: string, reason?: string) => {
      calls.push({ operation: 'cancel', value: { id, reason } });
      return { state: 'cancelled' as const };
    },
    pauseBackgroundTask: async (id: string, reason?: string) => {
      calls.push({ operation: 'pause', value: { id, reason } });
      return { state: 'paused' as const };
    },
    resumeBackgroundTask: async (id: string, context?: string) => {
      calls.push({ operation: 'resume', value: { id, context } });
      return { state: 'resumed' as const };
    },
  });
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
  });

  assert.equal(await handler.execute('/tasks 5'), 'handled');
  assert.equal(await handler.execute(`/task ${taskId}`), 'handled');
  assert.equal(await handler.execute(`/task pause ${taskId}`), 'handled');
  assert.equal(await handler.execute(`/task resume ${taskId} dependency is ready`), 'handled');
  assert.equal(await handler.execute(`/task cancel ${taskId} owner changed direction`), 'handled');

  assert.deepEqual(calls, [
    { operation: 'list', value: 5 },
    { operation: 'inspect', value: taskId },
    { operation: 'pause', value: { id: taskId, reason: undefined } },
    { operation: 'resume', value: { id: taskId, context: 'dependency is ready' } },
    { operation: 'cancel', value: { id: taskId, reason: 'owner changed direction' } },
  ]);
  assert.match(output[0] ?? '', /\[运行中\].*构建大型游戏项目/);
  assert.match(output[1] ?? '', /任务会话.*mimi-task/);
  assert.match(output[1] ?? '', /工作进程.*4821/);
  assert.match(output[1] ?? '', /工作区.*可写（独占）/);
  assert.match(output[1] ?? '', /计划进度.*1\/2.*实现战斗系统/);
  assert.match(output[1] ?? '', /当前动作.*正在执行 run_shell/);
  assert.match(output[1] ?? '', /已完成基础场景/);
  assert.match(output[2] ?? '', /已暂停/);
  assert.match(output[3] ?? '', /重新排队/);
  assert.match(output[4] ?? '', /已请求取消/);
});

test('running background task pause reports the safe-point request instead of claiming completion', async () => {
  const output: string[] = [];
  const handler = new CommandHandler(Object.assign(fakeAgent(), {
    pauseBackgroundTask: async () => ({ state: 'pause_requested' as const }),
  }), async () => undefined, { write: (text) => output.push(text) });

  assert.equal(await handler.execute('/task pause task-running'), 'handled');
  assert.match(output[0] ?? '', /安全点暂停/);
});

test('background task commands reject ambiguous input before calling the daemon', async () => {
  const handler = new CommandHandler(fakeAgent(), async () => undefined, { write: () => undefined });
  await assert.rejects(handler.execute('/tasks 0'), /\/tasks \[1-50\]/);
  await assert.rejects(handler.execute('/task'), /\/task <task-id>/);
  await assert.rejects(handler.execute('/task cancel'), /\/task cancel <task-id>/);
  await assert.rejects(handler.execute('/task pause'), /\/task pause <task-id>/);
  await assert.rejects(handler.execute('/task resume'), /\/task resume <task-id>/);
});
