import { randomUUID, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { MimiStore } from './store.js';

const bodySchema = z.object({
  externalId: z.string().min(1).max(500),
  channel: z.string().regex(/^[a-zA-Z0-9._-]+$/).max(100).default('generic'),
  kind: z.enum(['command', 'alert', 'ambient', 'webhook']).default('webhook'),
  payload: z.unknown(),
  occurredAt: z.string().optional(),
  priority: z.number().int().min(0).max(100).default(50),
  actor: z.object({ id: z.string().min(1).max(500), displayName: z.string().max(500).optional() }).optional(),
  conversation: z.object({ id: z.string().min(1).max(500), threadId: z.string().max(500).optional() }).optional(),
  reply: z.object({
    connector: z.string().regex(/^[a-zA-Z0-9._-]+$/).min(1).max(100),
    target: z.string().trim().min(1).max(500),
  }).strict().optional(),
  notify: z.boolean().default(true),
}).strict();

function response(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > 1024 * 1024) throw new Error('Webhook body 超过 1MB');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error('Webhook body 超过 1MB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export class MimiWebhookServer {
  private server?: Server;
  private readonly acceptedAt: number[] = [];

  constructor(
    private readonly store: MimiStore,
    private readonly port: number,
    private readonly token: string,
  ) {
    if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('MIMI_WEBHOOK_PORT 必须在 1～65535 之间');
    if (token.length < 24) throw new Error('MIMI_WEBHOOK_TOKEN 至少需要 24 个字符');
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  get address(): string | undefined {
    const value = this.server?.address();
    return value && typeof value === 'object' ? `http://127.0.0.1:${value.port}` : undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        response(res, 200, { ok: true });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/events') {
        response(res, 404, { error: 'not found' });
        return;
      }
      if (!authorized(req.headers.authorization, this.token)) {
        response(res, 401, { error: 'unauthorized' });
        return;
      }
      if (!this.takeRateLimit()) {
        response(res, 429, { error: 'rate limit exceeded' });
        return;
      }
      const body = bodySchema.parse(await readBody(req));
      const now = new Date().toISOString();
      const occurredAt = body.occurredAt && Number.isFinite(Date.parse(body.occurredAt))
        ? new Date(body.occurredAt).toISOString()
        : now;
      const result = this.store.ingestEvent({
        id: randomUUID(),
        externalId: body.externalId,
        source: `webhook:${body.channel}`,
        kind: body.kind,
        trust: 'external',
        actor: body.actor,
        conversation: body.conversation,
        payload: body.payload,
        occurredAt,
        receivedAt: now,
        priority: body.priority,
        profileId: 'owner',
        replyRoute: body.reply
          ? { channel: `connector:${body.reply.connector}`, target: body.reply.target }
          : body.notify ? { channel: 'system' } : undefined,
      });
      response(res, 202, {
        id: result.event.id,
        taskId: result.task?.id,
        inserted: result.inserted,
        decision: result.task ? 'task_created' : 'digest',
      });
    } catch (error) {
      response(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private takeRateLimit(): boolean {
    const now = Date.now();
    while (this.acceptedAt.length && this.acceptedAt[0]! < now - 60_000) this.acceptedAt.shift();
    if (this.acceptedAt.length >= 60) return false;
    this.acceptedAt.push(now);
    return true;
  }
}
