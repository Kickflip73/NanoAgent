import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RunContext, type Tool } from '@openai/agents';
import { ExecutionLedger } from '../src/core/execution-ledger.js';
import { decideEvent } from '../src/daemon/policy.js';
import { createMimiScheduleTools } from '../src/daemon/schedule-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';
import { withExecutionLedger } from '../src/runtime/tool-ledger.js';

function event(): StoredEvent {
  const timestamp = new Date().toISOString();
  return {
    id: 'owner-event', externalId: 'owner-event', source: 'local-cli', kind: 'command', trust: 'owner',
    payload: { prompt: 'follow this up' }, occurredAt: timestamp, receivedAt: timestamp,
    priority: 100, profileId: 'owner', sessionKey: 'work-followups', replyRoute: { channel: 'system' },
    status: 'running', attempts: 1, notBefore: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
}

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((candidate) => candidate.name === name);
  assert.ok(selected && 'invoke' in selected);
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

test('schedule tools create, inspect, emit, and cancel durable self-wakeups', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-tools-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const authority = store.enqueueEvent(event()).event;
    const tools = createMimiScheduleTools(store, authority);
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const followUp = await invoke(tools, 'schedule_mimi_follow_up', {
      name: 'check reply', prompt: '检查对方是否回复；只有需要我介入时才通知', runAt,
    }) as { id: string };
    const routine = await invoke(tools, 'schedule_mimi_routine', {
      name: 'project pulse', prompt: '检查项目重要变化并给出风险摘要', everyMinutes: 15,
    }) as { id: string };

    const schedules = await invoke(tools, 'list_mimi_schedules', {}) as Array<{ id: string }>;
    assert.deepEqual(schedules.map((item) => item.id).sort(), [followUp.id, routine.id].sort());
    assert.equal(store.getSchedule(followUp.id)?.authorityEventId, authority.id);
    const dueAt = new Date(Date.now() + 61_000);
    const emitted = store.emitDueSchedules(dueAt);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.trust, 'owner');
    assert.equal(emitted[0]?.executionLane, 'task');
    assert.equal(emitted[0]?.originSessionKey, 'work-followups');
    assert.notEqual(emitted[0]?.sessionKey, 'work-followups');
    assert.equal(emitted[0]?.sessionKey, `mimi-task-${emitted[0]?.id}`);
    assert.equal(emitted[0]?.parentEventId, authority.id);
    assert.equal(emitted[0]?.rootEventId, authority.id);
    assert.equal(emitted[0]?.taskDepth, 1);
    assert.equal((emitted[0]?.payload as { workspaceAccess?: string }).workspaceAccess, 'write');
    assert.deepEqual(emitted[0]?.replyRoute, { channel: 'system' });
    assert.equal(store.readyBackgroundTasks(10, dueAt)[0]?.id, emitted[0]?.id);

    assert.deepEqual(await invoke(tools, 'cancel_mimi_schedule', { id: routine.id }), {
      id: routine.id, removed: true,
    });
    assert.equal(store.listSchedules().length, 1);
  } finally {
    store.close();
  }
});

test('schedules created by external events preserve provenance and durable authority', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-provenance-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const external = store.enqueueEvent({
      ...event(), id: 'external-event', source: 'radar', trust: 'external' as const, replyRoute: undefined,
    }).event;
    await invoke(createMimiScheduleTools(store, external, {
      channel: 'connector:qq', target: 'private:123456',
    }), 'schedule_mimi_follow_up', {
      name: 'external follow-up', prompt: 'continue the external task',
      runAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(store.listSchedules()[0]?.trust, 'external');
    assert.equal(store.listSchedules()[0]?.authorityEventId, external.id);
    const emitted = store.emitDueSchedules(new Date(Date.now() + 61_000))[0];
    assert.equal(emitted?.trust, 'external');
    assert.equal(emitted?.executionLane, 'task');
    assert.equal(emitted?.originSessionKey, 'work-followups');
    assert.equal(emitted?.rootEventId, external.id);
    assert.deepEqual(emitted?.replyRoute, { channel: 'connector:qq', target: 'private:123456' });
    const restrictedAtPolicy = decideEvent(emitted!).options?.policy;
    assert.ok(restrictedAtPolicy);
    assert.equal(restrictedAtPolicy.allowSideEffects, false);
    const atTools = createMimiScheduleTools(store, emitted!);
    assert.equal(atTools.some((tool) => tool.name === 'complete_current_mimi_schedule'), false);
    assert.deepEqual(toolsForRunPolicy(atTools, restrictedAtPolicy), []);
  } finally {
    store.close();
  }
});

test('new schedules inherit the active resolved session instead of recomputing raw source identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-session-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const external = store.enqueueEvent({
      ...event(), sessionKey: undefined, source: 'mail:inbox', trust: 'external' as const,
      actor: { id: 'alice@example.com' },
    }).event;
    const tools = createMimiScheduleTools(store, external, undefined, 'mimi-person-alice');
    await invoke(tools, 'schedule_mimi_watch', {
      name: 'Alice reply', check: '检查 Alice 的回复并推进', stopWhen: '事项已关闭', everyMinutes: 15,
    });
    assert.equal(store.listSchedules()[0]?.sessionKey, 'mimi-person-alice');
    assert.equal(store.listSchedules()[0]?.authorityEventId, external.id);
    assert.equal(store.listSchedules()[0]?.type, 'watch');
  } finally {
    store.close();
  }
});

test('conditional watches stop themselves only from their authentic emitted schedule event', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-watch-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const authority = store.enqueueEvent(event()).event;
    const ownerTools = createMimiScheduleTools(store, authority);
    const watch = await invoke(ownerTools, 'schedule_mimi_watch', {
      name: 'wait for contract',
      check: '检查邮件是否收到签署版；收到后归档附件',
      stopWhen: '签署版已归档且没有待回复问题',
      everyMinutes: 15,
    }) as { id: string; prompt: string };
    assert.match(watch.prompt, /检查邮件是否收到签署版/);
    assert.match(watch.prompt, /complete_current_mimi_schedule/);
    assert.equal(ownerTools.some((tool) => tool.name === 'complete_current_mimi_schedule'), false);

    const due = store.emitDueSchedules(new Date(Date.now() + 16 * 60_000));
    assert.equal(due.length, 1);
    assert.equal(due[0]?.executionLane, 'task');
    assert.equal(due[0]?.originSessionKey, authority.sessionKey);
    const scheduledTools = createMimiScheduleTools(store, due[0]!);
    assert.equal(scheduledTools.some((tool) => tool.name === 'complete_current_mimi_schedule'), true);
    const policy = decideEvent(due[0]!).options?.policy;
    assert.ok(policy);
    assert.equal(
      toolsForRunPolicy(scheduledTools, policy).some((tool) => tool.name === 'complete_current_mimi_schedule'),
      true,
    );

    const forged = {
      ...due[0]!, id: 'forged', source: 'webhook', externalId: 'forged', trust: 'external' as const,
    };
    assert.equal(
      createMimiScheduleTools(store, forged).some((tool) => tool.name === 'complete_current_mimi_schedule'),
      false,
    );

    assert.deepEqual(await invoke(scheduledTools, 'complete_current_mimi_schedule', {}), {
      id: watch.id, completed: true,
    });
    assert.equal(store.listSchedules().length, 0);
  } finally {
    store.close();
  }
});

test('a revoked external watch gets one bounded completion tool and cannot keep polling', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-revoked-watch-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const authority = store.enqueueEvent({
      ...event(), id: 'external-watch-root', externalId: 'external-watch-root',
      source: 'daxiang', trust: 'external' as const,
    }).event;
    const watch = await invoke(createMimiScheduleTools(store, authority), 'schedule_mimi_watch', {
      name: 'revoked work', check: '检查外部任务', stopWhen: '完成', everyMinutes: 15,
    }) as { id: string };
    const due = store.emitDueSchedules(new Date(Date.now() + 16 * 60_000))[0]!;
    const restrictedPolicy = decideEvent(due).options?.policy;
    assert.ok(restrictedPolicy);
    const authenticTools = createMimiScheduleTools(store, due);
    const bounded = toolsForRunPolicy(authenticTools, restrictedPolicy);
    assert.deepEqual(bounded.map((tool) => tool.name), ['complete_current_mimi_schedule']);
    const forged = { ...due, id: 'forged-revoked-watch', sessionKey: 'mimi-task-forged-revoked-watch' };
    assert.equal(
      createMimiScheduleTools(store, forged).some((tool) => tool.name === 'complete_current_mimi_schedule'),
      false,
    );
    assert.deepEqual(await invoke(bounded, 'complete_current_mimi_schedule', {}), {
      id: watch.id, completed: true,
    });
    assert.deepEqual(store.emitDueSchedules(new Date(Date.now() + 32 * 60_000)), []);
  } finally {
    store.close();
  }
});

test('self-wakeup tools reject runaway timing and are classified as ledgered side effects', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-guard-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const tools = createMimiScheduleTools(store, store.enqueueEvent(event()).event);
    assert.match(String(await invoke(tools, 'schedule_mimi_follow_up', {
      name: 'past', prompt: 'do it', runAt: new Date(Date.now() - 1_000).toISOString(),
    })), /至少应在 5 秒之后/);
    assert.match(String(await invoke(tools, 'schedule_mimi_routine', {
      name: 'too fast', prompt: 'do it', everyMinutes: 1,
    })), /Invalid input|error/i);
    assert.equal(isSideEffectTool('schedule_mimi_follow_up'), true);
    assert.equal(isSideEffectTool('schedule_mimi_routine'), true);
    assert.equal(isSideEffectTool('schedule_mimi_watch'), true);
    assert.equal(isSideEffectTool('complete_current_mimi_schedule'), true);
    assert.equal(isSideEffectTool('cancel_mimi_schedule'), true);
    assert.equal(isSideEffectTool('list_mimi_schedules'), false);
    assert.deepEqual(toolsForRunPolicy(tools, {
      allowedCapabilities: ['state-read'], allowSideEffects: false,
    }).map((tool) => tool.name), ['list_mimi_schedules']);
  } finally {
    store.close();
  }
});

test('semantic event ledger prevents a retried model call from creating duplicate wakeups', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-schedule-ledger-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  try {
    const ledger = new ExecutionLedger(path.join(root, 'execution-ledger.json'));
    const baseTools = createMimiScheduleTools(store, store.enqueueEvent(event()).event);
    const identity = () => ({
      sessionId: 'work-followups', runId: 'event:owner-event', semanticCallIds: true,
    });
    const tools = withExecutionLedger(baseTools, ledger, identity);
    const selected = tools.find((tool) => tool.name === 'schedule_mimi_follow_up');
    assert.ok(selected && 'invoke' in selected);
    const input = JSON.stringify({
      name: 'one reminder', prompt: 'check once', runAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const first = await selected.invoke(new RunContext({}), input, { toolCall: { callId: 'first-sdk-id' } } as never);
    const retry = withExecutionLedger(baseTools, ledger, identity)
      .find((tool) => tool.name === 'schedule_mimi_follow_up');
    assert.ok(retry && 'invoke' in retry);
    const replay = await retry.invoke(new RunContext({}), input, { toolCall: { callId: 'changed-sdk-id' } } as never);
    assert.equal((replay as { id: string }).id, (first as { id: string }).id);
    assert.equal(store.listSchedules().length, 1);
  } finally {
    store.close();
  }
});
