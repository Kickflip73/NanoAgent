import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RagStore } from '../src/extensions/rag.js';
import { AtomicJsonStore } from '../src/core/state-file.js';

test('aborts RAG embedding without committing a partial index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-abort-'));
  const docs = path.join(root, 'knowledge');
  const indexFile = path.join(root, 'index.json');
  await mkdir(docs);
  await writeFile(path.join(docs, 'agent.md'), 'abortable embedding');
  const client = {
    embeddings: {
      create: async (_body: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ data: [{ embedding: [1, 0] }] }), 250);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      }),
    },
  } as never;
  const controller = new AbortController();
  const indexing = new RagStore(root, indexFile, client).index('knowledge', controller.signal);
  setTimeout(() => controller.abort(new Error('stop indexing')), 20);

  await assert.rejects(indexing, /stop indexing/);
  await assert.rejects(access(indexFile), /ENOENT/);
});

test('serializes concurrent RAG commits and reloads the latest disk index', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-concurrent-'));
  const firstDirectory = path.join(root, 'first');
  const secondDirectory = path.join(root, 'second');
  const indexFile = path.join(root, 'index.json');
  await Promise.all([mkdir(firstDirectory), mkdir(secondDirectory)]);
  await Promise.all([
    writeFile(path.join(firstDirectory, 'a.md'), 'UNIQUE_ALPHA'),
    writeFile(path.join(secondDirectory, 'b.md'), 'UNIQUE_BETA'),
  ]);
  const first = new RagStore(root, indexFile);
  const second = new RagStore(root, indexFile);

  await Promise.all([first.index('first'), second.index('second')]);

  const persisted = JSON.parse(await readFile(indexFile, 'utf8')) as { chunks: Array<{ content: string }> };
  assert.equal(persisted.chunks.length, 1);
  assert.match(persisted.chunks[0]?.content ?? '', /UNIQUE_(?:ALPHA|BETA)/);
  assert.deepEqual(await first.search('UNIQUE_ALPHA UNIQUE_BETA'), await second.search('UNIQUE_ALPHA UNIQUE_BETA'));
});

test('does not let workspace-scoped RAG index files outside the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-scope-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-outside-'));
  await writeFile(path.join(outside, 'secret.md'), 'OUTSIDE_SECRET');
  const indexFile = path.join(root, 'index.json');

  await assert.rejects(new RagStore(root, indexFile).index(outside), /不能超出当前工作区/);
  const trusted = new RagStore(root, indexFile, undefined, [], true);
  assert.equal((await trusted.index(outside)).files, 1);
  assert.match(JSON.stringify(await trusted.search('OUTSIDE_SECRET')), /OUTSIDE_SECRET/);
});

test('bounds RAG input bytes and chunk count before embedding or commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-limits-'));
  const docs = path.join(root, 'knowledge');
  await mkdir(docs);
  await writeFile(path.join(docs, 'large.md'), '0123456789');

  await assert.rejects(
    new RagStore(root, path.join(root, 'file-limit.json'), undefined, [], false, {
      maxFileBytes: 8,
    }).index('knowledge'),
    /单文件超过 8 字节/,
  );

  await writeFile(path.join(docs, 'large.md'), 'x'.repeat(1_700));
  await assert.rejects(
    new RagStore(root, path.join(root, 'chunk-limit.json'), undefined, [], false, {
      maxFileBytes: 2_000,
      maxTotalBytes: 2_000,
      maxChunks: 1,
    }).index('knowledge'),
    /切片超过 1 个/,
  );
});

test('does not follow nested knowledge symlinks outside the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-link-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-link-private-'));
  const docs = path.join(root, 'knowledge');
  await mkdir(docs);
  await writeFile(path.join(outside, 'secret.md'), 'PRIVATE_SENTINEL');
  await symlink(path.join(outside, 'secret.md'), path.join(docs, 'leak.md'));

  const rag = new RagStore(root, path.join(root, 'index.json'), undefined, [outside]);
  assert.deepEqual(await rag.index('knowledge'), { files: 0, chunks: 0, embeddings: false });
  assert.doesNotMatch(JSON.stringify(await rag.search('PRIVATE_SENTINEL')), /PRIVATE_SENTINEL/);
});

test('does not commit a RAG index when cancelled while waiting for the state lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-rag-lock-cancel-'));
  const docs = path.join(root, 'knowledge');
  const indexFile = path.join(root, 'index.json');
  await mkdir(docs);
  await writeFile(path.join(docs, 'agent.md'), 'SHOULD_NOT_COMMIT');
  const state = new AtomicJsonStore(indexFile, {
    defaultValue: () => ({ version: 1 as const, chunks: [] as unknown[] }),
  });
  let entered!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const blocker = state.update(async () => {
    entered();
    await barrier;
  });
  await locked;
  const controller = new AbortController();
  const indexing = new RagStore(root, indexFile).index('knowledge', controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error('cancelled while waiting'));
  release();
  await blocker;

  await assert.rejects(indexing, /cancelled while waiting/);
  assert.doesNotMatch(await readFile(indexFile, 'utf8'), /SHOULD_NOT_COMMIT/);
});
