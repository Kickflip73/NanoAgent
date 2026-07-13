import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tool } from '@openai/agents';
import { z } from 'zod';

export type MemoryType = 'preference' | 'fact' | 'decision' | 'todo';

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  createdAt: string;
  updatedAt?: string;
  importance?: number;
  source?: 'user' | 'agent';
}

function terms(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[a-z0-9_]+|[\u3400-\u9fff]/g) ?? [];
  return new Set(words);
}

export function textScore(query: string, content: string): number {
  const wanted = terms(query);
  if (wanted.size === 0) return 0;
  const available = terms(content);
  let matches = 0;
  for (const term of wanted) if (available.has(term)) matches += 1;
  return matches / wanted.size;
}

export class MemoryStore {
  constructor(private readonly file: string) {}

  async remember(
    content: string,
    type: MemoryType,
    options: { importance?: number; source?: 'user' | 'agent' } = {},
  ): Promise<Memory> {
    const memories = await this.list();
    const duplicate = memories.find(
      (memory) => memory.content.toLowerCase() === content.trim().toLowerCase(),
    );
    if (duplicate) {
      duplicate.updatedAt = new Date().toISOString();
      duplicate.importance = Math.max(duplicate.importance ?? 3, options.importance ?? 3);
      await this.save(memories);
      return duplicate;
    }
    const memory: Memory = {
      id: randomUUID().slice(0, 8),
      type,
      content: content.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      importance: options.importance ?? 3,
      source: options.source ?? 'user',
    };
    memories.push(memory);
    await this.save(memories);
    return memory;
  }

  async list(): Promise<Memory[]> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Memory[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    return (await this.list())
      .map((memory) => ({ memory, lexical: textScore(query, memory.content) }))
      .filter(({ lexical }) => lexical > 0)
      .map(({ memory, lexical }) => ({
        memory,
        score: lexical * 0.9 + ((memory.importance ?? 3) / 5) * 0.1,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory }) => memory);
  }

  async forget(id: string): Promise<boolean> {
    const memories = await this.list();
    const next = memories.filter((memory) => memory.id !== id);
    if (next.length === memories.length) return false;
    await this.save(next);
    return true;
  }

  createTools() {
    return [
      tool({
        name: 'remember',
        description: '保存值得跨会话记住的用户偏好、事实、决策或待办。用户明确说“记住”时使用。',
        parameters: z.object({
          content: z.string().min(1),
          type: z.enum(['preference', 'fact', 'decision', 'todo']).default('fact'),
          importance: z.number().int().min(1).max(5).default(3),
        }),
        execute: async ({ content, type, importance }) => this.remember(content, type, { importance, source: 'user' }),
      }),
      tool({
        name: 'recall',
        description: '搜索长期记忆。',
        parameters: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }),
        execute: async ({ query, limit }) => this.search(query, limit),
      }),
      tool({
        name: 'list_memories',
        description: '列出全部长期记忆。',
        parameters: z.object({}),
        execute: async () => this.list(),
      }),
      tool({
        name: 'forget',
        description: '按 ID 删除一条长期记忆。',
        parameters: z.object({ id: z.string().min(1) }),
        execute: async ({ id }) => ({ removed: await this.forget(id) }),
      }),
    ];
  }

  private async save(memories: Memory[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(memories, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}
