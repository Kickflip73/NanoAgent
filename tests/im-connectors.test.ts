import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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
      const timer = setTimeout(() => reject(new Error('connector response timed out')), 3_000);
      waiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  };
}

async function nextOfType(
  next: () => Promise<Record<string, unknown>>,
  type: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const value = await next();
    if (value.type === type) return value;
  }
  throw new Error(`connector did not emit ${type}`);
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function stop(child: ChildProcessWithoutNullStreams, server: Server): Promise<void> {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function openWebSocket(url: string, authorization?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, authorization ? { headers: { authorization } } : undefined);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket open timed out'));
    }, 3_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`WebSocket rejected with ${response.statusCode}`));
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function rejectedWebSocket(url: string, expectedStatus: number, authorization?: string): Promise<void> {
  await assert.rejects(openWebSocket(url, authorization), new RegExp(`rejected with ${expectedStatus}`));
}

async function closeWebSocket(ws: WebSocket): Promise<number> {
  if (ws.readyState === WebSocket.CLOSED) return 1006;
  return new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(1006);
    }, 3_000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else ws.terminate();
  });
}

test('Daxiang connector verifies official API credentials before reporting outbound ready', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    requests.push({ url: request.url ?? '', body, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/open/api/token/get'
      ? { code: 0, data: { accessToken: 'fixture-token', expiresIn: 7200 } }
      : { code: 0, data: { messageId: 'message-1' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/connectors/daxiang-connector.mjs');
  const child = spawn(process.execPath, [script], {
    env: {
      DX_APP_KEY: 'app-key', DX_APP_SECRET: 'app-secret', DX_ROBOT_ID: 'robot-1',
      DX_ENV: 'prod', DX_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = outputReader(child);
  try {
    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'health-1', action: 'health_check', target: 'connection', payload: {},
    })}\n`);
    assert.deepEqual(await nextOfType(next, 'action_result'), {
      type: 'action_result', id: 'health-1', ok: true,
      result: {
        connected: true, environment: 'prod', outbound: true,
        inbound: 'requires-published-event-subscription-relay',
      },
    });
    assert.equal(requests[0]?.url, '/open/api/token/get');
    assert.deepEqual(requests[0]?.body, { appKey: 'app-key', appSecret: 'app-secret' });

    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'send-1', action: 'send_message', target: 'single:owner', payload: { text: 'hello' },
    })}\n`);
    assert.deepEqual(await nextOfType(next, 'action_result'), {
      type: 'action_result', id: 'send-1', ok: true, result: { sent: true },
    });
    assert.equal(requests[1]?.url, '/open/api/message/robot/send/single');
    assert.equal(requests[1]?.authorization, 'Bearer fixture-token');
    assert.deepEqual(requests[1]?.body, {
      robotId: 'robot-1', userId: 'owner', content: 'hello', contentType: 'text',
    });
  } finally {
    await stop(child, server);
  }
});

test('QQ connector accepts desktop OneBot settings and distinguishes HTTP from WebSocket readiness', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    requests.push({
      url: request.url ?? '', body: await requestBody(request), authorization: request.headers.authorization,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/connectors/qq-napcat-connector.mjs');
  const child = spawn(process.execPath, [script], {
    env: {
      QQ_ONEBOT_HTTP_URL: `http://127.0.0.1:${address.port}`,
      QQ_ONEBOT_WS_PORT: '0',
      QQ_ONEBOT_ACCESS_TOKEN: 'fixture-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = outputReader(child);
  try {
    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'health-qq', action: 'health_check', target: 'connection', payload: {},
    })}\n`);
    assert.deepEqual(await nextOfType(next, 'action_result'), {
      type: 'action_result', id: 'health-qq', ok: true,
      result: { connected: true, inbound: false, status: { online: true, good: true } },
    });
    assert.deepEqual(requests, [{ url: '/get_status', body: {}, authorization: 'Bearer fixture-token' }]);
  } finally {
    await stop(child, server);
  }
});

test('QQ connector exposes bounded background directory, history, and string-id send actions', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const body = await requestBody(request);
    const url = request.url ?? '';
    requests.push({ url, body });
    const data = url === '/get_recent_contact'
      ? [{ peerUin: '9007199254740993', remark: 'Owner', chatType: 1, msgTime: '123', lastestMsg: {
        message_id: 'recent-1', time: 1_700_000_000,
        message: [{ type: 'text', data: { text: 'recent' } }, { type: 'image', data: {} }],
      } }]
      : url === '/get_friend_list'
        ? [{ user_id: '9007199254740993', nickname: 'Owner', remark: 'Me' }]
        : url === '/get_group_list'
          ? [{ group_id: '9007199254740994', group_name: 'Group', member_count: 2, max_member_count: 200 }]
          : url === '/get_friend_msg_history' || url === '/get_group_msg_history'
            ? { messages: [{
              message_id: 'history-1', time: 1_700_000_001, message_type: 'private', user_id: '9007199254740993',
              sender: { nickname: 'Owner' },
              message: [{ type: 'text', data: { text: 'hello' } }, { type: 'file', data: { name: 'a.txt' } }],
            }] }
            : url === '/send_private_msg' ? { message_id: 'sent-1' } : {};
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/connectors/qq-napcat-connector.mjs');
  const child = spawn(process.execPath, [script], {
    env: {
      NC_HTTP_URL: `http://127.0.0.1:${address.port}`, NC_WS_PORT: '0', NC_ACCESS_TOKEN: 'fixture-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = outputReader(child);
  const invoke = async (id: string, action: string, target: string, payload: object) => {
    child.stdin.write(`${JSON.stringify({ type: 'action', id, action, target, payload })}\n`);
    return await nextOfType(next, 'action_result');
  };
  try {
    const recent = await invoke('recent', 'recent_conversations', 'all', { count: 1 });
    assert.equal(recent.ok, true);
    const conversations = (recent.result as { conversations: Array<Record<string, unknown>> }).conversations;
    assert.equal(conversations[0]?.id, '9007199254740993');
    assert.equal((conversations[0]?.latestMessage as Record<string, unknown>).text, 'recent[image]');

    const friends = await invoke('friends', 'list_friends', 'all', { limit: 1 });
    assert.deepEqual(friends.result, {
      friends: [{ userId: '9007199254740993', nickname: 'Owner', remark: 'Me' }],
    });
    const groups = await invoke('groups', 'list_groups', 'all', { limit: 1 });
    assert.deepEqual(groups.result, {
      groups: [{ groupId: '9007199254740994', name: 'Group', memberCount: 2, maxMemberCount: 200 }],
    });

    const friendHistory = await invoke('friend-history', 'friend_history', 'private:9007199254740993', {
      count: 5, messageSeq: '42', reverseOrder: true,
    });
    assert.equal(((friendHistory.result as { messages: Array<Record<string, unknown>> }).messages[0]?.text), 'hello[file:a.txt]');
    const groupHistory = await invoke('group-history', 'group_history', 'group:9007199254740994', { count: 3 });
    assert.equal((groupHistory.result as { messages: unknown[] }).messages.length, 1);

    const sent = await invoke('send', 'send_message', 'private:9007199254740993', { text: 'background only' });
    assert.deepEqual(sent.result, { sent: true, messageId: 'sent-1' });
    assert.deepEqual(requests.find((request) => request.url === '/send_private_msg')?.body, {
      user_id: '9007199254740993', message: 'background only',
    });
    assert.deepEqual(requests.find((request) => request.url === '/get_friend_msg_history')?.body, {
      user_id: '9007199254740993', message_seq: '42', count: 5, reverseOrder: true,
    });
    assert.deepEqual(requests.find((request) => request.url === '/get_group_msg_history')?.body, {
      group_id: '9007199254740994', count: 3,
    });

    const beforeInvalid = requests.length;
    const invalid = await invoke('invalid', 'friend_history', 'private:12345', { count: 101 });
    assert.equal(invalid.ok, false);
    assert.match(String(invalid.error), /count must be an integer between 1 and 100/);
    assert.equal(requests.length, beforeInvalid);
  } finally {
    await stop(child, server);
  }
});

test('QQ connector marks a lost send confirmation uncertain instead of retryable', async () => {
  let sends = 0;
  const server = createServer(async (request, response) => {
    await requestBody(request);
    if (request.url === '/send_private_msg') {
      sends += 1;
      response.destroy();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/connectors/qq-napcat-connector.mjs');
  const child = spawn(process.execPath, [script], {
    env: { NC_HTTP_URL: `http://127.0.0.1:${address.port}`, NC_WS_PORT: '0', NC_ACCESS_TOKEN: 'fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = outputReader(child);
  try {
    child.stdin.write(`${JSON.stringify({
      type: 'deliver', id: 'uncertain-delivery', target: 'private:12345', payload: { text: 'send once' },
    })}\n`);
    const delivery = await nextOfType(next, 'delivery_ack');
    assert.equal(delivery.ok, false);
    assert.equal(delivery.uncertain, true);

    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'uncertain-action', action: 'send_message',
      target: 'private:12345', payload: { text: 'send once through action' },
    })}\n`);
    const action = await nextOfType(next, 'action_result');
    assert.equal(action.ok, false);
    assert.equal(action.uncertain, true);
    assert.equal(sends, 2);
  } finally {
    await stop(child, server);
  }
});

test('QQ connector requires an authenticated reverse WebSocket', async () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/connectors/qq-napcat-connector.mjs');
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      NC_HTTP_URL: 'http://127.0.0.1:1', NC_WS_PORT: '3080', NC_ACCESS_TOKEN: '', NC_WS_ACCESS_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /missing QQ_ONEBOT_WS_ACCESS_TOKEN/);
});

test('QQ connector authenticates one upstream, keeps HTTP credentials separate, and survives oversized input', async () => {
  const requests: Array<{ url: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    await requestBody(request);
    requests.push({ url: request.url ?? '', authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { online: true, good: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const wsPort = await freePort();
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/connectors/qq-napcat-connector.mjs');
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      NC_HTTP_URL: `http://127.0.0.1:${address.port}`,
      NC_WS_PORT: String(wsPort),
      NC_ACCESS_TOKEN: 'http-token',
      NC_WS_ACCESS_TOKEN: 'ws-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = outputReader(child);
  const baseUrl = `ws://127.0.0.1:${wsPort}/`;
  try {
    assert.deepEqual(await nextOfType(next, 'status'), {
      type: 'status', inbound: 'unavailable', outbound: 'unknown', deliveryConfirmed: true,
    });

    await rejectedWebSocket(baseUrl, 401);
    await rejectedWebSocket(baseUrl, 401, 'Bearer wrong-token');
    await rejectedWebSocket(`${baseUrl}?access_token=wrong-token`, 401, 'Bearer ws-token');

    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'health-before', action: 'health_check', target: 'connection', payload: {},
    })}\n`);
    assert.deepEqual(await nextOfType(next, 'action_result'), {
      type: 'action_result', id: 'health-before', ok: true,
      result: { connected: true, inbound: false, status: { online: true, good: true } },
    });

    const first = await openWebSocket(`${baseUrl}?access_token=ws-token`);
    assert.equal((await nextOfType(next, 'status')).inbound, 'ready');
    first.send(JSON.stringify({
      time: 1_699_999_999,
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
    }));
    first.send(JSON.stringify({
      time: 1_700_000_000,
      post_type: 'message',
      message_type: 'private',
      message_id: 42,
      user_id: 12345,
      message: '你好 Mimi',
      sender: { nickname: 'Owner' },
    }));
    const event = await nextOfType(next, 'event');
    assert.equal(event.externalId, 'qq-msg-42');
    assert.equal(event.kind, 'command');
    assert.deepEqual(event.payload, {
      messageId: '42',
      occurredAt: '2023-11-14T22:13:20.000Z',
      messageType: 'private',
      subType: '',
      userId: '12345',
      senderName: 'Owner',
      text: '你好 Mimi',
    });
    assert.equal(event.replyTarget, 'private:12345');

    await rejectedWebSocket(baseUrl, 409, 'Bearer ws-token');
    child.stdin.write(`${JSON.stringify({
      type: 'action', id: 'health-ready', action: 'health_check', target: 'connection', payload: {},
    })}\n`);
    assert.deepEqual(await nextOfType(next, 'action_result'), {
      type: 'action_result', id: 'health-ready', ok: true,
      result: { connected: true, inbound: true, status: { online: true, good: true } },
    });

    const oversizedClose = new Promise<number>((resolve) => first.once('close', resolve));
    first.send('x'.repeat(1024 * 1024 + 1));
    assert.equal(await oversizedClose, 1009);
    assert.equal((await nextOfType(next, 'status')).inbound, 'unavailable');
    assert.equal(child.exitCode, null);

    const second = await openWebSocket(baseUrl, 'Bearer ws-token');
    assert.equal((await nextOfType(next, 'status')).inbound, 'ready');
    await closeWebSocket(second);
    assert.equal((await nextOfType(next, 'status')).inbound, 'unavailable');

    assert.deepEqual(requests, [
      { url: '/get_status', authorization: 'Bearer http-token' },
      { url: '/get_status', authorization: 'Bearer http-token' },
    ]);
  } finally {
    await stop(child, server);
  }
});
