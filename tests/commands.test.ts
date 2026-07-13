import assert from 'node:assert/strict';
import test from 'node:test';
import type { NanoAgent } from '../src/agent.js';
import { CommandHandler } from '../src/commands.js';

function fakeAgent(): NanoAgent {
  return {
    currentSessionId: 'demo',
    runtimeInfo: async () => ({
      provider: 'deepseek',
      model: 'deepseek-chat',
      sessionId: 'demo',
      sessionTitle: '讨论 NanoAgent',
      workspaceRoot: '/tmp/demo',
      maxTurns: 200,
      skillCount: 2,
      memoryCount: 1,
      mcpServers: [],
    }),
    listSessions: async () => ['demo'],
    listSessionSummaries: async () => [{
      id: 'demo',
      title: '讨论 NanoAgent',
      preview: '增加交互能力',
      updatedAt: new Date().toISOString(),
      turns: 2,
    }],
    switchSession: async () => undefined,
    history: async () => [],
    clearSession: async () => undefined,
    listSkills: () => [{ name: 'review', description: 'Review code' }],
    listMemories: async () => [{ id: 'm1', type: 'fact', content: 'uses TS', createdAt: '' }],
    currentPlan: async () => [{ id: '1', description: 'test', status: 'running' }],
    indexKnowledge: async () => ({ files: 1, chunks: 1, embeddings: false }),
    availableModels: () => ['deepseek-chat', 'deepseek-reasoner'],
    switchModel: () => undefined,
    contextInfo: async () => ({ historyItems: 4, historyLimit: 40, memories: 1, planSteps: 1 }),
    toolNames: ['read_file', 'run_shell'],
    mcpServerNames: [],
  } as unknown as NanoAgent;
}

test('handles status and high-frequency inspection commands', async () => {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(' '));
  const handler = new CommandHandler(fakeAgent(), async () => undefined);

  try {
    assert.equal(await handler.execute('/status'), 'handled');
    assert.equal(await handler.execute('/skills'), 'handled');
    assert.equal(await handler.execute('/memories'), 'handled');
    assert.equal(await handler.execute('/plan'), 'handled');
    assert.match(output.join('\n'), /deepseek-chat/);
    assert.match(output.join('\n'), /Review code/);
    assert.match(output.join('\n'), /uses TS/);
    assert.match(output.join('\n'), /running/);
  } finally {
    console.log = original;
  }
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

test('selects sessions by summary and clears the terminal for clean context changes', async () => {
  const switched: string[] = [];
  const output: string[] = [];
  let clears = 0;
  const agent = fakeAgent() as NanoAgent & { switchSession: (id: string) => Promise<void> };
  agent.switchSession = async (id) => { switched.push(id); };
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
    resetScreen: () => { clears += 1; },
    selectSession: async () => 'demo',
  });

  assert.equal(await handler.execute('/sessions'), 'handled');
  assert.deepEqual(switched, ['demo']);
  assert.equal(clears, 1);
  assert.match(output.join('\n'), /讨论 NanoAgent/);
});

test('selects a model and exposes common runtime inspection commands', async () => {
  const switched: string[] = [];
  const output: string[] = [];
  const agent = fakeAgent() as NanoAgent & { switchModel: (name: string) => void };
  agent.switchModel = (name) => switched.push(name);
  const handler = new CommandHandler(agent, async () => undefined, {
    write: (text) => output.push(text),
    selectModel: async () => 'deepseek-reasoner',
  });

  assert.equal(await handler.execute('/model'), 'handled');
  assert.equal(await handler.execute('/context'), 'handled');
  assert.equal(await handler.execute('/tools'), 'handled');
  assert.equal(await handler.execute('/mcp'), 'handled');
  assert.deepEqual(switched, ['deepseek-reasoner']);
  assert.match(output.join('\n'), /历史条目/);
  assert.match(output.join('\n'), /run_shell/);
  assert.match(output.join('\n'), /MCP 未连接/);
});
