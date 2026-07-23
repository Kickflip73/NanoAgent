import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { createMimiRoutineTools } from '../src/daemon/routine-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((tool) => tool.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

test('routine tools atomically list, upsert and remove fixed local-time work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-routine-tools-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  const tools = createMimiRoutineTools(attention);
  try {
    const initial = await invoke(tools, 'list_mimi_routines', {}) as Array<{ id: string }>;
    assert.deepEqual(initial.map((routine) => routine.id), ['morning-plan', 'evening-close']);

    const created = await invoke(tools, 'upsert_mimi_routine', {
      id: 'workday-inbox', enabled: true, time: '09:15', weekdays: [1, 2, 3, 4, 5],
      prompt: '检查重要邮件并直接处理；没有变化时静默完成', priority: 72,
      sessionKey: 'mimi-workday-inbox', replyChannel: 'connector:daxiang', replyTarget: 'single:owner',
    }) as { created: boolean; routine: { id: string } };
    assert.equal(created.created, true);
    assert.equal(created.routine.id, 'workday-inbox');

    const updated = await invoke(tools, 'upsert_mimi_routine', {
      id: 'workday-inbox', enabled: true, time: '09:30', weekdays: [1, 2, 3, 4, 5],
      prompt: '检查重要邮件、日程冲突和待办；无变化时静默完成', priority: 75,
    }) as { created: boolean; routine: { time: string } };
    assert.equal(updated.created, false);
    assert.equal(updated.routine.time, '09:30');
    assert.equal(attention.listRoutines().filter((routine) => routine.id === 'workday-inbox').length, 1);

    assert.deepEqual(await invoke(tools, 'remove_mimi_routine', { id: 'workday-inbox' }), {
      id: 'workday-inbox', removed: true,
    });
    assert.deepEqual(await invoke(tools, 'remove_mimi_routine', { id: 'workday-inbox' }), {
      id: 'workday-inbox', removed: false,
    });
    assert.equal(attention.listRoutines().some((routine) => routine.id === 'workday-inbox'), false);
    assert.equal((await stat(configFile)).mode & 0o777, 0o600);
    assert.equal((await readdir(root)).some((name) => name.endsWith('.tmp')), false);
    const persisted = await readFile(configFile, 'utf8');
    assert.doesNotThrow(() => JSON.parse(persisted));
  } finally {
    store.close();
  }
});

test('concurrent routine mutations serialize without losing either update', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-routine-concurrent-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  try {
    await Promise.all([
      attention.upsertRoutine({ id: 'first', enabled: true, time: '10:00', prompt: 'first task', priority: 60 }),
      attention.upsertRoutine({ id: 'second', enabled: true, time: '11:00', prompt: 'second task', priority: 60 }),
    ]);
    assert.deepEqual(
      attention.listRoutines().filter((routine) => ['first', 'second'].includes(routine.id)).map((routine) => routine.id),
      ['first', 'second'],
    );
  } finally {
    store.close();
  }
});

test('routine mutation tools are ledgered state writes while listing remains read-only', () => {
  const tools = createMimiRoutineTools({} as AttentionEngine);
  assert.equal(isSideEffectTool('list_mimi_routines'), false);
  assert.equal(isSideEffectTool('upsert_mimi_routine'), true);
  assert.equal(isSideEffectTool('remove_mimi_routine'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['list_mimi_routines']);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['upsert_mimi_routine', 'remove_mimi_routine']);
});
