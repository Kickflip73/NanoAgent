import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { access, chmod, link, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import {
  preferredEnvironmentValue,
  resolveEnvironmentFile,
  type AgentPermissionMode,
  type AppConfig,
} from '../config.js';
import { MimiAgent } from '../agent.js';
import type { Memory } from '../core/memory.js';
import { assertSessionId } from '../core/session-id.js';
import { configureAgentRuntime, requireProviderApiKey } from '../runtime/bootstrap.js';
import { MimiHost } from '../runtime/mimi-host.js';
import { MimiDispatcher } from './dispatcher.js';
import {
  ConnectorManager,
  parseConnectorConfig,
  type ConnectorCapability,
  type ConnectorFileConfig,
} from './connectors.js';
import { connectorCapabilitySnapshot } from './connector-action-tool.js';
import {
  WORKER_CONNECTOR_ACTION_METHOD,
  WORKER_CONNECTOR_INSPECT_METHOD,
  workerConnectorActionParamsSchema,
  workerConnectorInspectParamsSchema,
} from './connector-worker-rpc.js';
import {
  ensureControlToken,
  mimiRpc,
  MimiIpcServer,
  readControlToken,
} from './ipc.js';
import { NotifierRegistry } from './notifier.js';
import { MimiStore } from './store.js';
import { MimiWebhookServer } from './webhook.js';
import { AttentionEngine } from './attention.js';
import { TaskProcessSupervisor } from './task-supervisor.js';
import { backgroundTaskSummary } from './task-tools.js';
import { createMimiCommandHostTools } from './host-tools.js';
import {
  MimiLiveEvents,
  mimiRuntimeStreamEvent,
  mimiStreamEvent,
  mimiStreamTaskState,
} from './live-events.js';
import { ownerSessionId } from './policy.js';
import {
  assertDaemonWorkspace,
  daemonHasActiveWork,
  daemonProtocolAction,
  daemonProtocolState,
  MIMI_BUILD_VERSION,
  migrateLegacyMimiDaemon,
  mimiPaths,
  type DaemonStatusWire,
  type MimiPaths,
} from './client-runtime.js';
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonStatus,
  type EventEnvelope,
  type EventKind,
  type EventTrust,
  type MimiActivitySnapshot,
  type MimiChatSnapshot,
  type MimiHistoryChunk,
  type MimiMemoryContentChunk,
  type MimiMemoryPage,
  type MimiSchedulePage,
  type ReplyRoute,
  type ScheduleRecord,
} from './types.js';

export {
  assertDaemonWorkspace,
  daemonHasActiveWork,
  daemonProtocolAction,
  daemonProtocolState,
  MIMI_BUILD_VERSION,
  mimiPaths,
} from './client-runtime.js';
export type { DaemonProtocolState, MimiPaths } from './client-runtime.js';

export class DaemonMutationGate {
  private activeCount = 0;
  private accepting = true;
  private readonly idleWaiters = new Set<() => void>();

  get active(): number {
    return this.activeCount;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) throw new Error('MimiAgent 正在关闭，不再接受新的管理事务');
    this.activeCount += 1;
    try {
      return await operation();
    } finally {
      this.activeCount -= 1;
      if (this.activeCount === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  beginShutdown(): boolean {
    if (this.activeCount > 0) return false;
    this.accepting = false;
    return true;
  }

  async closeAndWait(): Promise<void> {
    this.accepting = false;
    if (this.activeCount === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }
}

export function daemonProcessIsLive(
  pid: number,
  probe: (pid: number) => void = (candidate) => process.kill(candidate, 0),
): boolean {
  try {
    probe(pid);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function assertDaemonControlAuth(expected: string, supplied: string | undefined): void {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const suppliedDigest = createHash('sha256').update(supplied ?? '').digest();
  if (!timingSafeEqual(expectedDigest, suppliedDigest)) {
    throw new Error('MimiAgent IPC 控制认证失败');
  }
}

export function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

function chatSessionId(params: Record<string, unknown>): string {
  if (params.sessionKey !== undefined) {
    return assertSessionId(requiredString(params.sessionKey, 'sessionKey'));
  }
  return ownerSessionId(
    typeof params.profileId === 'string' && params.profileId.trim() ? params.profileId.trim() : 'owner',
  );
}

export async function createMimiChatSnapshot(
  host: Pick<MimiHost, 'snapshot'>,
  sessionId: string,
  workspaceRoot: string,
  itemLimit = 30,
): Promise<MimiChatSnapshot> {
  const snapshot = await host.snapshot(sessionId);
  return {
    sessionId: snapshot.sessionId,
    workspaceRoot,
    provider: snapshot.runtime.provider,
    model: snapshot.runtime.model,
    mode: snapshot.runtime.mode.label,
    outputLevel: snapshot.runtime.outputLevel,
    contextUsed: snapshot.context.estimatedTokens,
    contextWindow: snapshot.context.contextWindow,
    items: boundedChatItems(snapshot.items, itemLimit),
    plan: snapshot.plan.slice(0, 20).map((step) => ({
      ...step,
      id: step.id.slice(0, 100),
      description: step.description.slice(0, 1_000),
    })),
    recovery: snapshot.recovery,
  };
}

const CHAT_SNAPSHOT_MAX_BYTES = 512 * 1024;
const HISTORY_CHUNK_CHARACTERS = 256 * 1024;
const MEMORY_PAGE_MAX_BYTES = 256 * 1024;
const MEMORY_CONTENT_MAX_BYTES = 64 * 1024;

function boundedChatItems(items: MimiChatSnapshot['items'], itemLimit: number): MimiChatSnapshot['items'] {
  const limit = Math.max(1, Math.min(200, Math.trunc(itemLimit)));
  const selected = items.filter((item) => (
    'role' in item && (item.role === 'user' || item.role === 'assistant')
  )).slice(-limit);
  while (selected.length > 1 && Buffer.byteLength(JSON.stringify(selected), 'utf8') > CHAT_SNAPSHOT_MAX_BYTES) {
    selected.shift();
  }
  if (Buffer.byteLength(JSON.stringify(selected), 'utf8') <= CHAT_SNAPSHOT_MAX_BYTES) return selected;
  const last = selected.at(-1);
  if (!last || !('role' in last) || (last.role !== 'user' && last.role !== 'assistant')) return [];
  return [{
    role: last.role,
    content: '[最近一条对话超过 CLI 快照上限；请使用 /history 分块读取完整权威历史。]',
  } as MimiChatSnapshot['items'][number]];
}

export async function createMimiHistoryChunk(
  host: Pick<MimiHost, 'snapshot'>,
  sessionId: string,
  offset = 0,
  expectedRevision?: string,
): Promise<MimiHistoryChunk> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('history offset 必须是非负安全整数');
  const snapshot = await host.snapshot(sessionId);
  const source = JSON.stringify(snapshot.items);
  const revision = createHash('sha256').update(source).digest('hex');
  if (expectedRevision && expectedRevision !== revision) throw new Error('Session 历史在读取期间发生变化，请重试 /history');
  if (offset > source.length) throw new Error('history offset 超出当前 Session 历史');
  const end = Math.min(source.length, offset + HISTORY_CHUNK_CHARACTERS);
  return {
    chunk: source.slice(offset, end),
    nextOffset: end < source.length ? end : undefined,
    revision,
    totalCharacters: source.length,
  };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function boundedOptional(value: string | undefined, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : truncateUtf8(value, maximumBytes);
}

function memoryRevision(memories: Memory[]): string {
  return createHash('sha256').update(JSON.stringify(memories)).digest('hex');
}

function memoryItem(memory: Memory, index: number): MimiMemoryPage['items'][number] {
  const contentBytes = Buffer.byteLength(memory.content);
  return {
    index,
    id: truncateUtf8(memory.id, 100),
    type: memory.type,
    content: truncateUtf8(memory.content, MEMORY_CONTENT_MAX_BYTES),
    contentBytes,
    contentTruncated: contentBytes > MEMORY_CONTENT_MAX_BYTES,
    createdAt: truncateUtf8(memory.createdAt, 100),
    updatedAt: boundedOptional(memory.updatedAt, 100),
    importance: memory.importance,
    source: memory.source,
    sourceSessionId: boundedOptional(memory.sourceSessionId, 100),
    sourceEventId: boundedOptional(memory.sourceEventId, 100),
    sourceEventSource: boundedOptional(memory.sourceEventSource, 200),
    sourceTrust: memory.sourceTrust,
    sourceActor: boundedOptional(memory.sourceActor, 500),
    sourceConversation: boundedOptional(memory.sourceConversation, 500),
    personId: boundedOptional(memory.personId, 60),
    personName: boundedOptional(memory.personName, 100),
    recordedAt: boundedOptional(memory.recordedAt, 100),
    confirmedAt: boundedOptional(memory.confirmedAt, 100),
  };
}

export function createMimiMemoryPage(
  memories: Memory[],
  offset = 0,
  expectedRevision?: string,
): MimiMemoryPage {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('memory offset 必须是非负安全整数');
  const revision = memoryRevision(memories);
  if (expectedRevision && expectedRevision !== revision) throw new Error('长期记忆在读取期间发生变化，请重试 /memories');
  if (offset > memories.length) throw new Error('memory offset 超出当前长期记忆');
  const items: MimiMemoryPage['items'] = [];
  let encodedBytes = 2;
  let index = offset;
  while (index < memories.length) {
    const item = memoryItem(memories[index]!, index);
    const itemBytes = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
    if (items.length > 0 && encodedBytes + itemBytes > MEMORY_PAGE_MAX_BYTES) break;
    items.push(item);
    encodedBytes += itemBytes;
    index += 1;
  }
  return {
    items,
    nextOffset: index < memories.length ? index : undefined,
    revision,
    total: memories.length,
  };
}

export function createMimiMemoryContentChunk(
  memories: Memory[],
  index: number,
  id: string,
  offset = 0,
  expectedRevision?: string,
): MimiMemoryContentChunk {
  if (!Number.isSafeInteger(index) || index < 0 || index >= memories.length) {
    throw new Error('memory index 超出当前长期记忆');
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('memory content offset 必须是非负安全整数');
  const revision = memoryRevision(memories);
  if (expectedRevision && expectedRevision !== revision) throw new Error('长期记忆在读取期间发生变化，请重试 /memories');
  const memory = memories[index]!;
  if (memory.id !== id) throw new Error('长期记忆分页身份不一致，请重试 /memories');
  if (offset > memory.content.length) throw new Error('memory content offset 超出当前长期记忆');
  const chunk = truncateUtf8(memory.content.slice(offset), MEMORY_PAGE_MAX_BYTES);
  const end = offset + chunk.length;
  return {
    chunk,
    nextOffset: end < memory.content.length ? end : undefined,
    revision,
    totalCharacters: memory.content.length,
  };
}

const LAUNCH_AGENT_LABEL = 'com.mimiagent.daemon';

export type DaemonStartupMode = 'launchd' | 'detached';

export function daemonStartupMode(
  platform: NodeJS.Platform,
  launchAgentInstalled: boolean,
  persistentProviderConfigured = false,
): DaemonStartupMode {
  return platform === 'darwin' && (launchAgentInstalled || persistentProviderConfigured) ? 'launchd' : 'detached';
}

export function daemonSupervisorAction(
  status: Pick<DaemonStatus, 'activeEventId' | 'activeHostMutations' | 'activeTaskCount' | 'tasks' | 'outbox'>,
  startupMode: DaemonStartupMode,
  launchAgentInstalled: boolean,
): 'reuse' | 'migrate' {
  return startupMode === 'launchd' && !launchAgentInstalled && !daemonHasActiveWork(status)
    ? 'migrate'
    : 'reuse';
}

async function daemonSupervisorState(config: AppConfig): Promise<{
  launchAgentInstalled: boolean;
  startupMode: DaemonStartupMode;
}> {
  const launchAgentInstalled = await exists(launchAgentFile());
  const persistentProviderConfigured = process.platform === 'darwin'
    && await launchAgentProviderConfigured(config);
  return {
    launchAgentInstalled,
    startupMode: daemonStartupMode(
      process.platform,
      launchAgentInstalled,
      persistentProviderConfigured,
    ),
  };
}

export async function reconcileMimiDaemon(
  config: AppConfig,
  status: DaemonStatusWire,
): Promise<DaemonStatus> {
  const expectedPermissionMode = config.permissionMode ?? 'trusted';
  const protocolAction = daemonProtocolAction(status, expectedPermissionMode);
  const { launchAgentInstalled, startupMode } = await daemonSupervisorState(config);
  const supervisorAction = daemonSupervisorAction(status, startupMode, launchAgentInstalled);
  if (protocolAction === 'reuse' && supervisorAction === 'reuse') return status as DaemonStatus;
  return startMimiDaemon(config);
}

function launchAgentFile(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

const CONNECTOR_TEMPLATE_ROOTS = [
  '/absolute/path/to/MimiAgent',
  '/absolute/path/to/MimiAgent',
] as const;
const DEFAULT_MACOS_CONNECTORS = new Set([
  'macos-system',
  'macos-life',
  'macos-mail',
  'macos-messages',
  'macos-contacts',
  'macos-notes',
  'macos-shortcuts',
  'macos-desktop',
  'macos-browser',
  'macos-screen',
  'macos-voice',
]);

export interface MimiInitialization {
  root: string;
  connectors: { file: string; created: boolean; updatedActions: number; total: number; enabled: string[] };
  assistant: { file: string; created: boolean };
}

export interface MimiDoctorReport {
  ready: boolean;
  platform: NodeJS.Platform;
  node: string;
  provider: { id: AppConfig['provider']; configured: boolean };
  paths: MimiPaths;
  connectors: {
    configured: boolean;
    total: number;
    enabled: string[];
    missingScripts: string[];
    runtime?: {
      online: string[];
      offline: string[];
      inboundReady: string[];
      outboundReady: string[];
      unavailable: string[];
    };
  };
  systemBinaries: Array<{ path: string; available: boolean }>;
  daemon: {
    running: boolean;
    status?: DaemonStatus;
    activity?: {
      needsAttention: boolean;
      workPending: number;
      taskDeadLetters: number;
      outboxDeadLetters: number;
    };
  };
  launchAgent: { installed: boolean; file: string };
  issues: string[];
  nextActions: string[];
}

interface InitializeOptions {
  platform?: NodeJS.Platform;
  runtimeRoot?: string;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function plistString(value: string): string {
  return `    <string>${xml(value)}</string>`;
}

function launchctl(args: string[], ignoreFailure = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => ignoreFailure ? resolve() : reject(error));
    child.once('exit', (code) => {
      if (code === 0 || ignoreFailure) resolve();
      else reject(new Error(`launchctl ${args[0]} 失败：${stderr.trim() || `exit ${code}`}`));
    });
  });
}

interface SubmitParams {
  eventId?: string;
  text?: string;
  payload?: unknown;
  externalId?: string;
  source?: string;
  kind?: EventKind;
  trust?: EventTrust;
  priority?: number;
  profileId?: string;
  sessionKey?: string;
  actor?: EventEnvelope['actor'];
  conversation?: EventEnvelope['conversation'];
  replyRoute?: ReplyRoute;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RPC 参数必须是对象');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function eventKind(value: unknown): EventKind {
  if (value === undefined) return 'command';
  if (typeof value === 'string' && ['command', 'alert', 'ambient', 'schedule', 'webhook'].includes(value)) {
    return value as EventKind;
  }
  throw new Error('kind 不是有效事件类型');
}

function eventTrust(value: unknown): EventTrust {
  if (value === undefined) return 'owner';
  if (typeof value === 'string' && ['owner', 'trusted', 'external', 'public', 'system'].includes(value)) {
    return value as EventTrust;
  }
  throw new Error('trust 不是有效信任等级');
}

function limit(value: unknown, fallback = 50): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : fallback;
}

function createWebhook(store: MimiStore): MimiWebhookServer | undefined {
  const rawPort = preferredEnvironmentValue('MIMI_WEBHOOK_PORT');
  if (!rawPort) return undefined;
  if (!/^\d+$/.test(rawPort)) throw new Error('MIMI_WEBHOOK_PORT 必须是整数');
  const token = preferredEnvironmentValue('MIMI_WEBHOOK_TOKEN');
  if (!token) throw new Error('启用 Webhook 时必须设置 MIMI_WEBHOOK_TOKEN');
  return new MimiWebhookServer(store, Number(rawPort), token);
}

function runtimeRoot(): string {
  return path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writeExclusiveJson(file: string, value: unknown): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await link(temporary, file);
    await chmod(file, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeAtomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function localConnectorConfig(
  template: ConnectorFileConfig,
  root: string,
  platform: NodeJS.Platform,
): ConnectorFileConfig {
  return {
    connectors: Object.fromEntries(Object.entries(template.connectors).map(([id, connector]) => [id, {
      ...connector,
      enabled: platform === 'darwin' && DEFAULT_MACOS_CONNECTORS.has(id),
      command: connector.command === 'node' ? process.execPath : connector.command,
      args: connector.args.map((argument) => CONNECTOR_TEMPLATE_ROOTS.reduce(
        (resolved, placeholder) => resolved.replaceAll(placeholder, root),
        argument,
      )),
    }])),
  };
}

function connectorScriptPath(connector: ConnectorFileConfig['connectors'][string]): string | undefined {
  for (let index = connector.args.length - 1; index >= 0; index -= 1) {
    const argument = connector.args[index];
    if (argument && path.isAbsolute(argument) && /\.(?:mjs|cjs|js)$/.test(argument)) return argument;
  }
  return undefined;
}

const LEGACY_IM_CONNECTORS = [
  { legacy: 'qq-applescript', preferred: 'qq', script: 'qq-applescript-connector.mjs' },
  { legacy: 'wechat-applescript', preferred: 'openclaw-weixin', script: 'wechat-applescript-connector.mjs' },
] as const;

const REQUIRED_CONNECTOR_ENV: Readonly<Record<string, readonly string[]>> = {
  'openclaw-weixin': ['MIMI_DAEMON_SOCKET'],
};

interface ConnectorScriptIdentity {
  canonicalPath: string;
  device?: bigint;
  inode?: bigint;
}

async function connectorScriptIdentity(
  connector: ConnectorFileConfig['connectors'][string],
): Promise<ConnectorScriptIdentity | undefined> {
  const script = connectorScriptPath(connector);
  if (!script) return undefined;
  try {
    const canonicalPath = await realpath(script);
    const metadata = await stat(canonicalPath, { bigint: true });
    return { canonicalPath, device: metadata.dev, inode: metadata.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { canonicalPath: path.resolve(script) };
  }
}

async function sameConnectorScript(
  current: ConnectorFileConfig['connectors'][string],
  packaged: ConnectorFileConfig['connectors'][string],
): Promise<boolean> {
  const [currentIdentity, packagedIdentity] = await Promise.all([
    connectorScriptIdentity(current),
    connectorScriptIdentity(packaged),
  ]);
  if (!currentIdentity || !packagedIdentity) return false;
  if (currentIdentity.canonicalPath === packagedIdentity.canonicalPath) return true;
  return currentIdentity.device !== undefined
    && packagedIdentity.device !== undefined
    && currentIdentity.device === packagedIdentity.device
    && currentIdentity.inode === packagedIdentity.inode;
}

async function mergeTemplateActions(
  current: ConnectorFileConfig,
  template: ConnectorFileConfig,
): Promise<{ config: ConnectorFileConfig; updatedActions: number; changed: boolean }> {
  let updatedActions = 0;
  let changed = false;
  const connectors = { ...current.connectors };
  for (const migration of LEGACY_IM_CONNECTORS) {
    const legacy = connectors[migration.legacy];
    if (!legacy?.enabled || !connectors[migration.preferred]?.enabled) continue;
    const script = connectorScriptPath(legacy);
    if (!script || path.basename(script) !== migration.script) continue;
    connectors[migration.legacy] = { ...legacy, enabled: false };
    changed = true;
  }
  for (const [id, connector] of Object.entries(template.connectors)) {
    if (!connectors[id] && connector.enabled) {
      connectors[id] = connector;
      changed = true;
    }
  }
  for (const [id, connector] of Object.entries(current.connectors)) {
    const packaged = template.connectors[id];
    if (!packaged) continue;
    if (!await sameConnectorScript(connector, packaged)) continue;
    const migrateSystemProvenance = id === 'macos-system'
      && connector.source === 'system'
      && connector.trust === 'trusted'
      && packaged.source === 'macos-system'
      && packaged.trust === 'system';
    const migrateNodeCommand = connector.command === 'node'
      && path.isAbsolute(packaged.command);
    const missing = connector.syncTemplateActions
      ? Object.entries(packaged.actions).filter(([name]) => !Object.hasOwn(connector.actions, name))
      : [];
    const missingEnv = (REQUIRED_CONNECTOR_ENV[id] ?? []).filter((name) => (
      packaged.envAllowlist.includes(name) && !connector.envAllowlist.includes(name)
    ));
    if (
      !migrateSystemProvenance
      && !migrateNodeCommand
      && !missing.length
      && !missingEnv.length
    ) continue;
    updatedActions += missing.length;
    changed = true;
    connectors[id] = {
      ...connector,
      ...(migrateNodeCommand ? { command: packaged.command } : {}),
      ...(migrateSystemProvenance ? { source: packaged.source, trust: packaged.trust } : {}),
      envAllowlist: [...connector.envAllowlist, ...missingEnv],
      actions: { ...Object.fromEntries(missing), ...connector.actions },
    };
  }
  return { config: { connectors }, updatedActions, changed };
}

export async function initializeMimi(
  config: AppConfig,
  options: InitializeOptions = {},
): Promise<MimiInitialization> {
  const paths = mimiPaths(config);
  const root = path.resolve(options.runtimeRoot ?? runtimeRoot());
  const platform = options.platform ?? process.platform;
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await ensureControlToken(paths.socket);

  const templateFile = path.join(root, 'mimi.connectors.example.json');
  const template = parseConnectorConfig(JSON.parse(await readFile(templateFile, 'utf8')) as unknown);
  const localTemplate = localConnectorConfig(template, root, platform);
  let connectorCreated = false;
  if (!await exists(paths.connectorsConfig)) {
    connectorCreated = await writeExclusiveJson(
      paths.connectorsConfig,
      localTemplate,
    );
  }
  let connectorConfig = parseConnectorConfig(JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown);
  let updatedActions = 0;
  if (!connectorCreated) {
    const merged = await mergeTemplateActions(connectorConfig, localTemplate);
    connectorConfig = merged.config;
    updatedActions = merged.updatedActions;
    if (merged.changed) await writeAtomicJson(paths.connectorsConfig, connectorConfig);
  }
  await chmod(paths.connectorsConfig, 0o600);

  const assistantExisted = await exists(paths.assistantConfig);
  const store = new MimiStore(paths.database);
  try {
    await AttentionEngine.load(paths.assistantConfig, store);
  } finally {
    store.close();
  }
  return {
    root: paths.root,
    connectors: {
      file: paths.connectorsConfig,
      created: connectorCreated,
      updatedActions,
      total: Object.keys(connectorConfig.connectors).length,
      enabled: Object.entries(connectorConfig.connectors)
        .filter(([, connector]) => connector.enabled)
        .map(([id]) => id),
    },
    assistant: { file: paths.assistantConfig, created: !assistantExisted },
  };
}

function providerConfigured(config: AppConfig): boolean {
  return config.provider === 'deepseek'
    ? Boolean(process.env.DEEPSEEK_API_KEY)
    : Boolean(process.env.OPENAI_API_KEY);
}

function providerKeyName(config: AppConfig): 'OPENAI_API_KEY' | 'DEEPSEEK_API_KEY' {
  return config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
}

export async function launchAgentProviderConfigured(
  config: AppConfig,
  environmentFile = resolveEnvironmentFile(),
): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(environmentFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return Boolean(parseDotenv(contents)[providerKeyName(config)]?.trim());
}

async function requireLaunchAgentProviderApiKey(config: AppConfig): Promise<void> {
  const environmentFile = resolveEnvironmentFile();
  if (await launchAgentProviderConfigured(config, environmentFile)) return;
  throw new Error(
    `launchd 需要在持久环境文件 ${environmentFile} 中配置 ${providerKeyName(config)}；仅在当前 Shell export 无法跨登录或重启保留。`,
  );
}

export async function doctorMimi(config: AppConfig): Promise<MimiDoctorReport> {
  const paths = mimiPaths(config);
  const platform = process.platform;
  const issues: string[] = [];
  let connectorConfig: ConnectorFileConfig | undefined;
  if (await exists(paths.connectorsConfig)) {
    try {
      connectorConfig = parseConnectorConfig(JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown);
    } catch (error) {
      issues.push(`Connector 配置无效：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    issues.push('尚未初始化 connectors.json');
  }
  const enabled = connectorConfig
    ? Object.entries(connectorConfig.connectors).filter(([, connector]) => connector.enabled).map(([id]) => id)
    : [];
  if (connectorConfig && enabled.length === 0) issues.push('没有启用任何 Connector');
  const scriptPaths = connectorConfig
    ? [...new Set(Object.values(connectorConfig.connectors)
      .flatMap((connector) => connector.args)
      .filter((argument) => path.isAbsolute(argument) && /\.(?:mjs|cjs|js)$/.test(argument)))]
    : [];
  const missingScripts: string[] = [];
  for (const script of scriptPaths) if (!await exists(script)) missingScripts.push(script);
  if (missingScripts.length) issues.push(`${missingScripts.length} 个 Connector 脚本不存在`);
  const binaries = platform === 'darwin'
    ? ['/usr/bin/pmset', '/usr/bin/osascript', '/usr/bin/open', '/usr/bin/shortcuts', '/usr/sbin/screencapture', '/usr/bin/swift', '/usr/bin/say']
    : [];
  const systemBinaries = await Promise.all(binaries.map(async (binary) => ({
    path: binary,
    available: await exists(binary),
  })));
  const missingBinaries = systemBinaries.filter((binary) => !binary.available);
  if (missingBinaries.length) issues.push(`缺少系统命令：${missingBinaries.map((item) => item.path).join(', ')}`);
  const configured = providerConfigured(config);
  if (!configured) issues.push(`${config.provider} API Key 未配置`);
  const installedLaunchAgentFile = launchAgentFile();
  const launchAgentInstalled = await exists(installedLaunchAgentFile);
  const persistentProviderKey = await launchAgentProviderConfigured(config);
  if (launchAgentInstalled && !persistentProviderKey) {
    issues.push(`launchd 持久环境文件缺少 ${providerKeyName(config)}`);
  }

  let daemonStatus: DaemonStatus | undefined;
  let runtimeConnectors: ConnectorCapability[] | undefined;
  let activity: MimiActivitySnapshot | undefined;
  try {
    daemonStatus = await mimiRpc<DaemonStatus>(paths.socket, 'status', undefined, 300);
  } catch {
    // Offline is a state, not a Doctor failure.
  }
  if (daemonStatus) {
    const [connectorResult, activityResult] = await Promise.allSettled([
      mimiRpc<ConnectorCapability[]>(paths.socket, 'connectors.list', {}, 1_000),
      mimiRpc<MimiActivitySnapshot>(paths.socket, 'activity.get', { limit: 1 }, 1_000),
    ]);
    if (connectorResult.status === 'fulfilled') runtimeConnectors = connectorResult.value;
    else issues.push(`无法读取 Connector 在线状态：${connectorResult.reason instanceof Error ? connectorResult.reason.message : String(connectorResult.reason)}`);
    if (activityResult.status === 'fulfilled') activity = activityResult.value;
    else issues.push(`无法读取 MimiAgent 活动状态：${activityResult.reason instanceof Error ? activityResult.reason.message : String(activityResult.reason)}`);
  } else if (configured && connectorConfig) {
    issues.push('MimiAgent 后台服务未运行');
  }
  const offlineConnectors = runtimeConnectors?.filter((connector) => connector.enabled && !connector.online) ?? [];
  const unavailableConnectors = runtimeConnectors?.filter((connector) => (
    connector.enabled && connector.online
    && connector.readiness.inbound === 'unavailable'
    && connector.readiness.outbound === 'unavailable'
  )) ?? [];
  if (offlineConnectors.length) {
    issues.push(`${offlineConnectors.length} 个已启用 Connector 离线：${offlineConnectors.map((connector) => connector.id).join(', ')}`);
  }
  if (unavailableConnectors.length) {
    issues.push(`${unavailableConnectors.length} 个 Connector 进程在线但渠道不可用：${unavailableConnectors.map((connector) => connector.id).join(', ')}`);
  }
  const taskDeadLetters = activity?.tasks.dead_letter ?? 0;
  const outboxDeadLetters = activity?.outbox.dead_letter ?? 0;
  if (taskDeadLetters) issues.push(`${taskDeadLetters} 个任务进入 dead letter`);
  if (outboxDeadLetters) issues.push(`${outboxDeadLetters} 个消息投递进入 dead letter`);
  const nextActions: string[] = [];
  if (!connectorConfig) nextActions.push('运行 mimi 完成自动初始化');
  if (!configured) nextActions.push(`在 ~/.mimi-agent/.env（或旧目录）配置 ${config.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'}`);
  if (launchAgentInstalled && !persistentProviderKey && configured) {
    nextActions.push(`把 ${providerKeyName(config)} 写入 ${resolveEnvironmentFile()} 后重新运行 mimi`);
  }
  if (missingScripts.length) nextActions.push('重新运行 npm install 或修复 Connector 脚本路径');
  if (missingBinaries.length) nextActions.push('安装或恢复缺失的 macOS 系统命令');
  if (!daemonStatus && configured && connectorConfig) nextActions.push('运行 mimi，后台服务会自动启动');
  if (offlineConnectors.length) nextActions.push('mimi daemon connectors reload');
  if (unavailableConnectors.length) nextActions.push('mimi daemon connectors');
  if (taskDeadLetters) nextActions.push('mimi daemon tasks');
  if (outboxDeadLetters) nextActions.push('mimi daemon outbox');
  return {
    ready: issues.length === 0,
    platform,
    node: process.version,
    provider: { id: config.provider, configured },
    paths,
    connectors: {
      configured: Boolean(connectorConfig),
      total: connectorConfig ? Object.keys(connectorConfig.connectors).length : 0,
      enabled,
      missingScripts,
      ...(runtimeConnectors ? {
        runtime: {
          online: runtimeConnectors.filter((connector) => connector.enabled && connector.online).map((connector) => connector.id),
          offline: offlineConnectors.map((connector) => connector.id),
          inboundReady: runtimeConnectors.filter((connector) => connector.enabled && connector.online && connector.readiness.inbound === 'ready').map((connector) => connector.id),
          outboundReady: runtimeConnectors.filter((connector) => connector.enabled && connector.online && connector.readiness.outbound === 'ready').map((connector) => connector.id),
          unavailable: unavailableConnectors.map((connector) => connector.id),
        },
      } : {}),
    },
    systemBinaries,
    daemon: {
      running: Boolean(daemonStatus),
      ...(daemonStatus ? { status: daemonStatus } : {}),
      ...(activity ? {
        activity: {
          needsAttention: activity.needsAttention,
          workPending: activity.workPending,
          taskDeadLetters,
          outboxDeadLetters,
        },
      } : {}),
    },
    launchAgent: { installed: launchAgentInstalled, file: installedLaunchAgentFile },
    issues,
    nextActions,
  };
}

export function daemonLaunchEnvironment(config: AppConfig): Record<string, string> {
  const paths = mimiPaths(config);
  const session = preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION') ?? 'mimi-system';
  const environment: Record<string, string> = {
    MIMI_MODEL_PROVIDER: config.provider,
    MIMI_CONFIG_VERSION: '3',
    MIMI_WORKSPACE: config.workspaceRoot,
    AGENT_WORKSPACE: config.workspaceRoot,
    MIMI_DATA_DIR: config.dataRoot,
    MIMI_DAEMON_DATA_DIR: paths.root,
    MIMI_DAEMON_SOCKET: paths.socket,
    MIMI_SKILLS_DIR: config.skillsRoot,
    MIMI_MCP_CONFIG: config.mcpConfig,
    MIMI_HISTORY_LIMIT: String(config.historyLimit),
    MIMI_TEAM_MAX_CONCURRENCY: String(config.teamMaxConcurrency ?? 4),
    MIMI_PERMISSION_MODE: config.permissionMode ?? 'trusted',
    MIMI_SESSION: session,
    AGENT_SESSION: session,
    MIMI_CONNECTORS_CONFIG: paths.connectorsConfig,
    MIMI_ASSISTANT_CONFIG: paths.assistantConfig,
  };
  if (config.maxTurns !== null) environment.MIMI_MAX_TURNS = String(config.maxTurns);
  if (config.contextWindow !== undefined) environment.MIMI_CONTEXT_WINDOW = String(config.contextWindow);
  if (config.outputReserve !== undefined) environment.MIMI_OUTPUT_TOKEN_RESERVE = String(config.outputReserve);
  if (config.trustedWorkspaceMcp !== undefined) {
    environment.MIMI_TRUST_WORKSPACE_MCP = config.trustedWorkspaceMcp;
  }
  const environmentFile = resolveEnvironmentFile();
  environment.MIMI_ENV_FILE = environmentFile;
  environment.DOTENV_CONFIG_PATH = environmentFile;
  return environment;
}

export function launchAgentPlist(config: AppConfig, entry = process.argv[1], execArgs = process.execArgv): string {
  if (!entry) throw new Error('无法确定 MimiAgent 启动入口');
  const paths = mimiPaths(config);
  const argumentsXml = [process.execPath, ...execArgs, entry, 'daemon', 'run'].map(plistString).join('\n');
  const environment = daemonLaunchEnvironment(config);
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(config.workspaceRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(paths.stderrLog)}</string>
</dict>
</plist>
`;
}

export async function installMimiLaunchAgent(config: AppConfig): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('自动登录启动当前仅支持 macOS launchd');
  await initializeMimi(config);
  requireProviderApiKey(config);
  await requireLaunchAgentProviderApiKey(config);
  const paths = mimiPaths(config);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  const directory = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const file = launchAgentFile();
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, launchAgentPlist(config), { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
  const domain = `gui/${process.getuid?.() ?? 0}`;
  await launchctl(['bootout', domain, file], true);
  await launchctl(['bootstrap', domain, file]);
  return file;
}

export async function uninstallMimiLaunchAgent(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('自动登录启动当前仅支持 macOS launchd');
  const file = launchAgentFile();
  await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, file], true);
  await rm(file, { force: true });
  return file;
}

export async function runMimiDaemon(config: AppConfig): Promise<void> {
  await initializeMimi(config);
  requireProviderApiKey(config);
  configureAgentRuntime(config);
  const paths = mimiPaths(config);
  const controlToken = await readControlToken(paths.socket);
  if (!controlToken) throw new Error('MimiAgent IPC 控制令牌缺失');
  const store = new MimiStore(paths.database);
  let host: MimiHost | undefined;
  let connectors: ConnectorManager | undefined;
  let webhook: MimiWebhookServer | undefined;
  let dispatcher: MimiDispatcher | undefined;
  let taskSupervisor: TaskProcessSupervisor | undefined;
  let server: MimiIpcServer | undefined;
  let attention: AttentionEngine | undefined;
  const stopping = new AbortController();
  const mutationGate = new DaemonMutationGate();
  const stop = () => {
    if (!stopping.signal.aborted) stopping.abort();
  };
  const onSignal = () => {
    void mutationGate.closeAndWait().then(stop);
  };
  let signalsRegistered = false;
  try {
    const agent = await MimiAgent.create(config);
    host = new MimiHost(agent, undefined, {
      maxConcurrentSessions: config.sessionMaxConcurrency ?? 4,
      createSessionRuntime: async (sessionId) => ({
        agent: await MimiAgent.create(config, sessionId),
      }),
    });
    const notifier = new NotifierRegistry();
    connectors = await ConnectorManager.load(paths.connectorsConfig, store, notifier);
    attention = await AttentionEngine.load(paths.assistantConfig, store);
    store.setIngressRoutePolicy((event, at) => attention!.routeIngress(event, at));
    webhook = createWebhook(store);
    const liveEvents = new MimiLiveEvents();
    taskSupervisor = new TaskProcessSupervisor(store, config, {
      database: paths.database,
      assistantConfig: paths.assistantConfig,
      socket: paths.socket,
    }, {
      maxWorkers: config.sessionMaxConcurrency ?? 4,
      redactEnvironmentKeys: () => connectors?.environmentKeys ?? [],
      onStreamEvent: (eventId, event) => liveEvents.publish(eventId, event),
    });
    const activeTaskSupervisor = taskSupervisor;
    dispatcher = new MimiDispatcher(store, host, attention, notifier, connectors, {
      maxConcurrentTasks: config.sessionMaxConcurrency ?? 4,
      claimTaskTypes: ['conversation'],
      onStreamEvent: (eventId, event) => {
        const streamed = mimiStreamEvent(event);
        if (streamed) liveEvents.publish(eventId, streamed);
      },
      onRuntimeEvent: (eventId, event) => {
        const streamed = mimiRuntimeStreamEvent(event);
        if (streamed) liveEvents.publish(eventId, streamed);
      },
      cancelEvent: (eventId, reason) => {
        const task = store.getTask(eventId);
        return task?.executor === 'isolated_worker' || task?.executor === 'codex'
          ? activeTaskSupervisor.cancel(eventId, reason)
          : dispatcher!.cancel(eventId, reason);
      },
      pauseEvent: (eventId, reason) => {
        const task = store.getTask(eventId);
        return task?.executor === 'isolated_worker' || task?.executor === 'codex'
          ? activeTaskSupervisor.pause(eventId, reason)
          : { state: 'not_pauseable' };
      },
    });
    const activeConnectors = connectors;
    const activeDispatcher = dispatcher;
    const activeWebhook = webhook;
    const activeAttention = attention;
    const activeStatus = () => {
      const taskWorkers = activeTaskSupervisor.status();
      return {
        ...activeDispatcher.status(),
        activeTaskCount: taskWorkers.length,
        taskWorkers,
        activeHostMutations: mutationGate.active,
      };
    };
    const taskSummaryWithRuntime = (task: ReturnType<MimiStore['getTask']>) => {
      if (!task) throw new Error('后台任务不存在');
      const summary = backgroundTaskSummary(task);
      const worker = activeTaskSupervisor.status().find((candidate) => candidate.taskId === task.id);
      return {
        ...summary,
        ...(worker ? { worker } : {}),
      };
    };
    const taskDetailsWithRuntime = async (task: ReturnType<MimiStore['getTask']>) => {
      if (!task) throw new Error('后台任务不存在');
      const summary = taskSummaryWithRuntime(task);
      const recentEvents = liveEvents.recent(task.id, 8);
      const snapshot = task.sessionKey
        ? await host!.snapshot(task.sessionKey).catch(() => undefined)
        : undefined;
      return {
        ...summary,
        ...(recentEvents.length ? { recentEvents } : {}),
        ...(snapshot?.plan.length ? { plan: snapshot.plan } : {}),
        ...(snapshot?.recovery ? { checkpoint: snapshot.recovery } : {}),
      };
    };
    server = new MimiIpcServer(paths.socket, async (method, rawParams, signal, auth) => {
      if (method === WORKER_CONNECTOR_INSPECT_METHOD) {
        const params = workerConnectorInspectParamsSchema.parse(rawParams);
        if (!activeTaskSupervisor.authorizeWorker(params.taskId, params.workerToken)) {
          throw new Error('后台 Task worker 身份已失效');
        }
        return connectorCapabilitySnapshot(activeConnectors, params.filter);
      }
      if (method === WORKER_CONNECTOR_ACTION_METHOD) {
        const params = workerConnectorActionParamsSchema.parse(rawParams);
        if (!activeTaskSupervisor.authorizeWorkerAction(params.taskId, params.workerToken)) {
          throw new Error('后台 Task worker 身份已失效');
        }
        // Once handed to a Connector, a disconnected worker cannot prove the
        // external transaction did not happen. Let the broker reach a result;
        // the task execution ledger prevents an uncertain retry.
        return activeConnectors.executeAction(params.request);
      }
      assertDaemonControlAuth(controlToken, auth);
      if (method === 'ping' || method === 'status') return {
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        buildVersion: MIMI_BUILD_VERSION,
        permissionMode: config.permissionMode ?? 'trusted',
        ...activeStatus(), connectorCount: activeConnectors.size, webhookAddress: activeWebhook?.address,
        attention: activeAttention.status(), workspaceRoot: config.workspaceRoot,
      };
      if (stopping.signal.aborted) throw new Error('MimiAgent 正在关闭，不再接受新事务');
      if (method === 'activity.get') return store.activitySnapshot(limit(object(rawParams).limit, 10));
      if (method === 'chat.bootstrap') {
        const params = object(rawParams);
        const draftSessionId = assertSessionId(requiredString(params.draftSessionId, 'draftSessionId'));
        const snapshot = await createMimiChatSnapshot(
          host!, host!.currentSessionId, config.workspaceRoot, 1,
        );
        return {
          ...snapshot,
          sessionId: draftSessionId,
          draft: true,
          contextUsed: 0,
          items: [],
          plan: [],
          recovery: undefined,
        } satisfies MimiChatSnapshot;
      }
      if (method === 'chat.sessions') {
        return (await host!.listSessionSummaries())
          .filter((summary) => summary.turns > 0 || summary.recoverable);
      }
      if (method === 'chat.snapshot') {
        const params = object(rawParams);
        const sessionId = chatSessionId(params);
        return createMimiChatSnapshot(host!, sessionId, config.workspaceRoot, limit(params.limit, 30));
      }
      if (method === 'chat.history') {
        const params = object(rawParams);
        const sessionId = chatSessionId(params);
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        const revision = typeof params.revision === 'string' ? params.revision : undefined;
        return createMimiHistoryChunk(host!, sessionId, offset, revision);
      }
      if (method === 'chat.invoke') {
        const params = object(rawParams);
        const operation = requiredString(params.operation, 'operation');
        if (operation === 'sessions') return host!.listSessionSummaries();
        const sessionId = chatSessionId(params);
        return mutationGate.run(() => host!.mutate(sessionId, async (agent) => {
            if (operation === 'runtime') return agent.runtimeInfo();
            if (operation === 'models') return agent.availableModels();
            if (operation === 'model.set') {
              await agent.switchModel(requiredString(params.value, 'value'));
              return agent.runtimeInfo();
            }
            if (operation === 'modes') return agent.availableModes();
            if (operation === 'mode.set') {
              await agent.switchMode(requiredString(params.value, 'value'));
              return agent.runtimeInfo();
            }
            if (operation === 'output.set') {
              const value = requiredString(params.value, 'value');
              if (value !== 'answer' && value !== 'thinking' && value !== 'tools' && value !== 'trace') {
                throw new Error('value 必须是 answer、thinking、tools 或 trace');
              }
              await agent.setOutputLevel(value);
              return agent.runtimeInfo();
            }
            if (operation === 'skills') return agent.listSkills();
            if (operation === 'skills.reload') return agent.reloadSkills();
            if (operation === 'tools') {
              return agent.visibleToolNames(createMimiCommandHostTools(
                store,
                activeAttention,
                activeConnectors,
                sessionId,
              ));
            }
            if (operation === 'mcp') return agent.mcpStatuses();
            if (operation === 'mcp.reload') return agent.reloadMcp();
            if (operation === 'context') return agent.contextInfo();
            if (operation === 'compact') return agent.compactContext();
            if (operation === 'instructions') return agent.guidanceInfo();
            if (operation === 'memories.page') {
              const request = object(params.value);
              const offset = request.offset === undefined ? 0 : Number(request.offset);
              const revision = typeof request.revision === 'string' ? request.revision : undefined;
              return createMimiMemoryPage(await agent.listMemories(), offset, revision);
            }
            if (operation === 'memory.content') {
              const request = object(params.value);
              const index = Number(request.index);
              const offset = request.offset === undefined ? 0 : Number(request.offset);
              const revision = typeof request.revision === 'string' ? request.revision : undefined;
              return createMimiMemoryContentChunk(
                await agent.listMemories(),
                index,
                requiredString(request.id, 'id'),
                offset,
                revision,
              );
            }
            if (operation === 'memories') return agent.listMemories();
            if (operation === 'plan') return agent.currentPlan();
            if (operation === 'team') return agent.currentTeam();
            if (operation === 'goal') return agent.currentGoal();
            if (operation === 'goal.set') return agent.setGoal(requiredString(params.value, 'value'));
            if (operation === 'resume') return { prompt: await agent.resumePrompt() };
            if (operation === 'index') {
              return agent.indexKnowledge(requiredString(params.value, 'value'), signal);
            }
            if (operation === 'clear') {
              await agent.clearSession();
              return { cleared: true, sessionId };
            }
            throw new Error(`未知 MimiAgent Chat 操作：${operation}`);
          }, signal));
      }
      if (method === 'submit') {
        const params = object(rawParams) as SubmitParams;
        const now = new Date().toISOString();
        const event: EventEnvelope = {
          id: params.eventId ? requiredString(params.eventId, 'eventId') : randomUUID(),
          externalId: params.externalId ?? randomUUID(), source: params.source ?? 'local-cli',
          kind: eventKind(params.kind), trust: eventTrust(params.trust),
          payload: params.payload ?? { prompt: requiredString(params.text, 'text') },
          occurredAt: now, receivedAt: now, priority: Math.max(0, Math.min(100, params.priority ?? 100)),
          profileId: params.profileId ?? 'owner',
          sessionKey: params.sessionKey === undefined
            ? undefined
            : assertSessionId(requiredString(params.sessionKey, 'sessionKey')),
          actor: params.actor, conversation: params.conversation, replyRoute: params.replyRoute,
        };
        return store.ingestEvent(event);
      }
      if (method === 'task.cancel') {
        const params = object(rawParams);
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        const id = requiredString(params.id, 'id');
        const task = store.getTask(id);
        return task?.executor === 'isolated_worker' || task?.executor === 'codex'
          ? activeTaskSupervisor.cancel(id, reason)
          : activeDispatcher.cancel(id, reason);
      }
      if (method === 'event.get') return store.getImmutableEvent(requiredString(object(rawParams).id, 'id'));
      if (method === 'event.route') return store.getEventRouteReceipt(requiredString(object(rawParams).id, 'id'));
      if (method === 'event.stream') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const after = Number(params.after ?? 0);
        const page = liveEvents.page(id, Number.isSafeInteger(after) && after >= 0 ? after : 0);
        return {
          ...page,
          task: mimiStreamTaskState(store.getTask(id)),
        };
      }
      if (method === 'events.list') return store.listEventSummaries(limit(object(rawParams).limit));
      if (method === 'tasks.list') {
        return store.listTasks(limit(object(rawParams).limit))
          .map((task) => taskSummaryWithRuntime(task));
      }
      if (method === 'tasks.get') {
        const task = store.getTask(requiredString(object(rawParams).id, 'id'));
        if (!task) throw new Error('Task 不存在');
        return taskDetailsWithRuntime(task);
      }
      if (method === 'tasks.cancel') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        return activeTaskSupervisor.cancel(id, reason);
      }
      if (method === 'tasks.pause') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        return activeTaskSupervisor.pause(id, reason);
      }
      if (method === 'tasks.resume') {
        const params = object(rawParams);
        const id = requiredString(params.id, 'id');
        const context = typeof params.context === 'string' ? params.context : undefined;
        const task = store.getTask(id);
        if (!task || task.type !== 'background') return { state: 'not_found' };
        if (task.status !== 'paused' && task.status !== 'blocked') {
          return { state: 'not_resumable' };
        }
        store.resumeTask(id, context);
        return { state: 'resumed' };
      }
      if (method === 'task.retry') return store.retryDeadLetterTask(requiredString(object(rawParams).id, 'id'));
      if (method === 'run.get') return store.getRun(requiredString(object(rawParams).id, 'id'));
      if (method === 'runs.list') return store.listRunSummaries(limit(object(rawParams).limit));
      if (method === 'outbox.get') return store.getOutbox(requiredString(object(rawParams).id, 'id'));
      if (method === 'outbox.list') return store.listOutboxSummaries(limit(object(rawParams).limit));
      if (method === 'outbox.retry') return {
        outbox: store.retryDeadLetterOutbox(requiredString(object(rawParams).id, 'id')),
        warning: '该投递采用 at-least-once 重试；若远端已接收但确认丢失，可能产生重复消息。',
      };
      if (method === 'outbox.archive') return store.archiveDeadLetterOutbox(requiredString(object(rawParams).id, 'id'));
      if (method === 'digest.list') return store.listPendingDigest(limit(object(rawParams).limit, 100));
      if (method === 'attention.status') return activeAttention.status();
      if (method === 'attention.reload') return mutationGate.run(() => activeAttention.reload());
      if (method === 'attention.brief') return activeAttention.forceBriefing();
      if (method === 'connectors.list') return activeConnectors.listCapabilities();
      if (method === 'connectors.reload') {
        return mutationGate.run(async () => {
          await initializeMimi(config);
          const capabilities = await activeConnectors.reload();
          return {
            total: capabilities.length,
            enabled: capabilities.filter((connector) => connector.enabled).length,
            online: capabilities.filter((connector) => connector.online).length,
            connectors: capabilities,
          };
        });
      }
      if (method === 'schedule.get') return store.getSchedule(requiredString(object(rawParams).id, 'id'));
      if (method === 'schedules.page') {
        const params = object(rawParams);
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('schedule offset 必须是非负安全整数');
        const expectedRevision = typeof params.revision === 'string' ? params.revision : undefined;
        const revision = store.scheduleRevision();
        if (expectedRevision && expectedRevision !== revision) {
          throw new Error('计划任务在读取期间发生变化，请重试 mimi daemon schedule list');
        }
        const total = store.scheduleCount();
        const items = store.listScheduleSummaries(limit(params.limit, 200), offset);
        if (store.scheduleRevision() !== revision) {
          throw new Error('计划任务在读取期间发生变化，请重试 mimi daemon schedule list');
        }
        const nextOffset = offset + items.length;
        return {
          items,
          nextOffset: nextOffset < total ? nextOffset : undefined,
          revision,
          total,
        } satisfies MimiSchedulePage;
      }
      if (method === 'schedules.list') return store.listScheduleSummaries();
      if (method === 'schedules.add') {
        const params = object(rawParams);
        const type = requiredString(params.type, 'type');
        if (type !== 'at' && type !== 'interval') throw new Error('type 必须是 at 或 interval');
        const nextRunAt = requiredString(params.nextRunAt, 'nextRunAt');
        if (!Number.isFinite(Date.parse(nextRunAt))) throw new Error('nextRunAt 不是有效时间');
        return store.addSchedule({
          name: requiredString(params.name, 'name'), type, value: requiredString(params.value, 'value'),
          prompt: requiredString(params.prompt, 'prompt'),
          profileId: typeof params.profileId === 'string' ? params.profileId : 'owner',
          sessionKey: params.sessionKey === undefined
            ? undefined
            : assertSessionId(requiredString(params.sessionKey, 'sessionKey')),
          replyRoute: (params.replyRoute as ReplyRoute | undefined) ?? activeAttention.replyRouteFor(),
          trust: params.trust === 'owner' ? 'owner' : 'system', nextRunAt: new Date(nextRunAt).toISOString(),
        });
      }
      if (method === 'schedules.remove') return store.removeSchedule(requiredString(object(rawParams).id, 'id'));
      if (method === 'shutdown') {
        if (daemonHasActiveWork(activeStatus())) {
          throw new Error('MimiAgent 仍有活动事件、投递或 Chat 操作；为避免中断外部事务，当前拒绝关闭。');
        }
        if (!mutationGate.beginShutdown()) {
          throw new Error('MimiAgent 仍有活动管理事务；为避免竞态，当前拒绝关闭。');
        }
        setImmediate(stop);
        return { accepted: true };
      }
      throw new Error(`未知 MimiAgent RPC 方法：${method}`);
    });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    signalsRegistered = true;
    await server.start();
    await webhook?.start();
    connectors.start();
    dispatcher.start();
    taskSupervisor.start();
    await waitForAbort(stopping.signal);
  } finally {
    if (signalsRegistered) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    await webhook?.close().catch(() => undefined);
    await taskSupervisor?.stop().catch(() => undefined);
    await dispatcher?.stop().catch(() => undefined);
    await connectors?.stop().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await host?.close().catch(() => undefined);
    store.close();
  }
}

async function waitForDaemonOffline(
  socket: string,
  workerId: string,
  pid: number,
  workspaceRoot: string,
  expectedPermissionMode: AgentPermissionMode,
  allowManagedReplacement: boolean,
): Promise<DaemonStatus | undefined> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let status: DaemonStatusWire | undefined;
    try {
      status = await mimiRpc<DaemonStatusWire>(socket, 'status', undefined, 500);
    } catch {
      // The IPC socket closes before the daemon finishes draining its runtime.
    }
    if (status && status.workerId !== workerId) {
      assertDaemonWorkspace(status.workspaceRoot, workspaceRoot);
      if (daemonProtocolAction(status, expectedPermissionMode) === 'reuse') return status as DaemonStatus;
      // launchd may immediately restart the new binary with a stale plist. A
      // current, idle worker with the wrong permission can be replaced by the
      // install step below without treating it as an unknown legacy race.
      if (allowManagedReplacement && daemonProtocolState(status) === 'current') return undefined;
      throw new Error('旧版 MimiAgent 退出期间被另一个旧版后台重新启动；当前后台未被强制终止，请重试升级。');
    }
    if (!status && !daemonProcessIsLive(pid)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('旧版 MimiAgent 已接受关闭请求，但未在 10 秒内安全退出；当前后台未被强制终止。');
}

export async function startMimiDaemon(config: AppConfig): Promise<DaemonStatus> {
  await initializeMimi(config);
  requireProviderApiKey(config);
  let paths = mimiPaths(config);
  const expectedPermissionMode = config.permissionMode ?? 'trusted';
  const { launchAgentInstalled, startupMode } = await daemonSupervisorState(config);
  let existing: DaemonStatusWire | undefined;
  let stoppedExisting = false;
  try {
    existing = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 500);
  } catch {
    // No live daemon; continue with the selected supervisor.
  }
  if (existing) {
    assertDaemonWorkspace(existing.workspaceRoot, config.workspaceRoot);
    const protocolAction = daemonProtocolAction(existing, expectedPermissionMode);
    const supervisorAction = daemonSupervisorAction(existing, startupMode, launchAgentInstalled);
    if (protocolAction === 'reuse' && supervisorAction === 'reuse') return existing as DaemonStatus;
    await mimiRpc(paths.socket, 'shutdown', undefined, 2_000);
    const replacement = await waitForDaemonOffline(
      paths.socket,
      existing.workerId,
      existing.pid,
      config.workspaceRoot,
      expectedPermissionMode,
      startupMode === 'launchd',
    );
    if (replacement) return replacement;
    stoppedExisting = true;
  }
  if (stoppedExisting || !existsSync(paths.socket)) {
    config = migrateLegacyMimiDaemon(config);
    paths = mimiPaths(config);
  }
  if (startupMode === 'launchd') {
    await installMimiLaunchAgent(config);
  } else {
    const entry = process.argv[1];
    if (!entry) throw new Error('无法确定 MimiAgent 启动入口');
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    chmodSync(paths.root, 0o700);
    const stdout = openSync(paths.stdoutLog, 'a', 0o600);
    const stderr = openSync(paths.stderrLog, 'a', 0o600);
    try {
      const child = spawn(process.execPath, [...process.execArgv, entry, 'daemon', 'run'], {
        detached: true,
        stdio: ['ignore', stdout, stderr],
        cwd: config.workspaceRoot,
        env: {
          ...process.env,
          ...daemonLaunchEnvironment(config),
        },
      });
      child.unref();
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
  }
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    let status: DaemonStatusWire;
    try {
      status = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 500);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    assertDaemonWorkspace(status.workspaceRoot, config.workspaceRoot);
    const state = daemonProtocolState(status);
    if (state === 'current'
      && status.permissionMode === expectedPermissionMode
      && status.buildVersion === MIMI_BUILD_VERSION) return status as DaemonStatus;
    if (state === 'current') {
      lastError = new Error(
        `新启动的 MimiAgent 执行档位 ${String(status.permissionMode ?? 'unknown')} 与当前配置 ${expectedPermissionMode} 不一致`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    if (state === 'newer') {
      throw new Error(
        `新启动的 MimiAgent 协议版本 ${String(status.protocolVersion)} 高于当前 CLI ${DAEMON_PROTOCOL_VERSION}。`,
      );
    }
    lastError = new Error(
      `新启动的 MimiAgent 未返回当前协议/构建 ${DAEMON_PROTOCOL_VERSION}/${MIMI_BUILD_VERSION}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MimiAgent 启动失败，请查看 ${paths.stderrLog}：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

export async function stopMimiDaemon(config: AppConfig): Promise<void> {
  await mimiRpc(mimiPaths(config).socket, 'shutdown');
}

export async function waitForRemoteTask(
  config: AppConfig,
  id: string,
  timeoutMs = 24 * 60 * 60_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await mimiRpc<{ status: string; result?: unknown; error?: string } | undefined>(
      mimiPaths(config).socket, 'tasks.get', { id }, 2_000,
    );
    if (!task) throw new Error(`Task 不存在：${id}`);
    if (['completed', 'failed', 'cancelled', 'dead_letter', 'paused', 'blocked'].includes(task.status)) {
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`等待 Task 超时：${id}`);
}

export type { ScheduleRecord };
