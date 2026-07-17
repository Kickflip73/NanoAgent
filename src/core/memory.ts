import { randomUUID } from 'node:crypto';
import { tool } from '@openai/agents';
import { z } from 'zod';
import { AtomicJsonStore } from './state-file.js';
import { explicitlyForbidsMemory, explicitlyRequestsMemory } from './user-intent.js';

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
  sourceEventId?: string;
  sourceEventSource?: string;
  sourceTrust?: 'owner' | 'trusted' | 'external' | 'public' | 'system';
  sourceActor?: string;
  sourceConversation?: string;
  personId?: string;
  personName?: string;
  recordedAt?: string;
  confirmedAt?: string;
}

export interface MemoryToolContext {
  input: string;
  sessionId: string;
  eventId?: string;
  eventSource?: string;
  trust?: Memory['sourceTrust'];
  actor?: string;
  conversation?: string;
  personId?: string;
  personName?: string;
}

const MAX_MEMORIES = 1_000;
const MAX_MEMORY_CHARS = 2_000;

const memoryFileSchema = z.array(z.object({
  id: z.string(),
  type: z.enum(['preference', 'fact', 'decision', 'todo']),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  importance: z.number().optional(),
  source: z.enum(['user', 'agent']).optional(),
  sourceSessionId: z.string().optional(),
  sourceEventId: z.string().optional(),
  sourceEventSource: z.string().optional(),
  sourceTrust: z.enum(['owner', 'trusted', 'external', 'public', 'system']).optional(),
  sourceActor: z.string().optional(),
  sourceConversation: z.string().optional(),
  personId: z.string().optional(),
  personName: z.string().optional(),
  recordedAt: z.string().optional(),
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
    options: {
      importance?: number;
      source?: 'user' | 'agent';
      sourceSessionId?: string;
      sourceEventId?: string;
      sourceEventSource?: string;
      sourceTrust?: Memory['sourceTrust'];
      sourceActor?: string;
      sourceConversation?: string;
      personId?: string;
      personName?: string;
    } = {},
  ): Promise<Memory> {
    const normalized = content.trim();
    if (!normalized) throw new Error('长期记忆内容不能为空');
    if (normalized.length > MAX_MEMORY_CHARS) {
      throw new Error(`长期记忆内容不能超过 ${MAX_MEMORY_CHARS} 个字符`);
    }
    const provenance = {
      sourceSessionId: boundedMetadata(options.sourceSessionId, 100),
      sourceEventId: boundedMetadata(options.sourceEventId, 100),
      sourceEventSource: boundedMetadata(options.sourceEventSource, 200),
      sourceActor: boundedMetadata(options.sourceActor, 500),
      sourceConversation: boundedMetadata(options.sourceConversation, 500),
      personId: boundedMetadata(options.personId, 60),
      personName: boundedMetadata(options.personName, 100),
    };
    return this.state.update((memories) => {
      const duplicate = memories.find(
        (memory) => memory.content.toLowerCase() === normalized.toLowerCase(),
      );
      if (duplicate) {
        const timestamp = new Date().toISOString();
        duplicate.updatedAt = timestamp;
        duplicate.importance = Math.max(duplicate.importance ?? 3, options.importance ?? 3);
        if (options.source) duplicate.source = options.source;
        if (provenance.sourceSessionId) duplicate.sourceSessionId = provenance.sourceSessionId;
        if (provenance.sourceEventId) duplicate.sourceEventId = provenance.sourceEventId;
        if (provenance.sourceEventSource) duplicate.sourceEventSource = provenance.sourceEventSource;
        if (options.sourceTrust) duplicate.sourceTrust = options.sourceTrust;
        if (provenance.sourceActor) duplicate.sourceActor = provenance.sourceActor;
        if (provenance.sourceConversation) duplicate.sourceConversation = provenance.sourceConversation;
        if (provenance.personId) duplicate.personId = provenance.personId;
        if (provenance.personName) duplicate.personName = provenance.personName;
        duplicate.recordedAt = timestamp;
        return duplicate;
      }
      if (memories.filter(isUsableMemory).length >= MAX_MEMORIES) {
        throw new Error(`长期记忆已达到 ${MAX_MEMORIES} 条上限，请先整理或删除旧记忆`);
      }
      const timestamp = new Date().toISOString();
      const memory: Memory = {
        id: randomUUID().slice(0, 8),
        type,
        content: normalized,
        createdAt: timestamp,
        updatedAt: timestamp,
        importance: options.importance ?? 3,
        source: options.source ?? 'agent',
        sourceSessionId: provenance.sourceSessionId,
        sourceEventId: provenance.sourceEventId,
        sourceEventSource: provenance.sourceEventSource,
        sourceTrust: options.sourceTrust,
        sourceActor: provenance.sourceActor,
        sourceConversation: provenance.sourceConversation,
        personId: provenance.personId,
        personName: provenance.personName,
        recordedAt: timestamp,
      };
      memories.push(memory);
      return memory;
    });
  }

  async list(): Promise<Memory[]> {
    return this.state.read();
  }

  async search(query: string, limit = 5): Promise<Memory[]> {
    return (await this.listUsable())
      .map((memory) => ({ memory, lexical: textScore(query, memorySearchText(memory)) }))
      .filter(({ lexical }) => lexical > 0)
      .map(({ memory, lexical }) => ({
        memory,
        score: lexical * 0.9 + ((memory.importance ?? 3) / 5) * 0.1,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory }) => memory);
  }

  async listUsable(): Promise<Memory[]> {
    return (await this.list()).filter(isUsableMemory);
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
        description: '主动保存未来仍有价值的 owner 偏好、稳定事实、决策或承诺，无需逐次询问确认。不要保存瞬时信息、未经验证的外部陈述、密码或密钥；owner 明确说不要记住时禁止调用。',
        parameters: z.object({
          content: z.string().trim().min(1).max(MAX_MEMORY_CHARS),
          type: z.enum(['preference', 'fact', 'decision', 'todo']).default('fact'),
          importance: z.number().int().min(1).max(5).default(3),
        }),
        execute: async ({ content, type, importance }) => {
          const request = context?.();
          if (request && explicitlyForbidsMemory(request.input)) {
            throw new Error('长期记忆未写入：owner 本轮明确要求不要保存');
          }
          return this.remember(content, type, {
            importance,
            source: request && explicitlyRequestsMemory(request.input) ? 'user' : 'agent',
            sourceSessionId: request?.sessionId,
            sourceEventId: request?.eventId,
            sourceEventSource: request?.eventSource,
            sourceTrust: request?.trust,
            sourceActor: request?.actor,
            sourceConversation: request?.conversation,
            personId: request?.personId,
            personName: request?.personName,
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
        description: '列出可跨 Session 使用的长期记忆及其来源。',
        parameters: z.object({}),
        execute: async () => this.listUsable(),
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

function isUsableMemory(memory: Memory): boolean {
  return Boolean(memory.recordedAt || memory.confirmedAt);
}

function memorySearchText(memory: Memory): string {
  return [
    memory.content,
    memory.personId,
    memory.personName,
    memory.sourceActor,
    memory.sourceConversation,
    memory.sourceEventSource,
  ].filter(Boolean).join(' ');
}

function boundedMetadata(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}
