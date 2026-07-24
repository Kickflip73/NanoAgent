import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { stableDirectoryId, type MemoryDocument } from '../src/core/memory.js';
import { MemoryCompilationCoordinator } from '../src/extensions/memory/compilation-coordinator.js';
import { createMemoryHub } from '../src/extensions/memory/hub.js';
import { SqliteMemoryCatalog } from '../src/extensions/memory/sqlite-catalog.js';
import { parsePage, serializePage, WikiVault } from '../src/extensions/memory/wiki-vault.js';

function page(id: string): MemoryDocument {
  const timestamp = new Date().toISOString();
  return {
    ref: { scope: 'private', profileId: 'owner', id },
    metadata: {
      schemaVersion: 1,
      id,
      title: 'Migrated fact',
      kind: 'fact',
      scope: 'private',
      profileId: 'owner',
      status: 'active',
      confidence: 'user-confirmed',
      aliases: [],
      tags: [],
      sourceRefs: [{
        type: 'session',
        id: 'session-1@run-1',
        digest: `sha256:${'e'.repeat(64)}`,
        occurredAt: timestamp,
        trust: 'owner',
      }],
      validFrom: null,
      validUntil: null,
      supersedes: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    body: '# Migrated fact\n\nDurable evidence.',
    digest: `sha256:${'a'.repeat(64)}`,
  };
}

test('catalog migration gives every existing wiki page V2 provenance controls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-v2-'));
  const file = path.join(root, 'memory.db');
  const first = new SqliteMemoryCatalog(file, 'private', 'owner');
  first.index(page('fact-1'));
  first.close();
  const legacyMarker = new DatabaseSync(file);
  legacyMarker.prepare(`UPDATE schema_meta SET value='1' WHERE key='version'`).run();
  legacyMarker.close();

  const migrated = new SqliteMemoryCatalog(file, 'private', 'owner');
  try {
    await access(`${file}.pre-memory-v2.bak`);
    const revision = migrated.currentRevision('fact-1');
    assert.equal(revision?.revision, 1);
    assert.equal(revision?.bodyDigest, `sha256:${'a'.repeat(64)}`);
    assert.equal(revision?.evidenceRefs[0]?.locator.sessionId, 'session-1');
    assert.equal(revision?.evidenceRefs[0]?.locator.runId, 'run-1');
    const job = migrated.getJob(revision!.compilationJobId);
    assert.equal(job?.status, 'applied');
    assert.equal(job?.operation, 'legacy-import');
    const candidate = migrated.getCandidate(job!.candidateId);
    assert.equal(candidate?.createdBy, 'migration');
    assert.equal(migrated.getReceiptV2(job!.id)?.status, 'applied');

    migrated.rebuild([page('fact-1')]);
    assert.equal(migrated.currentRevision('fact-1')?.revisionId, revision?.revisionId);
  } finally {
    migrated.close();
  }
});

test('coordinator recovers applying jobs without replaying uncertain page writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-recover-'));
  const file = path.join(root, 'memory.db');
  const catalog = new SqliteMemoryCatalog(file, 'private', 'owner');
  const vault = new WikiVault(path.join(root, 'wiki'), 'private', 'owner');
  await vault.initialize();
  const coordinator = new MemoryCompilationCoordinator(catalog, vault, 'workspace-1');
  const document = page('mem_recover_0001');
  const targetDigest = parsePage(serializePage(document.metadata, document.body)).digest;
  const input = {
    operation: 'capture' as const,
    scope: 'private' as const,
    title: document.metadata.title,
    content: document.body,
    kind: document.metadata.kind,
    confidence: document.metadata.confidence,
    sourceRefs: document.metadata.sourceRefs,
    metadata: document.metadata,
    targetDigest,
    createdBy: 'owner' as const,
    context: {
      profileId: 'owner',
      workspaceRoot: root,
      sessionId: 'session-1',
      runId: 'run-1',
    },
  };
  try {
    const prepared = coordinator.prepare(input);
    const missing = await coordinator.recover(prepared.job.id);
    assert.equal(missing[0] && 'status' in missing[0] ? missing[0].status : undefined, 'pending');

    const resumed = coordinator.prepare(input);
    await vault.write(document.metadata, document.body);
    const recovered = await coordinator.recover(resumed.job.id);
    assert.equal(recovered[0] && 'status' in recovered[0] ? recovered[0].status : undefined, 'applied');
    assert.equal(catalog.currentRevision(document.ref.id)?.revision, 1);
    assert.equal((await coordinator.recover(resumed.job.id))[0]?.status, 'applied');
  } finally {
    catalog.close();
  }
});

test('coordinator marks a conflicting post-rename page uncertain', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-conflict-'));
  const catalog = new SqliteMemoryCatalog(path.join(root, 'memory.db'), 'private', 'owner');
  const vault = new WikiVault(path.join(root, 'wiki'), 'private', 'owner');
  await vault.initialize();
  const coordinator = new MemoryCompilationCoordinator(catalog, vault, 'workspace-1');
  const expected = page('mem_conflict_0001');
  const prepared = coordinator.prepare({
    operation: 'capture',
    scope: 'private',
    title: expected.metadata.title,
    content: expected.body,
    kind: expected.metadata.kind,
    confidence: expected.metadata.confidence,
    sourceRefs: expected.metadata.sourceRefs,
    metadata: expected.metadata,
    targetDigest: parsePage(serializePage(expected.metadata, expected.body)).digest,
    createdBy: 'owner',
    context: {
      profileId: 'owner', workspaceRoot: root, sessionId: 'session-1', runId: 'run-1',
    },
  });
  try {
    await vault.write(expected.metadata, 'conflicting body');
    const [result] = await coordinator.recover(prepared.job.id);
    assert.equal(result?.status, 'uncertain');
    assert.equal(catalog.getReceiptV2(prepared.job.id)?.reasonCode, 'partial_or_conflicting_page_write');
  } finally {
    catalog.close();
  }
});

test('remember, capture, reject, and ingest all produce V2 terminal receipts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-memory-entrypoints-'));
  const dataRoot = path.join(root, 'data');
  await mkdir(path.join(root, 'knowledge', 'sources'), { recursive: true });
  await writeFile(
    path.join(root, 'knowledge', 'sources', 'guide.md'),
    '# Guide\n\n## Durable rule\n\nAlways verify the durable result before completion.',
  );
  const hub = await createMemoryHub({ workspaceRoot: root, dataRoot, profileId: 'owner' });
  const context = {
    profileId: 'owner',
    workspaceRoot: root,
    sessionId: 'session-1',
    runId: 'run-1',
    cause: { trust: 'owner' as const, source: 'cli' },
  };
  const sourceRef = {
    type: 'session' as const,
    id: 'session-1@run-1',
    digest: `sha256:${'b'.repeat(64)}`,
    occurredAt: new Date().toISOString(),
    trust: 'owner' as const,
  };
  await hub.remember({ title: 'Explicit fact', content: 'Keep this fact.', kind: 'fact' }, context);
  await hub.capture({
    title: 'Captured lesson',
    content: 'Keep this verified lesson.',
    sourceRefs: [sourceRef],
    reasonCode: 'verified_lesson',
  }, context);
  await hub.reject([sourceRef], 'not_durable', context);
  await hub.ingest('knowledge/sources/guide.md', context);

  const privateDb = new DatabaseSync(path.join(
    dataRoot,
    'memory',
    'profiles',
    stableDirectoryId('owner'),
    'memory.db',
  ), { readOnly: true });
  const workspaceDb = new DatabaseSync(path.join(
    dataRoot,
    'memory',
    'workspaces',
    stableDirectoryId(root),
    'memory.db',
  ), { readOnly: true });
  try {
    const privateCounts = privateDb.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_page_current) AS pages,
        (SELECT COUNT(*) FROM compilation_receipts_v2 WHERE status='applied') AS applied,
        (SELECT COUNT(*) FROM compilation_receipts_v2 WHERE status='rejected') AS rejected
    `).get() as { pages: number; applied: number; rejected: number };
    assert.equal(Number(privateCounts.pages), 2);
    assert.equal(Number(privateCounts.applied), 2);
    assert.equal(Number(privateCounts.rejected), 1);
    const workspaceCounts = workspaceDb.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_page_current) AS pages,
        (SELECT COUNT(*) FROM compilation_receipts_v2 WHERE status='applied') AS applied
    `).get() as { pages: number; applied: number };
    assert.ok(Number(workspaceCounts.pages) >= 1);
    assert.equal(Number(workspaceCounts.applied), Number(workspaceCounts.pages));
  } finally {
    privateDb.close();
    workspaceDb.close();
  }
});
