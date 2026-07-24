#!/usr/bin/env node

/**
 * Generic MimiAgent Connector <-> fixed HTTP relay bridge.
 *
 * The relay URL is configuration, never model input. Both Outbox delivery and
 * declared Connector actions are forwarded with their stable protocol ID as an
 * Idempotency-Key so the remote adapter can absorb uncertain retries.
 */

const actionUrl = environmentEntry('MIMI_HTTP_ACTION_URL');
const eventUrlEntry = environmentEntry('MIMI_HTTP_EVENT_URL');
const url = parseRelayUrl(actionUrl?.value, actionUrl?.name ?? 'MIMI_HTTP_ACTION_URL');
const eventUrl = eventUrlEntry
  ? parseRelayUrl(eventUrlEntry.value, eventUrlEntry.name)
  : undefined;
const token = environmentEntry('MIMI_HTTP_ACTION_TOKEN')?.value.trim();
const timeoutMs = integerEnv('MIMI_HTTP_ACTION_TIMEOUT_MS', 30_000, 1_000, 120_000);
const maxResponseBytes = integerEnv(
  'MIMI_HTTP_ACTION_MAX_RESPONSE_BYTES',
  1024 * 1024, 1_024, 4 * 1024 * 1024,
);
const pollIntervalMs = integerEnv(
  'MIMI_HTTP_EVENT_POLL_INTERVAL_MS',
  5_000, 1_000, 3_600_000,
);
const maxRequestBytes = 128 * 1024;
const eventKinds = new Set(['command', 'alert', 'ambient', 'schedule', 'webhook']);

function environmentEntry(primary) {
  if (process.env[primary] !== undefined && process.env[primary] !== '') {
    return { name: primary, value: process.env[primary] };
  }
  return undefined;
}

function integerEnv(primary, fallback, minimum, maximum) {
  const entry = environmentEntry(primary);
  if (!entry) return fallback;
  const value = Number(entry.value);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${entry.name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseRelayUrl(value, name = 'MIMI_HTTP_ACTION_URL') {
  if (!value) throw new Error(`missing ${name}`);
  const parsed = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS or loopback HTTP`);
  }
  parsed.username = '';
  parsed.password = '';
  return parsed;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function resultType(message) {
  return message?.type === 'action' ? 'action_result' : 'delivery_ack';
}

function fail(message, error) {
  emit({
    type: resultType(message),
    id: typeof message?.id === 'string' ? message.id : 'invalid',
    ok: false,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
  });
}

function validateMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('message must be an object');
  if (message.type !== 'deliver' && message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.id !== 'string' || !message.id || message.id.length > 200) throw new Error('message.id is required');
  if (typeof message.target !== 'string' || !message.target.trim() || message.target.length > 2_000) {
    throw new Error('message.target is required');
  }
  if (message.type === 'action' && (
    typeof message.action !== 'string'
    || !/^[a-zA-Z0-9._-]{1,100}$/.test(message.action)
  )) throw new Error('message.action is invalid');
}

async function readBounded(response) {
  if (!response.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > maxResponseBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new Error(`HTTP response exceeds ${maxResponseBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function responseJson(response) {
  const text = await readBounded(response);
  let payload;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status} returned invalid JSON`);
    }
  }
  if (!response.ok) {
    const detail = payload && typeof payload.error === 'string' ? `: ${payload.error}` : '';
    throw new Error(`HTTP ${response.status}${detail}`);
  }
  if (payload?.ok === false) throw new Error(typeof payload.error === 'string' ? payload.error : 'relay rejected request');
  return payload;
}

async function forward(message) {
  validateMessage(message);
  const request = {
    version: 1,
    type: message.type,
    id: message.id,
    ...(message.type === 'action' ? { action: message.action } : {}),
    target: message.target,
    payload: message.payload,
  };
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > maxRequestBytes) throw new Error(`HTTP request exceeds ${maxRequestBytes} bytes`);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'idempotency-key': message.id,
      'x-mimi-message-type': message.type,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await responseJson(response);
  emit({
    type: resultType(message), id: message.id, ok: true,
    ...(message.type === 'action' ? { result: payload?.result ?? payload ?? { ok: true } } : {}),
  });
}

function boundedIdentity(value, label, extraField) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 500) throw new Error(`${label}.id is invalid`);
  const result = { id: value.id };
  if (extraField && value[extraField] !== undefined) {
    if (typeof value[extraField] !== 'string' || value[extraField].length > 500) {
      throw new Error(`${label}.${extraField} is invalid`);
    }
    result[extraField] = value[extraField];
  }
  return result;
}

function normalizeEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('event must be an object');
  if (typeof value.externalId !== 'string' || !value.externalId.trim() || value.externalId.length > 500) {
    throw new Error('event.externalId is invalid');
  }
  if (!Object.hasOwn(value, 'payload')) throw new Error('event.payload is required');
  if (value.kind !== undefined && !eventKinds.has(value.kind)) throw new Error('event.kind is invalid');
  if (value.occurredAt !== undefined && (
    typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt))
  )) throw new Error('event.occurredAt is invalid');
  if (value.priority !== undefined && (
    typeof value.priority !== 'number' || !Number.isFinite(value.priority) || value.priority < 0 || value.priority > 100
  )) throw new Error('event.priority is invalid');
  if (value.replyTarget !== undefined && (
    typeof value.replyTarget !== 'string' || !value.replyTarget.trim() || value.replyTarget.length > 500
  )) throw new Error('event.replyTarget is invalid');
  return {
    type: 'event', externalId: value.externalId,
    ...(value.kind ? { kind: value.kind } : {}),
    payload: value.payload,
    ...(value.occurredAt ? { occurredAt: new Date(value.occurredAt).toISOString() } : {}),
    ...(value.priority !== undefined ? { priority: value.priority } : {}),
    ...(value.actor ? { actor: boundedIdentity(value.actor, 'event.actor', 'displayName') } : {}),
    ...(value.conversation ? { conversation: boundedIdentity(value.conversation, 'event.conversation', 'threadId') } : {}),
    ...(value.replyTarget ? { replyTarget: value.replyTarget } : {}),
  };
}

let pollCursor;
let pollFailures = 0;
let pollOutageId;
const pendingEventAcks = new Map();
const pollFreshForMs = eventUrl && pollIntervalMs > 0
  ? Math.min(7 * 24 * 60 * 60_000, Math.max(5_000, pollIntervalMs * 3))
  : undefined;
function emitReadiness() {
  emit({
    type: 'status', inbound: eventUrl ? 'ready' : 'unavailable', outbound: 'ready',
    deliveryConfirmed: true, eventAcknowledgement: true,
    ...(pollFreshForMs ? { freshForMs: pollFreshForMs } : {}),
  });
}
emitReadiness();

function emitWithAck(event) {
  return new Promise((resolve, reject) => {
    if (pendingEventAcks.has(event.externalId)) {
      reject(new Error(`duplicate pending event: ${event.externalId}`));
      return;
    }
    const timer = setTimeout(() => {
      pendingEventAcks.delete(event.externalId);
      reject(new Error(`event ACK timed out: ${event.externalId}`));
    }, timeoutMs);
    pendingEventAcks.set(event.externalId, { resolve, reject, timer });
    emit(event);
  });
}

function pollHealth(state, error) {
  if (state === 'offline') pollOutageId = `http-event-poll:${Date.now()}`;
  if (!pollOutageId) return;
  emit({
    type: 'event', externalId: `${pollOutageId}:${state}`, kind: 'alert', priority: state === 'offline' ? 85 : 65,
    payload: {
      type: 'http_event_poll_health', state,
      ...(error ? { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) } : {}),
    },
  });
  if (state === 'recovered') pollOutageId = undefined;
}

async function pollEvents() {
  if (!eventUrl) return;
  const requestUrl = new URL(eventUrl);
  requestUrl.searchParams.set('limit', '100');
  if (pollCursor) requestUrl.searchParams.set('cursor', pollCursor);
  try {
    const response = await fetch(requestUrl, {
      method: 'GET', redirect: 'error',
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await responseJson(response);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('event response must be an object');
    if (!Array.isArray(payload.events) || payload.events.length > 100) {
      throw new Error('event response must contain at most 100 events');
    }
    const events = payload.events.map(normalizeEvent);
    if (payload.cursor !== undefined && (
      typeof payload.cursor !== 'string' || !payload.cursor || payload.cursor.length > 2_000
    )) throw new Error('event response cursor is invalid');
    await Promise.all(events.map((event) => emitWithAck(event)));
    if (payload.cursor) pollCursor = payload.cursor;
    if (pollFailures > 0) pollHealth('recovered');
    pollFailures = 0;
    emitReadiness();
  } catch (error) {
    pollFailures += 1;
    if (pollFailures === 1) pollHealth('offline', error);
    process.stderr.write(`[http-action] event poll failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 1_000)}\n`);
  }
  const retryMs = pollFailures === 0 ? pollIntervalMs : Math.min(60_000, pollIntervalMs * (2 ** Math.min(5, pollFailures - 1)));
  setTimeout(() => void pollEvents(), retryMs);
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > maxRequestBytes * 2) {
    fail(undefined, new Error('stdin message exceeds limit'));
    input = '';
    return;
  }
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(undefined, error);
      continue;
    }
    if (message?.type === 'event_ack') {
      const pending = pendingEventAcks.get(message.externalId);
      if (!pending) continue;
      clearTimeout(pending.timer);
      pendingEventAcks.delete(message.externalId);
      if (message.ok) pending.resolve();
      else pending.reject(new Error(message.error || `event rejected: ${message.externalId}`));
      continue;
    }
    void forward(message).catch((error) => fail(message, error));
  }
});

if (eventUrl) void pollEvents();
