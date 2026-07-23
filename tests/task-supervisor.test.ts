import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskProcessSupervisor } from '../src/daemon/task-supervisor.js';
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
