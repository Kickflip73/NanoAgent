import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, tool, type AgentInputItem, type SessionInputCallback, type Tool } from '@openai/agents';
import { z } from 'zod';
import { MemoryStore } from '../src/core/memory.js';
import { PlanStore } from '../src/core/plan.js';
import { TeamTaskStore } from '../src/core/team.js';
import { FileSession } from '../src/core/session.js';
import { decideEvent } from '../src/daemon/policy.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { MimiAgent, type MimiRunOptions } from '../src/runtime/mimi-agent.js';
import { TerminalRunInterruptedError } from '../src/runtime/run-outcome.js';

function hostTool(name: string): Tool {
  return tool({
    name,
    description: `test ${name}`,
    parameters: z.object({}),
    execute: async () => 'ok',
  });
}

function externalEvent(): StoredEvent {
  const at = '2026-07-15T00:00:00.000Z';
  return {
    id: 'external-event', externalId: 'external-message', source: 'webhook:test', kind: 'command', trust: 'external',
    payload: { text: 'EXTERNAL_CURRENT_INPUT' }, occurredAt: at, receivedAt: at, priority: 50,
    profileId: 'owner', status: 'running', attempts: 1, notBefore: at, createdAt: at, updatedAt: at,
  };
}

test('external runs inject host instructions without exposing private Session context or privileged host tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-external-policy-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionId = 'external-session';
  const session = new FileSession(path.join(dataRoot, 'sessions'), sessionId);
  await session.addItems([
    { role: 'user', content: 'PRIVATE_HISTORY_INPUT' },
    { role: 'assistant', content: 'PRIVATE_HISTORY_ANSWER' },
  ] as AgentInputItem[]);
  await session.setContextArchive({
    coveredItems: 2, summary: 'PRIVATE_ARCHIVE_SUMMARY', strategy: 'collapse',
    originalTokens: 100, compactedTokens: 10, updatedAt: new Date().toISOString(),
  });
  const checkpoint = await session.beginRun('PRIVATE_RECOVERY_INPUT', 'private-recovery');
  await session.failRun('PRIVATE_RECOVERY_ERROR', true, checkpoint.runId);
  await new MemoryStore(path.join(dataRoot, 'memories.json')).remember(
    'PRIVATE_MEMORY', 'fact', { source: 'user', sourceSessionId: sessionId },
  );
  await new PlanStore(path.join(dataRoot, 'plans.json'), sessionId).setGoal('PRIVATE_GOAL');
  await writeFile(path.join(root, 'MIMI.md'), 'PRIVATE_GUIDANCE');

  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = sessionId;
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot, permissionMode: 'trusted',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  let capturedAgent: Record<string, unknown> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;
  let completed = false;
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async (runtimeAgent, _input, options) => {
    capturedAgent = runtimeAgent as Record<string, unknown>;
    capturedOptions = options as Record<string, unknown>;
    const runSession = (options as { session: FileSession }).session;
    await runSession.addItems([
      { role: 'user', content: 'EXTERNAL_CURRENT_INPUT' },
      { role: 'assistant', content: 'EXTERNAL_CURRENT_OUTPUT' },
    ] as AgentInputItem[]);
    return {};
  };

  try {
    const decision = decideEvent(externalEvent(), ['HOST_STANDING_ORDER']);
    await agent.stream(decision.input!, undefined, {
      ...decision.options,
      hostTools: [
        hostTool('finish_mimi_silently'),
        hostTool('connector_action'),
        hostTool('inspect_mimi_activity'),
        hostTool('unknown_external_tool'),
      ],
    });

    const instructions = String(capturedAgent?.instructions ?? '');
    assert.doesNotMatch(instructions, /HOST_STANDING_ORDER/);
    for (const privateValue of [
      'PRIVATE_HISTORY_INPUT', 'PRIVATE_HISTORY_ANSWER', 'PRIVATE_ARCHIVE_SUMMARY',
      'PRIVATE_RECOVERY_INPUT', 'PRIVATE_RECOVERY_ERROR', 'PRIVATE_MEMORY', 'PRIVATE_GOAL', 'PRIVATE_GUIDANCE',
    ]) assert.doesNotMatch(instructions, new RegExp(privateValue));

    const names = ((capturedAgent?.tools ?? []) as Array<{ name: string }>).map((item) => item.name);
    assert.ok(names.includes('finish_mimi_silently'));
    assert.doesNotMatch(names.join(','), /read_file|run_shell|connector_action|inspect_mimi_activity|unknown_external_tool/);
    assert.equal(((capturedAgent?.mcpServers ?? []) as unknown[]).length, 0);

    const callback = capturedOptions?.sessionInputCallback as SessionInputCallback;
    const visible = await callback(
      [{ role: 'user', content: 'PRIVATE_SDK_SESSION_HISTORY' }] as AgentInputItem[],
      [{ role: 'user', content: decision.input! }] as AgentInputItem[],
    );
    assert.doesNotMatch(JSON.stringify(visible), /PRIVATE_SDK_SESSION_HISTORY/);
    assert.match(JSON.stringify(visible), /EXTERNAL_CURRENT_INPUT/);

    await agent.completeRun('EXTERNAL_CURRENT_OUTPUT');
    completed = true;
    const trustedItems = await session.getItems();
    assert.match(JSON.stringify(trustedItems), /PRIVATE_HISTORY_INPUT|PRIVATE_HISTORY_ANSWER/);
    assert.doesNotMatch(JSON.stringify(trustedItems), /EXTERNAL_CURRENT_INPUT|EXTERNAL_CURRENT_OUTPUT/);
    assert.equal((await session.getCheckpoint())?.runId, 'private-recovery');
    assert.equal((await session.getCheckpoint())?.status, 'interrupted');

    const isolated = new FileSession(path.join(dataRoot, 'isolated-sessions'), sessionId);
    assert.match(JSON.stringify(await isolated.getItems()), /EXTERNAL_CURRENT_INPUT/);
    assert.match(JSON.stringify(await isolated.getItems()), /EXTERNAL_CURRENT_OUTPUT/);
    assert.equal((await isolated.getCheckpoint())?.status, 'completed');
  } finally {
    if (!completed) await agent.failRun(new Error('test cleanup'), true);
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('default owner General runs expose Shell while Plan remains read-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-default-owner-shell-'));
  const previousSession = process.env.AGENT_SESSION;
  const previousSecret = process.env.OPENAI_API_KEY;
  process.env.AGENT_SESSION = 'default-owner-shell';
  process.env.OPENAI_API_KEY = 'DO_NOT_EXPOSE_TO_SHELL';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  let capturedTools: string[] = [];
  let shellOutput = '';
  let completed = false;
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async (runtimeAgent) => {
    const runtimeTools = (runtimeAgent as { tools: Array<Tool> }).tools;
    capturedTools = runtimeTools.map((item) => item.name);
    const shell = runtimeTools.find((item) => item.name === 'run_shell');
    assert.ok(shell && 'invoke' in shell);
    shellOutput = JSON.stringify(await shell.invoke(
      new RunContext({}),
      JSON.stringify({ command: 'printf %s "$OPENAI_API_KEY"', timeoutSeconds: 5 }),
    ));
    return {};
  };

  try {
    assert.ok(agent.toolNames.includes('run_shell'));
    await agent.stream('在本机执行一个简单命令', undefined, {
      cause: { eventId: 'local-shell-test', source: 'local-cli', trust: 'owner' },
      requireCompletionGate: false,
    });
    assert.ok(capturedTools.includes('run_shell'));
    assert.doesNotMatch(shellOutput, /DO_NOT_EXPOSE_TO_SHELL/);
    await agent.completeRun('done');
    completed = true;

    await agent.switchMode('plan');
    assert.ok(!agent.toolNames.includes('run_shell'));
  } finally {
    if (!completed) await agent.failRun(new Error('test cleanup'), true);
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
    if (previousSecret === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousSecret;
  }
});

test('restricted reply-only runs do not enable an impossible completion gate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-reply-only-completion-'));
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'),
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async () => ({});
  try {
    await agent.stream('生成今日主动简报', undefined, {
      policy: {
        allowedCapabilities: ['delivery-control'],
        allowSideEffects: false,
        allowUnknownTools: false,
        allowMcp: false,
        allowSessionContext: false,
      },
      hostTools: [hostTool('finish_mimi_silently')],
    });
    assert.equal(agent.completionGateRequired, false);
    await agent.completeRun('briefed');
  } finally {
    await agent.close();
  }
});

test('Plan mode describes requested changes without requiring impossible artifact evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-plan-completion-'));
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'), permissionMode: 'trusted',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async () => ({});
  try {
    await agent.switchMode('plan');
    await agent.stream('修改登录页并生成报告');
    assert.equal(agent.completionGateRequired, false);
    await agent.completeRun('只读实施方案');
  } finally {
    await agent.close();
  }
});

test('an unrelated long task cannot replace an unfinished Goal or inherit its Team', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-goal-ownership-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionId = 'goal-ownership';
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = sessionId;
  const plans = new PlanStore(path.join(dataRoot, 'plans.json'), sessionId);
  const team = new TeamTaskStore(path.join(dataRoot, 'teams.json'), sessionId);
  const existing = await plans.setGoal('EXISTING_UNFINISHED_GOAL');
  await team.set([{
    id: 'old-task', description: 'old work', role: 'builder', dependencies: [], paths: ['src/old.ts'],
  }, {
    id: 'old-test', description: 'old test', role: 'tester', dependencies: ['old-task'], paths: [],
  }, {
    id: 'old-review', description: 'old review', role: 'reviewer', dependencies: ['old-test'], paths: [],
  }]);
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot, permissionMode: 'trusted',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  const runner = (agent as unknown as { runner: { run: () => Promise<unknown> } }).runner;
  runner.run = async () => ({});
  try {
    await agent.stream('这是另一个需要多阶段长期执行并生成报告的新任务');
    assert.equal((await plans.getGoal())?.createdAt, existing.createdAt);
    assert.equal((await plans.getGoal())?.objective, 'EXISTING_UNFINISHED_GOAL');
    assert.deepEqual((await team.list()).map((task) => task.id), ['old-task', 'old-test', 'old-review']);
  } finally {
    await agent.failRun(new Error('test cleanup'), true);
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('an unrelated checkpoint retry cannot inherit an active Goal plan or Team', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-checkpoint-goal-ownership-'));
  const dataRoot = path.join(root, '.mimi-agent');
  const sessionId = 'checkpoint-goal-ownership';
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = sessionId;
  const plans = new PlanStore(path.join(dataRoot, 'plans.json'), sessionId);
  await plans.setGoal('ACTIVE_GOAL_A');
  await plans.update([{ id: 'goal-a-step', description: 'PRIVATE_GOAL_A_PLAN', status: 'running' }]);
  const team = new TeamTaskStore(path.join(dataRoot, 'teams.json'), sessionId);
  await team.set([{
    id: 'goal-a-builder', description: 'PRIVATE_GOAL_A_TEAM', role: 'builder', dependencies: [], paths: ['src/a.ts'],
  }, {
    id: 'goal-a-tester', description: 'test', role: 'tester', dependencies: ['goal-a-builder'], paths: [],
  }, {
    id: 'goal-a-reviewer', description: 'review', role: 'reviewer', dependencies: ['goal-a-tester'], paths: [],
  }]);
  const session = new FileSession(path.join(dataRoot, 'sessions'), sessionId);
  const unrelated = await session.beginRun('UNRELATED_TASK_B', 'unrelated-b');
  await session.failRun('interrupted B', true, unrelated.runId);
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot, permissionMode: 'trusted',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  let instructions = '';
  const runner = (agent as unknown as { runner: { run: (runtimeAgent: unknown) => Promise<unknown> } }).runner;
  runner.run = async (runtimeAgent) => {
    instructions = String((runtimeAgent as { instructions?: unknown }).instructions ?? '');
    return {};
  };
  try {
    await agent.stream('UNRELATED_TASK_B');
    assert.doesNotMatch(instructions, /PRIVATE_GOAL_A_PLAN|PRIVATE_GOAL_A_TEAM|ACTIVE_GOAL_A/);
    assert.equal((await plans.getGoal())?.objective, 'ACTIVE_GOAL_A');
  } finally {
    await agent.failRun(new Error('test cleanup'), true);
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('terminal cancellation removes the exact recoverable checkpoint instead of resuming it later', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-terminal-cancel-'));
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = 'terminal-cancel';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'), permissionMode: 'trusted',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async () => ({});
  try {
    await agent.stream('owner task');
    await agent.failRun(new TerminalRunInterruptedError('用户按下 Esc 取消任务'), true);
    assert.equal(await agent.recoveryInfo(), undefined);

    await agent.stream('recoverable task');
    await agent.failRun(new Error('dispatcher shutdown'), true);
    assert.equal((await agent.recoveryInfo())?.status, 'interrupted');
  } finally {
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('workspace owner runs expose configured connector actions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-owner-connector-action-'));
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = 'owner-connector-action';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'), permissionMode: 'workspace',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  let capturedTools: string[] = [];
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async (runtimeAgent) => {
    capturedTools = ((runtimeAgent as { tools: Array<{ name: string }> }).tools).map((item) => item.name);
    return {};
  };

  try {
    assert.ok((await agent.visibleToolNames([hostTool('connector_action')])).includes('connector_action'));
    await agent.stream('给联系人发微信', undefined, {
      cause: {
        eventId: 'owner-event', source: 'local-cli', trust: 'owner',
      },
      hostTools: [hostTool('connector_action')],
    });
    assert.ok(capturedTools.includes('connector_action'));
  } finally {
    await agent.failRun(new Error('test cleanup'), true);
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('an explicit event policy remains final authority over host tools', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-host-tool-permission-'));
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = 'host-tools';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'), permissionMode: 'workspace',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  let capturedTools: string[] = [];
  const runner = (agent as unknown as { runner: { run: (...args: unknown[]) => Promise<unknown> } }).runner;
  runner.run = async (runtimeAgent) => {
    capturedTools = ((runtimeAgent as { tools: Array<{ name: string }> }).tools).map((item) => item.name);
    return {};
  };
  const options: MimiRunOptions = {
    policy: {
      allowedCapabilities: ['network-write'], allowSideEffects: true,
      allowedSideEffectTools: ['connector_action'], allowUnknownTools: false,
      allowMcp: false, allowSessionContext: false,
    },
    hostTools: [hostTool('connector_action')],
  };

  try {
    await agent.stream('test', undefined, options);
    assert.doesNotMatch(capturedTools.join(','), /connector_action/);
  } finally {
    await agent.failRun(new Error('test cleanup'), true);
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});

test('workspace owner runs expose MCP servers whose configuration was already trusted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-workspace-mcp-policy-'));
  const previousSession = process.env.AGENT_SESSION;
  process.env.AGENT_SESSION = 'workspace-mcp';
  const agent = await MimiAgent.create({
    provider: 'openai', workspaceRoot: root, dataRoot: path.join(root, '.mimi-agent'), permissionMode: 'workspace',
    skillsRoot: path.join(root, 'skills'), mcpConfig: path.join(root, 'mcp.json'),
    historyLimit: 40, contextWindow: 128_000, maxTurns: 20,
  });
  const internal = agent as unknown as {
    mcp: { servers: unknown[] };
    runner: { run: (runtimeAgent: unknown) => Promise<unknown> };
  };
  internal.mcp.servers.push({
    name: 'unclassified-server-tool',
    listTools: async () => [{
      name: 'send_message', description: 'fixture MCP tool', inputSchema: { type: 'object', properties: {} },
    }],
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close: async () => undefined,
  });
  let exposed: unknown[] = [];
  internal.runner.run = async (runtimeAgent) => {
    exposed = (runtimeAgent as { mcpServers: unknown[] }).mcpServers;
    return {};
  };
  try {
    assert.match((await agent.visibleToolNames()).join(','), /unclassified.*send_message/);
    await agent.stream('test');
    assert.equal(exposed.length, 1);
    assert.equal((exposed[0] as { name: string }).name, 'unclassified-server-tool');
  } finally {
    await agent.failRun(new Error('test cleanup'), true);
    await agent.close();
    if (previousSession === undefined) delete process.env.AGENT_SESSION;
    else process.env.AGENT_SESSION = previousSession;
  }
});
