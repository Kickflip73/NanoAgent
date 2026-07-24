import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  securityProfileSummary,
  type AppConfig,
  type SecurityProfileSummary,
} from '../config.js';
import { mimiPaths } from './client-runtime.js';
import type { DaemonHealthSnapshot } from './health-model.js';
import type { MimiDoctorReport } from './service.js';

export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1;

const CAPACITY_THRESHOLDS = Object.freeze({
  logWarningBytes: 10 * 1024 * 1024,
  logCriticalBytes: 100 * 1024 * 1024,
  databaseWarningBytes: 512 * 1024 * 1024,
  databaseCriticalBytes: 2 * 1024 * 1024 * 1024,
  memoryWarningBytes: 1024 * 1024 * 1024,
  memoryCriticalBytes: 4 * 1024 * 1024 * 1024,
});

export type DiagnosticCapacityState = 'ok' | 'warning' | 'critical';

export interface DiagnosticFileMetric {
  exists: boolean;
  bytes: number;
  updatedAt?: string;
}

export interface DiagnosticDirectoryMetric extends DiagnosticFileMetric {
  files: number;
  unreadableEntries: number;
}

export interface DiagnosticStorageSnapshot {
  database: DiagnosticFileMetric;
  databaseWal: DiagnosticFileMetric;
  databaseSharedMemory: DiagnosticFileMetric;
  stdoutLog: DiagnosticFileMetric;
  stderrLog: DiagnosticFileMetric;
  memory: DiagnosticDirectoryMetric;
  capacity: {
    state: DiagnosticCapacityState;
    database: DiagnosticCapacityState;
    logs: DiagnosticCapacityState;
    memory: DiagnosticCapacityState;
    thresholds: typeof CAPACITY_THRESHOLDS;
  };
}

export interface RedactedDiagnosticBundle {
  schemaVersion: number;
  generatedAt: string;
  privacy: {
    redacted: true;
    excluded: string[];
  };
  runtime: {
    platform: NodeJS.Platform;
    node: string;
    provider: AppConfig['provider'];
    providerConfigured: boolean;
    securityProfile: SecurityProfileSummary;
  };
  daemon: {
    running: boolean;
    protocolVersion?: number;
    buildVersion?: string;
    startedAt?: string;
    health?: {
      state: 'ready' | 'degraded' | 'unhealthy';
      checkedAt: string;
      risks: Array<{ code: string; severity: 'warning' | 'error' }>;
      backlog: DaemonHealthSnapshot['backlog'];
      connectors: {
        enabled: number;
        online: number;
        ready: number;
        offline: number;
        unavailable: number;
        stale: number;
        unknown: number;
      };
    };
  };
  capabilities: {
    connectors: {
      configured: boolean;
      total: number;
      enabled: number;
      missingScripts: number;
      runtime?: {
        online: number;
        offline: number;
        inboundReady: number;
        outboundReady: number;
        unavailable: number;
      };
    };
    systemBinaries: { total: number; available: number };
    launchAgentInstalled: boolean;
    computer: { configured: boolean; ready?: boolean };
  };
  storage: DiagnosticStorageSnapshot;
}

async function fileMetric(file: string): Promise<DiagnosticFileMetric> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return { exists: false, bytes: 0 };
    return { exists: true, bytes: info.size, updatedAt: info.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, bytes: 0 };
    throw error;
  }
}

async function directoryMetric(root: string): Promise<DiagnosticDirectoryMetric> {
  const result: DiagnosticDirectoryMetric = {
    exists: false,
    bytes: 0,
    files: 0,
    unreadableEntries: 0,
  };
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
      result.exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.unreadableEntries += 1;
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await lstat(target);
        result.files += 1;
        result.bytes += info.size;
        const updatedAt = info.mtime.toISOString();
        if (!result.updatedAt || updatedAt > result.updatedAt) result.updatedAt = updatedAt;
      } catch {
        result.unreadableEntries += 1;
      }
    }
  }
  return result;
}

function capacityState(
  bytes: number,
  warningBytes: number,
  criticalBytes: number,
): DiagnosticCapacityState {
  if (bytes >= criticalBytes) return 'critical';
  if (bytes >= warningBytes) return 'warning';
  return 'ok';
}

function maximumCapacityState(states: DiagnosticCapacityState[]): DiagnosticCapacityState {
  if (states.includes('critical')) return 'critical';
  if (states.includes('warning')) return 'warning';
  return 'ok';
}

export async function buildRedactedDiagnosticBundle(
  config: AppConfig,
  doctor: MimiDoctorReport,
): Promise<RedactedDiagnosticBundle> {
  const storage = await inspectDiagnosticStorage(config);
  const health = doctor.daemon.health;
  return {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    privacy: {
      redacted: true,
      excluded: [
        'event payloads and message bodies',
        'reply targets and recipient identifiers',
        'tokens, credentials, environment values, and Connector arguments',
        'Session transcripts, run answers, and errors',
        'private Memory content and filesystem paths',
      ],
    },
    runtime: {
      platform: doctor.platform,
      node: doctor.node,
      provider: doctor.provider.id,
      providerConfigured: doctor.provider.configured,
      securityProfile: securityProfileSummary(config),
    },
    daemon: {
      running: doctor.daemon.running,
      ...(doctor.daemon.status ? {
        protocolVersion: doctor.daemon.status.protocolVersion,
        ...(doctor.daemon.status.buildVersion ? { buildVersion: doctor.daemon.status.buildVersion } : {}),
        startedAt: doctor.daemon.status.startedAt,
      } : {}),
      ...(health ? {
        health: {
          state: health.state,
          checkedAt: health.checkedAt,
          risks: health.risks.map((risk) => ({ code: risk.code, severity: risk.severity })),
          backlog: health.backlog,
          connectors: {
            enabled: health.connectors.enabled,
            online: health.connectors.online,
            ready: health.connectors.ready,
            offline: health.connectors.offline.length,
            unavailable: health.connectors.unavailable.length,
            stale: health.connectors.stale.length,
            unknown: health.connectors.unknown.length,
          },
        },
      } : {}),
    },
    capabilities: {
      connectors: {
        configured: doctor.connectors.configured,
        total: doctor.connectors.total,
        enabled: doctor.connectors.enabled.length,
        missingScripts: doctor.connectors.missingScripts.length,
        ...(doctor.connectors.runtime ? {
          runtime: {
            online: doctor.connectors.runtime.online.length,
            offline: doctor.connectors.runtime.offline.length,
            inboundReady: doctor.connectors.runtime.inboundReady.length,
            outboundReady: doctor.connectors.runtime.outboundReady.length,
            unavailable: doctor.connectors.runtime.unavailable.length,
          },
        } : {}),
      },
      systemBinaries: {
        total: doctor.systemBinaries.length,
        available: doctor.systemBinaries.filter((binary) => binary.available).length,
      },
      launchAgentInstalled: doctor.launchAgent.installed,
      computer: {
        configured: doctor.computer.configured,
        ...(doctor.computer.ready !== undefined ? { ready: doctor.computer.ready } : {}),
      },
    },
    storage,
  };
}

export async function inspectDiagnosticStorage(config: AppConfig): Promise<DiagnosticStorageSnapshot> {
  const paths = mimiPaths(config);
  const [database, databaseWal, databaseSharedMemory, stdoutLog, stderrLog, memory] = await Promise.all([
    fileMetric(paths.database),
    fileMetric(`${paths.database}-wal`),
    fileMetric(`${paths.database}-shm`),
    fileMetric(paths.stdoutLog),
    fileMetric(paths.stderrLog),
    directoryMetric(path.join(config.dataRoot, 'memory')),
  ]);
  const databaseBytes = database.bytes + databaseWal.bytes + databaseSharedMemory.bytes;
  const logBytes = stdoutLog.bytes + stderrLog.bytes;
  const databaseCapacity = capacityState(
    databaseBytes,
    CAPACITY_THRESHOLDS.databaseWarningBytes,
    CAPACITY_THRESHOLDS.databaseCriticalBytes,
  );
  const logCapacity = capacityState(
    logBytes,
    CAPACITY_THRESHOLDS.logWarningBytes,
    CAPACITY_THRESHOLDS.logCriticalBytes,
  );
  const memoryCapacity = capacityState(
    memory.bytes,
    CAPACITY_THRESHOLDS.memoryWarningBytes,
    CAPACITY_THRESHOLDS.memoryCriticalBytes,
  );
  return {
    database,
    databaseWal,
    databaseSharedMemory,
    stdoutLog,
    stderrLog,
    memory,
    capacity: {
      state: maximumCapacityState([databaseCapacity, logCapacity, memoryCapacity]),
      database: databaseCapacity,
      logs: logCapacity,
      memory: memoryCapacity,
      thresholds: CAPACITY_THRESHOLDS,
    },
  };
}

export async function writeRedactedDiagnosticBundle(
  outputFile: string,
  bundle: RedactedDiagnosticBundle,
): Promise<string> {
  const target = path.resolve(outputFile);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await link(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}
