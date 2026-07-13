import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Tool } from '@openai/agents';
import { TeamTaskStore } from '../src/core/team.js';
import { assertParallelSafe, runTeamWave } from '../src/extensions/team.js';
import { toolsForMode } from '../src/runtime/tool-policy.js';
import { AGENT_MODES } from '../src/runtime/instructions.js';

async function store(name = 'demo') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-team-'));
  return new TeamTaskStore(path.join(root, 'teams.json'), name);
}

test('validates dependencies and atomically claims a ready team task', async () => {
  const team = await store();
  await assert.rejects(team.set([
    { id: 'a', description: 'a', role: 'explorer', dependencies: ['b'], paths: [] },
    { id: 'b', description: 'b', role: 'architect', dependencies: ['a'], paths: [] },
  ]), /循环依赖/);
  await team.set([
    { id: 'a', description: 'inspect', role: 'explorer', dependencies: [], paths: [] },
    { id: 'b', description: 'design', role: 'architect', dependencies: ['a'], paths: [] },
  ]);
  assert.deepEqual((await team.ready()).map((item) => item.id), ['a']);
  const claims = await Promise.allSettled([team.claim('a', 'one'), team.claim('a', 'two')]);
  assert.equal(claims.filter((item) => item.status === 'fulfilled').length, 1);
  await team.update('a', 'completed', 'done');
  assert.deepEqual((await team.ready()).map((item) => item.id), ['b']);
});

test('keeps team task lists isolated by session', async () => {
  const team = await store('one');
  await team.set([
    { id: 'a', description: 'a', role: 'explorer', dependencies: [], paths: [] },
    { id: 'b', description: 'b', role: 'reviewer', dependencies: [], paths: [] },
  ]);
  team.useSession('two');
  assert.deepEqual(await team.list(), []);
  team.useSession('one');
  assert.equal((await team.list()).length, 2);
});

test('requires tester and reviewer gates after builder work', async () => {
  const team = await store();
  await assert.rejects(team.set([
    { id: 'build', description: 'build', role: 'builder', dependencies: [], paths: ['src/a.ts'] },
    { id: 'test', description: 'test', role: 'tester', dependencies: ['build'], paths: [] },
  ]), /reviewer/);
  const tasks = await team.set([
    { id: 'build', description: 'build', role: 'builder', dependencies: [], paths: ['src/a.ts'] },
    { id: 'test', description: 'test', role: 'tester', dependencies: ['build'], paths: [] },
    { id: 'review', description: 'review', role: 'reviewer', dependencies: ['build'], paths: [] },
  ]);
  assert.equal(tasks.length, 3);
});

test('runs an Ultra Team wave concurrently with bounded independent workers', async () => {
  const team = await store();
  await team.set([
    { id: 'a', description: 'inspect a', role: 'explorer', dependencies: [], paths: [] },
    { id: 'b', description: 'inspect b', role: 'reviewer', dependencies: [], paths: [] },
    { id: 'c', description: 'inspect c', role: 'architect', dependencies: [], paths: [] },
    { id: 'd', description: 'inspect d', role: 'explorer', dependencies: [], paths: [] },
  ]);
  let active = 0;
  let peak = 0;
  const results = await runTeamWave({
    store: team, model: 'gpt-5-mini', tools: [], workspaceRoot: '/tmp', maxConcurrency: 99,
    runWorker: async (task) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (task.id === 'b') throw new Error('expected failure');
      return `done ${task.id}`;
    },
  }, ['a', 'b', 'c', 'd']);
  assert.equal(peak, 4);
  assert.deepEqual(results.map((item) => item.status), ['completed', 'failed', 'completed', 'completed']);
  assert.deepEqual((await team.list()).map((item) => item.status), ['completed', 'failed', 'completed', 'completed']);
});

test('persists cancellation without rerunning completed work', async () => {
  const team = await store();
  await team.set([
    { id: 'a', description: 'a', role: 'explorer', dependencies: [], paths: [] },
    { id: 'b', description: 'b', role: 'reviewer', dependencies: [], paths: [] },
  ]);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  let calls = 0;
  const results = await runTeamWave({
    store: team, model: 'gpt-5-mini', tools: [], workspaceRoot: '/tmp', signal: controller.signal,
    runWorker: async () => { calls += 1; return 'unexpected'; },
  }, ['a', 'b']);
  assert.equal(calls, 0);
  assert.deepEqual(results.map((item) => item.status), ['failed', 'failed']);
  await assert.rejects(runTeamWave({
    store: team, model: 'gpt-5-mini', tools: [], workspaceRoot: '/tmp',
    runWorker: async () => 'unexpected',
  }, ['a', 'b']), /尚未 ready/);
  await Promise.all([team.retry('a'), team.retry('b')]);
  assert.deepEqual((await team.ready()).map((item) => item.id), ['a', 'b']);
});

test('rejects overlapping builder ownership and Plan hides mutating tools', () => {
  const now = new Date().toISOString();
  assert.throws(() => assertParallelSafe([
    { id: 'a', description: 'a', role: 'builder', status: 'pending', dependencies: [], paths: ['src'], createdAt: now, updatedAt: now },
    { id: 'b', description: 'b', role: 'builder', status: 'pending', dependencies: [], paths: ['src/api'], createdAt: now, updatedAt: now },
  ]), /重叠/);
  const fake = (name: string) => ({ name }) as Tool;
  const base = ['read_file', 'write_file', 'run_shell', 'switch_mode'].map(fake);
  assert.deepEqual(toolsForMode('plan', base).map((item) => item.name), ['read_file', 'switch_mode']);
  assert.deepEqual(toolsForMode('ultra', base, [fake('run_team')]).map((item) => item.name), [...base.map((item) => item.name), 'run_team']);
  assert.deepEqual(AGENT_MODES.map((item) => item.id), ['general', 'plan', 'ultra']);
});

test('gives tester and reviewer different read-only worker tool scopes', async () => {
  const team = await store();
  await team.set([
    { id: 'test', description: 'test', role: 'tester', dependencies: [], paths: [] },
    { id: 'review', description: 'review', role: 'reviewer', dependencies: [], paths: [] },
  ]);
  const fake = (name: string) => ({ name }) as Tool;
  const seen = new Map<string, string[]>();
  await runTeamWave({
    store: team,
    model: 'gpt-5-mini',
    workspaceRoot: '/tmp',
    tools: ['read_file', 'write_file', 'run_shell', 'calculate'].map(fake),
    runWorker: async (task, _prompt, tools) => {
      seen.set(task.id, tools.map((item) => item.name));
      return 'ok';
    },
  }, ['test', 'review']);
  assert.deepEqual(seen.get('test'), ['read_file', 'run_shell', 'calculate']);
  assert.deepEqual(seen.get('review'), ['read_file', 'run_shell']);
  assert.ok(!seen.get('test')?.includes('write_file'));
  assert.ok(!seen.get('review')?.includes('write_file'));
});
