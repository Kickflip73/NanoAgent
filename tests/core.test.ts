import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  getAllMcpTools,
  invalidateServerToolsCache,
  RunContext,
  type AgentInputItem,
  type MCPServer,
} from '@openai/agents';
import { ContextManager, estimateTokens } from '../src/core/context.js';
import { GuidanceLoader } from '../src/core/guidance.js';
import { explicitlyRequestsMemory, MemoryStore } from '../src/core/memory.js';
import { PlanStore } from '../src/core/plan.js';
import { FileSession, registerSessionRunOwner } from '../src/core/session.js';
import { TeamTaskStore } from '../src/core/team.js';
import { TraceStore } from '../src/core/trace.js';
import { HookBus } from '../src/runtime/hooks.js';
import {
  collectTrustedMcpEnvironment,
  expandMcpEnvironment,
  MCPManager,
  parseMcpConfig,
} from '../src/extensions/mcp.js';
import { RagStore } from '../src/extensions/rag.js';
import { SkillLoader } from '../src/extensions/skills.js';
import { createSubAgentTools } from '../src/extensions/subagents.js';
import { MimiAgent } from '../src/agent.js';

test('persists sessions and returns the latest items', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-'));
  const session = new FileSession(root, 'demo');
  const items = [
    { role: 'user', content: 'one' },
    { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'two' }] },
  ] as AgentInputItem[];
  await session.addItems(items);

  assert.deepEqual(await new FileSession(root, 'demo').getItems(1), [items[1]]);
  assert.deepEqual(await FileSession.list(root), ['demo']);
});

test('keeps runtime preferences isolated between sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-preferences-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const previous = {
    session: process.env.AGENT_SESSION,
    mode: process.env.AGENT_MODE,
    output: process.env.OUTPUT_LEVEL,
    model: process.env.OPENAI_MODEL,
  };
  process.env.AGENT_SESSION = 'first';
  process.env.AGENT_MODE = 'general';
  process.env.OUTPUT_LEVEL = 'tools';
  process.env.OPENAI_MODEL = 'gpt-5.4-mini';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  try {
    await agent.switchMode('plan');
    await agent.switchModel('gpt-5-mini');
    await agent.setOutputLevel('trace');

    await agent.switchSession('second');
    let info = await agent.runtimeInfo();
    assert.equal(info.mode.id, 'general');
    assert.equal(info.model, 'gpt-5.4-mini');
    assert.equal(info.outputLevel, 'tools');

    await agent.switchMode('ultra');
    await agent.switchModel('gpt-5.4');
    await agent.setOutputLevel('answer');

    await agent.switchSession('first');
    info = await agent.runtimeInfo();
    assert.equal(info.mode.id, 'plan');
    assert.equal(info.model, 'gpt-5-mini');
    assert.equal(info.outputLevel, 'trace');

    await agent.switchSession('second');
    info = await agent.runtimeInfo();
    assert.equal(info.mode.id, 'ultra');
    assert.equal(info.model, 'gpt-5.4');
    assert.equal(info.outputLevel, 'answer');
  } finally {
    await agent.close();
    if (previous.session === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previous.session;
    if (previous.mode === undefined) delete process.env.AGENT_MODE;
    else process.env.AGENT_MODE = previous.mode;
    if (previous.output === undefined) delete process.env.OUTPUT_LEVEL;
    else process.env.OUTPUT_LEVEL = previous.output;
    if (previous.model === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previous.model;
  }
});

test('reads a requested Session snapshot without changing the active Session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-snapshot-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionsRoot = path.join(dataRoot, 'sessions');
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = 'active';
  const requested = new FileSession(sessionsRoot, 'requested');
  const items = [
    { role: 'user', content: 'REQUESTED_SESSION_INPUT' },
    { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-1', output: 'REQUESTED_TOOL_RESULT' },
    { role: 'assistant', content: 'REQUESTED_SESSION_ANSWER' },
  ] as AgentInputItem[];
  await requested.addItems(items);
  await requested.setPreferences({ mode: 'plan', model: 'gpt-5-mini', outputLevel: 'trace' });
  const checkpoint = await requested.beginRun('REQUESTED_INTERRUPTED_INPUT', 'requested-run');
  await requested.failRun('interrupted for snapshot', true, checkpoint.runId);

  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  try {
    const snapshot = await agent.sessionSnapshot('requested');
    assert.equal(snapshot.sessionId, 'requested');
    assert.deepEqual(snapshot.items, items);
    assert.equal(snapshot.recovery?.status, 'interrupted');
    assert.equal(snapshot.runtime.mode.id, 'plan');
    assert.equal(snapshot.runtime.model, 'gpt-5-mini');
    assert.equal(snapshot.runtime.outputLevel, 'trace');
    assert.ok(snapshot.context.estimatedTokens > 0);
    assert.equal(snapshot.context.contextWindow, 128_000);
    assert.equal(agent.currentSessionId, 'active');
  } finally {
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('releases an active run owner when stream setup fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-stream-setup-failure-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = 'blocked';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, maxTurns: 20,
  });
  const ownerId = 'external-owner';
  const release = registerSessionRunOwner(ownerId);
  try {
    await new FileSession(path.join(dataRoot, 'sessions'), 'blocked')
      .beginRun('external work', 'external-run', ownerId);
    await assert.rejects(agent.stream('should not start'), /活跃 Run 占用/);
    await assert.doesNotReject(agent.switchSession('other'));
  } finally {
    release();
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('releases the active run when asynchronous Runner setup rejects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-runner-rejection-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, maxTurns: 20,
  });
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<never> } }).runner;
  runner.run = async () => { throw new Error('async runner setup failed'); };
  try {
    await assert.rejects(agent.stream('start'), /async runner setup failed/);
    await assert.doesNotReject(agent.switchSession('after-failure'));
  } finally {
    await agent.close();
  }
});

test('does not clear durable Session state while its Run is active', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-active-clear-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, maxTurns: 20,
  });
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async () => ({});
  try {
    await agent.stream('still active');
    await assert.rejects(agent.clearSession(), /仍有任务运行中/);
    await agent.failRun(new Error('test cleanup'), true);
  } finally {
    await agent.close();
  }
});

test('isolates transcript and context archives while sharing only usable long-term memory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-context-isolation-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionsRoot = path.join(dataRoot, 'sessions');
  const first = new FileSession(sessionsRoot, 'first');
  const second = new FileSession(sessionsRoot, 'second');
  const firstItems = Array.from({ length: 6 }, (_, index) => [
    { role: 'user', content: `FIRST_PRIVATE_REQUEST_${index}` },
    { role: 'assistant', content: `FIRST_PRIVATE_ANSWER_${index}` },
  ]).flat() as AgentInputItem[];
  await first.addItems(firstItems);
  await second.addItems([
    { role: 'user', content: 'SECOND_PRIVATE_REQUEST' },
    { role: 'assistant', content: 'SECOND_PRIVATE_ANSWER' },
  ] as AgentInputItem[]);
  await new MemoryStore(path.join(dataRoot, 'memories.json')).remember(
    'SHARED_CONFIRMED_MEMORY',
    'fact',
    { source: 'user', sourceSessionId: 'first' },
  );

  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = 'first';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 4, contextWindow: 4_000, maxTurns: 20,
  });
  try {
    let serialized = JSON.stringify(await agent.history());
    assert.match(serialized, /FIRST_PRIVATE_REQUEST_0/);
    assert.doesNotMatch(serialized, /SECOND_PRIVATE_REQUEST/);
    assert.match(JSON.stringify(await agent.listMemories()), /SHARED_CONFIRMED_MEMORY/);

    const compacted = await agent.compactContext();
    assert.equal(compacted.changed, true);
    assert.ok((await agent.contextInfo()).archivedItems > 0);

    await agent.switchSession('second');
    serialized = JSON.stringify(await agent.history());
    assert.match(serialized, /SECOND_PRIVATE_REQUEST/);
    assert.doesNotMatch(serialized, /FIRST_PRIVATE_REQUEST/);
    assert.equal((await agent.contextInfo()).archivedItems, 0);
    assert.match(JSON.stringify(await agent.listMemories()), /SHARED_CONFIRMED_MEMORY/);

    const secondPlan = new PlanStore(path.join(dataRoot, 'plans.json'), 'second');
    await secondPlan.setGoal('SECOND_DURABLE_GOAL');
    await secondPlan.update([{ id: 'work', description: 'SECOND_PLAN', status: 'running' }]);
    const secondTeam = new TeamTaskStore(path.join(dataRoot, 'teams.json'), 'second');
    await secondTeam.set([
      { id: 'inspect', description: 'SECOND_TEAM_A', role: 'explorer', dependencies: [], paths: [] },
      { id: 'review', description: 'SECOND_TEAM_B', role: 'reviewer', dependencies: [], paths: [] },
    ]);
    await agent.switchMode('ultra');
    await agent.clearSession();
    assert.deepEqual(await agent.history(), []);
    assert.deepEqual(await agent.currentPlan(), []);
    assert.equal(await agent.currentGoal(), undefined);
    assert.deepEqual(await agent.currentTeam(), []);
    assert.equal((await agent.runtimeInfo()).mode.id, 'ultra');
    assert.match(JSON.stringify(await agent.listMemories()), /SHARED_CONFIRMED_MEMORY/);
    await agent.switchSession('first');
    serialized = JSON.stringify(await agent.history());
    assert.match(serialized, /FIRST_PRIVATE_REQUEST_0/);
    assert.doesNotMatch(serialized, /SECOND_PRIVATE_REQUEST/);
    assert.equal((await agent.contextInfo()).archivedItems, compacted.archive?.coveredItems);
  } finally {
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('uses DeepSeek V4 Pro by default and lists both V4 models', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-deepseek-models-'));
  const previous = {
    session: process.env.AGENT_SESSION,
    model: process.env.DEEPSEEK_MODEL,
    key: process.env.DEEPSEEK_API_KEY,
  };
  process.env.AGENT_SESSION = 'deepseek-default';
  delete process.env.DEEPSEEK_MODEL;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const agent = await MimiAgent.create({
    provider: 'deepseek', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, maxTurns: 20,
  });
  try {
    assert.equal((await agent.runtimeInfo()).model, 'deepseek-v4-pro');
    assert.deepEqual(agent.availableModels().slice(0, 2), ['deepseek-v4-pro', 'deepseek-v4-flash']);
    assert.equal((await agent.contextInfo()).contextWindow, 1_048_576);
    assert.equal((await agent.contextInfo()).outputReserve, 65_536);
    await agent.switchModel('deepseek-v4-flash');
    assert.equal((await agent.contextInfo()).contextWindow, 128_000);
    assert.equal((await agent.contextInfo()).outputReserve, 16_384);
    await agent.switchModel('deepseek-v4-pro');
    assert.equal((await agent.contextInfo()).contextWindow, 1_048_576);
  } finally {
    await agent.close();
    if (previous.session === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previous.session;
    if (previous.model === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = previous.model;
    if (previous.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous.key;
  }
});

test('restores the complete session state after a process restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-restart-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessions = path.join(dataRoot, 'sessions');
  const previous = {
    session: process.env.AGENT_SESSION,
    mode: process.env.AGENT_MODE,
    output: process.env.OUTPUT_LEVEL,
    model: process.env.OPENAI_MODEL,
  };
  process.env.AGENT_SESSION = 'durable';
  process.env.AGENT_MODE = 'general';
  process.env.OUTPUT_LEVEL = 'tools';
  process.env.OPENAI_MODEL = 'gpt-5.4-mini';
  const config = {
    provider: 'openai' as const, workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  };
  let first: MimiAgent | undefined;
  let reopened: MimiAgent | undefined;
  try {
    first = await MimiAgent.create(config);
    await first.switchMode('ultra');
    await first.switchModel('gpt-5.4');
    await first.setOutputLevel('trace');
    await new FileSession(sessions, 'durable').addItems([
      { role: 'user', content: '继续完整状态恢复' },
    ] as AgentInputItem[]);
    const plans = new PlanStore(path.join(dataRoot, 'plans.json'), 'durable');
    await plans.update([
      { id: 'inspect', description: '检查状态', status: 'completed' },
      { id: 'build', description: '继续实现', status: 'running' },
    ]);
    await new FileSession(sessions, 'durable').beginRun('继续未完成任务');
    await first.close();
    first = undefined;

    reopened = await MimiAgent.create(config);
    const info = await reopened.runtimeInfo();
    assert.equal(info.sessionId, 'durable');
    assert.equal(info.mode.id, 'ultra');
    assert.equal(info.model, 'gpt-5.4');
    assert.equal(info.outputLevel, 'trace');
    assert.deepEqual((await reopened.currentPlan()).map((step) => step.status), ['completed', 'running']);
    assert.match(JSON.stringify(await reopened.history()), /继续完整状态恢复/);
    assert.equal((await reopened.recoveryInfo())?.status, 'interrupted');
    assert.match(await reopened.resumePrompt(), /继续未完成任务/);
    assert.match(await reopened.resumePrompt(), /继续实现/);
  } finally {
    await first?.close();
    await reopened?.close();
    if (previous.session === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previous.session;
    if (previous.mode === undefined) delete process.env.AGENT_MODE;
    else process.env.AGENT_MODE = previous.mode;
    if (previous.output === undefined) delete process.env.OUTPUT_LEVEL;
    else process.env.OUTPUT_LEVEL = previous.output;
    if (previous.model === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previous.model;
  }
});

test('loads canonical MIMI.md guidance and keeps project precedence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-guidance-'));
  const userFile = path.join(root, 'home', 'MIMI.md');
  await mkdir(path.dirname(userFile), { recursive: true });
  await writeFile(userFile, 'Use tabs.');
  await writeFile(path.join(root, 'MIMI.md'), 'Use two spaces.');
  const loader = new GuidanceLoader(root, userFile);

  const first = await loader.load();
  assert.deepEqual(first.files.map((file) => file.scope), ['user', 'project']);
  assert.match(first.instructions, /项目级指令优先于用户级指令/);
  assert.ok(first.instructions.indexOf('Use two spaces.') < first.instructions.indexOf('Use tabs.'));

  await writeFile(path.join(root, 'home', 'MIMI.md'), 'Use updated user guidance.');
  await writeFile(path.join(root, 'MIMI.md'), 'Run the current test suite.');
  const modern = await loader.load();
  assert.deepEqual(modern.files.map((file) => path.basename(file.path)), ['MIMI.md', 'MIMI.md']);
  assert.match(modern.instructions, /Run the current test suite/);
  assert.match(modern.instructions, /Use updated user guidance/);
  assert.doesNotMatch(modern.instructions, /Use two spaces|Use tabs/);
  assert.ok(modern.instructions.indexOf('Run the current test suite.') < modern.instructions.indexOf('Use updated user guidance.'));

  await writeFile(path.join(root, 'MIMI.md'), 'Run npm test.');
  assert.match((await loader.load()).instructions, /Run npm test/);
});

test('reads only the bounded prefix of oversized persistent guidance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-guidance-limit-'));
  await writeFile(path.join(root, 'MIMI.md'), `PREFIX-${'x'.repeat(100_000)}-TAIL`);
  const snapshot = await new GuidanceLoader(root, path.join(root, 'MIMI.md'), 20).load();
  assert.equal(snapshot.files[0]?.truncated, true);
  assert.match(snapshot.instructions, /PREFIX/);
  assert.doesNotMatch(snapshot.instructions, /TAIL/);
});

test('serializes concurrent session writes and keeps an in-process cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-concurrent-'));
  const session = new FileSession(root, 'demo');
  await Promise.all([
    session.addItems([{ role: 'user', content: 'one' }] as AgentInputItem[]),
    session.addItems([{ role: 'user', content: 'two' }] as AgentInputItem[]),
  ]);
  assert.deepEqual((await session.getItems()).map((item) => 'content' in item ? item.content : ''), ['one', 'two']);
});

test('summarizes and sorts sessions from recent conversation content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-summary-'));
  const session = new FileSession(root, 'opaque-id');
  await session.addItems([
    { role: 'user', content: '你好' },
    { role: 'user', content: '帮我优化 MimiAgent 的终端交互体验' },
    { role: 'user', content: '还要支持任务排队' },
  ] as AgentInputItem[]);

  const [summary] = await FileSession.listSummaries(root);
  assert.equal(summary?.id, 'opaque-id');
  assert.equal(summary?.title, '优化 MimiAgent 的终端交互体验');
  assert.equal(summary?.preview, '还要支持任务排队');
  assert.equal(summary?.turns, 3);
  assert.equal(summary?.recoverable, false);
});

test('orders session summaries by latest activity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-order-'));
  const older = new FileSession(root, 'older');
  const newer = new FileSession(root, 'newer');
  await older.addItems([{ role: 'user', content: '较早的任务' }] as AgentInputItem[]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await newer.addItems([{ role: 'user', content: '较新的任务' }] as AgentInputItem[]);
  assert.deepEqual((await FileSession.listSummaries(root)).map((item) => item.id), ['newer', 'older']);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await older.addItems([{ role: 'user', content: '重新继续这个任务' }] as AgentInputItem[]);
  assert.deepEqual((await FileSession.listSummaries(root)).map((item) => item.id), ['older', 'newer']);
});

test('persists run checkpoints and recovers a process exit at the latest progress point', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-recovery-'));
  const session = new FileSession(root, 'demo');
  await session.beginRun('继续实现上下文管理');
  await session.updateRunProgress('正在执行 read_file', 'read_file · src/core/context.ts');

  const reopened = new FileSession(root, 'demo');
  const checkpoint = await reopened.recoverInterruptedRun();
  assert.equal(checkpoint?.status, 'interrupted');
  assert.equal(checkpoint?.input, '继续实现上下文管理');
  assert.match(checkpoint?.lastEvent ?? '', /context\.ts/);
  assert.match(checkpoint?.nextAction ?? '', /继续/);

  const [summary] = await FileSession.listSummaries(root);
  assert.equal(summary?.recoverable, true);
  assert.match(summary?.progress ?? '', /context\.ts/);
});

test('durable run recovery rolls back only the incomplete transcript attempt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-session-attempt-rollback-'));
  const session = new FileSession(root, 'durable-attempt');
  await session.addItems([{ role: 'user', content: 'stable history' }] as AgentInputItem[]);
  await session.beginRun('send once', 'event-run', 'crashed-owner', true);
  await session.addItems([
    { role: 'user', content: 'send once' },
    { role: 'assistant', content: 'partial duplicate-prone output' },
  ] as AgentInputItem[]);

  const recovered = await session.recoverInterruptedRun('event-run');
  assert.equal(recovered?.status, 'interrupted');
  assert.deepEqual(await session.getItems(), [{ role: 'user', content: 'stable history' }]);

  await session.beginRun('send once', 'retry-run', undefined, true);
  await session.addItems([{ role: 'user', content: 'send once' }] as AgentInputItem[]);
  assert.equal(await session.rollbackRunItems('retry-run'), true);
  assert.deepEqual(await session.getItems(), [{ role: 'user', content: 'stable history' }]);
});

test('keeps completed and failed run outcomes in session metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-outcome-'));
  const session = new FileSession(root, 'demo');
  await session.beginRun('first');
  await session.completeRun('完成结果');
  assert.equal((await session.getCheckpoint())?.status, 'completed');
  assert.match((await session.getCheckpoint())?.answer ?? '', /完成结果/);

  await session.beginRun('second');
  await session.failRun('用户停止', true);
  assert.equal((await session.getCheckpoint())?.status, 'interrupted');
  assert.match((await session.getCheckpoint())?.error ?? '', /用户停止/);
});

test('resumes an interrupted ordinary task without requiring a Goal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-runtime-resume-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionId = 'resume-test';
  const session = new FileSession(path.join(dataRoot, 'sessions'), sessionId);
  await session.beginRun('实现任务恢复能力');
  await session.updateRunProgress('正在执行测试', 'npm test · 42 passed');
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = sessionId;
  const agent = await MimiAgent.create({
    provider: 'openai',
    workspaceRoot: root,
    dataRoot,
    skillsRoot: path.join(root, 'skills'),
    mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40,
    contextWindow: 128_000,
    maxTurns: 20,
  });
  try {
    assert.equal((await agent.recoveryInfo())?.status, 'interrupted');
    const prompt = await agent.resumePrompt();
    assert.match(prompt, /实现任务恢复能力/);
    assert.match(prompt, /npm test · 42 passed/);
    assert.match(prompt, /不要重复已经完成的步骤/);

    const switched = new FileSession(path.join(dataRoot, 'sessions'), 'switched');
    await switched.beginRun('切换后恢复的任务');
    await switched.updateRunProgress('正在修改文件', 'write_file · src/index.ts');
    await agent.switchSession('switched');
    assert.equal((await agent.recoveryInfo())?.status, 'interrupted');
    assert.match(await agent.resumePrompt(), /write_file · src\/index\.ts/);
  } finally {
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('manually compacts a session without deleting its archived transcript', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-runtime-compact-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionId = 'compact-test';
  const session = new FileSession(path.join(dataRoot, 'sessions'), sessionId);
  const items = Array.from({ length: 5 }, (_, index) => [
    { role: 'user', content: `question-${index}` },
    { role: 'assistant', content: `answer-${index}` },
  ]).flat() as AgentInputItem[];
  await session.addItems(items);
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = sessionId;
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot,
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  try {
    const result = await agent.compactContext();
    assert.equal(result.changed, true);
    assert.equal(result.archive?.coveredItems, 6);
    assert.equal((await agent.history()).length, items.length);
    assert.equal((await new FileSession(path.join(dataRoot, 'sessions'), sessionId).getContextArchive())?.strategy, 'full');
  } finally {
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('removes summaries accidentally persisted by older context management', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-cleanup-'));
  const session = new FileSession(root, 'demo');
  await session.addItems([
    { role: 'user', content: '[更早的会话历史已压缩为摘要，共 3 条]\nlegacy' },
    { role: 'user', content: 'real message' },
  ] as AgentInputItem[]);

  assert.equal(await session.cleanupGeneratedSummaries(), 1);
  assert.deepEqual(await session.getItems(), [{ role: 'user', content: 'real message' }]);
});

test('repairs dangling tool calls left by an interrupted task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-repair-'));
  const session = new FileSession(root, 'demo');
  await session.addItems([
    { type: 'message', role: 'user', content: 'run it' },
    { type: 'function_call', name: 'run_shell', callId: 'dangling', arguments: '{}' },
    { type: 'function_call', name: 'read_file', callId: 'paired', arguments: '{}' },
    { type: 'function_call_result', name: 'read_file', callId: 'paired', output: 'ok' },
    { type: 'function_call_result', name: 'read_file', callId: 'paired', output: 'duplicate' },
  ] as unknown as AgentInputItem[]);

  assert.equal(await session.repairToolPairs(), 2);
  const serialized = JSON.stringify(await session.getItems());
  assert.doesNotMatch(serialized, /dangling/);
  assert.doesNotMatch(serialized, /duplicate/);
  assert.match(serialized, /paired/);
});

test('stores, retrieves and forgets long-term memories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-'));
  const store = new MemoryStore(path.join(root, 'memories.json'));
  const memory = await store.remember('用户偏好 TypeScript', 'preference');

  assert.equal((await store.search('TypeScript 偏好'))[0]?.id, memory.id);
  assert.deepEqual(await store.search('完全无关'), []);
  assert.equal(await store.forget(memory.id), true);
  assert.deepEqual(await store.list(), []);
});

test('lets the Agent record durable memory without per-write confirmation and preserves provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-autonomous-'));
  const store = new MemoryStore(path.join(root, 'memories.json'));
  const [remember] = store.createTools(() => ({
    input: '我的编辑器是 Vim',
    sessionId: 'private-a',
    eventId: 'event-1',
    eventSource: 'messages',
    trust: 'owner',
    actor: '+15550001111',
    conversation: 'messages-thread',
    personId: 'alice',
    personName: 'Alice Chen',
  }));
  assert.ok(remember && 'invoke' in remember);
  await remember!.invoke(new RunContext({}), JSON.stringify({
    content: '用户使用 Vim', type: 'preference', importance: 3,
  }));
  const [saved] = await store.list();
  assert.equal(saved?.sourceSessionId, 'private-a');
  assert.equal(saved?.source, 'agent');
  assert.equal(saved?.sourceEventId, 'event-1');
  assert.equal(saved?.sourceEventSource, 'messages');
  assert.equal(saved?.sourceTrust, 'owner');
  assert.equal(saved?.sourceActor, '+15550001111');
  assert.equal(saved?.sourceConversation, 'messages-thread');
  assert.equal(saved?.personId, 'alice');
  assert.equal(saved?.personName, 'Alice Chen');
  assert.ok(saved?.recordedAt);
  assert.deepEqual((await store.search('alice mail:inbox')).map((item) => item.id), [saved?.id]);
});

test('recognizes explicit memory requests without requiring them for autonomous writes', () => {
  assert.equal(explicitlyRequestsMemory('请记住我喜欢简洁输出'), true);
  assert.equal(explicitlyRequestsMemory('不要记住我的密码'), false);
  assert.equal(explicitlyRequestsMemory('你还记住我什么？'), false);
  assert.equal(explicitlyRequestsMemory('please do not remember this password'), false);
});

test('honors an explicit request not to retain memory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-denied-'));
  const store = new MemoryStore(path.join(root, 'memories.json'));
  const [remember] = store.createTools(() => ({ input: '不要记住我的门禁密码', sessionId: 'private-a' }));
  assert.ok(remember && 'invoke' in remember);
  assert.match(String(await remember!.invoke(new RunContext({}), JSON.stringify({
    content: '用户门禁密码是 1234', type: 'fact', importance: 5,
  }))), /明确要求不要保存/);
  assert.deepEqual(await store.list(), []);
});

test('bounds autonomous memory content and usable entry growth', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-bounds-'));
  const file = path.join(root, 'memories.json');
  const timestamp = new Date().toISOString();
  await writeFile(file, JSON.stringify(Array.from({ length: 1_000 }, (_, index) => ({
    id: `memory-${index}`,
    type: 'fact',
    content: `fact-${index}`,
    createdAt: timestamp,
    recordedAt: timestamp,
  }))));
  const store = new MemoryStore(file);

  await assert.rejects(() => store.remember('x'.repeat(2_001), 'fact'), /2000/);
  await assert.rejects(() => store.remember('one-more', 'fact'), /1000/);
  assert.equal((await store.remember('fact-0', 'fact', { importance: 5 })).importance, 5);
});

test('does not inject legacy or unconfirmed memory across sessions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-unconfirmed-'));
  const file = path.join(root, 'memories.json');
  await writeFile(file, JSON.stringify([
    { id: 'legacy', type: 'fact', content: 'PRIVATE_LEGACY_SENTINEL', createdAt: new Date().toISOString() },
    { id: 'confirmed', type: 'fact', content: 'SHARED_CONFIRMED_SENTINEL', createdAt: new Date().toISOString(), confirmedAt: new Date().toISOString() },
  ]));
  const store = new MemoryStore(file);

  assert.deepEqual((await store.search('PRIVATE_LEGACY_SENTINEL')).map((item) => item.id), []);
  assert.deepEqual((await store.search('SHARED_CONFIRMED_SENTINEL')).map((item) => item.id), ['confirmed']);
  assert.deepEqual((await store.listUsable()).map((item) => item.id), ['confirmed']);
});

test('loads skill metadata and content on demand', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-skill-'));
  const directory = path.join(root, 'review');
  await mkdir(path.join(directory, 'references'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nDo it.');
  await writeFile(path.join(directory, 'references', 'guide.md'), 'Review carefully.');
  const loader = new SkillLoader(root);
  await loader.load();

  assert.match(loader.catalog(), /review: Review code/);
  assert.match(loader.catalog(), /location:/);
  assert.match(loader.get('review')?.content ?? '', /Do it/);
  assert.match((await loader.readResource('review', 'references/guide.md')).content, /carefully/);
  await assert.rejects(loader.readResource('review', '../secret'), /不能超出/);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, path.join(directory, 'references', 'escape.md'));
  await assert.rejects(loader.readResource('review', 'references/escape.md'), /符号链接/);
});

test('reports invalid skills without breaking valid skill discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-skill-invalid-'));
  await mkdir(path.join(root, 'Bad_Name'), { recursive: true });
  await writeFile(path.join(root, 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: Invalid\n---\nNo.');
  const loader = new SkillLoader(root);
  await loader.load();

  assert.deepEqual(loader.list(), []);
  assert.equal(loader.diagnostics().length, 1);
});

test('rejects oversized skill instructions and resources before loading them fully', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-skill-limit-'));
  const oversized = path.join(root, 'oversized');
  const valid = path.join(root, 'valid');
  await mkdir(oversized, { recursive: true });
  await mkdir(valid, { recursive: true });
  await writeFile(path.join(oversized, 'SKILL.md'), 'x'.repeat(512_001));
  await writeFile(path.join(valid, 'SKILL.md'), '---\nname: valid\ndescription: Valid\n---\nUse it.');
  await writeFile(path.join(valid, 'large.md'), 'x'.repeat(256_001));
  const loader = new SkillLoader(root);
  await loader.load();

  assert.equal(loader.get('oversized'), undefined);
  assert.ok(loader.get('valid'));
  assert.match(loader.diagnostics().join('\n'), /SKILL.md 超过 512KB/);
  await assert.rejects(loader.readResource('valid', 'large.md'), /超过 256KB/);
});

test('indexes and searches local documents without a vector database', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-'));
  const docs = path.join(root, 'knowledge');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(docs, { recursive: true }));
  await writeFile(path.join(docs, 'agent.md'), 'MimiAgent 使用 TypeScript 构建。');
  const indexFile = path.join(root, 'index.json');
  const rag = new RagStore(root, indexFile);

  assert.deepEqual(await rag.index('knowledge'), { files: 1, chunks: 1, embeddings: false });
  assert.equal((await rag.search('TypeScript'))[0]?.source, 'knowledge/agent.md');
  assert.ok((await readFile(indexFile, 'utf8')).includes('MimiAgent'));
});

test('never indexes private session runtime data into shared RAG', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-private-'));
  const runtime = path.join(root, '.mimi-agent');
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(root, 'public.md'), 'PUBLIC_KNOWLEDGE_SENTINEL');
  await writeFile(path.join(runtime, 'private.txt'), 'PRIVATE_SESSION_SENTINEL');
  const rag = new RagStore(root, path.join(runtime, 'rag-index.json'), undefined, [runtime]);

  await rag.index('.');
  assert.equal((await rag.search('PUBLIC_KNOWLEDGE_SENTINEL'))[0]?.source, 'public.md');
  assert.deepEqual(await rag.search('PRIVATE_SESSION_SENTINEL'), []);
  await assert.rejects(rag.index('.mimi-agent'), /MimiAgent 私有运行数据/);
});

test('rebuilds RAG embeddings when the embedding model changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-model-'));
  const docs = path.join(root, 'knowledge');
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, 'agent.md'), 'MimiAgent context management.');
  const indexFile = path.join(root, 'index.json');
  const previous = process.env.EMBEDDING_MODEL;
  let oldCalls = 0;
  let newCalls = 0;
  const client = (counter: () => void) => ({
    embeddings: {
      create: async ({ input }: { input: string | string[] }) => {
        counter();
        const values = Array.isArray(input) ? input : [input];
        return { data: values.map((_, index) => ({ embedding: [index + 1, 0] })) };
      },
    },
  }) as never;
  try {
    process.env.EMBEDDING_MODEL = 'embedding-old';
    await new RagStore(root, indexFile, client(() => { oldCalls += 1; })).index('knowledge');
    process.env.EMBEDDING_MODEL = 'embedding-new';
    await new RagStore(root, indexFile, client(() => { newCalls += 1; })).index('knowledge');
  } finally {
    if (previous === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = previous;
  }
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
});

test('context keeps recent history and injects memory, RAG and plan', async () => {
  const manager = new ContextManager(1);
  const history = [{ role: 'user', content: 'old' }, { role: 'user', content: 'recent' }] as AgentInputItem[];
  const compacted = await manager.sessionInput(history, [{ role: 'user', content: 'new' }]);
  assert.deepEqual(compacted, [history[1], { role: 'user', content: 'new' }]);
  assert.match(manager.summarizeHistory(history), /old/);
  const instructions = manager.buildInstructions({
    baseInstructions: 'base',
    sessionState: 'Session：demo\nPlan：1/2 completed · 当前阶段：2 test',
    historySummary: 'older conversation',
    skillCatalog: '- review: code',
    memories: [{
      id: 'm1', type: 'fact', content: 'uses TS', createdAt: '',
      personId: 'alice', personName: 'Alice Chen', sourceTrust: 'external',
    }],
    documents: [{ source: 'doc.md', content: 'hello', score: 1 }],
    plan: [{ id: '1', description: 'test', status: 'running' }],
    goal: { objective: 'ship', status: 'active', createdAt: '', updatedAt: '' },
  });
  assert.match(instructions, /uses TS/);
  assert.match(instructions, /person=Alice Chen/);
  assert.match(instructions, /trust=external/);
  assert.match(instructions, /older conversation/);
  assert.match(instructions, /doc\.md/);
  assert.match(instructions, /running/);
  assert.match(instructions, /ship/);
  assert.match(instructions, /当前会话状态/);
  assert.match(instructions, /Session：demo/);
  assert.match(instructions, /Plan：1\/2 completed/);
});

test('context trimming keeps tool calls paired and never persists generated summaries', async () => {
  const manager = new ContextManager(2);
  const history = [
    { type: 'message', role: 'user', content: 'first' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
    { role: 'user', content: '[更早的会话历史已压缩为摘要，共 2 条]\nlegacy' },
    { type: 'message', role: 'user', content: 'second' },
    { type: 'function_call', name: 'demo', callId: 'call-1', arguments: '{}' },
    { type: 'function_call_result', name: 'demo', callId: 'call-1', output: { type: 'text', text: 'done' } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
  ] as unknown as AgentInputItem[];
  const next = await manager.sessionInput(history, [{ role: 'user', content: 'third' }]);
  const serialized = JSON.stringify(next);

  assert.doesNotMatch(serialized, /更早的会话历史已压缩/);
  assert.match(serialized, /"type":"function_call"/);
  assert.match(serialized, /"type":"function_call_result"/);
  assert.ok(serialized.indexOf('function_call') < serialized.indexOf('function_call_result'));
});

test('limits recent history by token budget even below the item limit', async () => {
  const manager = new ContextManager(100, 4_000, 0.5);
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: 'user',
    content: `message-${index} ${'上下文'.repeat(180)}`,
  })) as AgentInputItem[];
  const next = await manager.sessionInput(history, [{ role: 'user', content: 'new' }]);

  assert.ok(next.length < history.length + 1);
  assert.match(JSON.stringify(next.at(-1)), /new/);
  assert.match(manager.summarizeHistory(history), /用户:/);
});

test('caps dynamic instructions within their token budget', () => {
  const manager = new ContextManager(100, 4_000, 0.5);
  const instructions = manager.buildInstructions({
    baseInstructions: 'base',
    historySummary: '历史'.repeat(4_000),
    skillCatalog: '技能'.repeat(4_000),
    memories: [],
    documents: [],
    plan: [],
  });
  assert.ok(estimateTokens(instructions) <= 2_000);
});

test('budgets the complete model request including input, instructions, tools and output reserve', () => {
  const contextWindow = 4_000;
  const outputReserveTokens = 600;
  const manager = new ContextManager(100, contextWindow, 0.55, outputReserveTokens);
  const tools = [{
    type: 'function',
    name: 'read_file',
    description: 'Read part of a workspace file and return its contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        lineStart: { type: 'number' },
        lineEnd: { type: 'number' },
      },
      required: ['path'],
    },
  }];
  const budget = manager.requestBudget(tools);

  assert.equal(budget.contextWindow, contextWindow);
  assert.equal(budget.outputReserveTokens, outputReserveTokens);
  assert.ok(budget.toolSchemaTokens >= estimateTokens(tools));
  assert.equal(
    budget.inputBudget,
    contextWindow - outputReserveTokens - budget.toolSchemaTokens,
  );

  const instructionBudget = Math.min(800, budget.inputBudget);
  const instructions = manager.buildInstructions({
    baseInstructions: `base ${'规则'.repeat(2_000)}`,
    historySummary: '',
    skillCatalog: '',
    memories: [],
    documents: [],
    plan: [],
  }, instructionBudget);
  const messageBudget = budget.inputBudget - estimateTokens(instructions);
  const currentInput = `current-input-start ${'当前输入'.repeat(4_000)} current-input-end`;
  const effective = manager.effectiveHistory(
    [{ role: 'user', content: `old-history ${'历史'.repeat(1_000)}` } as AgentInputItem],
    [{ role: 'user', content: currentInput } as AgentInputItem],
    undefined,
    messageBudget,
  );
  const serialized = JSON.stringify(effective);

  assert.ok(estimateTokens(instructions) <= instructionBudget);
  assert.ok(estimateTokens(effective) <= messageBudget);
  assert.ok(
    estimateTokens(instructions)
      + estimateTokens(effective)
      + budget.toolSchemaTokens
      + budget.outputReserveTokens
      <= contextWindow,
  );
  assert.match(serialized, /current-input-start/);
  assert.doesNotMatch(serialized, /current-input-end/);
});

test('reports raw, effective and archived context with non-overlapping semantics', () => {
  const manager = new ContextManager(100, 4_000, 0.5);
  const history = [
    { role: 'user', content: 'archived question' },
    { role: 'assistant', content: 'archived answer' },
    { role: 'user', content: 'visible question' },
    { role: 'assistant', content: 'visible answer' },
  ] as AgentInputItem[];
  const archive = {
    coveredItems: 2,
    summary: 'summary of the archived turn',
    strategy: 'collapse' as const,
    originalTokens: estimateTokens(history.slice(0, 2)),
    compactedTokens: estimateTokens('summary of the archived turn'),
    updatedAt: new Date().toISOString(),
  };
  const input = [{ role: 'user', content: 'current question' } as AgentInputItem];
  const effective = manager.effectiveHistory(history, input, archive);
  const stats = manager.stats(history, effective, archive, input.length);

  assert.equal(stats.rawTokens, estimateTokens(history));
  assert.equal(stats.effectiveTokens, estimateTokens(effective));
  assert.equal(stats.archiveTokens, archive.compactedTokens);
  assert.equal(stats.coveredItems, archive.coveredItems);
  assert.ok(stats.strategies.includes('context-collapse'));
});

test('drops an oversized tool-heavy turn instead of violating the token budget', async () => {
  const manager = new ContextManager(100, 4_000, 0.5);
  const history = [
    { type: 'message', role: 'user', content: 'large tool task' },
    ...Array.from({ length: 20 }, (_, index) => ({
      type: index % 2 ? 'function_call_result' : 'function_call',
      name: 'read_file',
      callId: `call-${Math.floor(index / 2)}`,
      ...(index % 2 ? { output: '内容'.repeat(1_000) } : { arguments: '{}' }),
    })),
  ] as unknown as AgentInputItem[];
  const next = await manager.sessionInput(history, [{ role: 'user', content: 'new task' }]);
  assert.deepEqual(next, [{ role: 'user', content: 'new task' }]);
});

test('persists context collapse while keeping the raw transcript unchanged', async () => {
  const manager = new ContextManager(4, 4_000, 0.5);
  const history = Array.from({ length: 6 }, (_, index) => [
    { type: 'message', role: 'user', content: `task-${index}` },
    { type: 'function_call', name: 'read_file', callId: `call-${index}`, arguments: '{}' },
    { type: 'function_call_result', name: 'read_file', callId: `call-${index}`, output: `result-${index} ${'内容'.repeat(600)}` },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `done-${index}` }] },
  ]).flat() as unknown as AgentInputItem[];
  const raw = JSON.stringify(history);

  const archive = manager.compactArchive(history, undefined, 'collapse');
  assert.ok(archive);
  assert.ok((archive?.coveredItems ?? 0) > 0);
  assert.match(archive?.summary ?? '', /task-/);
  const effective = manager.effectiveHistory(history, [{ role: 'user', content: 'next' } as AgentInputItem], archive);
  assert.equal(JSON.stringify(history), raw);
  assert.match(JSON.stringify(effective), /next/);
  assert.ok(estimateTokens(effective) < estimateTokens(history));

  const stats = manager.stats(history, effective, archive, 1);
  assert.ok(stats.strategies.includes('context-collapse'));
  assert.ok(stats.coveredItems > 0);
});

test('full compact archives all but the latest two complete turns', () => {
  const manager = new ContextManager(100, 128_000);
  const history = Array.from({ length: 5 }, (_, index) => [
    { role: 'user', content: `question-${index}` },
    { role: 'assistant', content: `answer-${index}` },
  ]).flat() as AgentInputItem[];

  const archive = manager.compactArchive(history, undefined, 'full');
  assert.equal(archive?.strategy, 'full');
  assert.equal(archive?.coveredItems, 6);
  assert.match(archive?.summary ?? '', /question-0/);
  assert.doesNotMatch(archive?.summary ?? '', /question-4/);
  const effective = manager.effectiveHistory(history, [], archive);
  assert.match(JSON.stringify(effective), /question-3/);
  assert.match(JSON.stringify(effective), /question-4/);
});

test('microcompacts only older tool results in the model-facing view', () => {
  const manager = new ContextManager(100, 128_000);
  const history = Array.from({ length: 4 }, (_, index) => [
    { role: 'user', content: `question-${index}` },
    { type: 'function_call', name: 'read_file', callId: `call-${index}`, arguments: '{}' },
    { type: 'function_call_result', name: 'read_file', callId: `call-${index}`, output: `start-${index} ${'x'.repeat(1_000)} end-${index}` },
    { role: 'assistant', content: `answer-${index}` },
  ]).flat() as unknown as AgentInputItem[];

  const effective = manager.effectiveHistory(history, []);
  const serialized = JSON.stringify(effective);
  assert.match(serialized, /较早工具结果已压缩/);
  assert.doesNotMatch(serialized, /end-0/);
  assert.match(serialized, /end-3/);
  assert.equal(JSON.stringify(history).includes('较早工具结果已压缩'), false);
});

test('keeps plans isolated by session and writes JSONL traces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-state-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'first');
  await plans.update([{ id: '1', description: 'build', status: 'running' }]);
  plans.useSession('second');
  assert.deepEqual(await plans.get(), []);
  plans.useSession('first');
  assert.equal((await plans.get())[0]?.description, 'build');
  const goal = await plans.setGoal('ship MimiAgent');
  assert.equal(goal.status, 'active');
  await plans.checkpoint({ checkpoint: 'tests pass', nextAction: 'publish' });
  assert.match(await plans.resumePrompt(), /tests pass/);
  await plans.update([{ id: 'old', description: 'old task', status: 'running' }]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await plans.setGoal('new objective');
  assert.deepEqual(await plans.get(), []);
  const current = await plans.getGoal();
  assert.notEqual(current?.createdAt, goal.createdAt);

  const traces = new TraceStore(path.join(root, 'traces'));
  await traces.record('first', 'turn_end', { answer: 'done' });
  const trace = await readFile(path.join(root, 'traces', 'first.jsonl'), 'utf8');
  assert.match(trace, /"type":"turn_end"/);
  assert.match(trace, /"answer":"done"/);
  assert.equal((await stat(path.join(root, 'traces'))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(root, 'traces', 'first.jsonl'))).mode & 0o777, 0o600);

  const rotating = new TraceStore(path.join(root, 'rotating'), 180);
  await rotating.record('demo', 'status', { detail: 'x'.repeat(120) });
  await rotating.record('demo', 'status', { detail: 'y'.repeat(120) });
  assert.match(await readFile(path.join(root, 'rotating', 'demo.1.jsonl'), 'utf8'), /xxxx/);
});

test('binds an in-flight plan read to the session that started it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-plan-read-isolation-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'first');
  await plans.update([{ id: 'a', description: 'FIRST_ONLY', status: 'running' }]);
  plans.useSession('second');
  await plans.update([{ id: 'b', description: 'SECOND_ONLY', status: 'running' }]);
  plans.useSession('first');

  const firstRead = plans.get();
  plans.useSession('second');
  assert.equal((await firstRead)[0]?.description, 'FIRST_ONLY');
});

test('serializes concurrent plan and goal mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-plan-concurrent-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'demo');
  await plans.setGoal('ship');
  await Promise.all([
    plans.update([{ id: '1', description: 'build', status: 'running' }]),
    plans.checkpoint({ checkpoint: 'started', nextAction: 'test' }),
  ]);

  assert.equal((await plans.get())[0]?.description, 'build');
  assert.equal((await plans.getGoal())?.checkpoint, 'started');
});

test('emits plan snapshots after task updates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-plan-events-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'demo');
  const snapshots: string[][] = [];
  plans.onChange((sessionId, steps) => {
    assert.equal(sessionId, 'demo');
    snapshots.push(steps.map((step) => `${step.id}:${step.status}`));
  });

  await plans.update([
    { id: 'inspect', description: '检查', status: 'completed' },
    { id: 'build', description: '实现', status: 'running' },
  ]);
  assert.deepEqual(snapshots, [['inspect:completed', 'build:running']]);
});

test('migrates legacy MCP config and accepts Streamable HTTP config', () => {
  const legacy = parseMcpConfig({ servers: { fs: { command: 'npx', args: ['server'] } } });
  const modern = parseMcpConfig({ mcpServers: { remote: { type: 'http', url: 'https://example.com/mcp' } } });
  assert.equal('command' in legacy.fs!, true);
  assert.equal('url' in modern.remote!, true);
});

test('requires an explicit per-server allowlist for MCP environment expansion', () => {
  const previous = process.env.MCP_TEST_TOKEN;
  process.env.MCP_TEST_TOKEN = 'allowed-value';
  try {
    assert.equal(expandMcpEnvironment('Bearer ${MCP_TEST_TOKEN}', ['MCP_TEST_TOKEN']), 'Bearer allowed-value');
    assert.throws(() => expandMcpEnvironment('${MCP_TEST_TOKEN}'), /allowedEnv/);
  } finally {
    if (previous === undefined) delete process.env.MCP_TEST_TOKEN;
    else process.env.MCP_TEST_TOKEN = previous;
  }
});

test('passes an explicit resolver only to a trusted MCP without exposing its secret as ambient env', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-explicit-env-'));
  const config = path.join(root, 'mcp.json');
  const marker = path.join(root, 'mcp-environment.json');
  const fixture = new URL('./fixtures/mcp-environment-fixture.mjs', import.meta.url);
  const secret = 'task-mcp-explicit-secret';
  await writeFile(config, JSON.stringify({ mcpServers: { explicit: {
    command: process.execPath,
    args: [fileURLToPath(fixture), marker],
    allowedEnv: ['MCP_TASK_SECRET'],
    env: { INJECTED_MCP_TOKEN: '${MCP_TASK_SECRET}' },
  } } }));
  const previous = process.env.MCP_TASK_SECRET;
  delete process.env.MCP_TASK_SECRET;
  const manager = new MCPManager(config, root, {
    resolveEnvironment: (name) => name === 'MCP_TASK_SECRET' ? secret : undefined,
  });
  try {
    assert.deepEqual(await manager.connect(), ['explicit']);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      injected: secret,
    });
    assert.equal(process.env.MCP_TASK_SECRET, undefined);
  } finally {
    await manager.close();
    if (previous === undefined) delete process.env.MCP_TASK_SECRET;
    else process.env.MCP_TASK_SECRET = previous;
  }
});

test('collects allowedEnv only from a trusted MCP configuration and redacts connection errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-bundle-'));
  const config = path.join(root, 'mcp.json');
  const secret = 'mcp-error-secret-value';
  await writeFile(config, JSON.stringify({ mcpServers: { explicit: {
    command: '${MCP_TASK_SECRET}',
    allowedEnv: ['MCP_TASK_SECRET'],
  } } }));
  const environment: NodeJS.ProcessEnv = { MCP_TASK_SECRET: secret };
  assert.deepEqual(await collectTrustedMcpEnvironment(config, root, undefined, environment), {});
  assert.deepEqual(await collectTrustedMcpEnvironment(config, root, root, environment), {
    MCP_TASK_SECRET: secret,
  });

  const manager = new MCPManager(config, root, {
    resolveEnvironment: (name) => environment[name],
    redactError: (message) => message.split(secret).join('[REDACTED]'),
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await manager.connect();
    assert.doesNotMatch(JSON.stringify(manager.statuses()), new RegExp(secret));
    assert.match(manager.statuses()[0]?.error ?? '', /REDACTED/);
  } finally {
    console.error = originalError;
    await manager.close();
  }
});

test('does not execute an untrusted workspace MCP configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-mcp-untrusted-'));
  const marker = path.join(root, 'executed.txt');
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { untrusted: {
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
  } } }));
  const manager = new MCPManager(config, root, { enabled: false, disabledReason: 'workspace not trusted' });

  assert.deepEqual(await manager.connect(), []);
  await assert.rejects(access(marker), /ENOENT/);
  assert.match(manager.statuses()[0]?.error ?? '', /not trusted/);
});

test('does not spawn stdio MCP when its configuration is not authorized', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-no-stdio-'));
  const marker = path.join(root, 'executed.txt');
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { local: {
    command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
  } } }));
  const manager = new MCPManager(config, root, { allowStdio: false });

  assert.deepEqual(await manager.connect(), []);
  await assert.rejects(access(marker), /ENOENT/);
  assert.match(manager.statuses()[0]?.error ?? '', /未被本机授权/);
});

test('keeps valid MCP definitions when another config entry is invalid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-mcp-config-'));
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({
    mcpServers: {
      disabled: { command: 'node', enabled: false },
      invalid: { args: ['missing-command'] },
    },
  }));
  const manager = new MCPManager(config, root);
  await manager.connect();
  assert.equal(manager.statuses()[0]?.name, 'invalid');
  assert.equal(manager.statuses()[0]?.state, 'failed');
});

test('isolates an MCP connection failure instead of blocking startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-mcp-'));
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { broken: { command: 'mimi-agent-command-that-does-not-exist' } } }));
  const manager = new MCPManager(config, root);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(await manager.connect(), []);
    assert.equal(manager.statuses()[0]?.state, 'failed');
    await manager.close();
  } finally {
    console.error = originalError;
  }
});

test('invalidates replaced MCP tool caches before closing the old server', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-mcp-reload-cache-'));
  const config = path.join(root, 'mcp.json');
  const serverName = `reload-cache-${path.basename(root)}`;
  await writeFile(config, JSON.stringify({ mcpServers: {
    [serverName]: { type: 'http', url: 'https://example.com/mcp' },
  } }));
  const calls: string[] = [];
  const fakeServer = (label: 'old' | 'new', rejectInvalidation = false) => ({
    cacheToolsList: true,
    name: serverName,
    connect: async () => { calls.push(`${label}:connect`); },
    close: async () => { calls.push(`${label}:close`); },
    listTools: async () => [{
      name: `${label}_tool`,
      description: `${label} tool`,
      inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false },
    }],
    callTool: async () => [],
    invalidateToolsCache: async () => {
      calls.push(`${label}:invalidate`);
      await invalidateServerToolsCache(serverName);
      if (rejectInvalidation) throw new Error('simulated invalidation failure');
    },
  }) as unknown as MCPServer;
  const oldServer = fakeServer('old', true);
  const newServer = fakeServer('new');
  const manager = new MCPManager(config, root);
  let factoryCalls = 0;
  (manager as unknown as { createServer: () => MCPServer }).createServer = () => (
    factoryCalls++ === 0 ? oldServer : newServer
  );

  try {
    await manager.connect();
    assert.deepEqual((await getAllMcpTools(manager.servers)).map((tool) => tool.name), ['old_tool']);

    await manager.reload();

    assert.ok(calls.indexOf('old:invalidate') < calls.indexOf('old:close'));
    assert.ok(calls.includes('old:close'), 'close must run even when cache invalidation rejects');
    assert.deepEqual((await getAllMcpTools(manager.servers)).map((tool) => tool.name), ['new_tool']);
  } finally {
    await manager.close();
    await invalidateServerToolsCache(serverName);
  }
});

test('creates bounded researcher and reviewer agent tools', () => {
  const tools = createSubAgentTools({ mode: 'general', model: 'gpt-5-mini', tools: [] });
  assert.deepEqual(tools.map((tool) => tool.name), ['delegate_research', 'delegate_review']);
  const planTools = createSubAgentTools({ mode: 'plan', model: 'gpt-5-mini', tools: [] });
  assert.deepEqual(planTools.map((tool) => tool.name), ['delegate_research', 'delegate_architecture', 'delegate_review']);
});

test('emits lightweight runtime lifecycle hooks', async () => {
  const bus = new HookBus();
  const seen: string[] = [];
  bus.on((event) => { seen.push(event.type); });
  await bus.emit({ type: 'run_start', sessionId: 'demo', input: 'hello' });
  assert.deepEqual(seen, ['run_start']);
});

test('isolates hook failures from the Agent run lifecycle', async () => {
  const bus = new HookBus();
  const seen: string[] = [];
  bus.on(() => { throw new Error('broken trace sink'); });
  bus.on((event) => { seen.push(event.type); });

  await bus.emit({ type: 'run_end', sessionId: 'demo', answer: 'done' });

  assert.deepEqual(seen, ['run_end']);
  assert.match(bus.diagnostics()[0]?.error ?? '', /broken trace sink/);
});
