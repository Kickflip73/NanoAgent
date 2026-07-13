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
      workspaceRoot: '/tmp/demo',
      maxTurns: 200,
      skillCount: 2,
      memoryCount: 1,
      mcpServers: [],
    }),
    listSessions: async () => ['demo'],
    switchSession: async () => undefined,
    history: async () => [],
    clearSession: async () => undefined,
    listSkills: () => [{ name: 'review', description: 'Review code' }],
    listMemories: async () => [{ id: 'm1', type: 'fact', content: 'uses TS', createdAt: '' }],
    currentPlan: async () => [{ id: '1', description: 'test', status: 'running' }],
    indexKnowledge: async () => ({ files: 1, chunks: 1, embeddings: false }),
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
