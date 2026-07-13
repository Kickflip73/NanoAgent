import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export class TraceStore {
  constructor(private readonly directory: string) {}

  async record(sessionId: string, type: string, data: unknown = {}): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const event = { timestamp: new Date().toISOString(), sessionId, type, data };
    await appendFile(path.join(this.directory, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
  }
}
