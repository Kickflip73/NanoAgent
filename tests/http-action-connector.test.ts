import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/connectors/http-action-connector.mjs');

function outputReader(child: ChildProcessWithoutNullStreams): () => Promise<Record<string, unknown>> {
  let buffer = '';
  const values: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const value = JSON.parse(line) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else values.push(value);
    }
  });
  return () => {
    const value = values.shift();
    if (value) return Promise.resolve(value);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connector response timed out')), 2_000);
      waiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  };
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timed out');
}

test('generic HTTP action connector pulls cursor events and forwards deliveries and actions with stable idempotency keys', async () => {
  const requests: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
  const eventRequests: Array<{ url: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      eventRequests.push({ url: request.url ?? '', authorization: request.headers.authorization });
      const requestUrl = new URL(request.url ?? '/', 'http://relay.test');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(requestUrl.searchParams.get('cursor') ? {
        events: [], cursor: 'cursor-1',
      } : {
        events: [{
          externalId: 'wechat-message-1', kind: 'command', payload: { text: '帮我处理' },
          occurredAt: '2026-07-15T08:00:00+08:00', priority: 88,
          actor: { id: 'person-1', displayName: 'Alice', ignored: 'x' },
          conversation: { id: 'chat-7', threadId: 'thread-2', ignored: 'x' },
          replyTarget: 'wechat:chat-7', ignored: 'x',
        }],
        cursor: 'cursor-1',
      }));
      return;
    }
    const body = JSON.parse(await bodyOf(request)) as Record<string, unknown>;
    requests.push({ headers: request.headers, body });
    if (body.target === 'failure') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'remote unavailable' }));
      return;
    }
    if (body.target === 'oversized') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ result: { text: 'x'.repeat(2_000) } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: { accepted: true, target: body.target } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const child = spawn(process.execPath, [script], {
    env: {
      MIMI_HTTP_ACTION_URL: `http://127.0.0.1:${address.port}/mimi`,
      MIMI_HTTP_EVENT_URL: `http://127.0.0.1:${address.port}/events`,
      MIMI_HTTP_EVENT_POLL_INTERVAL_MS: '1000',
      MIMI_HTTP_ACTION_TOKEN: 'relay-secret',
      MIMI_HTTP_ACTION_MAX_RESPONSE_BYTES: '1024',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = outputReader(child);
  try {
    assert.deepEqual(await next(), {
      type: 'event', externalId: 'wechat-message-1', kind: 'command', payload: { text: '帮我处理' },
      occurredAt: '2026-07-15T00:00:00.000Z', priority: 88,
      actor: { id: 'person-1', displayName: 'Alice' },
      conversation: { id: 'chat-7', threadId: 'thread-2' },
      replyTarget: 'wechat:chat-7',
    });
    assert.equal(eventRequests[0]?.authorization, 'Bearer relay-secret');
    assert.match(eventRequests[0]?.url ?? '', /limit=100/);
    await waitUntil(() => eventRequests.length >= 2);
    assert.match(eventRequests[1]?.url ?? '', /cursor=cursor-1/);

    child.stdin.write(`${JSON.stringify({
      type: 'deliver', id: 'outbox-1', target: 'wechat:conversation-7', payload: { text: 'done' },
    })}\n`);
    assert.deepEqual(await next(), { type: 'delivery_ack', id: 'outbox-1', ok: true });
    assert.equal(requests[0]?.headers.authorization, 'Bearer relay-secret');
    assert.equal(requests[0]?.headers['idempotency-key'], 'outbox-1');
    assert.equal(requests[0]?.headers['x-mimi-message-type'], 'deliver');
    assert.deepEqual(requests[0]?.body, {
      version: 1, type: 'deliver', id: 'outbox-1', target: 'wechat:conversation-7', payload: { text: 'done' },
    });

    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'action-1', action: 'create_ticket', target: 'project-9', payload: { title: 'Fix it' },
    })}\n`);
    assert.deepEqual(await next(), {
      type: 'action_result', id: 'action-1', ok: true,
      result: { accepted: true, target: 'project-9' },
    });
    assert.equal(requests[1]?.headers['idempotency-key'], 'action-1');
    assert.deepEqual(requests[1]?.body, {
      version: 1, type: 'action', id: 'action-1', action: 'create_ticket',
      target: 'project-9', payload: { title: 'Fix it' },
    });

    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'action-2', action: 'request', target: 'failure', payload: {},
    })}\n`);
    assert.deepEqual(await next(), {
      type: 'action_result', id: 'action-2', ok: false, error: 'HTTP 503: remote unavailable',
    });

    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'action-3', action: 'request', target: 'oversized', payload: {},
    })}\n`);
    assert.deepEqual(await next(), {
      type: 'action_result', id: 'action-3', ok: false, error: 'HTTP response exceeds 1024 bytes',
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('generic HTTP event polling reports one outage and recovery while continuing to retry', async () => {
  let polls = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    polls += 1;
    if (polls === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'event source unavailable' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ events: [], cursor: 'recovered' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const child = spawn(process.execPath, [script], {
    env: {
      MIMI_HTTP_ACTION_URL: `http://127.0.0.1:${address.port}/actions`,
      MIMI_HTTP_EVENT_URL: `http://127.0.0.1:${address.port}/events`,
      MIMI_HTTP_EVENT_POLL_INTERVAL_MS: '1000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = outputReader(child);
  try {
    const offline = await next();
    assert.equal(offline.type, 'event');
    assert.equal(offline.kind, 'alert');
    assert.equal(offline.priority, 85);
    assert.match(String(offline.externalId), /^http-event-poll:\d+:offline$/);
    assert.deepEqual(offline.payload, {
      type: 'http_event_poll_health', state: 'offline', error: 'HTTP 503: event source unavailable',
    });

    const recovered = await next();
    assert.equal(recovered.type, 'event');
    assert.equal(recovered.priority, 65);
    assert.equal(recovered.externalId, String(offline.externalId).replace(/:offline$/, ':recovered'));
    assert.deepEqual(recovered.payload, { type: 'http_event_poll_health', state: 'recovered' });
    assert.equal(polls, 2);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('generic HTTP action connector rejects credentials over non-loopback plaintext HTTP', async () => {
  const child = spawn(process.execPath, [script], {
    env: { MIMI_HTTP_ACTION_URL: 'http://example.com/relay' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /HTTPS or loopback HTTP/);
});
