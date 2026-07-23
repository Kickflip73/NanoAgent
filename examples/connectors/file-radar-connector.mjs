#!/usr/bin/env node

/**
 * MimiAgent file activity radar connector.
 * Bounded metadata-only polling for local drop folders, Downloads and shared inboxes.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const configPath = process.env.MIMI_FILE_RADAR_CONFIG;
if (!configPath) {
  process.stderr.write('[file-radar] missing MIMI_FILE_RADAR_CONFIG\n');
  process.exit(1);
}

let config;
try {
  config = await loadConfig(configPath);
} catch (error) {
  process.stderr.write(`[file-radar] invalid config: ${errorText(error)}\n`);
  process.exit(1);
}

const pollIntervalMs = integer(
  process.env.FILE_RADAR_POLL_INTERVAL_MS ?? config.pollIntervalMs,
  'pollIntervalMs', 0, 86_400_000,
);
let polling = false;
const lastErrors = new Map();
const stableCandidates = new Map();

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function integer(value, label, minimum, maximum, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function boolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function extensions(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array with at most 100 items`);
  }
  return [...new Set(value.map((item) => {
    const normalized = item.trim().toLocaleLowerCase();
    return normalized.startsWith('.') ? normalized : `.${normalized}`;
  }))];
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function configuredPath(value, file) {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(path.dirname(file), expanded);
}

async function loadConfig(file) {
  const raw = object(JSON.parse(await readFile(file, 'utf8')), 'config');
  if (raw.version !== 1) throw new Error('config.version must be 1');
  if (!Array.isArray(raw.watches) || raw.watches.length < 1 || raw.watches.length > 50) {
    throw new Error('config.watches must contain 1 to 50 watches');
  }
  const ids = new Set();
  const watches = raw.watches.map((candidate, index) => {
    const watch = object(candidate, `watches[${index}]`);
    const id = text(watch.id, `watches[${index}].id`);
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`invalid watch id: ${id}`);
    if (ids.has(id)) throw new Error(`duplicate watch id: ${id}`);
    ids.add(id);
    const kind = watch.kind ?? 'ambient';
    if (!['ambient', 'alert', 'command'].includes(kind)) throw new Error(`${id}.kind must be ambient, alert or command`);
    return {
      id,
      path: configuredPath(text(watch.path, `${id}.path`), file),
      recursive: boolean(watch.recursive, `${id}.recursive`, false),
      maxDepth: integer(watch.maxDepth, `${id}.maxDepth`, 0, 8, watch.recursive ? 2 : 0),
      ignoreHidden: boolean(watch.ignoreHidden, `${id}.ignoreHidden`, true),
      extensions: extensions(watch.extensions, `${id}.extensions`),
      kind,
      priority: integer(watch.priority, `${id}.priority`, 0, 100, kind === 'alert' ? 90 : 50),
    };
  });
  return {
    watches,
    pollIntervalMs: integer(raw.pollIntervalMs, 'pollIntervalMs', 0, 86_400_000, 30_000),
    lookbackMinutes: integer(raw.lookbackMinutes, 'lookbackMinutes', 1, 43_200, 60),
    maxEventsPerPoll: integer(raw.maxEventsPerPoll, 'maxEventsPerPoll', 1, 500, 100),
    maxScanEntries: integer(raw.maxScanEntries, 'maxScanEntries', 1, 100_000, 5_000),
  };
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function matchesExtension(filename, allowed) {
  if (allowed.length === 0) return true;
  const lower = filename.toLocaleLowerCase();
  return allowed.some((extension) => lower.endsWith(extension));
}

function metadata(watch, absolutePath, relativePath, stats) {
  return {
    watchId: watch.id,
    path: absolutePath,
    relativePath,
    name: path.basename(absolutePath),
    extension: path.extname(absolutePath).toLocaleLowerCase(),
    size: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    activity: 'created_or_modified',
  };
}

async function scanWatch(watch, sinceMs) {
  const files = [];
  const state = { visited: 0, truncated: false };
  async function walk(directory, depth) {
    if (state.truncated) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      state.visited += 1;
      if (state.visited > config.maxScanEntries) {
        state.truncated = true;
        break;
      }
      if (watch.ignoreHidden && entry.name.startsWith('.')) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (watch.recursive && depth < watch.maxDepth) await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matchesExtension(entry.name, watch.extensions)) continue;
      try {
        const stats = await lstat(absolutePath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.mtimeMs < sinceMs) continue;
        files.push(metadata(watch, absolutePath, path.relative(watch.path, absolutePath), stats));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  await walk(watch.path, 0);
  return { watchId: watch.id, files, visited: state.visited, truncated: state.truncated };
}

function selectWatches(target) {
  if (target === 'all' || target === '*') return config.watches;
  const watch = config.watches.find((candidate) => candidate.id === target);
  if (!watch) throw new Error(`watch not found: ${target}`);
  return [watch];
}

async function scan(target, sinceMs, limit, emit) {
  const selected = selectWatches(target);
  const results = await Promise.all(selected.map(async (watch) => {
    try {
      const result = await scanWatch(watch, sinceMs);
      lastErrors.delete(watch.id);
      return result;
    } catch (error) {
      const reason = errorText(error);
      if (lastErrors.get(watch.id) !== reason) process.stderr.write(`[file-radar:${watch.id}] ${reason}\n`);
      lastErrors.set(watch.id, reason);
      return { watchId: watch.id, files: [], visited: 0, truncated: false, error: reason };
    }
  }));
  const allFiles = results.flatMap((result) => result.files)
    .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  const files = allFiles.slice(0, limit);
  const truncated = results.some((result) => result.truncated) || allFiles.length > files.length;
  const stableFiles = [];
  if (emit) {
    const observed = new Set();
    for (const file of files) {
      const key = `${file.watchId}\u0000${file.path}`;
      const signature = `${file.modifiedAt}\u0000${file.size}`;
      observed.add(key);
      if (stableCandidates.get(key) === signature) stableFiles.push(file);
      stableCandidates.set(key, signature);
    }
    const selectedIds = new Set(selected.map((watch) => watch.id));
    for (const key of stableCandidates.keys()) {
      const watchId = key.slice(0, key.indexOf('\u0000'));
      if (selectedIds.has(watchId) && !observed.has(key)) stableCandidates.delete(key);
    }
    for (const file of [...stableFiles].reverse()) {
      const watch = config.watches.find((candidate) => candidate.id === file.watchId);
      write({
        type: 'event',
        externalId: `file:${file.watchId}:${hash(`${file.path}:${file.modifiedAt}:${file.size}`)}`,
        kind: watch.kind,
        priority: watch.priority,
        occurredAt: file.modifiedAt,
        conversation: { id: `file-watch-${file.watchId}` },
        payload: { type: 'file_activity', ...file },
      });
    }
  }
  return {
    files,
    watches: results.map(({ watchId, visited, truncated: watchTruncated, error, files: matched }) => ({
      id: watchId, visited, matched: matched.length, truncated: watchTruncated, error,
    })),
    truncated,
    ...(emit ? { emitted: stableFiles.length, pendingStability: files.length - stableFiles.length } : {}),
  };
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function payloadObject(value) {
  if (value === undefined) return {};
  return object(value, 'payload');
}

async function action(message) {
  if (typeof message.id !== 'string' || !message.id) throw new Error('action.id is required');
  if (typeof message.target !== 'string' || !message.target) throw new Error('action.target is required');
  const payload = payloadObject(message.payload);
  if (message.action === 'watches') {
    return { watches: selectWatches(message.target).map((watch) => ({
      id: watch.id, path: watch.path, recursive: watch.recursive, maxDepth: watch.maxDepth,
      ignoreHidden: watch.ignoreHidden, extensions: watch.extensions, kind: watch.kind, priority: watch.priority,
    })) };
  }
  if (message.action === 'scan_now') {
    return scan(message.target, Date.now() - config.lookbackMinutes * 60_000, config.maxEventsPerPoll, true);
  }
  if (message.action === 'recent_files') {
    const limit = integer(payload.limit, 'payload.limit', 1, 200, 50);
    const hours = integer(payload.hours, 'payload.hours', 1, 720, Math.max(1, Math.ceil(config.lookbackMinutes / 60)));
    return scan(message.target, Date.now() - hours * 3_600_000, limit, false);
  }
  throw new Error(`unsupported action: ${String(message.action)}`);
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[file-radar] input exceeded 1MB; resetting buffer\n');
    input = '';
    return;
  }
  while (input.includes('\n')) {
    const newline = input.indexOf('\n');
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
        if (message?.type !== 'action') throw new Error(`unsupported message type: ${String(message?.type)}`);
        write({ type: 'action_result', id: message.id, ok: true, result: await action(message) });
      } catch (error) {
        write({ type: 'action_result', id: message?.id ?? 'invalid', ok: false, error: errorText(error) });
      }
    })();
  }
});

async function poll() {
  if (polling || pollIntervalMs === 0) return;
  polling = true;
  try {
    await scan('all', Date.now() - config.lookbackMinutes * 60_000, config.maxEventsPerPoll, true);
  } finally {
    polling = false;
  }
}

let timer;
if (pollIntervalMs > 0) {
  void poll();
  timer = setInterval(() => void poll(), pollIntervalMs);
  timer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (timer) clearInterval(timer);
    process.exit(0);
  });
}
