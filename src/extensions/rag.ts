import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@openai/agents';
import type OpenAI from 'openai';
import { z } from 'zod';
import { textScore } from '../core/memory.js';

interface RagChunk {
  id: string;
  source: string;
  content: string;
  embedding?: number[];
}

interface RagIndex {
  version: 1;
  embeddingModel?: string;
  chunks: RagChunk[];
}

export interface RagMatch {
  source: string;
  content: string;
  score: number;
}

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

  constructor(
    private readonly workspaceRoot: string,
    private readonly indexFile: string,
    private readonly embeddingClient?: OpenAI,
  ) {
    this.embeddingModel = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
  }

  async index(target = 'knowledge'): Promise<{ files: number; chunks: number; embeddings: boolean; embeddingError?: string }> {
    const root = path.resolve(this.workspaceRoot, target);
    const files = await this.textFiles(root);
    const chunks: RagChunk[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      chunkText(content).forEach((text, index) => {
        chunks.push({
          id: `${path.relative(root, file)}:${index}`,
          source: path.relative(this.workspaceRoot, file),
          content: text,
        });
      });
    }
    let embeddingError: string | undefined;
    if (this.embeddingClient && chunks.length) {
      try {
        for (let start = 0; start < chunks.length; start += 64) {
          const batch = chunks.slice(start, start + 64);
          const response = await this.embeddingClient.embeddings.create({
            model: this.embeddingModel,
            input: batch.map((chunk) => chunk.content),
          });
          response.data.forEach((item, index) => {
            batch[index]!.embedding = item.embedding;
          });
        }
      } catch (error) {
        embeddingError = error instanceof Error ? error.message : String(error);
        chunks.forEach((chunk) => delete chunk.embedding);
      }
    }
    const embeddings = chunks.length > 0 && chunks.every((chunk) => chunk.embedding);
    await this.save({
      version: 1,
      embeddingModel: embeddings ? this.embeddingModel : undefined,
      chunks,
    });
    return { files: files.length, chunks: chunks.length, embeddings, ...(embeddingError ? { embeddingError } : {}) };
  }

  async search(query: string, limit = 4): Promise<RagMatch[]> {
    const index = await this.load();
    if (!index.chunks.length) return [];
    let queryEmbedding: number[] | undefined;
    if (this.embeddingClient && index.chunks.some((chunk) => chunk.embedding)) {
      try {
        const response = await this.embeddingClient.embeddings.create({
          model: index.embeddingModel ?? this.embeddingModel,
          input: query,
        });
        queryEmbedding = response.data[0]?.embedding;
      } catch {
        queryEmbedding = undefined;
      }
    }
    return index.chunks
      .map((chunk) => ({
        source: chunk.source,
        content: chunk.content,
        score: queryEmbedding && chunk.embedding
          ? cosine(queryEmbedding, chunk.embedding)
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
        execute: async ({ query, limit }) => this.search(query, limit),
      }),
      tool({
        name: 'index_knowledge',
        description: '索引工作区中的 Markdown 或文本知识库目录。',
        parameters: z.object({ path: z.string().default('knowledge') }),
        execute: async ({ path: target }) => this.index(target),
      }),
    ];
  }

  private async load(): Promise<RagIndex> {
    try {
      return JSON.parse(await readFile(this.indexFile, 'utf8')) as RagIndex;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, chunks: [] };
      throw error;
    }
  }

  private async save(index: RagIndex): Promise<void> {
    await mkdir(path.dirname(this.indexFile), { recursive: true });
    const temporary = `${this.indexFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(index)}\n`, 'utf8');
    await rename(temporary, this.indexFile);
  }

  private async textFiles(target: string): Promise<string[]> {
    const info = await stat(target);
    if (info.isFile()) return /\.(md|txt)$/i.test(target) ? [target] : [];
    const files: string[] = [];
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) files.push(...await this.textFiles(child));
      else if (/\.(md|txt)$/i.test(entry.name)) files.push(child);
    }
    return files;
  }
}
