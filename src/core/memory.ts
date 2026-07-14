import { randomUUID } from 'node:crypto';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { AtomicJsonStore } from './state-file.js';
import { explicitlyRequestsMemory } from './user-intent.js';

export { explicitlyRequestsMemory } from './user-intent.js';

export type MemoryType = 'preference' | 'fact' | 'decision' | 'todo';

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  createdAt: string;
  updatedAt?: string;
  importance?: number;
  source?: 'user' | 'agent';
  sourceSessionId?: string;
  confirmedAt?: string;
}

export interface MemoryToolContext {
  input: string;
  sessionId: string;
}

const memoryFileSchema = z.array(z.object({
  id: z.string(),
  type: z.enum(['preference', 'fact', 'decision', 'todo']),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  importance: z.number().optional(),
  source: z.enum(['user', 'agent']).optional(),
  sourceSessionId: z.string().optional(),
  confirmedAt: z.string().optional(),
}));

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
  private readonly state: AtomicJsonStore<Memory[]>;

  constructor(file: string) {
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => [],
      decode: (value) => memoryFileSchema.parse(value),
      recoverCorrupt: true,
    });
  }

  async remember(
    content: string,
    type: MemoryType,
    options: { importance?: number; source?: 'user' | 'agent'; sourceSessionId?: string; confirmed?: boolean } = {},
  ): Promise<Memory> {
    if (options.confirmed !== true) {
      throw new Error('长期记忆未写入：缺少用户明确确认');
    }
    return this.state.update((memories) => {
      const duplicate = memories.find(
        (memory) => memory.content.toLowerCase() === content.trim().toLowerCase(),
      );
      if (duplicate) {
        duplicate.updatedAt = new Date().toISOString();
        duplicate.importance = Math.max(duplicate.importance ?? 3, options.importance ?? 3);
        if (options.sourceSessionId) duplicate.sourceSessionId = options.sourceSessionId;
        duplicate.confirmedAt = new Date().toISOString();
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
        sourceSessionId: options.sourceSessionId,
        confirmedAt: new Date().toISOString(),
      };
      memories.push(memory);
      return memory;
    });
  }

  async list(): Promise<Memory[]> {
    return this.state.read();
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    return (await this.listConfirmed())
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

  async listConfirmed(): Promise<Memory[]> {
    return (await this.list()).filter((memory) => Boolean(memory.confirmedAt));
  }

  async forget(id: string): Promise<boolean> {
    return this.state.update((memories) => {
      const index = memories.findIndex((memory) => memory.id === id);
      if (index < 0) return false;
      memories.splice(index, 1);
      return true;
    });
  }

  createTools(context?: () => MemoryToolContext | undefined) {
    return [
      tool({
        name: 'remember',
        description: '把用户明确确认要跨 Session 共享的信息保存为长期记忆。没有“记住/保存为长期记忆”等明确请求时禁止调用。',
        parameters: z.object({
          content: z.string().min(1),
          type: z.enum(['preference', 'fact', 'decision', 'todo']).default('fact'),
          importance: z.number().int().min(1).max(5).default(3),
        }),
        execute: async ({ content, type, importance }) => {
          const request = context?.();
          if (!request || !explicitlyRequestsMemory(request.input)) {
            throw new Error('长期记忆未写入：本轮用户没有明确确认要跨 Session 保存');
          }
          return this.remember(content, type, {
            importance,
            source: 'user',
            sourceSessionId: request.sessionId,
            confirmed: true,
          });
        },
      }),
      tool({
        name: 'recall',
        description: '搜索长期记忆。',
        parameters: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }),
        execute: async ({ query, limit }) => this.search(query, limit),
      }),
      tool({
        name: 'list_memories',
        description: '列出已由用户确认、可跨 Session 共享的长期记忆。',
        parameters: z.object({}),
        execute: async () => this.listConfirmed(),
      }),
      tool({
        name: 'forget',
        description: '按 ID 删除一条长期记忆。',
        parameters: z.object({ id: z.string().min(1) }),
        execute: async ({ id }) => ({ removed: await this.forget(id) }),
      }),
    ];
  }
}
