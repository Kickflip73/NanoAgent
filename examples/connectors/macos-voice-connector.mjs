#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS voice connector.
 * Uses Speech/AVFoundation through Swift and the system say command without npm dependencies.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTIONS = new Set([
  'speak',
  'list_voices',
  'transcribe_audio',
  'listener_status',
  'listener_start',
  'listener_stop',
  'listener_restart',
]);
const say = process.env.MACOS_SAY_BIN || '/usr/bin/say';
const swift = process.env.MACOS_SWIFT_BIN || '/usr/bin/swift';
const recognizerHelper = process.env.MACOS_VOICE_RECOGNIZER_HELPER
  || fileURLToPath(new URL('./macos-voice-recognizer.swift', import.meta.url));
const locale = localeValue(process.env.MACOS_VOICE_LOCALE || 'zh-CN', 'MACOS_VOICE_LOCALE');
const onDevice = booleanEnv('MACOS_VOICE_ON_DEVICE', false);
const segmentSeconds = numberEnv('MACOS_VOICE_SEGMENT_SECONDS', 6, 2, 30);
const maxTranscriptChars = numberEnv('MACOS_VOICE_MAX_CHARS', 2_000, 1, 20_000);
const duplicateWindowMs = numberEnv('MACOS_VOICE_DUPLICATE_WINDOW_MS', 30_000, 0, 600_000);
const commandTimeoutMs = numberEnv('MACOS_VOICE_COMMAND_TIMEOUT_MS', 120_000, 100, 900_000);
const replyMaxChars = numberEnv('MACOS_VOICE_REPLY_MAX_CHARS', 80, 1, 20_000);
const replyRate = numberEnv('MACOS_VOICE_REPLY_RATE', 220, 80, 500);
const wakePhrases = phraseList(process.env.MACOS_VOICE_WAKE_PHRASES || '咪咪,Mimi,MimiAgent');
const listenerStateFile = absolutePath(
  process.env.MACOS_VOICE_STATE_FILE || defaultDaemonStateFile('voice-listener.json'),
  'MACOS_VOICE_STATE_FILE',
);
let listenerDesired = booleanEnv('MACOS_VOICE_LISTEN', false);

function defaultDaemonStateFile(name) {
  const configured = process.env.MIMI_DAEMON_DATA_DIR;
  if (configured) return path.join(expandHome(configured), name);
  return path.join(os.homedir(), '.mimi-agent', 'daemon', name);
}

function numberEnv(name, fallback, minimum, maximum) {
  if (process.env[name] === undefined || process.env[name] === '') return fallback;
  const value = Number(process.env[name]);
  if (Number.isFinite(value) && value >= minimum && value <= maximum) return value;
  process.stderr.write(`[macos-voice] invalid ${name}; using ${fallback}\n`);
  return fallback;
}

function booleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  process.stderr.write(`[macos-voice] invalid ${name}; using ${fallback}\n`);
  return fallback;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedString(value, label, maximum, required = false) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
    throw new Error(`${label} must be ${required ? 'a non-empty ' : 'a '}string with at most ${maximum} characters`);
  }
  return value;
}

function payloadObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('payload must be an object');
  return value;
}

function integer(value, label, minimum, maximum, fallback) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  return parsed;
}

function localeValue(value, label) {
  if (typeof value !== 'string' || value.length > 35 || !/^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8})*$/.test(value)) {
    throw new Error(`${label} must be a locale such as zh-CN or en-US`);
  }
  return value.replaceAll('_', '-');
}

function phraseList(value) {
  const values = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!values.length || values.length > 10 || values.some((item) => item.length > 50)) {
    throw new Error('MACOS_VOICE_WAKE_PHRASES must contain 1 to 10 comma-separated phrases of at most 50 characters');
  }
  return values;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function absolutePath(value, label) {
  const expanded = expandHome(boundedString(value, label, 4_000, true));
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(expanded);
}

async function readListenerDesired() {
  try {
    const value = JSON.parse(await readFile(listenerStateFile, 'utf8'));
    if (
      !value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'listenerDesired')
      || typeof value.listenerDesired !== 'boolean'
    ) throw new Error('state must contain only boolean listenerDesired');
    await chmod(listenerStateFile, 0o600);
    return value.listenerDesired;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    process.stderr.write(`[macos-voice] cannot read listener state; using environment default: ${errorText(error)}\n`);
    return undefined;
  }
}

async function persistListenerDesired(desired) {
  const directory = path.dirname(listenerStateFile);
  const temporary = `${listenerStateFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify({ listenerDesired: desired })}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, listenerStateFile);
    await chmod(listenerStateFile, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function boolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function validate(action, target, rawPayload) {
  if (!ACTIONS.has(action)) throw new Error(`unsupported action: ${String(action)}`);
  const payload = payloadObject(rawPayload);
  if (action === 'speak') {
    return {
      text: boundedString(payload.text, 'payload.text', 20_000, true),
      voice: target === 'default' ? undefined : boundedString(target, 'target', 200, true),
      rate: integer(payload.rate, 'payload.rate', 80, 500, 180),
      timeoutMs: integer(payload.timeoutMs, 'payload.timeoutMs', 100, 900_000, commandTimeoutMs),
    };
  }
  if (action === 'list_voices') {
    if (!['all', '*'].includes(target)) throw new Error('list_voices target must be all');
    return { limit: integer(payload.limit, 'payload.limit', 1, 1_000, 500) };
  }
  if (action === 'transcribe_audio') {
    return {
      audioPath: absolutePath(target, 'target'),
      locale: localeValue(payload.locale ?? locale, 'payload.locale'),
      onDevice: boolean(payload.onDevice, 'payload.onDevice', onDevice),
      maxChars: integer(payload.maxChars, 'payload.maxChars', 1, 100_000, 40_000),
      maxAudioBytes: integer(payload.maxAudioBytes, 'payload.maxAudioBytes', 1, 1_000_000_000, 200_000_000),
      timeoutMs: integer(payload.timeoutMs, 'payload.timeoutMs', 1_000, 900_000, commandTimeoutMs),
    };
  }
  if (!['listener', 'all', '*'].includes(target)) throw new Error(`${action} target must be listener`);
  return {};
}

function runCommand(command, args, timeoutMs, maxOutputBytes, captureOutput = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR },
      stdio: ['ignore', captureOutput ? 'pipe' : 'ignore', 'pipe'],
    });
    const chunks = [];
    let outputBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    if (captureOutput) {
      child.stdout.on('data', (chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) { overflow = true; child.kill('SIGKILL'); return; }
        chunks.push(chunk);
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`command timed out after ${timeoutMs}ms`));
      if (overflow) return reject(new Error(`command output exceeds ${maxOutputBytes} bytes`));
      if (code !== 0) return reject(new Error((stderr || `command exited code=${code} signal=${signal || 'none'}`).trim()));
      resolve(Buffer.concat(chunks));
    });
  });
}

function parseVoice(line) {
  const match = /^(.+?)\s{2,}([A-Za-z]{2,8}(?:[_-][A-Za-z0-9]{1,8})*)\s+#\s?(.*)$/.exec(line);
  return match ? { name: match[1].trim(), locale: match[2], sample: match[3] } : { name: line.trim() };
}

function listenerArgs() {
  return [recognizerHelper, 'listen', locale, String(onDevice), String(segmentSeconds), String(maxTranscriptChars), wakePhrases.join('\u001f')];
}

let listener;
let listenerReady = false;
let listenerStartedAt;
let listenerLastTranscriptAt;
let listenerLastError = '';
let listenerRestartTimer;
let listenerRestartCount = 0;
const recentCommands = new Map();
let eventSequence = 0;

function commandFromTranscript(value) {
  const text = value.trim();
  const lower = text.toLocaleLowerCase();
  for (const phrase of wakePhrases) {
    const normalized = phrase.toLocaleLowerCase();
    if (!lower.startsWith(normalized)) continue;
    const command = text.slice(phrase.length).replace(/^[\s,，:：;；!！?？。]+/, '').trim();
    if (command) return { command: command.slice(0, maxTranscriptChars), wakePhrase: phrase };
  }
  return undefined;
}

function duplicate(command, now) {
  if (duplicateWindowMs === 0) return false;
  const key = createHash('sha256').update(command.toLocaleLowerCase()).digest('hex');
  for (const [hash, timestamp] of recentCommands) if (now - timestamp > duplicateWindowMs) recentCommands.delete(hash);
  const previous = recentCommands.get(key);
  recentCommands.set(key, now);
  return previous !== undefined && now - previous <= duplicateWindowMs;
}

function transcriptMessage(message) {
  if (message?.type !== 'transcript' || typeof message.text !== 'string') return;
  listenerLastTranscriptAt = new Date().toISOString();
  const extracted = commandFromTranscript(message.text);
  if (!extracted) return;
  const now = Date.now();
  if (duplicate(extracted.command, now)) return;
  eventSequence += 1;
  const identity = createHash('sha256').update(`${now}:${eventSequence}:${extracted.command}`).digest('hex').slice(0, 32);
  write({
    type: 'event',
    externalId: `voice:${identity}`,
    kind: 'command',
    priority: 100,
    occurredAt: new Date(now).toISOString(),
    actor: { id: 'owner-voice' },
    conversation: { id: 'voice-owner' },
    replyTarget: 'default',
    payload: {
      type: 'voice_command',
      text: extracted.command,
      transcript: message.text.slice(0, maxTranscriptChars),
      wakePhrase: extracted.wakePhrase,
      locale: message.locale || locale,
      onDevice: message.onDevice === true,
      untrusted: true,
    },
  });
}

function scheduleListenerRestart() {
  if (!listenerDesired || listenerRestartTimer) return;
  listenerRestartCount += 1;
  const delay = Math.min(30_000, 1_000 * (2 ** Math.min(listenerRestartCount - 1, 5)));
  listenerRestartTimer = setTimeout(() => {
    listenerRestartTimer = undefined;
    startListener();
  }, delay);
  listenerRestartTimer.unref();
}

function startListener() {
  listenerDesired = true;
  if (listener || listenerRestartTimer) return;
  listenerReady = false;
  listenerStartedAt = new Date().toISOString();
  const child = spawn(swift, listenerArgs(), {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  listener = child;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 1_000_000) { listenerLastError = 'listener output exceeded 1MB'; child.kill('SIGKILL'); return; }
    while (stdout.includes('\n')) {
      const newline = stdout.indexOf('\n');
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message?.type === 'ready') { listenerReady = true; listenerRestartCount = 0; listenerLastError = ''; }
        else if (message?.type === 'error') listenerLastError = String(message.error || 'listener recognition error').slice(0, 1_000);
        else transcriptMessage(message);
      } catch { listenerLastError = `listener returned invalid JSON: ${line.slice(0, 500)}`; }
    }
  });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
  child.once('error', (error) => {
    listenerLastError = errorText(error);
    if (listener === child) {
      listener = undefined;
      listenerReady = false;
      scheduleListenerRestart();
    }
  });
  child.once('exit', (code, signal) => {
    if (listener !== child) return;
    listener = undefined;
    listenerReady = false;
    if (code !== 0 && !listenerLastError) listenerLastError = (stderr || `listener exited code=${code} signal=${signal || 'none'}`).trim();
    scheduleListenerRestart();
  });
}

async function stopListener() {
  listenerDesired = false;
  if (listenerRestartTimer) { clearTimeout(listenerRestartTimer); listenerRestartTimer = undefined; }
  const child = listener;
  listener = undefined;
  listenerReady = false;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function status() {
  return {
    desired: listenerDesired,
    running: Boolean(listener && listener.exitCode === null),
    ready: listenerReady,
    locale,
    onDevice,
    segmentSeconds,
    wakePhrases,
    startedAt: listenerStartedAt,
    lastTranscriptAt: listenerLastTranscriptAt,
    lastError: listenerLastError || undefined,
    restartCount: listenerRestartCount,
  };
}

function deliveryOptions(message) {
  const target = typeof message.target === 'string' && message.target.trim()
    ? boundedString(message.target, 'deliver.target', 200, true)
    : 'default';
  const payload = typeof message.payload === 'string' ? { text: message.payload } : payloadObject(message.payload);
  const rawText = typeof payload.text === 'string' ? payload.text : payload.message;
  const text = boundedString(rawText, 'deliver payload.text', 100_000, true);
  const truncated = text.length > replyMaxChars;
  return {
    text: truncated ? `${text.slice(0, replyMaxChars)}。后续内容已省略。` : text,
    voice: target === 'default' ? undefined : target,
    rate: replyRate,
    timeoutMs: commandTimeoutMs,
  };
}

async function speak(options) {
  const resume = listenerDesired;
  if (resume) await stopListener();
  try {
    const args = [];
    if (options.voice) args.push('-v', options.voice);
    args.push('-r', String(options.rate), options.text);
    await runCommand(say, args, options.timeoutMs, 0, false);
  } finally {
    if (resume) startListener();
  }
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type === 'deliver') {
    await speak(deliveryOptions(message));
    return { type: 'delivery_ack', id: message.id, ok: true };
  }
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (typeof message.target !== 'string') throw new Error('action.target is required');
  const options = validate(message.action, message.target, message.payload);
  if (message.action === 'listener_status') return { type: 'action_result', id: message.id, ok: true, result: status() };
  if (message.action === 'listener_start') {
    await persistListenerDesired(true);
    startListener();
    return { type: 'action_result', id: message.id, ok: true, result: status() };
  }
  if (message.action === 'listener_stop') {
    await persistListenerDesired(false);
    await stopListener();
    return { type: 'action_result', id: message.id, ok: true, result: status() };
  }
  if (message.action === 'listener_restart') {
    await persistListenerDesired(true);
    await stopListener();
    startListener();
    return { type: 'action_result', id: message.id, ok: true, result: status() };
  }
  if (message.action === 'list_voices') {
    const output = await runCommand(say, ['-v', '?'], commandTimeoutMs, 500_000);
    const lines = output.toString('utf8').split(/\r?\n/).filter((line) => line.trim());
    return { type: 'action_result', id: message.id, ok: true, result: { voices: lines.slice(0, options.limit).map(parseVoice), total: lines.length, truncated: lines.length > options.limit } };
  }
  if (message.action === 'transcribe_audio') {
    const info = await stat(options.audioPath);
    if (!info.isFile()) throw new Error('audio path must be a regular file');
    if (info.size < 1) throw new Error('audio file is empty');
    if (info.size > options.maxAudioBytes) throw new Error(`audio file exceeds ${options.maxAudioBytes} bytes`);
    const timeoutSeconds = Math.max(1, Math.floor(options.timeoutMs / 1_000));
    const output = await runCommand(swift, [
      recognizerHelper, 'transcribe', options.audioPath, options.locale, String(options.onDevice),
      String(timeoutSeconds), String(options.maxChars), wakePhrases.join('\u001f'),
    ], options.timeoutMs + 2_000, 1_000_000);
    let result;
    try { result = JSON.parse(output.toString('utf8').trim()); }
    catch { throw new Error(`voice recognizer returned invalid JSON: ${output.toString('utf8', 0, 500)}`); }
    return { type: 'action_result', id: message.id, ok: true, result: { ...result, audioPath: options.audioPath, audioBytes: info.size, untrusted: true } };
  }

  await speak(options);
  return { type: 'action_result', id: message.id, ok: true, result: { spoken: true, voice: options.voice || 'default', rate: options.rate, charCount: options.text.length } };
}

process.stdin.setEncoding('utf8');
let input = '';
let actionQueue = (async () => {
  listenerDesired = await readListenerDesired() ?? listenerDesired;
  if (listenerDesired) startListener();
})();
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-voice] input exceeded 1MB; resetting buffer\n');
    input = '';
    return;
  }
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    actionQueue = actionQueue.then(async () => {
      let message;
      try { message = JSON.parse(line); write(await execute(message)); }
      catch (error) {
        write({
          type: message?.type === 'action' ? 'action_result' : 'delivery_ack',
          id: message?.id ?? 'invalid', ok: false, error: errorText(error),
        });
      }
    });
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    listenerDesired = false;
    if (listenerRestartTimer) clearTimeout(listenerRestartTimer);
    if (listener) listener.kill('SIGTERM');
    process.exit(0);
  });
}
