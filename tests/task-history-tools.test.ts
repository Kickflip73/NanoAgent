import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { MimiStore } from '../src/daemon/store.js';
import { createTaskHistoryTools } from '../src/daemon/task-history-tools.js';
import { createRunFinalization } from '../src/core/run-finalization.js';
import type { ImmutableEvent } from '../src/daemon/types.js';
import { ToolSetBuilder } from '../src/runtime/pipeline/tool-set-builder.js';
import { toolsForMode } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], input: unknown) {
  const selected = tools[0]!;
  assert.ok('invoke' in selected);
  return await selected.invoke(new RunContext({}), JSON.stringify(input)) as Record<string, unknown>;
}

test('history finds scheduled, background and conversational deliverables across sessions and restarts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-history-'));
  const file = path.join(root, 'mimi.db');
  let store = new MimiStore(file);
  const ids: string[] = [];
  try {
    const now = new Date();
    const event: ImmutableEvent = { id: randomUUID(), externalId: randomUUID(), source: 'local-cli',
      type: 'command.received', trust: 'owner', profileId: 'owner', payload: {},
      occurredAt: now.toISOString(), receivedAt: now.toISOString(), createdAt: now.toISOString() };
    store.appendEvent(event);
    for (const type of ['scheduled', 'background', 'conversation'] as const) {
      const id = randomUUID(); ids.push(id);
      store.enqueueTask({ id, type, idempotencyKey: id, authorityEventId: event.id, profileId: 'owner',
        sessionKey: `${type}-original-session`, objective: { prompt: 'export monthly report' },
        executor: type === 'conversation' ? 'session_actor' : 'isolated_worker', workspaceAccess: 'write', priority: 50 });
      store.claimTaskById(id, 'worker', 60_000);
      const finalization = createRunFinalization({ runId: id, answer: 'exported', calls: [{
        sessionId: `${type}-original-session`, runId: id, toolName: 'export_report', callId: 'export',
        argumentsJson: '{}', status: 'succeeded', output: { file: `/tmp/${type}-report.csv` },
      }] });
      store.completeTask(id, 'worker', { answer: 'exported', finalization });
    }
    const privateId = randomUUID();
    const privateEvent = { ...event, id: randomUUID(), externalId: randomUUID(), profileId: 'someone-else' };
    store.appendEvent(privateEvent);
    store.enqueueTask({ id: privateId, type: 'conversation', idempotencyKey: privateId,
      authorityEventId: privateEvent.id, profileId: 'someone-else', sessionKey: 'private',
      objective: { prompt: 'private monthly report' }, executor: 'session_actor', workspaceAccess: 'write', priority: 50 });
    store.close(); store = new MimiStore(file);
    const tools = createTaskHistoryTools(store, { ...event, id: randomUUID() });
    const listed = await invoke(tools, { action: 'list', query: 'monthly report', limit: 2 });
    const tasks = listed.tasks as Array<{ taskId: string }>;
    assert.equal(tasks.length, 2);
    assert.equal(listed.truncated, true);
    const next = await invoke(tools, { action: 'list', query: 'monthly report', offset: listed.nextOffset });
    assert.equal((next.tasks as unknown[]).length, 1);
    for (const id of ids) {
      const detail = await invoke(tools, { action: 'inspect', taskId: id });
      assert.equal(detail.outcome, 'completed');
      assert.match(JSON.stringify(detail.artifacts), /report\.csv/);
      assert.match(String(detail.resultJson), /exported/);
    }
    const hidden = await invoke(tools, { action: 'inspect', taskId: privateId });
    assert.equal(hidden.mimiStatus, 'tool_failed');
    assert.equal(createTaskHistoryTools(store, { ...event, trust: 'external' }).length, 0);
    assert.equal(new ToolSetBuilder().classify(tools).direct[0]?.name, 'task_history');
    assert.equal(toolsForMode('plan', tools).length, 1);
    const expiredId = randomUUID();
    const claimedAt = new Date(Date.now() + 1_000);
    store.enqueueTask({ id: expiredId, type: 'conversation', idempotencyKey: expiredId,
      authorityEventId: event.id, profileId: 'owner', sessionKey: 'interrupted',
      objective: { prompt: 'partially executed operation' }, executor: 'session_actor',
      workspaceAccess: 'write', priority: 50, maxAttempts: 1 });
    store.claimTaskById(expiredId, 'expired-worker', 10, claimedAt);
    store.beginTaskAttempt(expiredId, 'expired-worker', 'interrupted', 'expired-worker', claimedAt);
    store.readyTasks({}, 10, new Date(claimedAt.getTime() + 100));
    assert.equal(store.getTask(expiredId)?.failure?.disposition.dispatchStarted, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
