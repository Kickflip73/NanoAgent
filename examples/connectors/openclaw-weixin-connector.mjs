#!/usr/bin/env node

import { access, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rpc as mimiRpc, socketPathFor as mimiSocketPathFor } from '../openclaw/mimiagent-bridge/index.mjs';

const MAX_TEXT = 20_000;
const MAX_HISTORY_TEXT = 4_000;
const DEFAULT_HISTORY_COUNT = 20;
const MAX_HISTORY_COUNT = 100;
const MAX_HISTORY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY_SCAN_BYTES = 32 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(10_000, Number.parseInt(process.env.OPENCLAW_COMMAND_TIMEOUT_MS || '60000', 10) || 60_000),
);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorText(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function payloadText(payload) {
  if (typeof payload === 'string') return payload.trim().slice(0, MAX_TEXT);
  if (payload && typeof payload.text === 'string') return payload.text.trim().slice(0, MAX_TEXT);
  return JSON.stringify(payload).slice(0, MAX_TEXT);
}

export function parseTarget(target) {
  if (typeof target !== 'string') throw new Error('target must be a string');
  const params = new URLSearchParams(target);
  const account = params.get('account')?.trim();
  const to = params.get('to')?.trim();
  if (!account || !to || [...params.keys()].some((key) => key !== 'account' && key !== 'to')) {
    throw new Error('target must contain only account and to');
  }
  return { account, to };
}

function boundedHistoryCount(payload) {
  const count = payload?.count ?? DEFAULT_HISTORY_COUNT;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_HISTORY_COUNT) {
    throw new Error(`count must be an integer from 1 to ${MAX_HISTORY_COUNT}`);
  }
  return count;
}

function openClawSessionsDir(env = process.env) {
  const configured = env.OPENCLAW_STATE_DIR?.trim();
  if (configured && !path.isAbsolute(configured)) throw new Error('OPENCLAW_STATE_DIR must be absolute');
  const home = env.HOME?.trim() || homedir();
  return path.join(configured || path.join(home, '.openclaw'), 'agents', 'main', 'sessions');
}

function fileBelongsToTarget(contents, to) {
  return contents.includes(`"to": "${to}"`)
    || contents.includes(`"to":"${to}"`)
    || contents.includes(`\\"to\\": \\"${to}\\"`)
    || contents.includes(`\\"to\\":\\"${to}\\"`);
}

function inboundText(content) {
  if (typeof content === 'string') return content.trim().slice(0, MAX_HISTORY_TEXT);
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (part && typeof part.text === 'string') return [part.text];
    return [];
  }).join('\n').trim().slice(0, MAX_HISTORY_TEXT);
}

export async function localInboundHistory(target, payload = {}, env = process.env) {
  const { account, to } = parseTarget(target);
  const count = boundedHistoryCount(payload);
  const sessionsDir = openClawSessionsDir(env);
  const registry = await readFile(path.join(sessionsDir, 'sessions.json'), 'utf8');
  if (!registry.includes('openclaw-weixin') || !registry.includes(account) || !registry.includes(to)) {
    throw new Error('target is not present in the local OpenClaw Weixin session registry');
  }
  const entries = await readdir(sessionsDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]+\.jsonl(?:\.deleted\..+)?$/i.test(entry.name)) continue;
    const file = path.join(sessionsDir, entry.name);
    const info = await stat(file);
    if (info.size <= 0 || info.size > MAX_HISTORY_FILE_BYTES) continue;
    candidates.push({ file, size: info.size, mtimeMs: info.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const messages = [];
  const seen = new Set();
  let scannedBytes = 0;
  let scanTruncated = false;
  for (const candidate of candidates) {
    if (scannedBytes + candidate.size > MAX_HISTORY_SCAN_BYTES) {
      scanTruncated = true;
      continue;
    }
    scannedBytes += candidate.size;
    const contents = await readFile(candidate.file, 'utf8');
    if (!fileBelongsToTarget(contents, to)) continue;
    for (const line of contents.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        const message = record?.message;
        if (message?.role !== 'user' || message.sourceChannel !== 'openclaw-weixin') continue;
        const text = inboundText(message.content);
        if (!text) continue;
        const dedupeKey = String(message.idempotencyKey || record.id || `${message.timestamp ?? record.timestamp}:${text}`);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        messages.push({
          messageId: String(record.id || dedupeKey).slice(0, 200),
          occurredAt: new Date(message.timestamp ?? record.timestamp).toISOString(),
          text,
        });
      } catch {}
    }
  }
  messages.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const selected = messages.slice(-count);
  return {
    account,
    to,
    source: 'openclaw-local-session-archive',
    upstreamHistory: false,
    count: selected.length,
    truncated: scanTruncated || messages.length > selected.length,
    messages: selected,
  };
}

async function resolveOpenClaw() {
  const configured = process.env.OPENCLAW_BIN?.trim();
  const candidates = [configured, '/opt/homebrew/bin/openclaw', '/usr/local/bin/openclaw']
    .filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return path.resolve(candidate);
    } catch {}
  }
  return 'openclaw';
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { detached, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (detached && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      } else child.kill('SIGKILL');
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`openclaw exited ${code ?? signal ?? 'unknown'}: ${stderr.trim()}`));
    });
  });
}

async function readiness(openclaw, pluginVerified) {
  const statusOutput = await run(process.execPath, [
    openclaw, 'channels', 'status', '--probe', '--timeout', '15000', '--json',
  ]);
  const status = JSON.parse(statusOutput);
  const accounts = status.channelAccounts?.['openclaw-weixin'];
  const readyAccounts = Array.isArray(accounts)
    ? accounts.filter((account) => account.enabled && account.configured && account.running && !account.lastError)
    : [];
  if (!readyAccounts.length) {
    return {
      ready: false, bridgeVerified: false, pluginVerified, socketVerified: false, accountCount: 0,
    };
  }
  let pluginReady = pluginVerified;
  if (!pluginReady) {
    const pluginOutput = await run(process.execPath, [
      openclaw, 'plugins', 'inspect', 'mimiagent-bridge', '--runtime', '--json',
    ]);
    const plugin = JSON.parse(pluginOutput);
    pluginReady = plugin.plugin?.status === 'loaded' && plugin.plugin?.activated === true;
  }
  if (!pluginReady) {
    return {
      ready: false, bridgeVerified: false, pluginVerified: false, socketVerified: false,
      accountCount: readyAccounts.length,
    };
  }
  const socketPath = mimiSocketPathFor({}, process.env);
  const daemon = await mimiRpc(socketPath, 'status', {}, 5_000);
  const socketVerified = Boolean(
    daemon && typeof daemon === 'object'
    && Number.isSafeInteger(daemon.protocolVersion)
    && typeof daemon.workspaceRoot === 'string',
  );
  return {
    ready: socketVerified,
    bridgeVerified: socketVerified,
    pluginVerified: true,
    socketVerified,
    accountCount: readyAccounts.length,
  };
}

async function send(openclaw, target, payload) {
  const { account, to } = parseTarget(target);
  const text = payloadText(payload);
  if (!text) throw new Error('message text is empty');
  const output = await run(process.execPath, [openclaw,
    'message', 'send', '--channel', 'openclaw-weixin', '--account', account,
    '--target', to, '--message', text, '--json',
  ]);
  const result = JSON.parse(output);
  if (result.dryRun === true) throw new Error('openclaw unexpectedly used dry-run');
  if (!result.messageId && !result.result?.messageId) throw new Error('openclaw did not return a message id');
  return { sent: true, messageId: result.messageId || result.result?.messageId };
}

async function main() {
  const openclaw = await resolveOpenClaw();
  let lastReady;
  let pluginVerified = false;
  let consecutiveFailures = 0;
  let checkingPromise;
  const updateStatus = async () => {
    if (checkingPromise) return await checkingPromise;
    checkingPromise = (async () => {
      try {
        const status = await readiness(openclaw, pluginVerified);
        const ready = status.ready;
        pluginVerified = status.pluginVerified;
        consecutiveFailures = 0;
        emit({
          type: 'status',
          inbound: ready ? 'ready' : 'unavailable',
          outbound: ready ? 'ready' : 'unavailable',
          deliveryConfirmed: true,
        });
        if (ready !== lastReady) process.stderr.write(`[openclaw-weixin] channel ${ready ? 'ready' : 'unavailable'}\n`);
        lastReady = ready;
        return status;
      } catch (error) {
        consecutiveFailures += 1;
        process.stderr.write(`[openclaw-weixin] readiness failed: ${errorText(error)}\n`);
        if (lastReady !== true || consecutiveFailures >= 3) {
          emit({ type: 'status', inbound: 'unavailable', outbound: 'unavailable', deliveryConfirmed: true });
          lastReady = false;
        }
        return {
          ready: false, bridgeVerified: false, pluginVerified, socketVerified: false,
          accountCount: 0, error: errorText(error),
        };
      } finally {
        checkingPromise = undefined;
      }
    })();
    return await checkingPromise;
  };
  await updateStatus();
  const statusTimer = setInterval(() => void updateStatus(), 60_000);
  statusTimer.unref();
  setTimeout(() => void updateStatus(), 1_000).unref();

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
            await send(openclaw, message.target, message.payload);
            emit({ type: 'delivery_ack', id: message.id, ok: true });
            return;
          }
          if (message.type === 'action' && message.action === 'send_message') {
            const result = await send(openclaw, message.target, message.payload);
            emit({ type: 'action_result', id: message.id, ok: true, result });
            return;
          }
          if (message.type === 'action' && message.action === 'health_check') {
            const status = await updateStatus();
            emit({
              type: 'action_result', id: message.id, ok: true,
              result: {
                connected: status.ready,
                bridgeVerified: status.bridgeVerified,
                socketVerified: status.socketVerified,
                accountCount: status.accountCount,
                ...(status.error ? { error: status.error } : {}),
              },
            });
            return;
          }
          if (message.type === 'action' && message.action === 'local_history') {
            const result = await localInboundHistory(message.target, message.payload);
            emit({ type: 'action_result', id: message.id, ok: true, result });
            return;
          }
          throw new Error(`unsupported message: ${message.type}/${message.action ?? ''}`);
        } catch (error) {
          const id = message?.id;
          const type = message?.type === 'deliver' ? 'delivery_ack' : 'action_result';
          emit({ type, id, ok: false, error: errorText(error) });
        }
      });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
