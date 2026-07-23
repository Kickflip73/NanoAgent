import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MAX_RPC_BYTES = 1024 * 1024;
const RPC_TIMEOUT_MS = 5_000;
const CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function bounded(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function exactIdentifier(value, limit) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= limit ? normalized : '';
}

function messageText(event) {
  const source = object(event);
  for (const candidate of [source.content, source.body, source.text]) {
    const direct = bounded(candidate, 20_000);
    if (direct) return direct;
    if (Array.isArray(candidate)) {
      const joined = candidate.flatMap((part) => {
        if (typeof part === 'string') return [part];
        const text = bounded(object(part).text, 20_000);
        return text ? [text] : [];
      }).join('\n').trim().slice(0, 20_000);
      if (joined) return joined;
    }
    const nested = bounded(object(candidate).text, 20_000);
    if (nested) return nested;
  }
  return '';
}

function dispatchContext(config, event, context) {
  const source = object(event);
  const current = object(context);
  return {
    ...current,
    channelId: exactIdentifier(current.channelId ?? source.channelId ?? source.channel, 200),
    accountId: exactIdentifier(current.accountId ?? source.accountId ?? object(config).accountId, 200),
    senderId: exactIdentifier(current.senderId ?? source.senderId ?? source.from, 500),
    conversationId: exactIdentifier(
      current.conversationId ?? source.conversationId ?? source.conversation,
      500,
    ),
  };
}

function isOwnerSender(config, context) {
  const accountId = exactIdentifier(context.accountId, 200);
  const senderId = exactIdentifier(context.senderId, 500);
  if (!accountId || !senderId) return false;
  const configured = object(config).ownerSenders;
  if (!Array.isArray(configured)) return false;
  const qualified = `${accountId}:${senderId}`;
  return configured.some((candidate) => {
    const allowed = exactIdentifier(candidate, 701);
    return allowed === senderId || allowed === qualified;
  });
}

export function bridgeTarget(accountId, recipient) {
  return new URLSearchParams({ account: accountId, to: recipient }).toString();
}

export function defaultSocketPath(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, '.mimi-agent', 'daemon', 'mimi.sock');
}

export function controlTokenPathForSocket(socketPath) {
  return path.join(path.dirname(socketPath), 'control.token');
}

async function readControlToken(socketPath) {
  let handle;
  try {
    handle = await open(controlTokenPathForSocket(socketPath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return '';
    throw error;
  }
  try {
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (!metadata.isFile() || metadata.nlink !== 1
      || (currentUid !== undefined && metadata.uid !== currentUid)
      || (metadata.mode & 0o777) !== 0o600) {
      throw new Error('MimiAgent IPC control token file must be an owner-only 0600 regular file');
    }
    const token = (await handle.readFile('utf8')).trim();
    if (!CONTROL_TOKEN_PATTERN.test(token)) throw new Error('MimiAgent IPC control token file is invalid');
    return token;
  } finally {
    await handle.close();
  }
}

export function socketPathFor(config, environment = process.env, homeDirectory = os.homedir()) {
  const values = object(environment);
  const direct = bounded(object(config).socketPath, 2_000)
    || bounded(values.MIMI_DAEMON_SOCKET, 2_000);
  if (direct) return direct;
  const dataRoot = bounded(values.MIMI_DAEMON_DATA_DIR, 2_000);
  if (dataRoot) {
    const expanded = dataRoot === '~'
      ? homeDirectory
      : dataRoot.startsWith('~/') ? path.join(homeDirectory, dataRoot.slice(2)) : dataRoot;
    if (!path.isAbsolute(expanded)) throw new Error('MIMI_DAEMON_DATA_DIR must be an absolute path or ~/path');
    return path.join(expanded, 'mimi.sock');
  }
  return defaultSocketPath(homeDirectory);
}

export function externalIdFor(event, context) {
  const messageId = exactIdentifier(event.messageId ?? context.messageId, 500);
  if (messageId) return `openclaw-weixin:${messageId}`;
  const stable = [
    context.accountId,
    context.senderId,
    event.timestamp,
    messageText(event),
  ].map((value) => String(value ?? '')).join('\0');
  return `openclaw-weixin:${createHash('sha256').update(stable).digest('hex')}`;
}

export function submitParams(event, context, ownerSessionId) {
  const accountId = bounded(context.accountId, 200);
  const senderId = bounded(context.senderId, 500);
  const conversationId = bounded(context.conversationId, 500) || senderId;
  const text = messageText(event);
  if (!accountId || !senderId || !text) throw new Error('微信消息缺少 account、sender 或正文');
  const sessionKey = bounded(ownerSessionId, 80);
  const owner = Boolean(sessionKey);
  return {
    externalId: externalIdFor(event, context),
    source: 'openclaw-weixin',
    kind: 'command',
    trust: owner ? 'owner' : 'external',
    priority: owner ? 100 : 50,
    profileId: 'owner',
    ...(owner ? { sessionKey } : {}),
    actor: { id: senderId },
    conversation: { id: conversationId },
    payload: { text, channel: 'weixin' },
    replyRoute: {
      channel: 'connector:openclaw-weixin',
      target: bridgeTarget(accountId, senderId),
    },
  };
}

export async function rpc(socketPath, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const auth = await readControlToken(socketPath);
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const requestId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const timer = setTimeout(() => socket.destroy(new Error(`MimiAgent IPC timeout: ${method}`)), timeoutMs);
    let output = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params, ...(auth ? { auth } : {}) })}\n`);
    });
    socket.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_RPC_BYTES) socket.destroy(new Error('MimiAgent IPC response exceeds 1MB'));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('end', () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(output.split('\n', 1)[0]);
        if (!response.ok) reject(new Error(response.error || `MimiAgent IPC failed: ${method}`));
        else resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export default {
  id: 'mimiagent-bridge',
  name: 'MimiAgent Bridge',
  description: 'Routes Weixin inbound messages to the local MimiAgent daemon',
  register(api) {
    api.on('inbound_claim', async (event, context) => {
      const config = object(api.pluginConfig);
      const normalized = dispatchContext(config, event, context);
      if (normalized.channelId !== 'openclaw-weixin') return;
      try {
        const socketPath = socketPathFor(config);
        let ownerSessionId = '';
        if (isOwnerSender(config, normalized)) {
          const snapshot = await rpc(socketPath, 'chat.snapshot', { profileId: 'owner', limit: 0 });
          ownerSessionId = bounded(object(snapshot).sessionId, 80);
          if (!ownerSessionId) throw new Error('MimiAgent owner session is unavailable');
        }
        await rpc(socketPath, 'submit', submitParams(event, normalized, ownerSessionId));
        api.logger.info?.('mimiagent-bridge: submitted Weixin message to MimiAgent');
        return { handled: true };
      } catch (error) {
        api.logger.error?.(`mimiagent-bridge: ${error instanceof Error ? error.message : String(error)}`);
        return {
          handled: true,
          reply: { text: 'MimiAgent 暂时不可用，消息未交给其他 Agent 处理。' },
        };
      }
    }, { priority: 1_000 });
  },
};
