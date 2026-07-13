import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AgentInputItem } from '@openai/agents';
import { ContextManager, estimateTokens } from '../src/core/context.js';
import { MemoryStore } from '../src/core/memory.js';
import { PlanStore } from '../src/core/plan.js';
import { FileSession } from '../src/core/session.js';
import { TraceStore } from '../src/core/trace.js';
import { HookBus } from '../src/runtime/hooks.js';
import { MCPManager, parseMcpConfig } from '../src/extensions/mcp.js';
import { RagStore } from '../src/extensions/rag.js';
import { SkillLoader } from '../src/extensions/skills.js';
import { createSubAgentTools } from '../src/extensions/subagents.js';

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

test('serializes concurrent session writes and keeps an in-process cache', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-concurrent-'));
  const session = new FileSession(root, 'demo');
  await Promise.all([
    session.addItems([{ role: 'user', content: 'one' }] as AgentInputItem[]),
    session.addItems([{ role: 'user', content: 'two' }] as AgentInputItem[]),
  ]);
  assert.deepEqual((await session.getItems()).map((item) => 'content' in item ? item.content : ''), ['one', 'two']);
});

test('summarizes and sorts sessions from recent conversation content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-summary-'));
  const session = new FileSession(root, 'opaque-id');
  await session.addItems([
    { role: 'user', content: '帮我优化 NanoAgent 的终端交互体验' },
    { role: 'user', content: '还要支持任务排队' },
  ] as AgentInputItem[]);

  const [summary] = await FileSession.listSummaries(root);
  assert.equal(summary?.id, 'opaque-id');
  assert.equal(summary?.title, '优化 NanoAgent 的终端交互体验');
  assert.equal(summary?.preview, '还要支持任务排队');
  assert.equal(summary?.turns, 2);
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

test('repairs dangling tool calls left by an interrupted task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-session-repair-'));
  const session = new FileSession(root, 'demo');
  await session.addItems([
    { type: 'message', role: 'user', content: 'run it' },
    { type: 'function_call', name: 'run_shell', callId: 'dangling', arguments: '{}' },
    { type: 'function_call', name: 'read_file', callId: 'paired', arguments: '{}' },
    { type: 'function_call_result', name: 'read_file', callId: 'paired', output: 'ok' },
  ] as unknown as AgentInputItem[]);

  assert.equal(await session.repairToolPairs(), 1);
  const serialized = JSON.stringify(await session.getItems());
  assert.doesNotMatch(serialized, /dangling/);
  assert.match(serialized, /paired/);
});

test('stores, retrieves and forgets long-term memories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-memory-'));
  const store = new MemoryStore(path.join(root, 'memories.json'));
  const memory = await store.remember('用户偏好 TypeScript', 'preference');

  assert.equal((await store.search('TypeScript 偏好'))[0]?.id, memory.id);
  assert.deepEqual(await store.search('完全无关'), []);
  assert.equal(await store.forget(memory.id), true);
  assert.deepEqual(await store.list(), []);
});

test('loads skill metadata and content on demand', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-skill-'));
  const directory = path.join(root, 'review');
  await mkdir(path.join(directory, 'references'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\nDo it.');
  await writeFile(path.join(directory, 'references', 'guide.md'), 'Review carefully.');
  const loader = new SkillLoader(root);
  await loader.load();

  assert.match(loader.catalog(), /review: Review code/);
  assert.match(loader.catalog(), /location:/);
  assert.match(loader.get('review')?.content ?? '', /Do it/);
  assert.match((await loader.readResource('review', 'references/guide.md')).content, /carefully/);
  await assert.rejects(loader.readResource('review', '../secret'), /不能超出/);
  const outside = path.join(root, 'outside.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, path.join(directory, 'references', 'escape.md'));
  await assert.rejects(loader.readResource('review', 'references/escape.md'), /符号链接/);
});

test('reports invalid skills without breaking valid skill discovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-skill-invalid-'));
  await mkdir(path.join(root, 'Bad_Name'), { recursive: true });
  await writeFile(path.join(root, 'Bad_Name', 'SKILL.md'), '---\nname: Bad_Name\ndescription: Invalid\n---\nNo.');
  const loader = new SkillLoader(root);
  await loader.load();

  assert.deepEqual(loader.list(), []);
  assert.equal(loader.diagnostics().length, 1);
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

test('rebuilds RAG embeddings when the embedding model changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-model-'));
  const docs = path.join(root, 'knowledge');
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, 'agent.md'), 'NanoAgent context management.');
  const indexFile = path.join(root, 'index.json');
  const previous = process.env.EMBEDDING_MODEL;
  let oldCalls = 0;
  let newCalls = 0;
  const client = (counter: () => void) => ({
    embeddings: {
      create: async ({ input }: { input: string | string[] }) => {
        counter();
        const values = Array.isArray(input) ? input : [input];
        return { data: values.map((_, index) => ({ embedding: [index + 1, 0] })) };
      },
    },
  }) as never;
  try {
    process.env.EMBEDDING_MODEL = 'embedding-old';
    await new RagStore(root, indexFile, client(() => { oldCalls += 1; })).index('knowledge');
    process.env.EMBEDDING_MODEL = 'embedding-new';
    await new RagStore(root, indexFile, client(() => { newCalls += 1; })).index('knowledge');
  } finally {
    if (previous === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = previous;
  }
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
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
    goal: { objective: 'ship', status: 'active', createdAt: '', updatedAt: '' },
  });
  assert.match(instructions, /uses TS/);
  assert.match(instructions, /older conversation/);
  assert.match(instructions, /doc\.md/);
  assert.match(instructions, /running/);
  assert.match(instructions, /ship/);
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

test('limits recent history by token budget even below the item limit', async () => {
  const manager = new ContextManager(100, 4_000, 0.5);
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: 'user',
    content: `message-${index} ${'上下文'.repeat(180)}`,
  })) as AgentInputItem[];
  const next = await manager.sessionInput(history, [{ role: 'user', content: 'new' }]);

  assert.ok(next.length < history.length + 1);
  assert.match(JSON.stringify(next.at(-1)), /new/);
  assert.match(manager.summarizeHistory(history), /用户:/);
});

test('caps dynamic instructions within their token budget', () => {
  const manager = new ContextManager(100, 4_000, 0.5);
  const instructions = manager.buildInstructions({
    baseInstructions: 'base',
    historySummary: '历史'.repeat(4_000),
    skillCatalog: '技能'.repeat(4_000),
    memories: [],
    documents: [],
    plan: [],
  });
  assert.ok(estimateTokens(instructions) <= 2_000);
});

test('drops an oversized tool-heavy turn instead of violating the token budget', async () => {
  const manager = new ContextManager(100, 4_000, 0.5);
  const history = [
    { type: 'message', role: 'user', content: 'large tool task' },
    ...Array.from({ length: 20 }, (_, index) => ({
      type: index % 2 ? 'function_call_result' : 'function_call',
      name: 'read_file',
      callId: `call-${Math.floor(index / 2)}`,
      ...(index % 2 ? { output: '内容'.repeat(1_000) } : { arguments: '{}' }),
    })),
  ] as unknown as AgentInputItem[];
  const next = await manager.sessionInput(history, [{ role: 'user', content: 'new task' }]);
  assert.deepEqual(next, [{ role: 'user', content: 'new task' }]);
});

test('keeps plans isolated by session and writes JSONL traces', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-state-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'first');
  await plans.update([{ id: '1', description: 'build', status: 'running' }]);
  plans.useSession('second');
  assert.deepEqual(await plans.get(), []);
  plans.useSession('first');
  assert.equal((await plans.get())[0]?.description, 'build');
  const goal = await plans.setGoal('ship NanoAgent');
  assert.equal(goal.status, 'active');
  await plans.checkpoint({ checkpoint: 'tests pass', nextAction: 'publish' });
  assert.match(await plans.resumePrompt(), /tests pass/);
  await plans.update([{ id: 'old', description: 'old task', status: 'running' }]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await plans.setGoal('new objective');
  assert.deepEqual(await plans.get(), []);
  const current = await plans.getGoal();
  assert.notEqual(current?.createdAt, goal.createdAt);

  const traces = new TraceStore(path.join(root, 'traces'));
  await traces.record('first', 'turn_end', { answer: 'done' });
  const trace = await readFile(path.join(root, 'traces', 'first.jsonl'), 'utf8');
  assert.match(trace, /"type":"turn_end"/);
  assert.match(trace, /"answer":"done"/);

  const rotating = new TraceStore(path.join(root, 'rotating'), 180);
  await rotating.record('demo', 'status', { detail: 'x'.repeat(120) });
  await rotating.record('demo', 'status', { detail: 'y'.repeat(120) });
  assert.match(await readFile(path.join(root, 'rotating', 'demo.1.jsonl'), 'utf8'), /xxxx/);
});

test('serializes concurrent plan and goal mutations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-plan-concurrent-'));
  const plans = new PlanStore(path.join(root, 'plans.json'), 'demo');
  await plans.setGoal('ship');
  await Promise.all([
    plans.update([{ id: '1', description: 'build', status: 'running' }]),
    plans.checkpoint({ checkpoint: 'started', nextAction: 'test' }),
  ]);

  assert.equal((await plans.get())[0]?.description, 'build');
  assert.equal((await plans.getGoal())?.checkpoint, 'started');
});

test('migrates legacy MCP config and accepts Streamable HTTP config', () => {
  const legacy = parseMcpConfig({ servers: { fs: { command: 'npx', args: ['server'] } } });
  const modern = parseMcpConfig({ mcpServers: { remote: { type: 'http', url: 'https://example.com/mcp' } } });
  assert.equal('command' in legacy.fs!, true);
  assert.equal('url' in modern.remote!, true);
});

test('keeps valid MCP definitions when another config entry is invalid', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-mcp-config-'));
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({
    mcpServers: {
      disabled: { command: 'node', enabled: false },
      invalid: { args: ['missing-command'] },
    },
  }));
  const manager = new MCPManager(config, root);
  await manager.connect();
  assert.equal(manager.statuses()[0]?.name, 'invalid');
  assert.equal(manager.statuses()[0]?.state, 'failed');
});

test('isolates an MCP connection failure instead of blocking startup', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-mcp-'));
  const config = path.join(root, 'mcp.json');
  await writeFile(config, JSON.stringify({ mcpServers: { broken: { command: 'nano-agent-command-that-does-not-exist' } } }));
  const manager = new MCPManager(config, root);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.deepEqual(await manager.connect(), []);
    assert.equal(manager.statuses()[0]?.state, 'failed');
    await manager.close();
  } finally {
    console.error = originalError;
  }
});

test('creates bounded researcher and reviewer agent tools', () => {
  const tools = createSubAgentTools({ model: 'gpt-5-mini', tools: [] });
  assert.deepEqual(tools.map((tool) => tool.name), ['delegate_research', 'delegate_review']);
});

test('emits lightweight runtime lifecycle hooks', async () => {
  const bus = new HookBus();
  const seen: string[] = [];
  bus.on((event) => { seen.push(event.type); });
  await bus.emit({ type: 'run_start', sessionId: 'demo', input: 'hello' });
  assert.deepEqual(seen, ['run_start']);
});
