#!/usr/bin/env node

/**
 * MimiAgent ↔ macOS system health connector.
 *
 * Node built-ins provide memory, load, network and storage snapshots. Battery
 * state comes from pmset through argv-only spawning. It emits only state edges.
 */

import { spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const pmset = process.env.MACOS_SYSTEM_PMSET || '/usr/bin/pmset';
const pollIntervalMs = numberEnv('MACOS_SYSTEM_POLL_INTERVAL_MS', 300_000, 0, 86_400_000);
const commandTimeoutMs = numberEnv('MACOS_SYSTEM_COMMAND_TIMEOUT_MS', 10_000, 1_000, 120_000);
const batteryLowPercent = numberEnv('MACOS_SYSTEM_BATTERY_LOW_PERCENT', 20, 1, 100);
const batteryCriticalPercent = Math.min(
  batteryLowPercent,
  numberEnv('MACOS_SYSTEM_BATTERY_CRITICAL_PERCENT', 10, 1, 100),
);
const diskMinPercent = numberEnv('MACOS_SYSTEM_DISK_MIN_PERCENT', 10, 0, 100);
const diskMinBytes = numberEnv('MACOS_SYSTEM_DISK_MIN_GB', 10, 0, 100_000) * 1024 ** 3;
const configuredDiskPath = process.env.MACOS_SYSTEM_DISK_PATH || '/';
const diskPath = path.isAbsolute(configuredDiskPath) ? configuredDiskPath : '/';

const ACTIONS = new Set(['system_snapshot', 'battery_status', 'network_status', 'storage_status']);

function numberEnv(name, fallback, minimum, maximum) {
  if (!process.env[name]) return fallback;
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    process.stderr.write(`[macos-system] invalid ${name}; using ${fallback}\n`);
    return fallback;
  }
  return value;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function localDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, commandTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > 100_000) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${path.basename(command)} timed out after ${commandTimeoutMs}ms`));
      if (overflow) return reject(new Error(`${path.basename(command)} output exceeds 100000 bytes`));
      if (code !== 0) {
        return reject(new Error((stderr || `${path.basename(command)} exited code=${code} signal=${signal || 'none'}`).trim()));
      }
      resolve(stdout);
    });
  });
}

function parseBattery(output) {
  const source = /Now drawing from '([^']+)'/i.exec(output)?.[1]?.toLowerCase() ?? '';
  const detail = /(\d{1,3})%;\s*([^;\n]+)(?:;\s*([^;\n]+))?/i.exec(output);
  if (!detail) return { available: false, powerSource: source.includes('battery') ? 'battery' : 'ac' };
  const percent = Math.max(0, Math.min(100, Number(detail[1])));
  const state = String(detail[2] ?? 'unknown').trim().toLowerCase();
  const estimate = String(detail[3] ?? '');
  const remaining = /(\d+):(\d+)\s+remaining/i.exec(estimate);
  return {
    available: true,
    percent,
    powerSource: source.includes('battery') ? 'battery' : source.includes('ac') ? 'ac' : 'unknown',
    state,
    charging: state.includes('charging') && !state.includes('discharging'),
    ...(remaining ? { timeRemainingMinutes: Number(remaining[1]) * 60 + Number(remaining[2]) } : {}),
  };
}

async function batteryStatus() {
  return parseBattery(await runCommand(pmset, ['-g', 'batt']));
}

async function safeBatteryStatus() {
  try {
    return await batteryStatus();
  } catch {
    return { available: false, powerSource: 'unknown' };
  }
}

function networkStatus() {
  const interfaces = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces()).sort(([left], [right]) => left.localeCompare(right))) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      interfaces.push({ name, family: address.family, address: address.address });
      if (interfaces.length >= 64) break;
    }
    if (interfaces.length >= 64) break;
  }
  return { online: interfaces.length > 0, interfaces };
}

async function storageStatus(target = diskPath) {
  if (!path.isAbsolute(target) || target.length > 4096) throw new Error('storage target must be an absolute path');
  const stats = await statfs(target, { bigint: true });
  const totalBytes = Number(stats.bsize * stats.blocks);
  const freeBytes = Number(stats.bsize * stats.bavail);
  return {
    path: target,
    totalBytes,
    freeBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes),
    freePercent: totalBytes > 0 ? round(freeBytes / totalBytes * 100) : 0,
  };
}

function runtimeStatus() {
  const totalBytes = safeSystemMetric(() => os.totalmem(), 0);
  const freeBytes = safeSystemMetric(() => os.freemem(), 0);
  return {
    uptimeSeconds: Math.floor(safeSystemMetric(() => os.uptime(), 0)),
    memory: {
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freePercent: totalBytes > 0 ? round(freeBytes / totalBytes * 100) : 0,
    },
    loadAverage: safeSystemMetric(() => os.loadavg(), [0, 0, 0]).map((value) => round(value)),
    logicalCpuCount: safeSystemMetric(() => os.cpus().length, 0),
  };
}

function safeSystemMetric(read, fallback) {
  try {
    return read();
  } catch {
    return fallback;
  }
}

async function systemSnapshot() {
  const [battery, storage] = await Promise.all([safeBatteryStatus(), storageStatus()]);
  return {
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    ...runtimeStatus(),
    battery,
    network: networkStatus(),
    storage,
  };
}

function validateTarget(action, target) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('action.target is required');
  if (action === 'storage_status') return target === 'default' || target === 'storage' ? diskPath : target;
  const expected = action === 'battery_status' ? 'battery'
    : action === 'network_status' ? 'network'
      : 'system';
  if (![expected, 'all'].includes(target)) throw new Error(`${action} target must be ${expected} or all`);
  return target;
}

async function execute(message) {
  if (!message || typeof message !== 'object') throw new Error('message must be an object');
  if (typeof message.id !== 'string' || !message.id) throw new Error('message.id is required');
  if (message.type !== 'action') throw new Error(`unsupported message type: ${String(message.type)}`);
  if (!ACTIONS.has(message.action)) throw new Error(`unsupported action: ${String(message.action)}`);
  const target = validateTarget(message.action, message.target);
  const result = message.action === 'system_snapshot' ? await systemSnapshot()
    : message.action === 'battery_status' ? await batteryStatus()
      : message.action === 'network_status' ? networkStatus()
        : await storageStatus(target);
  return { type: 'action_result', id: message.id, ok: true, result };
}

function batteryBand(battery) {
  if (!battery.available) return 'unavailable';
  if (battery.powerSource !== 'battery' || battery.charging) return 'charging';
  if (battery.percent <= batteryCriticalPercent) return 'critical';
  if (battery.percent <= batteryLowPercent) return 'low';
  return 'normal';
}

function storageLow(storage) {
  return (diskMinPercent > 0 && storage.freePercent <= diskMinPercent)
    || (diskMinBytes > 0 && storage.freeBytes <= diskMinBytes);
}

let lastBatteryBand;
let lastNetworkOnline;
let lastStorageLow;
let polling = false;
let lastPollError = '';

async function poll() {
  if (polling || pollIntervalMs === 0) return;
  polling = true;
  try {
    const snapshot = await systemSnapshot();
    const now = new Date();
    const occurredAt = now.toISOString();
    const date = localDate(now);
    const currentBatteryBand = batteryBand(snapshot.battery);
    if (currentBatteryBand !== lastBatteryBand && ['low', 'critical'].includes(currentBatteryBand)) {
      write({
        type: 'event', externalId: `battery:${currentBatteryBand}:${date}`,
        kind: 'alert', priority: currentBatteryBand === 'critical' ? 100 : 85, occurredAt,
        payload: { type: `battery_${currentBatteryBand}`, battery: snapshot.battery },
      });
    }
    lastBatteryBand = currentBatteryBand;

    if (lastNetworkOnline !== undefined && snapshot.network.online !== lastNetworkOnline) {
      write({
        type: 'event', externalId: `network:${snapshot.network.online ? 'restored' : 'offline'}:${occurredAt}`,
        kind: snapshot.network.online ? 'ambient' : 'alert',
        priority: snapshot.network.online ? 45 : 90, occurredAt,
        payload: {
          type: snapshot.network.online ? 'network_restored' : 'network_offline',
          network: snapshot.network,
        },
      });
    }
    lastNetworkOnline = snapshot.network.online;

    const currentStorageLow = storageLow(snapshot.storage);
    if (currentStorageLow && lastStorageLow !== true) {
      write({
        type: 'event', externalId: `storage:low:${date}:${snapshot.storage.path}`,
        kind: 'alert', priority: 90, occurredAt,
        payload: { type: 'storage_low', storage: snapshot.storage },
      });
    }
    lastStorageLow = currentStorageLow;
    lastPollError = '';
  } catch (error) {
    const message = errorText(error);
    if (message !== lastPollError) process.stderr.write(`[macos-system] poll failed: ${message}\n`);
    lastPollError = message;
  } finally {
    polling = false;
  }
}

process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1_000_000) {
    process.stderr.write('[macos-system] input exceeded 1MB; resetting buffer\n');
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
        write(await execute(message));
      } catch (error) {
        write({ type: 'action_result', id: message?.id ?? 'invalid', ok: false, error: errorText(error) });
      }
    })();
  }
});

let pollTimer;
if (pollIntervalMs > 0) {
  void poll();
  pollTimer = setInterval(() => void poll(), pollIntervalMs);
  pollTimer.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (pollTimer) clearInterval(pollTimer);
    process.exit(0);
  });
}
