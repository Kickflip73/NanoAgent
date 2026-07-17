import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunContext, type Tool } from '@openai/agents';
import { test } from 'node:test';
import { AttentionEngine } from '../src/daemon/attention.js';
import { createMimiPeopleTools } from '../src/daemon/people-tools.js';
import { MimiStore } from '../src/daemon/store.js';
import type { StoredEvent } from '../src/daemon/types.js';
import { isSideEffectTool, toolsForRunPolicy } from '../src/runtime/tool-policy.js';

async function invoke(tools: Tool[], name: string, input: unknown): Promise<unknown> {
  const selected = tools.find((tool) => tool.name === name);
  assert.ok(selected && 'invoke' in selected && typeof selected.invoke === 'function');
  return selected.invoke(new RunContext({}), JSON.stringify(input));
}

function event(id: string, source: string, actor: string, trust: StoredEvent['trust'] = 'external'): StoredEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id, externalId: id, source, kind: 'command', trust, actor: { id: actor },
    payload: { text: '请处理这件事' }, occurredAt: timestamp, receivedAt: timestamp,
    priority: 80, profileId: 'owner', status: 'running', attempts: 1, notBefore: timestamp,
    createdAt: timestamp, updatedAt: timestamp,
  };
}

test('people tools unify verified cross-channel identities and expose context only to privileged events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-people-tools-'));
  const configFile = path.join(root, 'assistant.json');
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(configFile, store);
  const tools = createMimiPeopleTools(attention);
  try {
    assert.deepEqual(await invoke(tools, 'list_mimi_people', {}), []);
    const alice = {
      id: 'alice', displayName: 'Alice Chen',
      aliases: [
        { source: 'mail:*', actor: 'alice@example.com' },
        { source: 'messages', actor: '+15550001111' },
      ],
      context: ['负责 APAC 项目，偏好先看结论'],
    };
    assert.deepEqual(await invoke(tools, 'upsert_mimi_person', alice), {
      person: alice, created: true,
    });

    const mail = attention.decide(
      event('mail-1', 'mail:inbox', 'alice@example.com', 'system'),
      new Date('2026-07-15T12:00:00Z'),
    );
    const message = attention.decide(
      event('message-1', 'messages', '+15550001111', 'system'),
      new Date('2026-07-15T12:00:00Z'),
    );
    assert.equal(mail.action, 'run');
    assert.equal(message.action, 'run');
    if (mail.action === 'run' && message.action === 'run') {
      assert.equal(mail.run.sessionId, 'mimi-person-alice');
      assert.equal(message.run.sessionId, 'mimi-person-alice');
      assert.equal(mail.run.options?.cause?.personId, 'alice');
      assert.match(mail.run.options?.hostInstructions ?? '', /负责 APAC 项目/);
    }

    const updated = { ...alice, displayName: 'Alice', context: ['关键合作方'] };
    assert.deepEqual(await invoke(tools, 'upsert_mimi_person', updated), {
      person: updated, created: false,
    });
    assert.deepEqual(await invoke(tools, 'list_mimi_people', {}), [updated]);
    assert.deepEqual(await invoke(tools, 'remove_mimi_person', { id: 'alice' }), { id: 'alice', removed: true });
    assert.deepEqual(await invoke(tools, 'remove_mimi_person', { id: 'alice' }), { id: 'alice', removed: false });
    assert.deepEqual(attention.listPeople(), []);

    const persisted = JSON.parse(await readFile(configFile, 'utf8')) as { people: unknown[] };
    assert.deepEqual(persisted.people, []);
  } finally {
    store.close();
  }
});

test('concurrent person mutations serialize and duplicate aliases fail without partial writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-people-concurrent-'));
  const store = new MimiStore(path.join(root, 'mimi.db'));
  const attention = await AttentionEngine.load(path.join(root, 'assistant.json'), store);
  try {
    await Promise.all([
      attention.upsertPerson({
        id: 'alice', displayName: 'Alice', aliases: [{ source: 'mail', actor: 'alice@example.com' }], context: [],
      }),
      attention.upsertPerson({
        id: 'bob', displayName: 'Bob', aliases: [{ source: 'messages', actor: 'bob-id' }], context: [],
      }),
    ]);
    assert.deepEqual(attention.listPeople().map((person) => person.id), ['alice', 'bob']);

    await assert.rejects(attention.upsertPerson({
      id: 'duplicate', displayName: 'Duplicate',
      aliases: [{ source: 'mail', actor: 'alice@example.com' }], context: [],
    }), /duplicate person alias/);
    assert.deepEqual(attention.listPeople().map((person) => person.id), ['alice', 'bob']);
  } finally {
    store.close();
  }
});

test('people writes are ledgered state changes while listing remains read-only', async () => {
  const tools = createMimiPeopleTools({} as AttentionEngine);
  assert.equal(isSideEffectTool('list_mimi_people'), false);
  assert.equal(isSideEffectTool('upsert_mimi_person'), true);
  assert.equal(isSideEffectTool('remove_mimi_person'), true);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-read'], allowSideEffects: false,
  }).map((tool) => tool.name), ['list_mimi_people']);
  assert.deepEqual(toolsForRunPolicy(tools, {
    allowedCapabilities: ['state-write'], allowSideEffects: true,
  }).map((tool) => tool.name), ['upsert_mimi_person', 'remove_mimi_person']);
});
