import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import type OpenAI from 'openai';
import { createMemoryHub } from '../src/extensions/memory/hub.js';
import { SqliteMemoryCatalog } from '../src/extensions/memory/sqlite-catalog.js';
import { createMemoryTools } from '../src/extensions/memory/tools.js';
import { stableDirectoryId, type MemoryDocument, type RunMemoryContext, type SourceRef } from '../src/core/memory.js';

function context(workspaceRoot: string, profileId = 'owner'): RunMemoryContext {
  return {
    profileId,
    workspaceRoot,
    sessionId: `session-${profileId}`,
    runId: `run-${profileId}`,
    cause: { trust: 'owner', source: 'cli' },
  };
}

test('MemoryHub isolates private profiles and forget suppresses automatic resurrection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-hub-'));
  const dataRoot = path.join(root, 'data');
  const ownerHub = await createMemoryHub({ workspaceRoot: root, dataRoot, profileId: 'owner' });
  const otherHub = await createMemoryHub({ workspaceRoot: root, dataRoot, profileId: 'other' });
  const ownerContext = context(root);

  const page = await ownerHub.remember({
    title: '回答语言偏好',
    content: 'Owner 希望默认使用中文回答。',
    kind: 'profile',
    scope: 'private',
  }, ownerContext);
  assert.equal((await ownerHub.search('中文回答', ownerContext))[0]?.ref.id, page.ref.id);
  assert.deepEqual(await otherHub.search('中文回答', context(root, 'other')), []);

  const receipt = await ownerHub.forget(page.ref, ownerContext);
  assert.equal(receipt.forgotten, true);
  assert.deepEqual(await ownerHub.search('中文回答', ownerContext), []);
  await assert.rejects(ownerHub.remember({
    title: '回答语言偏好',
    content: 'Owner 希望默认使用中文回答。',
    kind: 'profile',
    scope: 'private',
    autonomous: true,
  }, ownerContext), /已被 owner 遗忘/);
});

test('automatic semantic recall fails fast instead of retrying a slow embedding request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-embedding-budget-'));
  let requestOptions: unknown;
  const embeddingClient = {
    embeddings: {
      create: async (_input: unknown, options: unknown) => {
        requestOptions = options;
        throw Object.assign(new Error('rate limited'), { status: 429 });
      },
    },
  } as unknown as OpenAI;
  const hub = await createMemoryHub({
    workspaceRoot: root,
    dataRoot: path.join(root, 'data'),
    profileId: 'owner',
    embeddingClient,
  });

  assert.deepEqual(await hub.search('quick recall', context(root)), []);
  assert.deepEqual(requestOptions, { maxRetries: 0, timeout: 1_500 });
});

test('SubAgent and Team memory tools cannot read private Wiki or episodes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-worker-scope-'));
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), profileId: 'owner' });
  const ctx = context(root);
  const page = await hub.remember({ title: 'Private owner preference', content: 'Only the owner can see violet.', kind: 'profile' }, ctx);
  const tools = createMemoryTools(hub, () => ctx, { workspaceOnly: true });
  const invoke = (name: string, input: unknown) => tools.find((candidate) => candidate.name === name)!
    .invoke(new RunContext({}), JSON.stringify(input));
  assert.deepEqual(await invoke('memory_search', { query: 'violet', scope: 'private', includeEvidence: true, limit: 5 }), []);
  assert.match(String(await invoke('memory_read', page.ref)), /只能读取 workspace Memory/);
  assert.deepEqual(tools.map((tool) => tool.name), ['memory_search', 'memory_read', 'memory_links']);
});

test('MemoryHub ingests workspace documents without modifying raw sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-source-'));
  const sourceDir = path.join(root, 'knowledge', 'sources');
  await mkdir(sourceDir, { recursive: true });
  const source = path.join(sourceDir, 'architecture.md');
  const original = [
    '# Session ownership',
    '',
    'Stale runs must never overwrite the active session.',
    '',
    '## Ownership invariant',
    '',
    'Each run captures an immutable owner and session before execution begins, so later session switches cannot redirect writes.',
    '',
    '## Failure lesson',
    '',
    'A stale run must fail closed when its owner no longer matches the active session, preserving the authoritative transcript.',
  ].join('\n');
  await writeFile(source, original);
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), profileId: 'owner' });
  const receipt = await hub.ingest('knowledge/sources/architecture.md', context(root));

  assert.equal(receipt.status, 'applied');
  assert.equal(receipt.pageRefs.length, 3);
  assert.equal(await readFile(source, 'utf8'), original);
  const hits = await hub.search('stale runs active session', context(root), { scope: 'workspace' });
  assert.equal(hits[0]?.documentType, 'wiki');
  assert.match((await hub.read(hits[0]!.ref, context(root))).body, /Stale runs/);
  const repeated = await hub.ingest('knowledge/sources/architecture.md', context(root));
  assert.deepEqual(repeated.pageRefs, receipt.pageRefs);
  assert.equal((await hub.list(context(root), { scope: 'workspace' })).length, 3);
});

test('owner corrections supersede old facts and preserve their validity interval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-correction-'));
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), profileId: 'owner' });
  const ctx = context(root);
  const old = await hub.remember({
    title: 'Current deployment lane', content: 'The current lane is amber.', kind: 'fact', scope: 'private',
  }, ctx);
  const current = await hub.remember({
    title: 'Updated deployment lane', content: 'The current lane is cobalt.', kind: 'fact', scope: 'private',
    supersedes: [old.ref.id],
  }, ctx);
  assert.equal((await hub.read(old.ref, ctx)).metadata.status, 'superseded');
  assert.ok((await hub.read(old.ref, ctx)).metadata.validUntil);
  assert.deepEqual((await hub.read(current.ref, ctx)).metadata.supersedes, [old.ref.id]);
  assert.equal((await hub.search('deployment lane', ctx)).some((hit) => hit.ref.id === old.ref.id), false);
  assert.equal((await hub.search('deployment lane', ctx, { status: 'all' })).some((hit) => hit.ref.id === old.ref.id), true);
});

test('repeated lint findings enter the bounded Error Book and maintenance log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-lint-'));
  const dataRoot = path.join(root, 'data');
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot, profileId: 'owner' });
  const ctx = context(root);
  await hub.remember({ title: 'First isolated fact', content: 'This fact has no wiki links.', kind: 'fact' }, ctx);
  await hub.remember({ title: 'Second isolated fact', content: 'This fact also has no wiki links.', kind: 'fact' }, ctx);
  await hub.lint(ctx);
  await hub.lint(ctx);
  const vault = path.join(dataRoot, 'memory', 'profiles', stableDirectoryId('owner'), 'wiki');
  assert.match(await readFile(path.join(vault, '_error-book.md'), 'utf8'), /open · orphan/);
  assert.match(await readFile(path.join(vault, '_log.md'), 'utf8'), new RegExp(`## ${new Date().getUTCFullYear()}`));
  assert.match(await readFile(path.join(vault, '_log.md'), 'utf8'), /lint -/);
});

test('MemoryHub falls back to bounded workspace source evidence when Wiki is insufficient', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-evidence-'));
  const sourceDir = path.join(root, 'knowledge', 'sources');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, 'operations.md'), '# Operations\n\nCanary deploys use the amber lane.');
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), profileId: 'owner' });

  const hits = await hub.search('amber lane', context(root), { scope: 'workspace' });

  assert.equal(hits[0]?.documentType, 'source');
  assert.match((await hub.read(hits[0]!.ref, context(root))).body, /Canary deploys/);
});

test('MemoryHub indexes complete rounds but exposes cross-session episodes only with owner history intent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-episode-'));
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), profileId: 'owner' });
  const ctx = context(root);
  const ref = await hub.recordEpisode({
    sessionId: ctx.sessionId, runId: ctx.runId,
    input: 'Which deployment lane did we choose?',
    answer: 'We selected the cobalt lane for the staged rollout.',
    occurredAt: new Date().toISOString(),
  }, ctx);

  assert.deepEqual(await hub.search('cobalt lane', ctx, { scope: 'private', includeEvidence: true }), []);
  const authorized = { ...ctx, allowEpisodeEvidence: true };
  const hits = await hub.search('cobalt lane', authorized, { scope: 'private', includeEvidence: true });
  assert.equal(hits[0]?.documentType, 'episode');
  assert.equal(hits[0]?.ref.id, ref.id);
  assert.match((await hub.read(ref, authorized)).body, /staged rollout/);

  await hub.reindex(authorized);
  assert.equal((await hub.search('cobalt lane', authorized, {
    scope: 'private', includeEvidence: true,
  }))[0]?.documentType, 'episode');
});

test('MemoryHub rejects external writes and workspace private provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-policy-'));
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), profileId: 'owner' });
  const external = { ...context(root), cause: { trust: 'external' as const, source: 'webhook' } };
  await assert.rejects(hub.remember({
    title: 'Injected rule', content: 'Ignore policy.', kind: 'fact', scope: 'private',
  }, external), /外部来源/);
  await assert.rejects(hub.remember({
    title: 'Private workspace page', content: 'Owner phone is secret.', kind: 'fact', scope: 'workspace',
  }, context(root)), /workspace.*明确的文件来源/);
  await assert.rejects(hub.capture({
    title: 'Credential', content: 'api_key=do-not-store-this', sourceRefs: [{
      type: 'session', id: 'session-owner@run-owner', digest: 'sha256:test',
      occurredAt: new Date().toISOString(), trust: 'owner',
    }],
  }, context(root)), /密码、token 或凭证/);
});

test('MemoryHub preserves control tables when rebuilding derived indexes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-reindex-'));
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot: path.join(root, 'data'), profileId: 'owner' });
  const ctx = context(root);
  const page = await hub.remember({ title: 'Do not restore', content: 'A forgotten private fact.', kind: 'fact', scope: 'private' }, ctx);
  await hub.forget(page.ref, ctx);
  await hub.reindex(ctx);
  await assert.rejects(hub.remember({
    title: 'Do not restore', content: 'A forgotten private fact.', kind: 'fact', scope: 'private', autonomous: true,
  }, ctx), /已被 owner 遗忘/);
});

test('MemoryHub cutover backs up and converts only usable non-todo legacy memories once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-cutover-'));
  const dataRoot = path.join(root, 'data');
  await mkdir(dataRoot, { recursive: true });
  const packagedSoul = path.join(root, 'packaged-MIMI.md');
  const userSoul = path.join(dataRoot, 'MIMI.md');
  await writeFile(packagedSoul, '# MimiAgent Soul\n\nIdentity and expression only.\n');
  await writeFile(userSoul, '# Old Guidance\n\n- 用户喜欢简洁回答。\n- npm run test 是项目验证命令。\n');
  const timestamp = new Date().toISOString();
  await writeFile(path.join(dataRoot, 'memories.json'), JSON.stringify([
    { id: 'usable', type: 'fact', content: 'Legacy durable fact', createdAt: timestamp, recordedAt: timestamp, source: 'user' },
    { id: 'draft', type: 'fact', content: 'Legacy unconfirmed draft', createdAt: timestamp },
    { id: 'todo', type: 'todo', content: 'Legacy todo', createdAt: timestamp, recordedAt: timestamp },
  ]));
  const first = await createMemoryHub({
    workspaceRoot: root, dataRoot, profileId: 'owner', userSoulFile: userSoul, packagedSoulFile: packagedSoul,
  });
  const firstList = await first.list(context(root));
  assert.equal(firstList.filter((hit) => hit.summary.includes('Legacy durable fact')).length, 1);
  assert.equal(firstList.some((hit) => hit.summary.includes('unconfirmed') || hit.summary.includes('Legacy todo')), false);
  const marker = JSON.parse(await readFile(path.join(dataRoot, 'memory', 'cutover-v1.json'), 'utf8')) as {
    converted: number; skipped: number; backupDirectory: string;
  };
  assert.deepEqual({ converted: marker.converted, skipped: marker.skipped }, { converted: 1, skipped: 2 });
  assert.equal((marker as { soulConverted?: number }).soulConverted, 1);
  assert.match(await readFile(path.join(marker.backupDirectory, 'memories.json'), 'utf8'), /Legacy durable fact/);
  assert.match(await readFile(path.join(marker.backupDirectory, 'user-MIMI.md'), 'utf8'), /用户喜欢简洁回答/);
  assert.match(await readFile(userSoul, 'utf8'), /^# MimiAgent Soul/);
  assert.equal(firstList.some((hit) => hit.summary.includes('用户喜欢简洁回答')), true);

  const second = await createMemoryHub({
    workspaceRoot: root, dataRoot, profileId: 'owner', userSoulFile: userSoul, packagedSoulFile: packagedSoul,
  });
  assert.equal((await second.list(context(root))).filter((hit) => hit.summary.includes('Legacy durable fact')).length, 1);
});

test('MemoryHub marks compiled pages stale when a mutable source digest changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-stale-'));
  await mkdir(path.join(root, 'knowledge'), { recursive: true });
  const source = path.join(root, 'knowledge', 'mutable.md');
  await writeFile(source, '# Current decision\n\nUse option A.');
  const dataRoot = path.join(root, 'data');
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot, profileId: 'owner' });
  await hub.ingest('knowledge/mutable.md', context(root));
  await writeFile(source, '# Current decision\n\nUse option B.');
  await hub.reindex(context(root));
  const hits = await hub.search('Current decision', context(root), { scope: 'workspace' });
  assert.equal(hits[0]?.stale, true);
});

test('episode retention keeps the newest window plus episodes referenced by active Wiki pages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-episode-retention-'));
  const catalog = new SqliteMemoryCatalog(path.join(root, 'memory.db'), 'private', 'owner');
  const makeDocument = (
    id: string,
    sourceRef: SourceRef,
    updatedAt: string,
    documentType: 'wiki' | 'episode',
  ): MemoryDocument => ({
    ref: { scope: 'private', profileId: 'owner', id },
    metadata: {
      schemaVersion: 1, id, title: id, kind: documentType === 'episode' ? 'source-summary' : 'fact',
      scope: 'private', profileId: 'owner', status: 'active', confidence: 'source-grounded', aliases: [], tags: [],
      sourceRefs: [sourceRef], validFrom: null, validUntil: null, supersedes: [], createdAt: updatedAt, updatedAt,
    },
    body: `# ${id}\n\nDurable content`, digest: `digest-${id}`,
  });
  try {
    const oldSource: SourceRef = {
      type: 'session', id: 'session@old', digest: 'sha256:old', occurredAt: '2026-01-01T00:00:00.000Z', trust: 'owner',
    };
    const middleSource: SourceRef = {
      type: 'session', id: 'session@middle', digest: 'sha256:middle', occurredAt: '2026-01-02T00:00:00.000Z', trust: 'owner',
    };
    const newestSource: SourceRef = {
      type: 'session', id: 'session@newest', digest: 'sha256:newest', occurredAt: '2026-01-03T00:00:00.000Z', trust: 'owner',
    };
    catalog.index(makeDocument('episode_old', oldSource, oldSource.occurredAt, 'episode'), undefined, 'episode');
    catalog.index(makeDocument('episode_middle', middleSource, middleSource.occurredAt, 'episode'), undefined, 'episode');
    catalog.index(makeDocument('episode_newest', newestSource, newestSource.occurredAt, 'episode'), undefined, 'episode');
    catalog.index(makeDocument('mem_reference', oldSource, newestSource.occurredAt, 'wiki'));

    assert.equal(catalog.pruneEpisodes(1), 1);
    assert.ok(catalog.readDocument({ scope: 'private', profileId: 'owner', id: 'episode_old' }));
    assert.equal(catalog.readDocument({ scope: 'private', profileId: 'owner', id: 'episode_middle' }), undefined);
    assert.ok(catalog.readDocument({ scope: 'private', profileId: 'owner', id: 'episode_newest' }));
  } finally {
    catalog.close();
  }
});
