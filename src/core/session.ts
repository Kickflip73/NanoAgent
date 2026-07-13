import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentInputItem, Session } from '@openai/agents';

interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  items: AgentInputItem[];
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error('会话 ID 只能包含字母、数字、下划线和连字符');
  }
  return id;
}

export class FileSession implements Session {
  private readonly file: string;

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
    await this.save(await this.load());
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = (await this.load()).items;
    return limit === undefined ? items : items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const session = await this.load();
    session.items.push(...items);
    session.updatedAt = new Date().toISOString();
    await this.save(session);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const session = await this.load();
    const item = session.items.pop();
    session.updatedAt = new Date().toISOString();
    await this.save(session);
    return item;
  }

  async clearSession(): Promise<void> {
    const session = await this.load();
    session.items = [];
    session.updatedAt = new Date().toISOString();
    await this.save(session);
  }

  async cleanupGeneratedSummaries(): Promise<number> {
    const session = await this.load();
    const items = session.items.filter((item) => {
      if (!('role' in item) || item.role !== 'user' || !('content' in item)) return true;
      return typeof item.content !== 'string' || !item.content.startsWith('[更早的会话历史已压缩为摘要');
    });
    const removed = session.items.length - items.length;
    if (removed > 0) {
      session.items = items;
      session.updatedAt = new Date().toISOString();
      await this.save(session);
    }
    return removed;
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

  private async load(): Promise<SessionFile> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as SessionFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const now = new Date().toISOString();
      return { id: this.id, createdAt: now, updatedAt: now, items: [] };
    }
  }

  private async save(session: SessionFile): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}
