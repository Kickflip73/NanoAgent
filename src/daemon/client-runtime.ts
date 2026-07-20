import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  preferredEnvironmentValue,
  type AgentPermissionMode,
  type AppConfig,
} from '../config.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from './types.js';
import {
  PRE_MIMI_DAEMON_DIRECTORY,
  PRE_MIMI_DAEMON_FILES,
  PRE_MIMI_DATA_DIRECTORY,
} from '../core/mimi-legacy.js';

export type DaemonStatusWire = Omit<DaemonStatus, 'protocolVersion'> & { protocolVersion?: unknown };
export type DaemonProtocolState = 'legacy' | 'current' | 'newer';

export const MIMI_BUILD_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    };
    const version = typeof manifest.version === 'string' ? manifest.version : 'unknown';
    const modulePath = fileURLToPath(import.meta.url);
    const digest = createHash('sha256')
      .update(readFileSync(modulePath))
      .update(String(statSync(modulePath).mtimeMs))
      .digest('hex')
      .slice(0, 12);
    return `${version}+${digest}`;
  } catch {
    return 'unknown';
  }
})();

export interface MimiPaths {
  root: string;
  database: string;
  socket: string;
  stdoutLog: string;
  stderrLog: string;
  connectorsConfig: string;
  assistantConfig: string;
}

function daemonConfigPath(primary: string, fallback: string): string {
  const value = preferredEnvironmentValue(primary);
  if (!value) return path.resolve(fallback);
  if (value === '~') return os.homedir();
  if (/^~[\\/]/.test(value)) return path.resolve(os.homedir(), value.slice(2));
  if (value.startsWith('~')) throw new Error(`${primary} 中的 ~ 只支持 ~/path 形式`);
  return path.resolve(value);
}

export function mimiPaths(config: AppConfig): MimiPaths {
  const root = path.resolve(config.daemonDataRoot ?? path.join(config.dataRoot, 'mimi'));
  const compatibleFile = (modern: string, legacy: string): string => {
    const modernPath = path.join(root, modern);
    return !existsSync(modernPath) && existsSync(path.join(root, legacy))
      ? path.join(root, legacy)
      : modernPath;
  };
  return {
    root,
    database: compatibleFile('mimi.db', PRE_MIMI_DAEMON_FILES.database),
    socket: compatibleFile('mimi.sock', PRE_MIMI_DAEMON_FILES.socket),
    stdoutLog: compatibleFile('mimi.out.log', PRE_MIMI_DAEMON_FILES.stdoutLog),
    stderrLog: compatibleFile('mimi.err.log', PRE_MIMI_DAEMON_FILES.stderrLog),
    connectorsConfig: daemonConfigPath(
      'MIMI_CONNECTORS_CONFIG', path.join(root, 'connectors.json'),
    ),
    assistantConfig: daemonConfigPath(
      'MIMI_ASSISTANT_CONFIG', path.join(root, 'assistant.json'),
    ),
  };
}

export function migrateLegacyMimiDaemon(config: AppConfig, homeDirectory = os.homedir()): AppConfig {
  const legacyRoot = path.join(homeDirectory, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY);
  const modernRoot = path.join(homeDirectory, '.mimi-agent', 'daemon');
  const configuredRoot = path.resolve(config.daemonDataRoot ?? path.join(config.dataRoot, 'mimi'));
  const migratingLegacyDirectory = configuredRoot === path.resolve(legacyRoot);
  let root = configuredRoot;
  if (migratingLegacyDirectory) {
    mkdirSync(path.dirname(modernRoot), { recursive: true, mode: 0o700 });
    if (existsSync(modernRoot)) {
      if (readdirSync(modernRoot).length) {
        throw new Error(`MimiAgent 新旧 Daemon 数据目录同时存在且非空：${modernRoot} / ${legacyRoot}`);
      }
      rmdirSync(modernRoot);
    }
    renameSync(legacyRoot, modernRoot);
    root = modernRoot;
  }
  const renames = [
    [PRE_MIMI_DAEMON_FILES.database, 'mimi.db'],
    [PRE_MIMI_DAEMON_FILES.socket, 'mimi.sock'],
    [PRE_MIMI_DAEMON_FILES.stdoutLog, 'mimi.out.log'],
    [PRE_MIMI_DAEMON_FILES.stderrLog, 'mimi.err.log'],
  ] as const;
  for (const [legacy, modern] of renames) {
    const from = path.join(root, legacy);
    const to = path.join(root, modern);
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      if (migratingLegacyDirectory) {
        throw new Error(`MimiAgent 新旧 Daemon 文件同时存在：${to} / ${from}`);
      }
      continue;
    }
    renameSync(from, to);
  }
  return root === path.resolve(config.daemonDataRoot ?? path.join(config.dataRoot, 'mimi'))
    ? config
    : { ...config, daemonDataRoot: root };
}

export function daemonProtocolState(status: { protocolVersion?: unknown }): DaemonProtocolState {
  const version = status.protocolVersion;
  if (version === DAEMON_PROTOCOL_VERSION) return 'current';
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > DAEMON_PROTOCOL_VERSION) {
    return 'newer';
  }
  return 'legacy';
}

export function daemonHasActiveWork(
  status: {
    activeEventId?: unknown;
    activeEventIds?: unknown;
    activeEventCount?: unknown;
    activeHostMutations?: unknown;
    activeTaskCount?: unknown;
    tasks?: unknown;
    events?: unknown;
    outbox?: unknown;
  },
): boolean {
  const positiveCount = (value: unknown): boolean => typeof value === 'number' && value > 0;
  const count = (value: unknown, key: string): unknown => value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
  return Boolean(status.activeEventId)
    || (Array.isArray(status.activeEventIds) && status.activeEventIds.length > 0)
    || positiveCount(status.activeEventCount)
    || positiveCount(status.activeHostMutations)
    || positiveCount(status.activeTaskCount)
    || positiveCount(count(status.tasks, 'running'))
    // Protocol <= 6 stored execution state on Events. Keep this read-only
    // fallback so upgrade safety can detect an old daemon's in-flight work.
    || positiveCount(count(status.events, 'running'))
    || positiveCount(count(status.outbox, 'sending'));
}

export function assertDaemonWorkspace(
  workspaceRoot: unknown,
  expectedWorkspaceRoot: string,
): asserts workspaceRoot is string {
  const local = path.resolve(expectedWorkspaceRoot);
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new Error([
      'MimiAgent 后台未返回真实工作区，可能仍在运行旧版本；为避免误操作已拒绝连接。',
      '请先执行 mimi daemon stop，再升级并从目标工作区重新运行 mimi。',
    ].join('\n'));
  }
  const remote = path.resolve(workspaceRoot);
  if (remote === local) return;
  throw new Error([
    `MimiAgent 后台工作区不一致：后台=${remote}，当前=${local}；为避免误操作已拒绝连接。`,
    '请回到后台工作区使用，或先执行 mimi daemon stop，再从目标工作区重新运行 mimi。',
  ].join('\n'));
}

export function daemonProtocolAction(
  status: DaemonStatusWire,
  expectedPermissionMode: AgentPermissionMode,
): 'reuse' | 'upgrade' {
  const state = daemonProtocolState(status);
  const permissionMismatch = state === 'current' && status.permissionMode !== expectedPermissionMode;
  const buildMismatch = state === 'current' && status.buildVersion !== MIMI_BUILD_VERSION;
  if (state === 'current' && !permissionMismatch && !buildMismatch) return 'reuse';
  if (state === 'newer') {
    throw new Error(
      `MimiAgent 后台协议版本 ${String(status.protocolVersion)} 高于当前 CLI ${DAEMON_PROTOCOL_VERSION}；请升级 CLI，当前后台未被停止。`,
    );
  }
  if (daemonHasActiveWork(status)) {
    const active = status.activeEventId ? `（活动事件 ${status.activeEventId}）` : '';
    const configuration = permissionMismatch
      ? `（后台执行档位 ${String(status.permissionMode ?? 'unknown')}，当前配置 ${expectedPermissionMode}）`
      : buildMismatch
        ? `（后台构建 ${String(status.buildVersion ?? 'unknown')}，当前构建 ${MIMI_BUILD_VERSION}）`
        : '';
    throw new Error(
      `MimiAgent 后台需要升级${configuration}，但仍有活动任务${active}；为避免中断外部事务，等待任务完成后重试。`,
    );
  }
  return 'upgrade';
}
