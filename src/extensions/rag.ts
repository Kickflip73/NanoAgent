import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tool } from '@openai/agents';
import type OpenAI from 'openai';
import { z } from 'zod';
import { textScore } from '../core/memory.js';
import { AtomicJsonStore, withExclusiveFileLock } from '../core/state-file.js';

interface RagChunk {
  id: string;
  source: string;
  content: string;
  digest?: string;
  embedding?: number[];
}

interface RagIndex {
  version: 1;
  embeddingModel?: string;
  chunks: RagChunk[];
}

const ragIndexSchema = z.object({
  version: z.literal(1),
  embeddingModel: z.string().optional(),
  chunks: z.array(z.object({
    id: z.string(),
    source: z.string(),
    content: z.string(),
    digest: z.string().optional(),
    embedding: z.array(z.number()).optional(),
  })),
});

export interface RagMatch {
  source: string;
  content: string;
  score: number;
}

export interface RagLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxChunks: number;
}

const DEFAULT_RAG_LIMITS: RagLimits = {
  maxFiles: 2_000,
  maxFileBytes: 2_000_000,
  maxTotalBytes: 10_000_000,
  maxChunks: 2_000,
};

function chunkText(content: string, size = 900, overlap = 120): string[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += size - overlap) {
    chunks.push(normalized.slice(start, start + size));
    if (start + size >= normalized.length) break;
  }
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    aa += a[index]! ** 2;
    bb += b[index]! ** 2;
  }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb) || 1);
}

export class RagStore {
  private readonly embeddingModel: string;
  private readonly state: AtomicJsonStore<RagIndex>;
  private readonly limits: RagLimits;

  constructor(
    private readonly workspaceRoot: string,
    private readonly indexFile: string,
    private readonly embeddingClient?: OpenAI,
    private readonly protectedRoots: string[] = [],
    private readonly allowOutsideWorkspace = false,
    limits: Partial<RagLimits> = {},
  ) {
    this.embeddingModel = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
    this.limits = { ...DEFAULT_RAG_LIMITS, ...limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`RAG ${name} 必须是正安全整数`);
    }
    this.state = new AtomicJsonStore<RagIndex>(indexFile, {
      defaultValue: () => ({ version: 1, chunks: [] }),
      decode: (value) => ragIndexSchema.parse(value),
      pretty: false,
      recoverCorrupt: true,
    });
  }

  async index(
    target = 'knowledge',
    signal?: AbortSignal,
  ): Promise<{ files: number; chunks: number; embeddings: boolean; embeddingError?: string }> {
    return withExclusiveFileLock(`${this.indexFile}.indexing`, () => this.buildIndex(target, signal), signal);
  }

  private async buildIndex(
    target: string,
    signal?: AbortSignal,
  ): Promise<{ files: number; chunks: number; embeddings: boolean; embeddingError?: string }> {
    signal?.throwIfAborted();
    const root = path.resolve(this.workspaceRoot, target);
    if (!this.allowOutsideWorkspace && !await this.isWithinWorkspace(root)) {
      throw new Error('知识索引路径不能超出当前工作区');
    }
    if (await this.isProtected(root)) throw new Error('不能把 MimiAgent 私有运行数据加入共享知识索引');
    const files = await this.textFiles(root, signal);
    const previous = await this.load();
    const previousEmbeddings = new Map((previous.embeddingModel === this.embeddingModel ? previous.chunks : [])
      .filter((chunk) => chunk.digest && chunk.embedding)
      .map((chunk) => [chunk.digest!, chunk.embedding!]));
    const chunks: RagChunk[] = [];
    for (const file of files) {
      signal?.throwIfAborted();
      const content = await readFile(file.path, { encoding: 'utf8', signal });
      const fileChunks = chunkText(content);
      if (chunks.length + fileChunks.length > this.limits.maxChunks) {
        throw new Error(`知识库切片超过 ${this.limits.maxChunks} 个，请缩小索引目录`);
      }
      fileChunks.forEach((text, index) => {
        const digest = createHash('sha256').update(text).digest('hex');
        chunks.push({
          id: `${path.relative(root, file.path)}:${index}`,
          source: path.relative(this.workspaceRoot, file.path),
          content: text,
          digest,
          embedding: previousEmbeddings.get(digest),
        });
      });
    }
    let embeddingError: string | undefined;
    if (this.embeddingClient && chunks.length) {
      try {
        const pending = chunks.filter((chunk) => !chunk.embedding);
        for (let start = 0; start < pending.length; start += 64) {
          signal?.throwIfAborted();
          const batch = pending.slice(start, start + 64);
          const response = await this.embeddingClient.embeddings.create({
            model: this.embeddingModel,
            input: batch.map((chunk) => chunk.content),
          }, { signal });
          response.data.forEach((item, index) => {
            batch[index]!.embedding = item.embedding;
          });
        }
      } catch (error) {
        signal?.throwIfAborted();
        embeddingError = error instanceof Error ? error.message : String(error);
        chunks.forEach((chunk) => delete chunk.embedding);
      }
    }
    const embeddings = chunks.length > 0 && chunks.every((chunk) => chunk.embedding);
    signal?.throwIfAborted();
    await this.save({
      version: 1,
      embeddingModel: embeddings ? this.embeddingModel : undefined,
      chunks,
    }, signal);
    return { files: files.length, chunks: chunks.length, embeddings, ...(embeddingError ? { embeddingError } : {}) };
  }

  async search(query: string, limit = 4, useEmbeddings = true, signal?: AbortSignal): Promise<RagMatch[]> {
    signal?.throwIfAborted();
    const index = await this.load();
    if (!index.chunks.length) return [];
    let queryEmbedding: number[] | undefined;
    if (useEmbeddings && this.embeddingClient && index.chunks.some((chunk) => chunk.embedding)) {
      try {
        const response = await this.embeddingClient.embeddings.create({
          model: index.embeddingModel ?? this.embeddingModel,
          input: query,
        }, { signal });
        queryEmbedding = response.data[0]?.embedding;
      } catch (error) {
        signal?.throwIfAborted();
        void error;
        queryEmbedding = undefined;
      }
    }
    return index.chunks
      .map((chunk) => ({
        source: chunk.source,
        content: chunk.content,
        score: queryEmbedding && chunk.embedding
          ? cosine(queryEmbedding, chunk.embedding) * 0.85 + textScore(query, chunk.content) * 0.15
          : textScore(query, chunk.content),
      }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  createTools() {
    return [
      tool({
        name: 'search_knowledge',
        description: '从本地知识库检索与问题相关的文档片段，并返回来源。',
        parameters: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(4) }),
        execute: async ({ query, limit }, _context, details) => this.search(query, limit, true, details?.signal),
      }),
      tool({
        name: 'index_knowledge',
        description: '索引工作区中的 Markdown 或文本知识库目录。',
        parameters: z.object({ path: z.string().default('knowledge') }),
        execute: async ({ path: target }, _context, details) => this.index(target, details?.signal),
      }),
    ];
  }

  private async load(): Promise<RagIndex> {
    return this.state.read();
  }

  private async save(index: RagIndex, signal?: AbortSignal): Promise<void> {
    await this.state.replace(index, signal);
  }

  private async textFiles(target: string, signal?: AbortSignal): Promise<Array<{ path: string; bytes: number }>> {
    const files: Array<{ path: string; bytes: number }> = [];
    let totalBytes = 0;
    const visit = async (current: string): Promise<void> => {
      signal?.throwIfAborted();
      if (await this.isProtected(current)) return;
      if (!this.allowOutsideWorkspace && !await this.isWithinWorkspace(current)) {
        throw new Error('知识索引路径不能通过符号链接超出当前工作区');
      }
      const info = await stat(current);
      if (info.isFile()) {
        if (!/\.(md|txt)$/i.test(current)) return;
        if (info.size > this.limits.maxFileBytes) {
          throw new Error(`知识文件 ${path.basename(current)} 单文件超过 ${this.limits.maxFileBytes} 字节`);
        }
        totalBytes += info.size;
        if (totalBytes > this.limits.maxTotalBytes) {
          throw new Error(`知识库文本总量超过 ${this.limits.maxTotalBytes} 字节，请缩小索引目录`);
        }
        files.push({ path: current, bytes: info.size });
        if (files.length > this.limits.maxFiles) {
          throw new Error(`知识库文件超过 ${this.limits.maxFiles} 个，请缩小索引目录`);
        }
        return;
      }
      if (!info.isDirectory()) return;
      for (const entry of await readdir(current, { withFileTypes: true })) {
        signal?.throwIfAborted();
        // Directory trees are deterministic and cannot escape through nested links.
        if (entry.isSymbolicLink()) continue;
        await visit(path.join(current, entry.name));
      }
    };
    await visit(target);
    return files;
  }

  private async isProtected(target: string): Promise<boolean> {
    const candidates = [path.resolve(target)];
    try {
      candidates.push(await realpath(target));
    } catch {
      // Use the lexical path for non-existing targets.
    }
    const roots = await Promise.all(this.protectedRoots.map(async (root) => {
      try {
        return [path.resolve(root), await realpath(root)];
      } catch {
        return [path.resolve(root)];
      }
    }));
    return roots.flat().some((root) => candidates.some((candidate) => {
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }));
  }

  private async isWithinWorkspace(target: string): Promise<boolean> {
    const workspace = path.resolve(this.workspaceRoot);
    const lexicalTarget = path.resolve(target);
    const lexicalRelative = path.relative(workspace, lexicalTarget);
    if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) return false;
    try {
      const [canonicalWorkspace, canonicalTarget] = await Promise.all([
        realpath(workspace),
        realpath(lexicalTarget),
      ]);
      const relative = path.relative(canonicalWorkspace, canonicalTarget);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch (error) {
      // Missing targets are reported by stat; other canonicalization failures close the boundary.
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
}
