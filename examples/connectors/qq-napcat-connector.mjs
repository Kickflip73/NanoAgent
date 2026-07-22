#!/usr/bin/env node

/**
 * MimiAgent ↔ QQ personal account connector (OneBot 11).
 *
 * This connector is background-only: inbound events arrive over an authenticated
 * reverse WebSocket and outbound/read actions use a loopback OneBot HTTP API.
 * It can connect either to a plugin hosted by the user's visible QQ process
 * (for example LLOneBot/LLBot) or to a separately managed NapCat process. It
 * never activates QQ.app or uses Accessibility/UI automation itself.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';
import { WebSocketServer } from 'ws';

const MAX_TEXT_CHARS = 20_000;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_HISTORY_COUNT = 20;
const MAX_HISTORY_COUNT = 100;
const MAX_DIRECTORY_COUNT = 500;
const HTTP_TIMEOUT_MS = 20_000;
const STATUS_POLL_MS = integerEnv(['QQ_ONEBOT_STATUS_POLL_MS', 'NC_STATUS_POLL_MS'], 30_000, 10_000, 600_000);

const HTTP_URL = parseHttpUrl(firstEnv('QQ_ONEBOT_HTTP_URL', 'NC_HTTP_URL'));
const WS_PORT = integerEnv(['QQ_ONEBOT_WS_PORT', 'NC_WS_PORT'], 3_080, 0, 65_535);
const ACCESS_TOKEN = firstEnv('QQ_ONEBOT_ACCESS_TOKEN', 'NC_ACCESS_TOKEN')?.trim() ?? '';
const WS_ACCESS_TOKEN = firstEnv('QQ_ONEBOT_WS_ACCESS_TOKEN', 'NC_WS_ACCESS_TOKEN')?.trim() || ACCESS_TOKEN;

if (!HTTP_URL) {
  process.stderr.write('[qq] missing or invalid QQ_ONEBOT_HTTP_URL (or legacy NC_HTTP_URL)\n');
  process.exit(1);
}
if (!WS_ACCESS_TOKEN) {
  process.stderr.write('[qq] missing QQ_ONEBOT_WS_ACCESS_TOKEN (or HTTP/legacy token fallback)\n');
  process.exit(1);
}

function firstEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function integerEnv(names, fallback, min, max) {
  const list = Array.isArray(names) ? names : [names];
  const raw = firstEnv(...list);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    process.stderr.write(`[qq] ${list[0]} must be an integer between ${min} and ${max}\n`);
    process.exit(1);
  }
  return value;
}

function parseHttpUrl(raw) {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      process.stderr.write('[qq] plain HTTP is only allowed for a loopback OneBot endpoint\n');
      return undefined;
    }
    return url.href.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

class UncertainSendError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UncertainSendError';
    this.uncertain = true;
  }
}

let inboundReadiness = 'unavailable';
let outboundReadiness = 'unknown';
let lastStatusKey = '';

function emitStatus(inbound = inboundReadiness, outbound = outboundReadiness, force = false) {
  inboundReadiness = inbound;
  outboundReadiness = outbound;
  const status = { type: 'status', inbound, outbound, deliveryConfirmed: true };
  const key = JSON.stringify(status);
  if (!force && key === lastStatusKey) return;
  lastStatusKey = key;
  emit(status);
}

function actionResult(id, ok, result, error, uncertain = false) {
  emit({
    type: 'action_result', id, ok, ...(ok ? { result } : {}),
    ...(error ? { error } : {}), ...(uncertain ? { uncertain: true } : {}),
  });
}

function deliveryAck(id, ok, error, uncertain = false) {
  emit({ type: 'delivery_ack', id, ok, ...(error ? { error } : {}), ...(uncertain ? { uncertain: true } : {}) });
}

async function onebotApi(action, params) {
  const headers = { 'content-type': 'application/json' };
  if (ACCESS_TOKEN) headers.authorization = `Bearer ${ACCESS_TOKEN}`;
  const response = await fetch(`${HTTP_URL}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error(`OneBot response exceeds ${MAX_HTTP_RESPONSE_BYTES} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_HTTP_RESPONSE_BYTES) {
    throw new Error(`OneBot response exceeds ${MAX_HTTP_RESPONSE_BYTES} bytes`);
  }
  if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error('OneBot returned invalid JSON');
  }
  if (body?.status !== 'ok' && body?.retcode !== 0) {
    throw new Error(String(body?.wording || body?.msg || body?.message || `retcode=${body?.retcode}`));
  }
  return body?.data;
}

function boundedString(value, limit = MAX_TEXT_CHARS) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function identifier(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d{1,32}$/.test(normalized)) throw new Error(`${label} must be a numeric string`);
  return normalized;
}

function parseConversationTarget(target, allowedTypes = ['private', 'group']) {
  if (typeof target !== 'string') throw new Error('target must be private:<qq> or group:<qq>');
  const separator = target.indexOf(':');
  if (separator < 1) throw new Error('target must be private:<qq> or group:<qq>');
  const type = target.slice(0, separator);
  if (!allowedTypes.includes(type)) throw new Error(`unsupported target type: ${type}`);
  const id = identifier(target.slice(separator + 1), `${type} id`);
  return { type, id };
}

function objectPayload(payload) {
  if (payload === undefined || payload === null) return {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be an object');
  }
  return payload;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function textPayload(payload) {
  const text = typeof payload === 'string'
    ? payload
    : payload && typeof payload.text === 'string' ? payload.text : '';
  const bounded = text.trim().slice(0, MAX_TEXT_CHARS);
  if (!bounded) throw new Error('message text is empty');
  return bounded;
}

function segmentText(segment) {
  if (!segment || typeof segment !== 'object') return '';
  const type = boundedString(segment.type, 40);
  const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
  if (type === 'text') return boundedString(data.text);
  if (type === 'at') return `[at:${boundedString(String(data.qq ?? ''), 64)}]`;
  if (type === 'reply') return `[reply:${boundedString(String(data.id ?? ''), 128)}]`;
  if (type === 'image') return '[image]';
  if (type === 'record') return '[voice]';
  if (type === 'video') return '[video]';
  if (type === 'file') return `[file:${boundedString(String(data.name ?? data.file ?? ''), 200)}]`;
  if (type === 'face') return `[face:${boundedString(String(data.id ?? ''), 64)}]`;
  return type ? `[${type}]` : '';
}

function normalizedMessageText(message, rawMessage) {
  const value = message ?? rawMessage;
  const text = Array.isArray(value)
    ? value.map(segmentText).join('')
    : boundedString(typeof value === 'string' ? value : '');
  return (text.trim() || '[non-text message]').slice(0, MAX_TEXT_CHARS);
}

function safeTimestamp(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1_000).toISOString()
    : undefined;
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'object') return { text: '[non-text message]' };
  const sender = message.sender && typeof message.sender === 'object' ? message.sender : {};
  return {
    messageId: boundedString(String(message.message_id ?? message.message_seq ?? ''), 128),
    ...(safeTimestamp(message.time) ? { occurredAt: safeTimestamp(message.time) } : {}),
    messageType: boundedString(message.message_type, 40),
    subType: boundedString(message.sub_type, 40),
    userId: boundedString(String(message.user_id ?? sender.user_id ?? ''), 64),
    ...(message.group_id !== undefined ? { groupId: boundedString(String(message.group_id), 64) } : {}),
    senderName: boundedString(sender.card || sender.nickname || message.sender_name || '', 200),
    text: normalizedMessageText(message.message, message.raw_message),
  };
}

function sanitizeHistory(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return { messages: messages.slice(0, MAX_HISTORY_COUNT).map(sanitizeMessage) };
}

function sanitizeRecentContacts(data, limit) {
  const values = Array.isArray(data) ? data : Array.isArray(data?.records) ? data.records : [];
  return {
    conversations: values.slice(0, limit).map((value) => ({
      id: boundedString(String(value?.peerUin ?? value?.peer_uid ?? ''), 64),
      name: boundedString(value?.remark || value?.peerName || value?.sendNickName || '', 200),
      chatType: boundedString(String(value?.chatType ?? ''), 40),
      messageTime: boundedString(String(value?.msgTime ?? ''), 80),
      latestMessage: sanitizeMessage(value?.lastestMsg || value?.latestMsg || {}),
    })),
  };
}

function sanitizeFriends(data, limit) {
  const values = Array.isArray(data) ? data : [];
  return {
    friends: values.slice(0, limit).map((value) => ({
      userId: boundedString(String(value?.user_id ?? value?.uin ?? value?.uid ?? ''), 64),
      nickname: boundedString(value?.nickname || value?.nick || '', 200),
      remark: boundedString(value?.remark || '', 200),
    })),
  };
}

function sanitizeGroups(data, limit) {
  const values = Array.isArray(data) ? data : [];
  return {
    groups: values.slice(0, limit).map((value) => ({
      groupId: boundedString(String(value?.group_id ?? value?.groupId ?? ''), 64),
      name: boundedString(value?.group_name || value?.groupName || '', 200),
      memberCount: Number.isFinite(Number(value?.member_count)) ? Number(value.member_count) : undefined,
      maxMemberCount: Number.isFinite(Number(value?.max_member_count)) ? Number(value.max_member_count) : undefined,
    })),
  };
}

async function deliver(message) {
  if (typeof message.id !== 'string') throw new Error('deliver requires id');
  const { type, id } = parseConversationTarget(message.target);
  const text = textPayload(message.payload);
  let data;
  try {
    data = await onebotApi(type === 'private' ? 'send_private_msg' : 'send_group_msg', {
      [type === 'private' ? 'user_id' : 'group_id']: id,
      message: text,
    });
  } catch (error) {
    throw new UncertainSendError(
      `OneBot 发送请求已提交但未获得可靠确认：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { sent: true, messageId: boundedString(String(data?.message_id ?? ''), 128) || undefined };
}

function connectedStatus(status) {
  return Boolean(status && status.online === true && status.good !== false);
}

async function healthCheck() {
  const status = await onebotApi('get_status', {});
  const connected = connectedStatus(status);
  emitStatus(activeSocket?.readyState === 1 ? 'ready' : 'unavailable', connected ? 'ready' : 'unavailable');
  return {
    connected,
    inbound: activeSocket?.readyState === 1,
    status: { online: status?.online === true, good: status?.good !== false },
  };
}

async function executeAction(message) {
  switch (message.action) {
    case 'health_check':
      return await healthCheck();
    case 'send_message':
      return await deliver(message);
    case 'recent_conversations': {
      if (message.target !== 'all') throw new Error('recent_conversations target must be all');
      const payload = objectPayload(message.payload);
      const count = boundedInteger(payload.count, DEFAULT_HISTORY_COUNT, 1, MAX_HISTORY_COUNT, 'count');
      return sanitizeRecentContacts(await onebotApi('get_recent_contact', { count }), count);
    }
    case 'list_friends': {
      if (message.target !== 'all') throw new Error('list_friends target must be all');
      const payload = objectPayload(message.payload);
      const limit = boundedInteger(payload.limit, 100, 1, MAX_DIRECTORY_COUNT, 'limit');
      return sanitizeFriends(await onebotApi('get_friend_list', { no_cache: false }), limit);
    }
    case 'list_groups': {
      if (message.target !== 'all') throw new Error('list_groups target must be all');
      const payload = objectPayload(message.payload);
      const limit = boundedInteger(payload.limit, 100, 1, MAX_DIRECTORY_COUNT, 'limit');
      return sanitizeGroups(await onebotApi('get_group_list', { no_cache: false }), limit);
    }
    case 'friend_history': {
      const { id } = parseConversationTarget(message.target, ['private']);
      const payload = objectPayload(message.payload);
      const count = boundedInteger(payload.count, DEFAULT_HISTORY_COUNT, 1, MAX_HISTORY_COUNT, 'count');
      const messageSeq = payload.messageSeq === undefined ? '0' : identifier(payload.messageSeq, 'messageSeq');
      if (payload.reverseOrder !== undefined && typeof payload.reverseOrder !== 'boolean') {
        throw new Error('reverseOrder must be a boolean');
      }
      return sanitizeHistory(await onebotApi('get_friend_msg_history', {
        user_id: id, message_seq: messageSeq, count, reverseOrder: payload.reverseOrder ?? false,
      }));
    }
    case 'group_history': {
      const { id } = parseConversationTarget(message.target, ['group']);
      const payload = objectPayload(message.payload);
      const count = boundedInteger(payload.count, DEFAULT_HISTORY_COUNT, 1, MAX_HISTORY_COUNT, 'count');
      const params = { group_id: id, count };
      if (payload.messageSeq !== undefined) params.message_seq = identifier(payload.messageSeq, 'messageSeq');
      if (payload.reverseOrder !== undefined) {
        if (typeof payload.reverseOrder !== 'boolean') throw new Error('reverseOrder must be a boolean');
        params.reverseOrder = payload.reverseOrder;
      }
      return sanitizeHistory(await onebotApi('get_group_msg_history', params));
    }
    default:
      throw new Error(`unsupported action: ${message.action}`);
  }
}

function transformEvent(onebotEvent) {
  const postType = boundedString(onebotEvent.post_type, 40);
  if (postType !== 'message') return undefined;
  const messageId = onebotEvent.message_id === undefined ? '' : String(onebotEvent.message_id);
  const externalId = messageId
    ? `qq-msg-${messageId}`
    : `qq-${postType}-${createHash('sha256').update(JSON.stringify(onebotEvent)).digest('hex')}`;
  const messageType = boundedString(onebotEvent.message_type, 40);
  const sender = onebotEvent.sender && typeof onebotEvent.sender === 'object' ? onebotEvent.sender : {};
  const userId = boundedString(String(onebotEvent.user_id ?? sender.user_id ?? ''), 64);
  const conversationId = messageType === 'private'
    ? `private:${identifier(userId, 'user id')}`
    : messageType === 'group'
      ? `group:${identifier(onebotEvent.group_id, 'group id')}`
      : '';
  const normalized = sanitizeMessage(onebotEvent);
  return {
    type: 'event',
    externalId,
    kind: 'command',
    payload: normalized,
    occurredAt: safeTimestamp(onebotEvent.time) ?? new Date().toISOString(),
    priority: 80,
    actor: {
      id: userId,
      displayName: boundedString(sender.card || sender.nickname || '', 200),
    },
    conversation: { id: conversationId },
    replyTarget: conversationId,
  };
}

const server = createServer((_request, response) => {
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not Found');
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
const expectedTokenDigest = createHash('sha256').update(WS_ACCESS_TOKEN).digest();
let activeSocket;

function equalToken(candidate) {
  if (!candidate) return false;
  return timingSafeEqual(createHash('sha256').update(candidate).digest(), expectedTokenDigest);
}

function requestToken(request) {
  const rawAuthorization = request.headers.authorization;
  const authorization = Array.isArray(rawAuthorization) ? rawAuthorization[0] : rawAuthorization;
  const bearer = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization)?.[1] : undefined;
  if (authorization && !bearer) return undefined;
  let queryTokens;
  try {
    queryTokens = new URL(request.url || '/', 'http://127.0.0.1').searchParams.getAll('access_token');
  } catch {
    return undefined;
  }
  if (queryTokens.length > 1) return undefined;
  const query = queryTokens[0] || undefined;
  if (bearer && query && bearer !== query) return undefined;
  return bearer || query;
}

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

server.on('upgrade', (request, socket, head) => {
  if (!equalToken(requestToken(request))) {
    process.stderr.write('[qq] rejected unauthenticated WebSocket client\n');
    rejectUpgrade(socket, 401, 'Unauthorized');
    return;
  }
  if (activeSocket && activeSocket.readyState < 2) {
    process.stderr.write('[qq] rejected additional WebSocket upstream\n');
    rejectUpgrade(socket, 409, 'Conflict');
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    activeSocket = ws;
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  process.stderr.write('[qq] OneBot reverse WebSocket connected\n');
  emitStatus('ready');
  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      const event = data?.post_type ? transformEvent(data) : undefined;
      if (event) emit(event);
    } catch (error) {
      process.stderr.write(`[qq] WS parse error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });
  ws.on('close', () => {
    process.stderr.write('[qq] OneBot reverse WebSocket disconnected\n');
    if (activeSocket === ws) {
      activeSocket = undefined;
      emitStatus('unavailable');
    }
  });
  ws.on('error', (error) => {
    process.stderr.write(`[qq] WS error: ${error.message}\n`);
  });
});

server.listen(WS_PORT, '127.0.0.1', () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : WS_PORT;
  process.stderr.write(`[qq] WebSocket server listening on ws://127.0.0.1:${port}/\n`);
  emitStatus('unavailable', 'unknown', true);
});

const statusTimer = setInterval(() => {
  void healthCheck().catch((error) => {
    process.stderr.write(`[qq] health poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
    emitStatus(activeSocket?.readyState === 1 ? 'ready' : 'unavailable', 'unavailable');
  });
}, STATUS_POLL_MS);
statusTimer.unref();

process.stdin.setEncoding('utf8');
let input = '';
let queue = Promise.resolve();
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (message.type === 'deliver') {
          await deliver(message);
          deliveryAck(message.id, true);
          return;
        }
        if (message.type !== 'action' || typeof message.id !== 'string') {
          throw new Error('message must be deliver or action with an id');
        }
        actionResult(message.id, true, await executeAction(message));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const uncertain = error?.uncertain === true;
        if (message?.type === 'action') actionResult(message?.id ?? 'invalid', false, undefined, reason, uncertain);
        else deliveryAck(message?.id ?? 'invalid', false, reason, uncertain);
      }
    }).catch((error) => {
      process.stderr.write(`[qq] input queue failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
});

function shutdown(code) {
  clearInterval(statusTimer);
  activeSocket?.terminate();
  wss.close();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2_000).unref();
}

process.once('SIGTERM', () => shutdown(0));
process.once('SIGINT', () => shutdown(0));
