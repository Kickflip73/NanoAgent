import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultTaskWorkerEntry,
  TaskProcessSupervisor,
  taskWorkerEnvironment,
  taskWorkerExecArgv,
} from '../src/daemon/task-supervisor.js';
import type { TaskRecord } from '../src/daemon/types.js';

function task(id: string, executor: TaskRecord['executor']): TaskRecord {
  return {
    id,
    type: 'background',
    idempotencyKey: id,
    authorityEventId: 'authority',
    profileId: 'owner',
    sessionKey: `mimi-task-${id}`,
    objective: { objective: 'build game' },
    executor,
    workspaceAccess: 'write',
    priority: 70,
    status: 'queued',
    notBefore: '2026-07-20T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
  };
}

test('process supervisor schedules Codex background tasks instead of ignoring them', async () => {
  const sessionTask = task('session-task', 'session_actor');
  const codexTask = task('codex-task', 'codex');
  const store = {
    emitDueMemoryMaintenanceTasks: () => [],
    runningTasks: () => [],
    readyTasks: () => [sessionTask, codexTask],
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
    { maxWorkers: 1 },
  );
  const internal = supervisor as unknown as {
    pump(): Promise<void>;
    launch(taskId: string, workspaceAccess: 'read' | 'write'): Promise<void>;
  };
  const launched: Array<{ taskId: string; workspaceAccess: 'read' | 'write' }> = [];
  internal.launch = async (taskId, workspaceAccess) => {
    launched.push({ taskId, workspaceAccess });
  };

  await internal.pump();

  assert.deepEqual(launched, [{ taskId: codexTask.id, workspaceAccess: 'write' }]);
});

test('detached Codex write task keeps the workspace reservation', async () => {
  const queued = task('queued-task', 'isolated_worker');
  const runningCodex = { ...task('running-codex', 'codex'), status: 'running' as const };
  const store = {
    emitDueMemoryMaintenanceTasks: () => [],
    runningTasks: () => [runningCodex],
    readyTasks: () => [queued],
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
    { maxWorkers: 2 },
  );
  const internal = supervisor as unknown as {
    pump(): Promise<void>;
    launch(taskId: string, workspaceAccess: 'read' | 'write'): Promise<void>;
  };
  const launched: string[] = [];
  internal.launch = async (taskId) => { launched.push(taskId); };

  await internal.pump();

  assert.deepEqual(launched, []);
});

test('task worker environment keeps only safe shell values and explicit worker controls', () => {
  assert.deepEqual(taskWorkerEnvironment({
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    LANG: 'en_US.UTF-8',
    OPENAI_API_KEY: 'provider-secret',
    CONNECTOR_TOKEN: 'connector-secret',
    TASK_WORKER_VISIBLE: 'yes',
    TASK_WORKER_SECRET: 'remove-me',
  }, ['TASK_WORKER_SECRET']), {
    PATH: '/usr/bin',
    HOME: '/tmp/home',
    LANG: 'en_US.UTF-8',
    TASK_WORKER_VISIBLE: 'yes',
  });
});

test('task worker exec arguments remove dotenv and env-file credential loaders only', () => {
  assert.deepEqual(taskWorkerExecArgv([
    '--trace-warnings',
    '--env-file', '/tmp/provider.env',
    '--env-file-if-exists=/tmp/optional.env',
    '--require', 'dotenv/config',
    '--import=dotenv/config.js',
    '--import', 'tsx',
    '-r./instrumentation.cjs',
  ]), [
    '--trace-warnings',
    '--import', 'tsx',
    '-r./instrumentation.cjs',
  ]);
});

test('default worker entry follows the source module extension', () => {
  assert.match(defaultTaskWorkerEntry('file:///tmp/runtime/task-supervisor.ts'), /task-worker-entry\.ts$/);
  assert.match(defaultTaskWorkerEntry('file:///tmp/runtime/task-supervisor.js'), /task-worker-entry\.js$/);
});

test('supervisor cancel and pause report durable task states without requiring a live worker', () => {
  const tasks = new Map<string, TaskRecord>([
    ['queued', task('queued', 'isolated_worker')],
    ['paused', { ...task('paused', 'isolated_worker'), status: 'paused' }],
    ['done', { ...task('done', 'isolated_worker'), status: 'completed' }],
  ]);
  const store = {
    getTask: (id: string) => tasks.get(id),
    cancelTask: (id: string, reason: string) => {
      const current = tasks.get(id)!;
      tasks.set(id, { ...current, status: 'cancelled', error: reason });
    },
    pauseTask: (id: string, reason: string) => {
      const current = tasks.get(id)!;
      const updated = { ...current, status: 'paused' as const, controlReason: reason };
      tasks.set(id, updated);
      return updated;
    },
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
  );

  assert.deepEqual(supervisor.cancel('missing'), { state: 'not_found' });
  assert.deepEqual(supervisor.cancel('done'), { state: 'already_terminal' });
  assert.deepEqual(supervisor.cancel('queued', 'stop now'), { state: 'cancelled' });
  assert.equal(tasks.get('queued')?.status, 'cancelled');
  assert.deepEqual(supervisor.pause('missing'), { state: 'not_found' });
  assert.deepEqual(supervisor.pause('paused'), { state: 'already_paused' });
  assert.deepEqual(supervisor.pause('done'), { state: 'already_terminal' });
});

test('worker authorization requires a live matching lease and owner-rooted write task', () => {
  const running = {
    ...task('authorized', 'isolated_worker'),
    status: 'running' as const,
    leaseOwner: 'worker-1',
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  const store = {
    getTask: (id: string) => id === running.id ? running : undefined,
    getImmutableEvent: (id: string) => id === running.authorityEventId ? { trust: 'owner' } : undefined,
    runningTasks: () => [],
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
  );
  const internal = supervisor as unknown as {
    workers: Map<string, {
      taskId: string;
      workerId: string;
      workerToken: string;
      workspaceAccess: 'read' | 'write';
    }>;
  };
  internal.workers.set(running.id, {
    taskId: running.id,
    workerId: 'worker-1',
    workerToken: 'worker-token',
    workspaceAccess: 'write',
  });

  assert.equal(supervisor.authorizeWorker(running.id, 'wrong-token'), false);
  assert.equal(supervisor.authorizeWorker(running.id, 'worker-token'), true);
  assert.equal(supervisor.authorizeWorkerAction(running.id, 'worker-token'), true);
  internal.workers.get(running.id)!.workspaceAccess = 'read';
  assert.equal(supervisor.authorizeWorkerAction(running.id, 'worker-token'), false);
});

test('status includes detached Codex process metadata from durable task state', () => {
  const detached = {
    ...task('detached', 'codex'),
    status: 'running' as const,
    workspaceAccess: 'read' as const,
    objective: {
      codex: {
        runnerPid: 123,
        codexPid: 456,
        startedAt: '2026-07-20T01:00:00.000Z',
      },
    },
  };
  const store = {
    getTask: () => undefined,
    runningTasks: () => [detached],
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
  );

  assert.deepEqual(supervisor.status(), [{
    taskId: 'detached',
    pid: 123,
    codexPid: 456,
    spawnedAt: '2026-07-20T01:00:00.000Z',
    heartbeatAt: detached.updatedAt,
    workspaceAccess: 'read',
    executor: 'codex',
  }]);
});

test('unexpected worker exits persist queued bootstrap and running lease failures', () => {
  const queued = task('queued-exit', 'isolated_worker');
  const running = {
    ...task('running-exit', 'isolated_worker'),
    status: 'running' as const,
    leaseOwner: 'worker-2',
  };
  const tasks = new Map<string, TaskRecord>([[queued.id, queued], [running.id, running]]);
  const failures: Array<{ taskId: string; owner: string; message: string }> = [];
  const store = {
    getTask: (id: string) => tasks.get(id),
    claimTaskById: (id: string, owner: string) => {
      const current = tasks.get(id);
      if (!current || current.status !== 'queued') return undefined;
      const claimed = { ...current, status: 'running' as const, leaseOwner: owner };
      tasks.set(id, claimed);
      return claimed;
    },
    failTask: (id: string, owner: string, error: Error) => {
      failures.push({ taskId: id, owner, message: error.message });
    },
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
  );
  const internal = supervisor as unknown as {
    persistWorkerExit(
      record: {
        taskId: string;
        workerId?: string;
        gracefulExit?: boolean;
        terminating?: boolean;
        failureReason?: string;
      },
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void;
  };

  internal.persistWorkerExit({ taskId: queued.id, failureReason: 'bootstrap failed' }, 1, null);
  internal.persistWorkerExit({ taskId: running.id, workerId: 'worker-2' }, null, 'SIGTERM');
  internal.persistWorkerExit({ taskId: running.id, workerId: 'worker-2', gracefulExit: true }, 0, null);

  assert.equal(failures.length, 2);
  assert.equal(failures[0]?.taskId, queued.id);
  assert.match(failures[0]?.owner ?? '', /^task-supervisor-/);
  assert.equal(failures[0]?.message, 'bootstrap failed');
  assert.deepEqual(failures[1], {
    taskId: running.id,
    owner: 'worker-2',
    message: 'Task worker 意外退出（code=null, signal=SIGTERM）',
  });
});

test('launch failures are claimed and persisted under a supervisor bootstrap lease', () => {
  const queued = task('launch-failure', 'isolated_worker');
  let claimedOwner = '';
  let failed: { owner: string; message: string } | undefined;
  const store = {
    claimTaskById: (id: string, owner: string) => {
      assert.equal(id, queued.id);
      claimedOwner = owner;
      return { ...queued, status: 'running' as const, leaseOwner: owner };
    },
    failTask: (_id: string, owner: string, error: Error) => {
      failed = { owner, message: error.message };
    },
  };
  const supervisor = new TaskProcessSupervisor(
    store as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
  );
  const internal = supervisor as unknown as {
    persistLaunchFailure(taskId: string, error: unknown): void;
  };

  internal.persistLaunchFailure(queued.id, new Error('missing provider credential'));

  assert.match(claimedOwner, /^task-supervisor-/);
  assert.deepEqual(failed, { owner: claimedOwner, message: 'missing provider credential' });
});

test('stale worker detection distinguishes startup and heartbeat expiry', () => {
  const supervisor = new TaskProcessSupervisor(
    { runningTasks: () => [] } as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
    { workerStartTimeoutMs: 100, workerHeartbeatTimeoutMs: 100 },
  );
  const internal = supervisor as unknown as {
    workers: Map<string, {
      taskId: string;
      spawnedAt: number;
      workerId?: string;
      heartbeatAt?: string;
    }>;
    terminateStaleWorkers(now: number): void;
    terminateWorker(worker: { taskId: string }, reason: string): void;
  };
  internal.workers.set('starting', { taskId: 'starting', spawnedAt: 0 });
  internal.workers.set('running', {
    taskId: 'running',
    spawnedAt: 0,
    workerId: 'worker-3',
    heartbeatAt: new Date(100).toISOString(),
  });
  const terminated: Array<{ taskId: string; reason: string }> = [];
  internal.terminateWorker = (worker, reason) => { terminated.push({ taskId: worker.taskId, reason }); };

  internal.terminateStaleWorkers(1_000);

  assert.deepEqual(terminated, [
    { taskId: 'starting', reason: '启动超时' },
    { taskId: 'running', reason: '心跳超时' },
  ]);
});

test('stopping an idle supervisor is idempotent', async () => {
  const supervisor = new TaskProcessSupervisor(
    { runningTasks: () => [] } as never,
    {} as never,
    { database: '/tmp/mimi.db', assistantConfig: '/tmp/assistant.json', socket: '/tmp/mimi.sock' },
  );
  await supervisor.stop();
  await supervisor.stop();
  assert.deepEqual(supervisor.status(), []);
});
