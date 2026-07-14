import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { TeamTaskStore } from '../src/core/team.js';
import { assertParallelSafe, createTeamTools, runTeamWave } from '../src/extensions/team.js';
import {
  subAgentToolNames,
  teamRoleToolNames,
  toolsForMode,
  toolsForPermission,
} from '../src/runtime/tool-policy.js';
import { AGENT_MODES } from '../src/runtime/instructions.js';
import { createTeamWorkerTools } from '../src/runtime/team-worker-tools.js';

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

test('normalizes task ids before self-dependency and graph validation', async () => {
  const team = await store();
  await assert.rejects(team.set([
    { id: ' a ', description: 'a', role: 'explorer', dependencies: ['a'], paths: [] },
    { id: 'b', description: 'b', role: 'reviewer', dependencies: [], paths: [] },
  ]), /不能依赖自己/);
});

test('renews only the active Team task claim lease', async () => {
  const team = await store();
  await team.set([
    { id: 'a', description: 'a', role: 'explorer', dependencies: [], paths: [] },
    { id: 'b', description: 'b', role: 'reviewer', dependencies: [], paths: [] },
  ]);
  const claimed = await team.claim('a', 'worker');
  const renewed = await team.renew('a', claimed.claimId!, Date.now() + 1_000);
  assert.ok(Date.parse(renewed.leaseExpiresAt!) > Date.parse(claimed.leaseExpiresAt!));
  await assert.rejects(team.renew('a', 'stale-claim'), /领取凭证已失效/);
});

test('claims an overlapping Team wave all-or-nothing', async () => {
  const team = await store();
  await team.set([
    { id: 'a', description: 'a', role: 'explorer', dependencies: [], paths: [] },
    { id: 'b', description: 'b', role: 'reviewer', dependencies: [], paths: [] },
    { id: 'c', description: 'c', role: 'architect', dependencies: [], paths: [] },
  ]);
  const originalReady = team.ready.bind(team);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  team.ready = async () => {
    const snapshot = await originalReady();
    arrivals += 1;
    if (arrivals === 2) release();
    else await barrier;
    return snapshot;
  };
  const options = {
    store: team,
    model: 'gpt-5-mini' as const,
    tools: [],
    workspaceRoot: '/tmp',
    runWorker: async (task: { id: string }) => `done ${task.id}`,
  };

  const waves = await Promise.allSettled([
    runTeamWave(options, ['a', 'b']),
    runTeamWave(options, ['c', 'b']),
  ]);

  assert.equal(waves.filter((result) => result.status === 'fulfilled').length, 1);
  assert.deepEqual((await team.list()).map((task) => task.status).sort(), ['completed', 'completed', 'pending']);
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

test('preserves concurrent team writes from separate store instances', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-team-instances-'));
  const file = path.join(root, 'teams.json');
  const first = new TeamTaskStore(file, 'first');
  const second = new TeamTaskStore(file, 'second');
  const tasks = (prefix: string) => [
    { id: `${prefix}-explore`, description: 'inspect', role: 'explorer' as const, dependencies: [], paths: [] },
    { id: `${prefix}-review`, description: 'review', role: 'reviewer' as const, dependencies: [`${prefix}-explore`], paths: [] },
  ];

  await Promise.all([first.set(tasks('a')), second.set(tasks('b'))]);

  assert.deepEqual((await first.list()).map((task) => task.id), ['a-explore', 'a-review']);
  assert.deepEqual((await second.list()).map((task) => task.id), ['b-explore', 'b-review']);
});

test('binds an in-flight team read to the session that started it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-team-read-isolation-'));
  const team = new TeamTaskStore(path.join(root, 'teams.json'), 'one');
  const inputs = [
    { id: 'a', description: 'ONE_A', role: 'explorer' as const, dependencies: [], paths: [] },
    { id: 'b', description: 'ONE_B', role: 'reviewer' as const, dependencies: [], paths: [] },
  ];
  await team.set(inputs);
  team.useSession('two');
  await team.set(inputs.map((task) => ({ ...task, description: `TWO_${task.description}` })));
  team.useSession('one');

  const firstRead = team.list();
  team.useSession('two');
  assert.doesNotMatch((await firstRead)[0]?.description ?? '', /^TWO_/);
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
  const events: Array<{ id: string; event: string; result?: string }> = [];
  const results = await runTeamWave({
    store: team, model: 'gpt-5-mini', tools: [], workspaceRoot: '/tmp', maxConcurrency: 99,
    onEvent: (task, event) => { events.push({ id: task.id, event, result: task.result }); },
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
  assert.ok(events.some((item) => item.id === 'a' && item.event === 'start'));
  assert.ok(events.some((item) => item.id === 'a' && item.event === 'end' && item.result === 'done a'));
  assert.ok(events.some((item) => item.id === 'b' && item.event === 'error' && item.result === 'expected failure'));
});

test('runs one ready Team task so dependency pipelines can advance', async () => {
  const team = await store();
  await team.set([
    { id: 'inspect', description: 'inspect', role: 'explorer', dependencies: [], paths: [] },
    { id: 'review', description: 'review', role: 'reviewer', dependencies: ['inspect'], paths: [] },
  ]);
  const tools = createTeamTools({
    store: team,
    model: 'gpt-5-mini',
    tools: [],
    workspaceRoot: '/tmp',
    runWorker: async () => 'done',
  });
  const runTeam = tools.find((item) => item.name === 'run_team');
  assert.ok(runTeam && 'invoke' in runTeam);

  await runTeam.invoke(new RunContext({}), JSON.stringify({ taskIds: ['inspect'] }));

  assert.equal((await team.list()).find((task) => task.id === 'inspect')?.status, 'completed');
  assert.deepEqual((await team.ready()).map((task) => task.id), ['review']);
});

test('contains a stale worker result after its claim has already been ended', async () => {
  const team = await store();
  await team.set([
    { id: 'late', description: 'late', role: 'explorer', dependencies: [], paths: [] },
    { id: 'other', description: 'other', role: 'reviewer', dependencies: [], paths: [] },
  ]);
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const workerBarrier = new Promise<void>((resolve) => { release = resolve; });
  const wave = runTeamWave({
    store: team,
    model: 'gpt-5-mini',
    tools: [],
    workspaceRoot: '/tmp',
    runWorker: async () => {
      started();
      await workerBarrier;
      return 'stale success';
    },
  }, ['late']);
  await startedPromise;
  await team.update('late', 'failed', 'lease recovered elsewhere');
  release();

  const result = await wave;
  assert.equal(result[0]?.status, 'failed');
  assert.match(result[0]?.output ?? '', /状态提交失败|已结束/);
  assert.equal((await team.list()).find((item) => item.id === 'late')?.result, 'lease recovered elsewhere');
});

test('does not let Team lifecycle callback failures change task outcomes', async () => {
  const team = await store();
  await team.set([
    { id: 'work', description: 'work', role: 'explorer', dependencies: [], paths: [] },
    { id: 'other', description: 'other', role: 'reviewer', dependencies: [], paths: [] },
  ]);
  const result = await runTeamWave({
    store: team,
    model: 'gpt-5-mini',
    tools: [],
    workspaceRoot: '/tmp',
    runWorker: async () => 'done',
    onEvent: async () => { throw new Error('observer failed'); },
  }, ['work']);

  assert.equal(result[0]?.status, 'completed');
  assert.equal((await team.list()).find((item) => item.id === 'work')?.status, 'completed');
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
  const workspace = path.resolve('/tmp/nano-overlap');
  assert.throws(() => assertParallelSafe([
    { id: 'relative', description: 'relative', role: 'builder', status: 'pending', dependencies: [], paths: ['src'], createdAt: now, updatedAt: now },
    { id: 'absolute', description: 'absolute', role: 'builder', status: 'pending', dependencies: [], paths: [path.join(workspace, 'src/api')], createdAt: now, updatedAt: now },
  ], workspace), /重叠/);
  const fake = (name: string) => ({ name }) as Tool;
  const base = ['read_file', 'write_file', 'run_shell', 'switch_mode'].map(fake);
  assert.deepEqual(toolsForMode('plan', base).map((item) => item.name), ['read_file', 'switch_mode']);
  assert.deepEqual(toolsForMode('ultra', base, [fake('run_team')]).map((item) => item.name), [...base.map((item) => item.name), 'run_team']);
  assert.deepEqual(
    toolsForMode('plan', [fake('http_get'), fake('http_request')]).map((item) => item.name),
    ['http_get'],
  );
  assert.ok(subAgentToolNames('researcher').includes('http_get'));
  assert.ok(!subAgentToolNames('researcher').includes('http_request'));
  assert.ok(teamRoleToolNames('explorer').includes('http_get'));
  assert.ok(!teamRoleToolNames('explorer').includes('http_request'));
  assert.ok(!teamRoleToolNames('builder').includes('run_shell'));
  assert.deepEqual(AGENT_MODES.map((item) => item.id), ['general', 'plan', 'ultra']);
});

test('does not let read-only Ultra builders regain mutation tools', () => {
  const now = new Date().toISOString();
  const task = {
    id: 'build', description: 'build', role: 'builder' as const, status: 'pending' as const,
    dependencies: [], paths: ['src'], createdAt: now, updatedAt: now,
  };
  const root = path.resolve('/tmp/nano-read-only-worker');
  const readOnly = createTeamWorkerTools({
    workspaceRoot: root, dataRoot: path.join(root, '.nano-agent'), permissionMode: 'read-only', task,
  }).map((tool) => tool.name);
  const workspace = createTeamWorkerTools({
    workspaceRoot: root, dataRoot: path.join(root, '.nano-agent'), permissionMode: 'workspace', task,
  }).map((tool) => tool.name);
  assert.ok(!readOnly.includes('write_file'));
  assert.ok(!readOnly.includes('edit_file'));
  assert.ok(!readOnly.includes('move_file'));
  assert.ok(workspace.includes('write_file'));
});

test('treats symlink aliases as overlapping builder ownership', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'nano-team-link-overlap-'));
  await mkdir(path.join(workspace, 'src'));
  await symlink(path.join(workspace, 'src'), path.join(workspace, 'alias'));
  const now = new Date().toISOString();
  assert.throws(() => assertParallelSafe([
    { id: 'real', description: 'real', role: 'builder', status: 'pending', dependencies: [], paths: ['src'], createdAt: now, updatedAt: now },
    { id: 'alias', description: 'alias', role: 'builder', status: 'pending', dependencies: [], paths: ['alias'], createdAt: now, updatedAt: now },
  ], workspace), /重叠/);
});

test('treats differently-cased new paths as aliases on case-insensitive platforms', () => {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return;
  const now = new Date().toISOString();
  assert.throws(() => assertParallelSafe([
    { id: 'upper', description: 'upper', role: 'builder', status: 'pending', dependencies: [], paths: ['New/Foo'], createdAt: now, updatedAt: now },
    { id: 'lower', description: 'lower', role: 'builder', status: 'pending', dependencies: [], paths: ['new/foo'], createdAt: now, updatedAt: now },
  ]), /重叠/);
});

test('applies local permission profiles before mode-specific tools', () => {
  const fake = (name: string) => ({ name }) as Tool;
  const tools = ['read_file', 'write_file', 'run_shell', 'http_get', 'http_request'].map(fake);
  assert.deepEqual(toolsForPermission('trusted', tools).map((item) => item.name), tools.map((item) => item.name));
  assert.deepEqual(
    toolsForPermission('workspace', tools).map((item) => item.name),
    ['read_file', 'write_file', 'http_get'],
  );
  assert.deepEqual(
    toolsForPermission('read-only', tools).map((item) => item.name),
    ['read_file', 'http_get'],
  );
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
  assert.deepEqual(seen.get('test'), ['read_file', 'calculate']);
  assert.deepEqual(seen.get('review'), ['read_file']);
  assert.ok(!seen.get('test')?.includes('write_file'));
  assert.ok(!seen.get('review')?.includes('write_file'));
});
