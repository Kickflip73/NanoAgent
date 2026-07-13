import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export class TraceStore {
  private readonly ready: Promise<void>;
  private readonly sizes = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {
    this.ready = mkdir(this.directory, { recursive: true }).then(() => undefined);
  }

  async record(sessionId: string, type: string, data: unknown = {}): Promise<void> {
    const event = { timestamp: new Date().toISOString(), sessionId, type, data };
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line);
    const operation = this.queue.then(async () => {
      await this.ready;
      const file = path.join(this.directory, `${sessionId}.jsonl`);
      let size = this.sizes.get(file);
      if (size === undefined) {
        size = await stat(file).then((value) => value.size).catch(() => 0);
      }
      if (size > 0 && size + bytes > this.maxBytes) {
        const rotated = path.join(this.directory, `${sessionId}.1.jsonl`);
        await rm(rotated, { force: true });
        await rename(file, rotated);
        size = 0;
      }
      await appendFile(file, line, 'utf8');
      this.sizes.set(file, size + bytes);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    await operation;
  }
}
