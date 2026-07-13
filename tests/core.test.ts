import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { ContextManager } from '../src/core/context.js';
import { MemoryStore } from '../src/core/memory.js';
import { PlanStore } from '../src/core/plan.js';
import { FileSession } from '../src/core/session.js';
import { TraceStore } from '../src/core/trace.js';
import { RagStore } from '../src/extensions/rag.js';
import { SkillLoader } from '../src/extensions/skills.js';

test('persists sessions and returns the latest items', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-'));
  const session = new FileSession(root, 'demo');
  const items = [
    { role: 'user', content: 'one' },
    { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'two' }] },
  ] as AgentInputItem[];
  await session.addItems(items);

  assert.deepEqual(await new FileSession(root, 'demo').getItems(1), [items[1]]);
  assert.deepEqual(await FileSession.list(root), ['demo']);
});

test('removes summaries accidentally persisted by older context management', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-cleanup-'));
  const session = new FileSession(root, 'demo');
  await session.addItems([
    { role: 'user', content: '[更早的会话历史已压缩为摘要，共 3 条]\nlegacy' },
    { role: 'user', content: 'real message' },
  ] as AgentInputItem[]);

  assert.equal(await session.cleanupGeneratedSummaries(), 1);
  assert.deepEqual(await session.getItems(), [{ role: 'user', content: 'real message' }]);
});

test('stores, retrieves and forgets long-term memories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-'));
  const store = new MemoryStore(path.join(root, 'memories.json'));
  const memory = await store.remember('用户偏好 TypeScript', 'preference');

  assert.equal((await store.search('TypeScript 偏好'))[0]?.id, memory.id);
  assert.equal(await store.forget(memory.id), true);
  assert.deepEqual(await store.list(), []);
});

test('loads skill metadata and content on demand', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-skill-'));
  const directory = path.join(root, 'review');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nDo it.');
  const loader = new SkillLoader(root);
  await loader.load();

  assert.match(loader.catalog(), /review: Review code/);
  assert.match(loader.get('review')?.content ?? '', /Do it/);
});

test('indexes and searches local documents without a vector database', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-'));
  const docs = path.join(root, 'knowledge');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(docs, { recursive: true }));
  await writeFile(path.join(docs, 'agent.md'), 'NanoAgent 使用 TypeScript 构建。');
  const indexFile = path.join(root, 'index.json');
  const rag = new RagStore(root, indexFile);

  assert.deepEqual(await rag.index('knowledge'), { files: 1, chunks: 1, embeddings: false });
  assert.equal((await rag.search('TypeScript'))[0]?.source, 'knowledge/agent.md');
  assert.ok((await readFile(indexFile, 'utf8')).includes('NanoAgent'));
});

test('context keeps recent history and injects memory, RAG and plan', async () => {
  const manager = new ContextManager(1);
  const history = [{ role: 'user', content: 'old' }, { role: 'user', content: 'recent' }] as AgentInputItem[];
  const compacted = await manager.sessionInput(history, [{ role: 'user', content: 'new' }]);
  assert.deepEqual(compacted, [history[1], { role: 'user', content: 'new' }]);
  assert.match(manager.summarizeHistory(history), /old/);
  const instructions = manager.buildInstructions({
    baseInstructions: 'base',
    historySummary: 'older conversation',
    skillCatalog: '- review: code',
    memories: [{ id: 'm1', type: 'fact', content: 'uses TS', createdAt: '' }],
    documents: [{ source: 'doc.md', content: 'hello', score: 1 }],
    plan: [{ id: '1', description: 'test', status: 'running' }],
  });
  assert.match(instructions, /uses TS/);
  assert.match(instructions, /older conversation/);
  assert.match(instructions, /doc\.md/);
  assert.match(instructions, /running/);
});

test('context trimming keeps tool calls paired and never persists generated summaries', async () => {
  const manager = new ContextManager(2);
  const history = [
    { type: 'message', role: 'user', content: 'first' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
    { role: 'user', content: '[更早的会话历史已压缩为摘要，共 2 条]\nlegacy' },
    { type: 'message', role: 'user', content: 'second' },
    { type: 'function_call', name: 'demo', callId: 'call-1', arguments: '{}' },
    { type: 'function_call_result', name: 'demo', callId: 'call-1', output: { type: 'text', text: 'done' } },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
  ] as unknown as AgentInputItem[];
  const next = await manager.sessionInput(history, [{ role: 'user', content: 'third' }]);
  const serialized = JSON.stringify(next);

  assert.doesNotMatch(serialized, /更早的会话历史已压缩/);
  assert.match(serialized, /"type":"function_call"/);
  assert.match(serialized, /"type":"function_call_result"/);
  assert.ok(serialized.indexOf('function_call') < serialized.indexOf('function_call_result'));
});

test('keeps plans isolated by session and writes JSONL traces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-state-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'first');
  await plans.update([{ id: '1', description: 'build', status: 'running' }]);
  plans.useSession('second');
  assert.deepEqual(await plans.get(), []);
  plans.useSession('first');
  assert.equal((await plans.get())[0]?.description, 'build');

  const traces = new TraceStore(path.join(root, 'traces'));
  await traces.record('first', 'turn_end', { answer: 'done' });
  const trace = await readFile(path.join(root, 'traces', 'first.jsonl'), 'utf8');
  assert.match(trace, /"type":"turn_end"/);
  assert.match(trace, /"answer":"done"/);
});
