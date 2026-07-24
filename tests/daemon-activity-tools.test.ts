import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { createMimiActivityTools } from '../src/daemon/activity-tools.js';
import { buildDaemonHealth } from '../src/daemon/health-model.js';
import { buildOwnerStatusAnswer } from '../src/daemon/status-context.js';
import { MimiStore } from '../src/daemon/store.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === 'inspect_mimi_activity');
  assert.ok(selected && 'invoke' in selected);
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

test('Mimi activity tool is bounded read-only self-inspection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-activity-tool-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createMimiActivityTools(store);
    const snapshot = await invoke(tools, { limit: 10 }) as { needsAttention: boolean; workPending: number };
    assert.equal(snapshot.needsAttention, false);
    assert.equal(snapshot.workPending, 0);
    assert.match(String(await invoke(tools, { limit: 21 })), /Invalid input|error/i);
    assert.equal(isSideEffectTool('inspect_mimi_activity'), false);
    assert.deepEqual(toolsForRunPolicy(tools, {
      allowedCapabilities: ['state-read'], allowSideEffects: false,
    }).map((candidate) => candidate.name), ['inspect_mimi_activity']);
  } finally {
    store.close();
  }
});

test('Mimi activity separates conversation executions from background tasks and identifies their source Events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-activity-task-types-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const timestamp = '2026-07-20T03:00:00.000Z';
    const conversation = store.ingestEvent({
      id: 'qq-event', externalId: 'qq-message-1', source: 'qq', kind: 'command', trust: 'external',
      payload: { text: 'hello' }, occurredAt: timestamp, receivedAt: timestamp,
      priority: 80, profileId: 'owner',
    });
    const authority = store.appendEvent({
      id: 'owner-authority', externalId: 'owner-authority', source: 'local-cli',
      type: 'command.received', trust: 'owner', payload: {}, profileId: 'owner',
      occurredAt: timestamp, receivedAt: timestamp,
    }).event;
    store.enqueueTask({
      id: 'background-task', type: 'background', idempotencyKey: 'background-task',
      authorityEventId: authority.id, profileId: 'owner', objective: { prompt: 'research' },
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 50,
    });

    const snapshot = store.activitySnapshot(10);
    assert.equal(snapshot.tasks.queued, 2);
    assert.equal(snapshot.tasksByType.conversation.queued, 1);
    assert.equal(snapshot.tasksByType.background.queued, 1);
    assert.equal(snapshot.tasksByType.memory_maintenance.queued, 0);
    assert.deepEqual(
      snapshot.recentTasks.find((task) => task.id === conversation.task?.id),
      {
        id: conversation.task?.id,
        type: 'conversation',
        status: 'queued',
        triggerEventId: 'qq-event',
        source: 'qq',
        eventType: 'command.received',
        priority: 80,
        attemptCount: 0,
        updatedAt: conversation.task?.updatedAt,
        error: undefined,
      },
    );
  } finally {
    store.close();
  }
});

test('owner status answer is generated from bounded daemon state without a model round', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-owner-status-context-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const timestamp = '2026-07-20T03:00:00.000Z';
    const authority = store.appendEvent({
      id: 'status-authority', externalId: 'status-authority', source: 'local-cli',
      type: 'command.received', trust: 'owner', payload: {}, profileId: 'owner',
      occurredAt: timestamp, receivedAt: timestamp,
    }).event;
    store.enqueueTask({
      id: 'status-background-task', type: 'background', idempotencyKey: 'status-background-task',
      authorityEventId: authority.id, profileId: 'owner',
      objective: { objective: `检查构建状态${'x'.repeat(8_000)}` },
      executor: 'isolated_worker', workspaceAccess: 'read', priority: 50,
    });

    const answer = buildOwnerStatusAnswer(store, 'mimi-owner-status-session');
    assert.match(answer, /当前有 1 个后台任务/);
    assert.match(answer, /检查构建状态/);
    assert.match(answer, /queued/);
    assert.ok(answer.length <= 6_000, answer.length.toString());

    const degraded = buildOwnerStatusAnswer(store, 'mimi-owner-status-session', undefined, {
      plan: [],
      health: buildDaemonHealth({
        tasks: { ...store.activitySnapshot(1).tasks, dead_letter: 2 },
        outbox: store.activitySnapshot(1).outbox,
      }),
    });
    assert.match(degraded, /系统健康：unhealthy/);
    assert.match(degraded, /2 个任务进入 dead letter/);
    assert.match(degraded, /mimi daemon tasks/);
  } finally {
    store.close();
  }
});
