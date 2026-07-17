import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine, type MimiSettings } from '../src/daemon/attention.js';
import { createMimiSettingsTools } from '../src/daemon/settings-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((tool) => tool.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

function event(trust: StoredEvent['trust'] = 'external'): StoredEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id: 'message-1', externalId: 'message-1', source: 'messages', kind: 'command', trust,
    payload: { text: '请处理' }, occurredAt: timestamp, receivedAt: timestamp, priority: 80,
    profileId: 'owner', status: 'running', attempts: 1, notBefore: timestamp,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

test('settings tools update the live assistant while preserving independently managed domains', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-settings-tools-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  const tools = createMimiSettingsTools(attention);
  try {
    await attention.addStandingOrder('能直接完成就代我完成');
    await attention.upsertSourcePolicy({ id: 'messages', source: 'messages', instructions: ['先处理再汇报'] });
    await attention.upsertPerson({
      id: 'alice', displayName: 'Alice', aliases: [{ source: 'messages', actor: 'alice-id' }], context: [],
    });
    await attention.upsertAttentionRule({ id: 'mail-now', source: 'mail:*', action: 'run' });
    const initial = await invoke(tools, 'get_mimi_settings', {}) as MimiSettings;
    const updated: MimiSettings = {
      ...initial,
      owner: {
        displayName: 'Tony', locale: 'zh-CN', focus: ['工作风险', '家庭安排'],
        replyRoute: { channel: 'connector:qq', target: 'private:123456' },
      },
      timezone: 'UTC',
      quietHours: { enabled: true, start: '00:00', end: '23:59', urgentPriority: 99 },
      budgets: { maxRunsPerHour: 30, maxRunsPerDay: 200, maxRunsPerSourcePerHour: 20 },
      thresholds: { alertPriority: 90, webhookPriority: 90 },
      execution: { runIdleTimeoutMs: 60_000 },
      maintenance: { enabled: true, historyRetentionDays: 180, intervalHours: 12 },
      briefings: { enabled: true, times: ['09:00', '18:30'], maxItems: 50, replyChannel: 'system' },
    };
    assert.deepEqual(await invoke(tools, 'update_mimi_settings', updated), updated);
    assert.deepEqual(attention.getSettings(), updated);
    assert.deepEqual(attention.replyRouteFor(), { channel: 'connector:qq', target: 'private:123456' });
    assert.equal(attention.runIdleTimeoutMs, 60_000);
    assert.equal(attention.decide(event(), new Date('2026-07-15T12:00:00Z')).action, 'digest');
    assert.equal(attention.decide(event('owner'), new Date('2026-07-15T12:00:00Z')).action, 'run');

    assert.deepEqual(attention.listStandingOrders(), ['能直接完成就代我完成']);
    assert.deepEqual(attention.listSourcePolicies().map((policy) => policy.id), ['messages']);
    assert.deepEqual(attention.listPeople().map((person) => person.id), ['alice']);
    assert.deepEqual(attention.listAttentionRules().map((rule) => rule.id), ['mail-now']);
    assert.deepEqual(attention.listRoutines().map((routine) => routine.id), ['morning-plan', 'evening-close']);

    const persisted = JSON.parse(await readFile(configFile, 'utf8')) as { owner: { displayName: string } };
    assert.equal(persisted.owner.displayName, 'Tony');
  } finally {
    store.close();
  }
});

test('settings updates require a complete validated snapshot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-settings-validation-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  try {
    const initial = attention.getSettings();
    const result = await invoke(createMimiSettingsTools(attention), 'update_mimi_settings', { timezone: 'UTC' });
    assert.match(String(result), /Invalid input|error/i);
    assert.deepEqual(attention.getSettings(), initial);
  } finally {
    store.close();
  }
});

test('snooze tools temporarily digest non-urgent autonomy and persist atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-snooze-tools-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  const tools = createMimiSettingsTools(attention);
  try {
    const initial = attention.getSettings();
    await attention.updateSettings({
      ...initial,
      quietHours: { ...initial.quietHours, enabled: false, urgentPriority: 95 },
    });
    assert.deepEqual(await invoke(tools, 'get_mimi_snooze', {}), { active: false });

    const snoozed = await invoke(tools, 'snooze_mimi', {
      minutes: 60,
      reason: '专注写方案',
    }) as { active: boolean; until: string; reason: string };
    assert.equal(snoozed.active, true);
    assert.equal(snoozed.reason, '专注写方案');
    const during = new Date(Date.parse(snoozed.until) - 30 * 60_000);
    assert.equal(attention.decide(event(), during).action, 'digest');
    assert.equal(attention.decide(event('owner'), during).action, 'run');
    assert.equal(attention.decide({ ...event(), kind: 'alert', priority: 99 }, during).action, 'run');
    assert.equal(attention.decide(event(), new Date(snoozed.until)).action, 'run');

    const persisted = JSON.parse(await readFile(configFile, 'utf8')) as {
      snooze?: { until: string; reason?: string };
    };
    assert.deepEqual(persisted.snooze, { until: snoozed.until, reason: '专注写方案' });
    assert.deepEqual(await invoke(tools, 'clear_mimi_snooze', {}), { active: false });
    assert.equal(attention.decide(event(), during).action, 'run');
    assert.equal((JSON.parse(await readFile(configFile, 'utf8')) as { snooze?: unknown }).snooze, undefined);
  } finally {
    store.close();
  }
});

test('settings writes are ledgered while reads remain side-effect free', () => {
  const tools = createMimiSettingsTools({} as AttentionEngine);
  assert.equal(isSideEffectTool('get_mimi_settings'), false);
  assert.equal(isSideEffectTool('get_mimi_snooze'), false);
  assert.equal(isSideEffectTool('update_mimi_settings'), true);
  assert.equal(isSideEffectTool('snooze_mimi'), true);
  assert.equal(isSideEffectTool('clear_mimi_snooze'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['get_mimi_settings', 'get_mimi_snooze']);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['update_mimi_settings', 'snooze_mimi', 'clear_mimi_snooze']);
});
