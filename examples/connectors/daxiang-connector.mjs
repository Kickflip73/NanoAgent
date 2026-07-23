#!/usr/bin/env node

/**
 * MimiAgent ↔ 大象开放平台机器人 Connector（出站）。
 * stdin:  deliver 回复，或 action(send_message) 主动发送
 * stdout: delivery_ack 或 action_result
 */

const required = ['DX_APP_KEY', 'DX_APP_SECRET', 'DX_ROBOT_ID'];
for (const name of required) {
  if (!process.env[name]) {
    process.stderr.write(`[daxiang] missing ${name}\n`);
    process.exit(1);
  }
}

const defaultBaseUrl = process.env.DX_ENV === 'test'
  ? 'https://dxopen.xm.test.sankuai.com'
  : 'https://dxopen.sankuai.com';
const configuredBaseUrl = process.env.DX_BASE_URL;
if (configuredBaseUrl) {
  const url = new URL(configuredBaseUrl);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('DX_BASE_URL must use HTTPS or loopback HTTP');
  }
}
const baseUrl = (configuredBaseUrl || defaultBaseUrl).replace(/\/$/, '');
let accessToken;
let tokenExpiresAt = 0;

async function post(path, body, token) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`); }
  if (!response.ok || payload?.code !== 0) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 1_000)}`);
  }
  return payload;
}

async function token() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  const response = await post('/open/api/token/get', {
    appKey: process.env.DX_APP_KEY,
    appSecret: process.env.DX_APP_SECRET,
  });
  accessToken = response.data?.accessToken ?? response.data?.access_token;
  if (!accessToken) throw new Error('token response missing accessToken');
  tokenExpiresAt = Date.now() + (response.data?.expiresIn ?? 7_200) * 1_000 - 5 * 60_000;
  return accessToken;
}

function textPayload(payload) {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload.text === 'string') return payload.text;
  return JSON.stringify(payload);
}

async function deliver(message) {
  if (typeof message.id !== 'string' || typeof message.target !== 'string') {
    throw new Error('deliver requires id and target');
  }
  const separator = message.target.indexOf(':');
  if (separator < 1) throw new Error('target must be single:<userId> or group:<chatId>');
  const type = message.target.slice(0, separator);
  const target = message.target.slice(separator + 1);
  if (!target) throw new Error('target id is empty');
  const content = textPayload(message.payload).slice(0, 20_000);
  const contentType = process.env.DX_CONTENT_TYPE === 'markdown' ? 'markdown' : 'text';
  const common = { robotId: process.env.DX_ROBOT_ID, content, contentType };
  if (type === 'single') {
    await post('/open/api/message/robot/send/single', { ...common, userId: target }, await token());
  } else if (type === 'group') {
    await post('/open/api/message/robot/send/group', { ...common, chatId: target }, await token());
  } else {
    throw new Error(`unsupported target type: ${type}`);
  }
}

function result(type, id, ok, value, error) {
  process.stdout.write(`${JSON.stringify({
    type, id, ok,
    ...(type === 'action_result' && ok ? { result: value } : {}),
    ...(error ? { error } : {}),
  })}\n`);
}

function emitStatus(outbound = 'unknown') {
  process.stdout.write(`${JSON.stringify({
    type: 'status', inbound: 'unavailable', outbound, deliveryConfirmed: true,
  })}\n`);
}

emitStatus();

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (message.type !== 'deliver' && message.type !== 'action') {
          throw new Error(`unsupported message type: ${message.type}`);
        }
        if (message.type === 'action' && message.action === 'health_check') {
          await token();
          emitStatus('ready');
          result('action_result', message.id, true, {
            connected: true,
            environment: process.env.DX_ENV === 'test' ? 'test' : 'prod',
            outbound: true,
            inbound: 'requires-published-event-subscription-relay',
          });
          return;
        }
        if (message.type === 'action' && message.action !== 'send_message') {
          throw new Error(`unsupported action: ${message.action}`);
        }
        await deliver(message);
        result(
          message.type === 'action' ? 'action_result' : 'delivery_ack',
          message.id,
          true,
          message.type === 'action' ? { sent: true } : undefined,
        );
      } catch (error) {
        result(
          message?.type === 'action' ? 'action_result' : 'delivery_ack',
          message?.id ?? 'invalid',
          false,
          undefined,
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  }
});
