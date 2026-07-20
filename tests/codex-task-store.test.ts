import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MimiStore } from '../src/daemon/store.js';
import { backgroundTaskSummary } from '../src/daemon/task-tools.js';

test('Codex task completes directly without handing execution back to Mimi', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-codex-store-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const taskId = randomUUID();
    const now = new Date();
    const event = store.appendEvent({
      id: randomUUID(),
      externalId: `codex-${taskId}`,
      source: 'test',
      type: 'command.received',
      trust: 'owner',
      payload: { prompt: 'delegate to codex' },
      profileId: 'owner',
      replyRoute: { channel: 'system' },
      occurredAt: now.toISOString(),
      receivedAt: now.toISOString(),
    }).event;
    store.routeEvent(event.id, {
      routerVersion: 'test',
      decision: 'task_created',
      reasonCode: 'test',
      tasks: [{
        id: taskId,
        type: 'background',
        idempotencyKey: taskId,
        triggerEventId: event.id,
        authorityEventId: event.id,
        profileId: 'owner',
        sessionKey: `mimi-task-${taskId}`,
        objective: { objective: 'implement feature', executor: 'codex' },
        executor: 'codex',
        workspaceAccess: 'write',
        priority: 70,
      }],
    });
    const workerId = 'codex-runner-test';
    const startedAt = new Date(now.getTime() + 1_000);
    const claimed = store.claimTaskById(taskId, workerId, 60_000, startedAt)!;
    const attempt = store.beginTaskAttempt(taskId, workerId, claimed.sessionKey!, workerId, startedAt);
    store.checkpointCodexTask(taskId, workerId, {
      runnerPid: 101,
      codexPid: 202,
      threadId: 'thread-123',
      outputJsonlPath: path.join(root, 'events.jsonl'),
      summaryPath: path.join(root, 'summary.json'),
      startedAt: startedAt.toISOString(),
      lastEvent: 'turn.completed',
    }, startedAt);
    const completedAt = new Date(startedAt.getTime() + 1_000);
    const completed = store.completeCodexTask(taskId, workerId, {
      threadId: 'thread-123',
      answer: 'implemented and tested',
      usage: { input_tokens: 4, output_tokens: 2 },
      exitCode: 0,
      runnerPid: 101,
      codexPid: 202,
      outputJsonlPath: path.join(root, 'events.jsonl'),
      summaryPath: path.join(root, 'summary.json'),
      startedAt: startedAt.toISOString(),
    }, attempt.id, completedAt);

    assert.equal(completed.status, 'completed');
    assert.equal(completed.executor, 'codex');
    assert.equal(completed.attemptCount, 1);
    assert.deepEqual(completed.result, {
      executor: 'codex',
      exitCode: 0,
      answer: 'implemented and tested',
      usage: { input_tokens: 4, output_tokens: 2 },
      process: {
        runnerPid: 101,
        codexPid: 202,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
      artifacts: {
        outputJsonl: path.join(root, 'events.jsonl'),
        summary: path.join(root, 'summary.json'),
      },
      threadId: 'thread-123',
    });
    assert.deepEqual(backgroundTaskSummary(completed).codex, {
      runnerPid: 101,
      codexPid: 202,
      threadId: 'thread-123',
      outputJsonlPath: path.join(root, 'events.jsonl'),
      summaryPath: path.join(root, 'summary.json'),
      startedAt: startedAt.toISOString(),
      lastEvent: 'turn.completed',
      checkpointedAt: startedAt.toISOString(),
    });
    assert.equal(store.getTaskAttempt(attempt.id)?.status, 'completed');
    assert.equal(store.listOutbox().length, 1);
  } finally {
    store.close();
  }
});
