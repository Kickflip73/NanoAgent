import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentInputItem, Session } from '@openai/agents';

interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  items: AgentInputItem[];
}

export interface SessionSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  turns: number;
}

function messageText(item: AgentInputItem): string | undefined {
  if (!('role' in item) || item.role !== 'user' || !('content' in item)) return undefined;
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return undefined;
  return item.content
    .map((part) => typeof part === 'object' && part && 'text' in part ? String(part.text) : '')
    .join(' ');
}

function compactText(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').replace(/^\/+\S+\s*/, '').trim();
  if (!clean) return '新对话';
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function summarizeTitle(text: string): string {
  const clean = text
    .replace(/\s+/g, ' ')
    .replace(/^\/+\S+\s*/, '')
    .replace(/^(?:请|帮我|麻烦|我想要?|我希望|需要|必须|能否|你能不能)\s*/u, '')
    .split(/[，。！？；\n]/u)[0]
    ?.trim() ?? '';
  return compactText(clean, 32);
}

function summarizeSession(session: SessionFile): SessionSummary {
  const messages = session.items.map(messageText).filter((text): text is string => Boolean(text?.trim()));
  const meaningful = messages.filter((text) => !text.trim().startsWith('/'));
  const source = meaningful.length ? meaningful : messages;
  return {
    id: session.id,
    title: summarizeTitle(source[0] ?? ''),
    preview: compactText(source.at(-1) ?? '', 52),
    updatedAt: session.updatedAt,
    turns: messages.length,
  };
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('会话 ID 只能包含字母、数字、下划线和连字符');
  }
  return id;
}

export class FileSession implements Session {
  private readonly file: string;
  private cache?: SessionFile;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly id: string,
  ) {
    this.file = path.join(directory, `${safeId(id)}.json`);
  }

  async getSessionId(): Promise<string> {
    return this.id;
  }

  async ensure(): Promise<void> {
    await this.mutate(() => undefined);
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    await this.writeQueue;
    const items = (await this.load()).items;
    return limit === undefined ? [...items] : items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.mutate((session) => {
      session.items.push(...items);
      session.updatedAt = new Date().toISOString();
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.mutate((session) => {
      const item = session.items.pop();
      session.updatedAt = new Date().toISOString();
      return item;
    });
  }

  async clearSession(): Promise<void> {
    await this.mutate((session) => {
      session.items = [];
      session.updatedAt = new Date().toISOString();
    });
  }

  async summary(): Promise<SessionSummary> {
    await this.writeQueue;
    return summarizeSession(await this.load());
  }

  async cleanupGeneratedSummaries(): Promise<number> {
    return this.mutateWhen((session) => {
      const items = session.items.filter((item) => {
        if (!('role' in item) || item.role !== 'user' || !('content' in item)) return true;
        return typeof item.content !== 'string' || !item.content.startsWith('[更早的会话历史已压缩为摘要');
      });
      const removed = session.items.length - items.length;
      if (removed > 0) {
        session.items = items;
        session.updatedAt = new Date().toISOString();
      }
      return { result: removed, changed: removed > 0 };
    });
  }

  async repairToolPairs(): Promise<number> {
    return this.mutateWhen((session) => {
      const calls = new Set(session.items.flatMap((item) =>
        'type' in item && item.type === 'function_call' && 'callId' in item
          ? [String(item.callId)]
          : [],
      ));
      const results = new Set(session.items.flatMap((item) =>
        'type' in item && item.type === 'function_call_result' && 'callId' in item
          ? [String(item.callId)]
          : [],
      ));
      const items = session.items.filter((item) => {
        if (!('type' in item) || !('callId' in item)) return true;
        if (item.type === 'function_call') return results.has(String(item.callId));
        if (item.type === 'function_call_result') return calls.has(String(item.callId));
        return true;
      });
      const removed = session.items.length - items.length;
      if (removed) {
        session.items = items;
        session.updatedAt = new Date().toISOString();
      }
      return { result: removed, changed: removed > 0 };
    });
  }

  static async list(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  static async listSummaries(directory: string): Promise<SessionSummary[]> {
    const ids = await FileSession.list(directory);
    const summaries = await Promise.all(ids.map((id) => new FileSession(directory, id).summary()));
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  private async load(): Promise<SessionFile> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, 'utf8')) as SessionFile;
      return this.cache;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const now = new Date().toISOString();
      this.cache = { id: this.id, createdAt: now, updatedAt: now, items: [] };
      return this.cache;
    }
  }

  private mutate<T>(mutation: (session: SessionFile) => T): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const session = await this.load();
      const result = mutation(session);
      await this.save(session);
      return result;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private mutateWhen<T>(mutation: (session: SessionFile) => { result: T; changed: boolean }): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const session = await this.load();
      const { result, changed } = mutation(session);
      if (changed) await this.save(session);
      return result;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async save(session: SessionFile): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session)}\n`, 'utf8');
    await rename(temporary, this.file);
    this.cache = session;
  }
}
