import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { MimiStore } from '../src/daemon/store.js';
import {
  backgroundTaskSummary,
  createBackgroundTaskTools,
} from '../src/daemon/task-tools.js';
import type { TaskRecord } from '../src/daemon/types.js';
import { BASE_INSTRUCTIONS } from '../src/runtime/instructions.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

test('progress guidance treats active Codex evidence as authoritative over an old attempt error', () => {
  const summary = backgroundTaskSummary({
    id: randomUUID(),
    type: 'background',
    idempotencyKey: 'delegate:test',
    authorityEventId: randomUUID(),
    profileId: 'owner',
    objective: { objective: 'build game', executor: 'codex' },
    executor: 'codex',
    workspaceAccess: 'write',
    priority: 70,
    status: 'running',
    notBefore: new Date().toISOString(),
    attemptCount: 2,
    maxAttempts: 3,
    leaseOwner: 'codex-worker',
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    error: 'Task worker 意外退出（signal=SIGKILL）',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies TaskRecord);

  assert.equal(summary.execution?.leaseActive, true);
  assert.equal(summary.error, undefined);
  assert.match(summary.previousAttemptError ?? '', /SIGKILL/);
  assert.match(BASE_INSTRUCTIONS, /codex\.latestActivity/);
  assert.match(BASE_INSTRUCTIONS, /previousAttemptError.*绝不能/);
});

test('repeated background delegation returns the same durable task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-task-tools-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const now = new Date().toISOString();
    const eventId = randomUUID();
    const routed = store.ingestEvent({
      id: eventId,
      externalId: eventId,
      source: 'test',
      kind: 'command',
      trust: 'owner',
      payload: { prompt: 'delegate work' },
      occurredAt: now,
      receivedAt: now,
      priority: 100,
      profileId: 'owner',
      sessionKey: 'test-session',
      replyRoute: { channel: 'system' },
    });
    assert.ok(routed.task);
    const tools = createBackgroundTaskTools({
      store,
      task: routed.task,
      event: routed.event,
      sessionId: 'test-session',
    });
    const input = {
      objective: 'Implement the game MVP',
      executor: 'codex',
      workspaceAccess: 'write',
    };

    const first = await invoke(tools, 'delegate_background_task', input) as { taskId: string };
    const repeated = await invoke(tools, 'delegate_background_task', input) as { taskId: string };

    assert.equal(typeof first.taskId, 'string', JSON.stringify(first));
    assert.equal(repeated.taskId, first.taskId);
    assert.equal(store.taskChildCount(routed.task.id), 1);

    const outputJsonlPath = path.join(root, 'events.jsonl');
    await writeFile(outputJsonlPath, `${JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'file_change', status: 'completed',
        changes: [{ kind: 'add', path: '/workspace/src/game.ts' }],
      },
    })}\n`);
    const workerId = 'codex-progress-test';
    assert.ok(store.claimTaskById(first.taskId, workerId, 60_000));
    store.checkpointCodexTask(first.taskId, workerId, {
      outputJsonlPath,
      lastEvent: 'item.completed',
    });

    const inspected = await invoke(tools, 'inspect_background_task', {
      taskId: first.taskId,
    }) as {
      codex?: { latestActivity?: string; recentEvents?: unknown[]; logUpdatedAt?: string };
      execution?: { leaseActive: boolean };
    };
    assert.match(inspected.codex?.latestActivity ?? '', /file_change.*game\.ts/);
    assert.equal(inspected.codex?.recentEvents?.length, 1);
    assert.match(inspected.codex?.logUpdatedAt ?? '', /^\d{4}-/);
    assert.equal(inspected.execution?.leaseActive, true);
  } finally {
    store.close();
  }
});
