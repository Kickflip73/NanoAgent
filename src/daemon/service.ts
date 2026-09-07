import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { parse as parseDotenv } from 'dotenv';
import {
  adoptRuntimeWorkspaceConfig,
  adoptWorkspaceConfig,
  preferredEnvironmentValue,
  resolveEnvironmentFile,
  securityProfileSummary,
  type AgentPermissionMode,
  type AppConfig,
} from '../config.js';
import { persistEnvironmentValues, providerApiKeyName } from '../provider-config.js';
import { MimiAgent } from '../agent.js';
import { sanitizeSensitiveData } from '../core/data-sanitizer.js';
import { assertSessionId } from '../core/session-id.js';
import { withExclusiveFileLock } from '../core/state-file.js';
import { configureAgentRuntime, requireProviderApiKey } from '../runtime/bootstrap.js';
import { MimiHost } from '../runtime/mimi-host.js';
import {
  AgentRunService,
  providerBackupRouteFromEnvironment,
} from '../runtime/run-service.js';
import { resolveTaskWorkspace } from '../runtime/workspace-resolution.js';
import { stageAttachments, type LocalAttachmentRequest } from '../runtime/attachments.js';
import { MimiDispatcher } from './dispatcher.js';
import {
  ConnectorManager,
  parseConnectorConfig,
  type ConnectorCapability,
  type ConnectorFileConfig,
} from './connectors.js';
import {
  connectorCapabilitySnapshot,
  createConnectorHostTools,
} from './connector-action-tool.js';
import {
  WORKER_CONNECTOR_ACTION_METHOD,
  WORKER_CONNECTOR_INSPECT_METHOD,
  workerConnectorActionParamsSchema,
  workerConnectorInspectParamsSchema,
} from './connector-worker-rpc.js';
import { isMimiIpcTimeout, mimiRpc, MimiIpcServer, readControlToken } from './ipc.js';
import { NotifierRegistry } from './notifier.js';
import { MimiStore } from './store.js';
import { MimiWebhookServer } from './webhook.js';
import { MimiRuntimeHttpServer, runtimeHttpSessionId } from './runtime-http.js';
import { AttentionEngine } from './attention.js';
import { EphemeralSecretBroker } from './ephemeral-secrets.js';
import { TaskProcessSupervisor } from './task-supervisor.js';
import { backgroundTaskSummary, inspectBackgroundTaskSummary } from './task-tools.js';
import {
  buildDaemonHealth,
  doctorBlockingHealthRisks,
} from './health-model.js';
import {
  inspectDiagnosticStorage,
  type DiagnosticStorageSnapshot,
} from './diagnostics.js';
import { rotateDaemonLogs } from './log-maintenance.js';
import {
  DaemonLifecycleStore,
  DaemonMutationGate,
  type DaemonLifecycleEpoch,
  type DaemonLifecycleStopReason,
} from './lifecycle.js';
import { classifyReadinessUnknown } from './operational-classification.js';
import { createMimiCommandHostTools } from './host-tools.js';
import { MimiLiveEvents, mimiRuntimeStreamEvent, mimiStreamEvent, mimiStreamTaskState } from './live-events.js';
import { ownerSessionId } from './policy.js';
import { requestedSecurityProfileForLocalSubmit } from './local-run-policy.js';
import { createMimiChatSnapshot, createMimiHistoryChunk } from './chat-snapshot.js';
import { pathExists as exists, writeAtomicJson } from './json-file.js';
import { initializeMimi } from './initialization.js';
import {
  daemonLaunchEnvironment,
  launchAgentPlist,
  launchAgentPlistBelongsTo,
  MIMI_LAUNCH_AGENT_LABEL,
} from './launch-agent-config.js';
import {
  sharedCuaDriverLifecycle,
  type CuaDriverLifecycle,
} from '../extensions/computer/cua-driver-lifecycle.js';
import {
  assertReadOnlyProbeIdle,
  executeReadOnlyProbe,
} from './read-only-probe.js';
import {
  assertDaemonWorkspace,
  daemonHasActiveWork,
  daemonProtocolAction,
  daemonProtocolState,
  forcedRestartBlockers,
  mimiBuildDiagnostics,
  MIMI_BUILD_IDENTITY,
  MIMI_BUILD_VERSION,
  migrateLegacyMimiDaemon,
  mimiPaths,
  type DaemonStatusWire,
} from './client-runtime.js';
import {
  DAEMON_PROTOCOL_VERSION,
  eventKindSchema,
  eventTrustSchema,
  type DaemonStatus,
  type EventEnvelope,
  type MimiActivitySnapshot,
  type MimiChatSnapshot,
  type MimiSchedulePage,
  type ReplyRoute,
  type ScheduleRecord,
} from './types.js';

export {
  assertDaemonWorkspace,
  daemonHasActiveWork,
  daemonProtocolAction,
  daemonProtocolState,
  MIMI_BUILD_IDENTITY,
  MIMI_BUILD_VERSION,
  mimiPaths,
} from './client-runtime.js';
export type { DaemonProtocolState, MimiPaths } from './client-runtime.js';
export { createMimiChatSnapshot, createMimiHistoryChunk } from './chat-snapshot.js';
export { initializeMimi, type MimiInitialization } from './initialization.js';
export { daemonLaunchEnvironment, launchAgentPlist } from './launch-agent-config.js';
export { DaemonMutationGate } from './lifecycle.js';

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

const DAEMON_WORKSPACE_FILE = 'workspace.json';

async function launchAgentOwnership(config: AppConfig) {
  try {
    const source = await readFile(launchAgentFile(), 'utf8');
    return { installed: true, owned: launchAgentPlistBelongsTo(source, config) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: false, owned: false };
    throw error;
  }
}

export async function reconcileMimiDaemon(
  config: AppConfig,
  status: DaemonStatusWire,
): Promise<DaemonStatus> {
  const expectedPermissionMode = config.permissionMode ?? 'trusted';
  if (daemonProtocolAction(status, expectedPermissionMode) === 'reuse') return status as DaemonStatus;
  return startMimiDaemon(config);
}

function launchAgentFile(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MIMI_LAUNCH_AGENT_LABEL}.plist`);
}

function daemonWorkspaceFile(config: AppConfig): string {
  return path.join(mimiPaths(config).root, DAEMON_WORKSPACE_FILE);
}

function parseDaemonWorkspace(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MimiAgent 后台工作区绑定必须是对象');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.workspaceRoot !== 'string'
    || !path.isAbsolute(record.workspaceRoot) || record.workspaceRoot.length > 4096) {
    throw new Error('MimiAgent 后台工作区绑定无效');
  }
  return path.resolve(record.workspaceRoot);
}

async function readDaemonWorkspace(config: AppConfig): Promise<string | undefined> {
  const file = daemonWorkspaceFile(config);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`MimiAgent 后台工作区绑定必须是普通文件：${file}`);
  }
  const workspaceRoot = parseDaemonWorkspace(JSON.parse(await readFile(file, 'utf8')) as unknown);
  await chmod(file, 0o600);
  return workspaceRoot;
}

async function rememberDaemonWorkspace(config: AppConfig): Promise<void> {
  const file = daemonWorkspaceFile(config);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700);
  await writeAtomicJson(file, { version: 1, workspaceRoot: path.resolve(config.workspaceRoot) });
}

export async function resolveDaemonWorkspaceConfig(config: AppConfig): Promise<AppConfig> {
  const paths = mimiPaths(config);
  let liveWorkspace: string | undefined;
  try {
    const status = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 500);
    if (typeof status.workspaceRoot === 'string' && status.workspaceRoot.trim()) {
      liveWorkspace = path.resolve(status.workspaceRoot);
    }
  } catch {
    // An offline service falls back to the last durable workspace binding.
  }
  const workspaceRoot = liveWorkspace ?? await readDaemonWorkspace(config);
  const resolved = workspaceRoot ? adoptWorkspaceConfig(config, workspaceRoot) : config;
  if (liveWorkspace) await rememberDaemonWorkspace(resolved);
  return resolved;
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

interface SubmitParams extends Partial<Pick<EventEnvelope,
  'externalId' | 'source' | 'trust' | 'priority' | 'profileId' | 'sessionKey'
  | 'actor' | 'conversation' | 'replyRoute'>> {
  eventId?: string;
  text?: string;
  payload?: unknown;
  kind?: EventEnvelope['kind'];
  workspaceRoot?: string;
  resumeState?: boolean;
  approvedPersonalMessageText?: string;
  attachments?: LocalAttachmentRequest[];
  requestedSecurityProfile?: unknown;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RPC 参数必须是对象');
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 不能为空`);
  return value.trim();
}

function optionalAbsoluteDirectory(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const selected = requiredString(value, name);
  if (!path.isAbsolute(selected)) throw new Error(`${name} 必须是绝对路径`);
  if (selected.length > 4096) throw new Error(`${name} 过长`);
  return path.resolve(selected);
}

function limit(value: unknown, fallback = 50): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) ? Math.max(1, Math.min(200, parsed)) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createWebhook(store: MimiStore): MimiWebhookServer | undefined {
  const rawPort = preferredEnvironmentValue('MIMI_WEBHOOK_PORT');
  if (!rawPort) return undefined;
  if (!/^\d+$/.test(rawPort)) throw new Error('MIMI_WEBHOOK_PORT 必须是整数');
  const token = preferredEnvironmentValue('MIMI_WEBHOOK_TOKEN');
  if (!token) throw new Error('启用 Webhook 时必须设置 MIMI_WEBHOOK_TOKEN');
  return new MimiWebhookServer(store, Number(rawPort), token);
}

function runtimeHttpConfiguration(): { port: number; token: string } | undefined {
  const rawPort = preferredEnvironmentValue('MIMI_RUNTIME_HTTP_PORT');
  if (!rawPort) return undefined;
  if (!/^\d+$/.test(rawPort)) throw new Error('MIMI_RUNTIME_HTTP_PORT 必须是整数');
  const port = Number(rawPort);
  if (port < 1 || port > 65_535) throw new Error('MIMI_RUNTIME_HTTP_PORT 必须在 1～65535 之间');
  const token = preferredEnvironmentValue('MIMI_RUNTIME_HTTP_TOKEN');
  if (!token) throw new Error('启用 Runtime HTTP 时必须设置 MIMI_RUNTIME_HTTP_TOKEN');
  return { port, token };
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
  return Boolean(parseDotenv(contents)[providerApiKeyName(config.provider)]?.trim());
}

export async function persistLaunchAgentProviderApiKey(
  config: AppConfig,
  environmentFile = resolveEnvironmentFile(),
): Promise<void> {
  if (await launchAgentProviderConfigured(config, environmentFile)) return;
  const keyName = providerApiKeyName(config.provider);
  const value = process.env[keyName]?.trim();
  if (!value) return;
  await persistEnvironmentValues(environmentFile, { [keyName]: value });
}

export async function doctorMimi(config: AppConfig) {
  const paths = mimiPaths(config);
  const platform = process.platform;
  const issues: string[] = [];
  try {
    providerBackupRouteFromEnvironment(config.provider);
  } catch (error) {
    issues.push(`Provider 主备配置无效：${errorMessage(error)}`);
  }
  let connectorConfig: ConnectorFileConfig | undefined;
  if (await exists(paths.connectorsConfig)) {
    try {
      connectorConfig = parseConnectorConfig(JSON.parse(await readFile(paths.connectorsConfig, 'utf8')) as unknown);
    } catch (error) {
      issues.push(`Connector 配置无效：${errorMessage(error)}`);
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
  const configured = Boolean(process.env[providerApiKeyName(config.provider)]?.trim());
  if (!configured) issues.push(`${config.provider} API Key 未配置`);
  const launchAgent = await launchAgentOwnership(config);
  const installedLaunchAgentFile = launchAgentFile();
  const launchAgentInstalled = launchAgent.installed;
  const persistentProviderKey = await launchAgentProviderConfigured(config);
  if (launchAgent.owned && !persistentProviderKey) {
    issues.push(`launchd 持久环境文件缺少 ${providerApiKeyName(config.provider)}`);
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
    else issues.push(`无法读取 Connector 在线状态：${errorMessage(connectorResult.reason)}`);
    if (activityResult.status === 'fulfilled') activity = activityResult.value;
    else issues.push(`无法读取 MimiAgent 活动状态：${errorMessage(activityResult.reason)}`);
  } else if (configured && connectorConfig) {
    issues.push('MimiAgent 后台服务未运行');
  }
  const computerStatus = daemonStatus?.computer;
  if (config.computer && daemonStatus && computerStatus?.ready !== true) {
    issues.push(`Computer Use 不可用：${computerStatus?.lastOperationalFailure ?? computerStatus?.lastFailure ?? 'Daemon 未报告 ready'}`);
  }
  const offlineConnectors = runtimeConnectors?.filter((connector) => connector.enabled && !connector.online) ?? [];
  const unavailableConnectors = runtimeConnectors?.filter((connector) => (
    connector.enabled && connector.online
    && connector.readiness.inbound === 'unavailable'
    && connector.readiness.outbound === 'unavailable'
  )) ?? [];
  const taskDeadLetters = activity?.tasks.dead_letter ?? 0;
  const outboxDeadLetters = activity?.outbox.dead_letter ?? 0;
  const health = daemonStatus
    ? daemonStatus.health ?? buildDaemonHealth({
        tasks: activity?.tasks ?? daemonStatus.tasks,
        outbox: activity?.outbox ?? daemonStatus.outbox,
        pendingDigest: activity?.pendingDigest,
        connectors: runtimeConnectors,
        checkedAt: activity?.generatedAt,
        taskWorkerRuntime: daemonStatus.taskWorkerRuntime,
        autonomousBudgetExhaustions: activity?.autonomousBudgetExhaustions?.length,
        unknownRunSources: activity?.unknownRunSources,
      })
    : undefined;
  if (health) {
    issues.push(...doctorBlockingHealthRisks(
      health,
      activity?.failureClassification?.unclassifiedDeadLetters ?? taskDeadLetters,
    ).map((risk) => risk.message));
  }
  const build = mimiBuildDiagnostics(daemonStatus?.buildVersion, config.workspaceRoot);
  if (build.aligned === false) {
    issues.push(`构建漂移：installed=${build.installed}，running=${build.running ?? 'unknown'}`);
  }
  let storage: DiagnosticStorageSnapshot | undefined;
  const capacityRisks = [
    ['database', 'SQLite', '运行 mimi daemon activity 检查保留策略和积压，再安排数据库备份与维护'],
    ['logs', 'Daemon 日志', '安全重启 MimiAgent 以轮转超限日志，并检查重复错误'],
    ['memory', 'Memory', '检查 MemoryHub 页面、索引和备份增长'],
  ] as const;
  try {
    storage = await inspectDiagnosticStorage(config);
    for (const [key, label] of capacityRisks) {
      if (storage.capacity[key] !== 'ok') issues.push(`${label} 容量达到 ${storage.capacity[key]} 阈值`);
    }
  } catch (error) {
    issues.push(`无法读取本地容量指标：${errorMessage(error)}`);
  }
  const nextActions: string[] = [];
  if (!connectorConfig) nextActions.push('运行 mimi 完成自动初始化');
  if (!configured) nextActions.push(`在 ~/.mimi-agent/.env（或旧目录）配置 ${providerApiKeyName(config.provider)}`);
  if (launchAgent.owned && !persistentProviderKey && configured) {
    nextActions.push(`把 ${providerApiKeyName(config.provider)} 写入 ${resolveEnvironmentFile()} 后重新运行 mimi`);
  }
  if (missingScripts.length) nextActions.push('重新运行 npm install 或修复 Connector 脚本路径');
  if (!daemonStatus && configured && connectorConfig) nextActions.push('运行 mimi，后台服务会自动启动');
  if (build.aligned === false) {
    nextActions.push('满足安全切换门禁后，从同一 clean package 部署运行构建');
  }
  if (health) {
    for (const action of health.risks.map((risk) => risk.nextAction)) {
      if (!nextActions.includes(action)) nextActions.push(action);
    }
  }
  for (const [key, , action] of capacityRisks) {
    if (storage && storage.capacity[key] !== 'ok') nextActions.push(action);
  }
  return {
    ready: issues.length === 0,
    platform,
    node: process.version,
    provider: { id: config.provider, configured },
    build,
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
    systemBinaries: [] as Array<{ path: string; available: boolean }>,
    daemon: {
      running: Boolean(daemonStatus),
      ...(daemonStatus ? { status: daemonStatus } : {}),
      ...(health ? { health } : {}),
      ...(activity ? {
        activity: {
          needsAttention: activity.needsAttention,
          workPending: activity.workPending,
          taskDeadLetters,
          outboxDeadLetters,
          resourceTrends: activity.resourceTrends ?? [],
          runUsageBySource: activity.runUsageBySource ?? [],
          autonomousBudgetExhaustions: activity.autonomousBudgetExhaustions ?? [],
          failureClassification: {
            ...(activity.failureClassification ?? {
              deadLetters: [],
              digest: [],
              unclassifiedDeadLetters: taskDeadLetters,
            }),
            readinessUnknown: classifyReadinessUnknown(
              runtimeConnectors ?? [],
              daemonStatus?.startedAt ?? new Date().toISOString(),
            ),
          },
        },
      } : {}),
    },
    launchAgent: {
      installed: launchAgentInstalled,
      owned: launchAgent.owned,
      file: installedLaunchAgentFile,
    },
    computer: {
      configured: Boolean(config.computer),
      ...(config.computer ? { backend: config.computer.backend, ready: computerStatus?.ready === true } : {}),
      ...(computerStatus ? { diagnostics: { ...computerStatus } as Record<string, unknown> } : {}),
    },
    ...(storage ? { storage } : {}),
    issues,
    nextActions,
  };
}

export type MimiDoctorReport = Awaited<ReturnType<typeof doctorMimi>>;

export async function installLaunchAgentPlistFile(
  config: AppConfig, file: string, activate: () => Promise<void>,
  entry = process.argv[1], execArgs = process.execArgv): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await withExclusiveFileLock(file, async () => {
    let existing: string | undefined;
    try { existing = await readFile(file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing !== undefined && !launchAgentPlistBelongsTo(existing, config)) {
      throw new Error('全局 launchd 服务属于另一个 MimiAgent 数据目录；请先从原实例执行 mimi daemon uninstall');
    }
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, launchAgentPlist(config, entry, execArgs), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
      await chmod(file, 0o600);
      await activate();
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

export async function installMimiLaunchAgent(config: AppConfig): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('自动登录启动当前仅支持 macOS launchd');
  config = await resolveDaemonWorkspaceConfig(config);
  await initializeMimi(config);
  requireProviderApiKey(config);
  await persistLaunchAgentProviderApiKey(config);
  const paths = mimiPaths(config);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  const file = launchAgentFile();
  const domain = `gui/${process.getuid?.() ?? 0}`;
  await installLaunchAgentPlistFile(config, file, async () => {
    await launchctl(['bootout', domain, file], true);
    await rotateDaemonLogs(paths);
    await launchctl(['bootstrap', domain, file]);
  });
  return file;
}

export async function uninstallMimiLaunchAgent(): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('自动登录启动当前仅支持 macOS launchd');
  const file = launchAgentFile();
  await withExclusiveFileLock(file, async () => {
    await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, file], true);
    await rm(file, { force: true });
  });
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
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const lifecycle = new DaemonLifecycleStore(paths.lifecycle);
  let lifecycleEpoch: DaemonLifecycleEpoch = await lifecycle.begin({
    buildVersion: MIMI_BUILD_VERSION,
    pid: process.pid,
    workerId,
    workspaceRoot: config.workspaceRoot,
    supervisor: process.env.MIMI_DAEMON_SUPERVISOR === 'launchd'
      ? 'launchd'
      : process.env.MIMI_DAEMON_SUPERVISOR === 'detached'
        ? 'detached'
        : 'foreground',
  });
  let host: MimiHost | undefined;
  let connectors: ConnectorManager | undefined;
  let webhook: MimiWebhookServer | undefined;
  let runtimeHttp: MimiRuntimeHttpServer | undefined;
  let dispatcher: MimiDispatcher | undefined;
  let taskSupervisor: TaskProcessSupervisor | undefined;
  let server: MimiIpcServer | undefined;
  let attention: AttentionEngine | undefined;
  let computerLifecycle: CuaDriverLifecycle | undefined;
  const stopping = new AbortController();
  const mutationGate = new DaemonMutationGate();
  const ephemeralSecrets = new EphemeralSecretBroker();
  let stopRequest: {
    reason: DaemonLifecycleStopReason;
    signal?: DaemonLifecycleEpoch['signal'];
    exitCode: number;
  } | undefined;
  const stop = async (
    reason: DaemonLifecycleStopReason,
    signal?: DaemonLifecycleEpoch['signal'],
    exitCode = 0,
  ) => {
    if (stopRequest) return;
    stopRequest = { reason, ...(signal ? { signal } : {}), exitCode };
    lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'stopping', {
      reason,
      ...(signal ? { signal } : {}),
    });
    if (!stopping.signal.aborted) stopping.abort();
  };
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => {
    process.exitCode = 1;
    void mutationGate.closeAndWait().then(() => stop('signal', signal, 1));
  };
  let signalsRegistered = false;
  let runtimeFailure: unknown;
  try {
    const runtimeConfig = (workspaceRoot?: string): AppConfig => workspaceRoot
      ? adoptRuntimeWorkspaceConfig(config, workspaceRoot)
      : config;
    const backupProvider = providerBackupRouteFromEnvironment(config.provider);
    const runService = (runtime: MimiAgent) => new AgentRunService(runtime, {
      providerId: config.provider,
      providerIdForRun: (request) => runtime.providerReliabilityKey(
        request.modelInput ?? request.input,
        request.options,
      ),
      ...(backupProvider ? { backupProvider } : {}),
    });
    if (config.computer) {
      computerLifecycle = sharedCuaDriverLifecycle(
        config.computer.driverCommand,
        config.computer.actionTimeoutMs,
      );
      await computerLifecycle.start();
    }
    const agent = await MimiAgent.create(config);
    host = new MimiHost(agent, runService(agent), {
      maxConcurrentSessions: config.sessionMaxConcurrency ?? 4,
      primaryWorkspaceRoot: config.workspaceRoot,
      createSessionRuntime: async (sessionId, workspaceRoot) => {
        const sessionAgent = await MimiAgent.create(runtimeConfig(workspaceRoot), sessionId);
        return { agent: sessionAgent, runs: runService(sessionAgent) };
      },
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
    const cancelTask = (taskId: string, reason?: string) => {
      const executor = store.getTask(taskId)?.executor;
      return executor === 'isolated_worker' || executor === 'codex'
        ? activeTaskSupervisor.cancel(taskId, reason)
        : dispatcher!.cancel(taskId, reason);
    };
    const pauseTask = (taskId: string, reason?: string) => {
      const executor = store.getTask(taskId)?.executor;
      return executor === 'isolated_worker' || executor === 'codex'
        ? activeTaskSupervisor.pause(taskId, reason)
        : { state: 'not_pauseable' as const };
    };
    const ingestOwnerPrompt = (event: EventEnvelope, prompt: string) => {
      if (!event.sessionKey) throw new Error('认证 Owner 命令缺少 Session，无法绑定临时敏感输入');
      const captured = ephemeralSecrets.capture({
        eventId: event.id,
        sessionId: event.sessionKey,
        profileId: event.profileId,
        source: event.source,
        trust: event.trust,
      }, prompt);
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload as Record<string, unknown>
        : {};
      try {
        const accepted = store.ingestEvent({
          ...event,
          payload: {
            ...payload,
            prompt: captured.sanitized,
            ...(captured.references.length ? { transientInputRefs: captured.references } : {}),
          },
        });
        if (!accepted.inserted || !accepted.task) ephemeralSecrets.discard(event.id);
        return accepted;
      } catch (error) {
        ephemeralSecrets.discard(event.id);
        throw error;
      }
    };
    dispatcher = new MimiDispatcher(store, host, attention, notifier, connectors, {
      workerId,
      maxConcurrentTasks: config.sessionMaxConcurrency ?? 4,
      onStreamEvent: (eventId, event) => {
        const streamed = mimiStreamEvent(event);
        if (streamed) liveEvents.publish(eventId, streamed);
      },
      onRuntimeEvent: (eventId, event) => {
        const streamed = mimiRuntimeStreamEvent(event);
        if (streamed) liveEvents.publish(eventId, streamed);
      },
      cancelEvent: cancelTask,
      pauseEvent: pauseTask,
      takeEphemeralSecrets: (eventId, sessionId, references) =>
        ephemeralSecrets.take(eventId, sessionId, references),
      resolveWorkspace: async (event, sessionId, task) => {
        const current = host!.workspaceRootFor(sessionId);
        const authority = store.getImmutableEvent(task.authorityEventId);
        if (authority?.trust !== 'owner') return current ?? config.workspaceRoot;
        const payload = task.objective && typeof task.objective === 'object' && !Array.isArray(task.objective)
          ? task.objective as Record<string, unknown>
          : {};
        const requestedWorkspaceRoot = optionalAbsoluteDirectory(
          payload.workspaceRoot,
          'event.payload.workspaceRoot',
        );
        const resolved = await resolveTaskWorkspace({
          requestedWorkspaceRoot,
          sessionWorkspaceRoot: current,
          defaultWorkspaceRoot: config.workspaceRoot,
        });
        return resolved.workspaceRoot;
      },
    });
    const activeConnectors = connectors;
    const activeDispatcher = dispatcher;
    const activeWebhook = webhook;
    const activeAttention = attention;
    const activeStatus = () => {
      const taskWorkers = activeTaskSupervisor.status();
      const taskWorkerRuntime = activeTaskSupervisor.runtimeStatus();
      const status = {
        ...activeDispatcher.status(),
        activeTaskCount: taskWorkers.length,
        taskWorkers,
        taskWorkerRuntime,
        activeHostMutations: mutationGate.active,
      };
      const activity = store.healthSnapshot();
      const effectiveCapability = host?.currentCapabilitySnapshot();
      const providerHealth = host?.providerHealth();
      const providerHealthRoutes = host?.providerHealthRoutes();
      const transportComputer = computerLifecycle?.status();
      const operationalComputer = host?.computerStatus();
      const computer = transportComputer ? {
        ...transportComputer,
        transportReady: transportComputer.ready,
        ready: transportComputer.ready && operationalComputer?.operationalReadiness === 'ready',
        operationalReadiness: operationalComputer?.operationalReadiness ?? 'unknown',
        ...(operationalComputer?.operationalCheckedAt
          ? { operationalCheckedAt: operationalComputer.operationalCheckedAt }
          : {}),
        ...(operationalComputer?.lastOperationalFailure
          ? { lastOperationalFailure: operationalComputer.lastOperationalFailure }
          : {}),
      } : undefined;
      return {
        ...status,
        lifecycle: lifecycleEpoch,
        ...(providerHealth ? { providerHealth } : {}),
        ...(providerHealthRoutes?.length ? { providerHealthRoutes } : {}),
        ...(effectiveCapability ? {
          effectiveCapability: {
            schemaVersion: effectiveCapability.schemaVersion,
            snapshotDigest: effectiveCapability.snapshotDigest,
            observedAt: effectiveCapability.observedAt,
          },
        } : {}),
        ...(computer ? { computer } : {}),
        health: buildDaemonHealth({
          tasks: status.tasks,
          outbox: status.outbox,
          pendingDigest: activity.pendingDigest,
          connectors: activeConnectors.listCapabilities(),
          checkedAt: activity.generatedAt,
          taskWorkerRuntime,
          computer,
          autonomousBudgetExhaustions: activity.autonomousBudgetExhaustions.length,
          unknownRunSources: activity.unknownRunSources,
        }),
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
      const summary = task.executor === 'codex'
        ? { ...await inspectBackgroundTaskSummary(task), worker: taskSummaryWithRuntime(task).worker }
        : taskSummaryWithRuntime(task);
      const recentEvents = liveEvents.recent(task.id, 8);
      const snapshot = task.executor !== 'codex' && task.sessionKey
        ? await host!.snapshot(task.sessionKey).catch(() => undefined)
        : undefined;
      return {
        ...summary,
        ...(recentEvents.length ? { recentEvents } : {}),
        ...(snapshot?.plan.length ? { plan: snapshot.plan } : {}),
        ...(snapshot?.recovery ? { checkpoint: snapshot.recovery } : {}),
      };
    };
    const runtimeHttpConfig = runtimeHttpConfiguration();
    if (runtimeHttpConfig) {
      runtimeHttp = new MimiRuntimeHttpServer(runtimeHttpConfig.port, runtimeHttpConfig.token, {
        createSession: runtimeHttpSessionId,
        submit: async (sessionId, input, idempotencyKey) => {
          const now = new Date().toISOString();
          const eventId = randomUUID();
          const accepted = ingestOwnerPrompt({
            id: eventId,
            externalId: idempotencyKey
              ? `runtime-http:${sessionId}:${idempotencyKey}`
              : `runtime-http:${eventId}`,
            source: 'runtime-http',
            kind: 'command',
            trust: 'owner',
            payload: { workspaceRoot: config.workspaceRoot },
            occurredAt: now,
            receivedAt: now,
            priority: 100,
            profileId: 'owner',
            sessionKey: assertSessionId(sessionId),
          }, input);
          if (!accepted.task) throw new Error('MimiAgent 没有为 HTTP 命令创建 Task');
          return { taskId: accepted.task.id, inserted: accepted.inserted };
        },
        task: (taskId) => taskSummaryWithRuntime(store.getTask(taskId)),
        cancel: cancelTask,
        events: (taskId, after) => {
          const page = liveEvents.page(taskId, after);
          const task = mimiStreamTaskState(store.getTask(taskId));
          return {
            events: page.events,
            next: page.nextSequence,
            terminal: Boolean(task && ['completed', 'failed', 'cancelled', 'dead_letter'].includes(task.status)),
            task,
          };
        },
      });
    }
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
        securityProfile: securityProfileSummary(config),
        ...activeStatus(),
        connectorCount: activeConnectors.size,
        webhookAddress: activeWebhook?.address,
        runtimeHttpAddress: runtimeHttp?.address,
        attention: activeAttention.status(), workspaceRoot: config.workspaceRoot,
      };
      if (stopping.signal.aborted) throw new Error('MimiAgent 正在关闭，不再接受新事务');
      if (method === 'probe.read') {
        assertReadOnlyProbeIdle(activeStatus());
        await host!.mutate(
          host!.currentSessionId,
          (agent) => agent.assertReadOnlyDaemonProbePolicy(
            createConnectorHostTools(activeConnectors),
          ),
          signal,
        );
        const claimedApps = [...new Set(activeConnectors.listCapabilities()
          .filter((connector) => connector.enabled)
          .flatMap((connector) => connector.claimedComputerApps))];
        const receipt = await executeReadOnlyProbe(rawParams, {
          connectors: activeConnectors,
          computerWindow: (expectedTarget, probeSignal) => host!.mutate(
            host!.currentSessionId,
            (agent) => agent.probeReadOnlyComputerWindow(
              [
                'com.apple.finder',
                'com.apple.Preview',
                'com.apple.TextEdit',
                'com.apple.SystemSettings',
              ],
              claimedApps,
              probeSignal,
              expectedTarget,
            ),
            probeSignal,
          ),
        }, signal);
        assertReadOnlyProbeIdle(activeStatus());
        return sanitizeSensitiveData(receipt);
      }
      if (method === 'activity.get') {
        return sanitizeSensitiveData(store.activitySnapshot(limit(object(rawParams).limit, 10)));
      }
      if (method === 'usage.get') return store.usageReport(Number(object(rawParams).days ?? 7));
      if (method === 'chat.bootstrap') {
        const params = object(rawParams);
        const draftSessionId = assertSessionId(requiredString(params.draftSessionId, 'draftSessionId'));
        const requestedWorkspaceRoot = optionalAbsoluteDirectory(params.workspaceRoot, 'workspaceRoot');
        const draftExists = await host!.hasSession(draftSessionId);
        const snapshot = await createMimiChatSnapshot(
          host!,
          draftExists ? draftSessionId : host!.currentSessionId,
          config.workspaceRoot,
          1,
        );
        return sanitizeSensitiveData({
          ...snapshot,
          sessionId: draftSessionId,
          workspaceRoot: requestedWorkspaceRoot ?? snapshot.workspaceRoot,
          draft: true,
          permissionMode: config.permissionMode ?? 'trusted',
          contextUsed: 0,
          contextStatus: {
            value: 0,
            source: 'raw-history',
            contextWindow: snapshot.contextWindow,
          },
          items: [],
          plan: [],
          recovery: undefined,
        } satisfies MimiChatSnapshot);
      }
      if (method === 'chat.sessions') {
        return sanitizeSensitiveData(
          (await host!.listSessionSummaries())
            .filter((summary) => summary.turns > 0 || summary.recoverable),
        );
      }
      if (method === 'chat.snapshot') {
        const params = object(rawParams);
        const sessionId = chatSessionId(params);
        return sanitizeSensitiveData(await createMimiChatSnapshot(
          host!,
          sessionId,
          host!.workspaceRootFor(sessionId) ?? config.workspaceRoot,
          limit(params.limit, 30),
        ));
      }
      if (method === 'chat.history') {
        const params = object(rawParams);
        const sessionId = chatSessionId(params);
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        const revision = typeof params.revision === 'string' ? params.revision : undefined;
        return sanitizeSensitiveData(await createMimiHistoryChunk(host!, sessionId, offset, revision));
      }
      if (method === 'chat.invoke') {
        const params = object(rawParams);
        const operation = requiredString(params.operation, 'operation');
        if (operation === 'sessions') return sanitizeSensitiveData(await host!.listSessionSummaries());
        const sessionId = chatSessionId(params);
        return sanitizeSensitiveData(await mutationGate.run(() => host!.mutate(sessionId, async (agent) => {
            const operations: Record<string, () => unknown | Promise<unknown>> = {
              runtime: () => agent.runtimeInfo(),
              models: () => agent.availableModels(),
              'model.control': () => agent.modelControl(object(params.value)),
              'model.set': async () => {
                await agent.switchModel(requiredString(params.value, 'value'));
                return agent.runtimeInfo();
              },
              modes: () => agent.availableModes(),
              'mode.set': async () => {
                await agent.switchMode(requiredString(params.value, 'value'));
                return agent.runtimeInfo();
              },
              'output.set': async () => {
              const value = requiredString(params.value, 'value');
              if (value !== 'answer' && value !== 'thinking' && value !== 'tools' && value !== 'trace') {
                throw new Error('value 必须是 answer、thinking、tools 或 trace');
              }
              await agent.setOutputLevel(value);
              return agent.runtimeInfo();
              },
              skills: () => agent.listSkills(),
              'skills.reload': () => agent.reloadSkills(),
              'skills.set': async () => {
                const request = object(params.value);
                const scope = request.scope === 'project' || request.scope === 'user' ? request.scope : undefined;
                if (!scope || typeof request.enabled !== 'boolean') throw new Error('skills.set 参数无效');
                await agent.setSkillEnabled(requiredString(request.name, 'name'), scope, request.enabled);
                return { updated: true };
              },
              tools: () => agent.visibleToolNames(createMimiCommandHostTools(
                store, activeAttention, activeConnectors, sessionId,
              )),
              mcp: () => agent.mcpStatuses(),
              'mcp.reload': () => agent.reloadMcp(),
              context: () => agent.contextInfo(),
              compact: () => agent.compactContext(),
              instructions: () => agent.guidanceInfo(),
              'memory.list': () => agent.memoryList(
                params.value === 'private' || params.value === 'workspace' ? params.value : 'all',
              ),
              'memory.search': () => {
                const request = object(params.value);
                const scope = request.scope === 'private' || request.scope === 'workspace' ? request.scope : 'all';
                return agent.memorySearch(requiredString(request.query, 'query'), scope);
              },
              'memory.read': () => agent.memoryRead(object(params.value) as never),
              'memory.forget': () => agent.memoryForget(object(params.value) as never),
              'memory.ingest': () => agent.memoryIngest(requiredString(params.value, 'value'), signal),
              'memory.capture': () => agent.memoryCaptureRound(
                typeof params.value === 'string' && params.value.trim() ? params.value.trim() : undefined,
              ),
              'memory.lint': () => agent.memoryLint(),
              'memory.refresh': () => agent.memoryRefresh(limit(params.value, 20)),
              'memory.conflicts': () => agent.memoryConflicts(limit(params.value, 20)),
              'memory.audit': () => agent.memoryAudit(limit(params.value, 20)),
              'memory.maintain': () => {
                const created = store.memoryObservations.emitDue(new Date(), 'owner');
                return { created: created.map((task) => task.id), ...store.memoryObservations.status('owner') };
              },
              'memory.reindex': () => agent.memoryReindex(),
              'memory.status': async () => ({
                ...await agent.memoryStatus(), observations: store.memoryObservations.status('owner'),
              }),
              plan: () => agent.currentPlan(),
              team: () => agent.currentTeam(),
              goal: () => agent.currentGoal(),
              'goal.set': () => agent.setGoal(requiredString(params.value, 'value')),
              resume: async () => ({ prompt: await agent.resumePrompt() }),
              clear: async () => {
                await agent.clearSession();
                return { cleared: true, sessionId };
              },
              'undo.list': () => agent.listUndoableRuns(limit(params.value, 20)),
              'undo.preview': () => agent.previewUndo(requiredString(params.value, 'value')),
              'undo.apply': () => agent.undoRun(requiredString(params.value, 'value')),
            };
            const execute = operations[operation];
            if (!execute) throw new Error(`未知 MimiAgent Chat 操作：${operation}`);
            return execute();
          }, signal)));
      }
      if (method === 'submit') {
        const params = object(rawParams) as SubmitParams;
        const now = new Date().toISOString();
        const source = params.source ?? 'local-cli';
        const trust = eventTrustSchema.parse(params.trust ?? 'owner');
        const requestedSecurityProfile = requestedSecurityProfileForLocalSubmit(params);
        const requestedWorkspaceRoot = source === 'local-cli' && trust === 'owner'
          ? optionalAbsoluteDirectory(params.workspaceRoot, 'workspaceRoot')
          : undefined;
        const stagedAttachments = source === 'local-cli' && trust === 'owner' && params.attachments?.length
          ? await stageAttachments(
              params.attachments,
              requestedWorkspaceRoot ?? config.workspaceRoot,
              path.join(mimiPaths(config).root, 'attachments'),
            )
          : [];
        const prompt = params.payload === undefined ? requiredString(params.text, 'text') : undefined;
        const submittedPayload = params.payload ?? {
          ...(requestedWorkspaceRoot ? { workspaceRoot: requestedWorkspaceRoot } : {}),
          ...(params.resumeState === true ? { resumeState: true } : {}),
          ...(typeof params.approvedPersonalMessageText === 'string'
            && params.approvedPersonalMessageText.trim()
            ? { approvedPersonalMessageText: params.approvedPersonalMessageText.trim().slice(0, 4_000) }
            : {}),
          ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
        };
        const payload = requestedSecurityProfile
          ? {
              ...(submittedPayload as Record<string, unknown>),
              requestedSecurityProfile,
            }
          : submittedPayload;
        const event: EventEnvelope = {
          id: params.eventId ? requiredString(params.eventId, 'eventId') : randomUUID(),
          externalId: params.externalId ?? randomUUID(), source,
          kind: eventKindSchema.parse(params.kind ?? 'command'), trust,
          payload,
          occurredAt: now, receivedAt: now, priority: Math.max(0, Math.min(100, params.priority ?? 100)),
          profileId: params.profileId ?? 'owner',
          sessionKey: params.sessionKey === undefined
            ? undefined
            : assertSessionId(requiredString(params.sessionKey, 'sessionKey')),
          actor: params.actor, conversation: params.conversation, replyRoute: params.replyRoute,
        };
        return prompt !== undefined && source === 'local-cli' && trust === 'owner'
          ? ingestOwnerPrompt(event, prompt)
          : store.ingestEvent(event);
      }
      const params = rawParams === undefined ? {} : object(rawParams);
      const requestedId = () => requiredString(params.id, 'id');
      const simpleOperations: Record<string, () => unknown | Promise<unknown>> = {
        'event.get': () => store.getImmutableEvent(requestedId()),
        'event.route': () => store.getEventRouteReceipt(requestedId()),
        'events.list': () => store.listEventSummaries(limit(params.limit)),
        'tasks.list': () => store.listTasks(limit(params.limit)).map(taskSummaryWithRuntime),
        'tasks.get': () => taskDetailsWithRuntime(store.getTask(requestedId())),
        'task.retry': () => store.retryDeadLetterTask(requestedId()),
        'run.get': () => store.runs.get(requestedId()),
        'runs.list': () => store.runs.listSummaries(limit(params.limit)),
        'outbox.get': () => store.outbox.get(requestedId()),
        'outbox.list': () => store.outbox.listSummaries(limit(params.limit)),
        'outbox.retry': () => ({
          outbox: store.outbox.retryDeadLetter(requestedId()),
          warning: '该投递采用 at-least-once 重试；若远端已接收但确认丢失，可能产生重复消息。',
        }),
        'outbox.archive': () => store.outbox.archiveDeadLetter(requestedId()),
        'digest.list': () => store.listPendingDigest(limit(params.limit, 100)),
        'attention.status': () => activeAttention.status(),
        'attention.reload': () => mutationGate.run(() => activeAttention.reload()),
        'attention.brief': () => activeAttention.forceBriefing(),
        'connectors.list': () => activeConnectors.listCapabilities(),
        'schedule.get': () => store.schedules.get(requestedId()),
        'schedules.list': () => store.schedules.listSummaries(),
        'schedules.remove': () => store.schedules.remove(requestedId()),
      };
      const simpleOperation = simpleOperations[method];
      if (simpleOperation) return sanitizeSensitiveData(await simpleOperation());
      if (method === 'event.stream') {
        const id = requiredString(params.id, 'id');
        const after = Number(params.after ?? 0);
        const page = liveEvents.page(id, Number.isSafeInteger(after) && after >= 0 ? after : 0);
        return sanitizeSensitiveData({
          ...page,
          task: mimiStreamTaskState(store.getTask(id)),
        });
      }
      if (method === 'tasks.cancel') {
        const id = requiredString(params.id, 'id');
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        return cancelTask(id, reason);
      }
      if (method === 'tasks.pause') {
        const id = requiredString(params.id, 'id');
        const reason = typeof params.reason === 'string' ? params.reason : undefined;
        return pauseTask(id, reason);
      }
      if (method === 'tasks.resume') {
        const id = requiredString(params.id, 'id');
        const context = typeof params.context === 'string' ? params.context : undefined;
        const task = store.getTask(id);
        if (!task) return { state: 'not_found' };
        if (task.status !== 'paused' && task.status !== 'blocked') {
          return { state: 'not_resumable' };
        }
        store.resumeTask(id, context);
        return { state: 'resumed' };
      }
      if (method === 'connectors.setEnabled') {
        return mutationGate.run(() => activeConnectors.setEnabled(
          requiredString(params.id, 'id'),
          params.enabled === true,
        ));
      }
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
      if (method === 'schedules.page') {
        const offset = params.offset === undefined ? 0 : Number(params.offset);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('schedule offset 必须是非负安全整数');
        const expectedRevision = typeof params.revision === 'string' ? params.revision : undefined;
        const revision = store.schedules.revision();
        if (expectedRevision && expectedRevision !== revision) {
          throw new Error('计划任务在读取期间发生变化，请重试 mimi daemon schedule list');
        }
        const total = store.schedules.count();
        const items = store.schedules.listSummaries(limit(params.limit, 200), offset);
        if (store.schedules.revision() !== revision) {
          throw new Error('计划任务在读取期间发生变化，请重试 mimi daemon schedule list');
        }
        const nextOffset = offset + items.length;
        return sanitizeSensitiveData({
          items,
          nextOffset: nextOffset < total ? nextOffset : undefined,
          revision,
          total,
        } satisfies MimiSchedulePage);
      }
      if (method === 'schedules.add') {
        const type = requiredString(params.type, 'type');
        if (type !== 'at' && type !== 'interval') throw new Error('type 必须是 at 或 interval');
        const nextRunAt = requiredString(params.nextRunAt, 'nextRunAt');
        if (!Number.isFinite(Date.parse(nextRunAt))) throw new Error('nextRunAt 不是有效时间');
        return sanitizeSensitiveData(store.schedules.add({
          name: requiredString(params.name, 'name'), type, value: requiredString(params.value, 'value'),
          prompt: requiredString(params.prompt, 'prompt'),
          profileId: typeof params.profileId === 'string' ? params.profileId : 'owner',
          sessionKey: params.sessionKey === undefined
            ? undefined
            : assertSessionId(requiredString(params.sessionKey, 'sessionKey')),
          replyRoute: (params.replyRoute as ReplyRoute | undefined) ?? activeAttention.replyRouteFor(),
          trust: params.trust === 'owner' ? 'owner' : 'system', nextRunAt: new Date(nextRunAt).toISOString(),
        }));
      }
      if (method === 'shutdown') {
        for (const key of Object.keys(params)) {
          if (key !== 'force') throw new Error(`shutdown 不支持参数：${key}`);
        }
        if (params.force !== undefined && typeof params.force !== 'boolean') {
          throw new Error('shutdown.force 必须是 boolean');
        }
        const force = params.force === true;
        const status = activeStatus();
        if (!force && daemonHasActiveWork(status)) {
          throw new Error('MimiAgent 仍有活动事件、投递或 Chat 操作；为避免中断外部事务，当前拒绝关闭。');
        }
        if (force) {
          const blockers = forcedRestartBlockers(status);
          if (blockers.length > 0) {
            throw new Error(
              `强制重启仍被不可中断边界阻止：${blockers.join('、')}。请等待这些操作结束；不会重放 uncertain 副作用。`,
            );
          }
        }
        if (!mutationGate.beginShutdown()) {
          throw new Error('MimiAgent 仍有活动管理事务；为避免竞态，当前拒绝关闭。');
        }
        if (force) activeDispatcher.forceStop('Owner 请求强制重启，已中断无在途 Tool 的活动 Run');
        setImmediate(() => { void stop('owner_shutdown'); });
        return { accepted: true, forced: force };
      }
      throw new Error(`未知 MimiAgent RPC 方法：${method}`);
    });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    signalsRegistered = true;
    await server.start();
    await webhook?.start();
    await runtimeHttp?.start();
    connectors.start();
    dispatcher.start();
    taskSupervisor.start();
    lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'online');
    await waitForAbort(stopping.signal);
  } catch (error) {
    runtimeFailure = error;
    process.exitCode = 1;
    if (lifecycleEpoch.phase !== 'failed') {
      lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'failed', {
        reason: 'runtime_failure',
        exitCode: 1,
        error: errorMessage(error),
      }).catch(() => lifecycleEpoch);
    }
    throw error;
  } finally {
    if (signalsRegistered) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    const cleanupErrors: string[] = [];
    const cleanup = async (operation: (() => void | Promise<void>) | undefined) => {
      if (!operation) return;
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(errorMessage(error));
      }
    };
    for (const operation of [
      () => webhook?.close(),
      () => runtimeHttp?.close(),
      () => taskSupervisor?.stop(),
      () => dispatcher?.stop(),
      () => connectors?.stop(),
      () => server?.close(),
      () => host?.close(),
      () => computerLifecycle?.stop(),
    ]) await cleanup(operation);
    await cleanup(() => store.close());
    if (!runtimeFailure && cleanupErrors.length > 0) {
      process.exitCode = 1;
      lifecycleEpoch = await lifecycle.transition(lifecycleEpoch.epochId, 'failed', {
        reason: 'cleanup_failure',
        exitCode: 1,
        error: cleanupErrors.join('; '),
      }).catch(() => lifecycleEpoch);
    } else if (!runtimeFailure && stopRequest) {
      lifecycleEpoch = await lifecycle.transition(
        lifecycleEpoch.epochId,
        stopRequest.reason === 'owner_shutdown' ? 'stopped' : 'failed',
        {
          reason: stopRequest.reason,
          ...(stopRequest.signal ? { signal: stopRequest.signal } : {}),
          exitCode: stopRequest.exitCode,
        },
      ).catch(() => lifecycleEpoch);
    }
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
      // owned supervisor start below without treating it as an unknown legacy race.
      if (allowManagedReplacement && daemonProtocolState(status) === 'current') return undefined;
      throw new Error('旧版 MimiAgent 退出期间被另一个旧版后台重新启动；当前后台未被强制终止，请重试升级。');
    }
    if (!status && !daemonProcessIsLive(pid)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('旧版 MimiAgent 已接受关闭请求，但未在 10 秒内安全退出；当前后台未被强制终止。');
}

export async function startMimiDaemon(config: AppConfig): Promise<DaemonStatus> {
  config = await resolveDaemonWorkspaceConfig(config);
  await initializeMimi(config);
  await rememberDaemonWorkspace(config);
  requireProviderApiKey(config);
  let paths = mimiPaths(config);
  const expectedPermissionMode = config.permissionMode ?? 'trusted';
  const launchAgentOwned = (await launchAgentOwnership(config)).owned;
  const useLaunchAgent = process.platform === 'darwin' && launchAgentOwned;
  let existing: DaemonStatusWire | undefined;
  let stoppedExisting = false;
  try {
    existing = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 5_000);
  } catch (error) {
    if (isMimiIpcTimeout(error)) throw error;
  }
  if (existing) {
    assertDaemonWorkspace(existing.workspaceRoot, config.workspaceRoot);
    const protocolAction = daemonProtocolAction(existing, expectedPermissionMode);
    if (protocolAction === 'reuse') return existing as DaemonStatus;
    await mimiRpc(paths.socket, 'shutdown', undefined, 2_000);
    const replacement = await waitForDaemonOffline(
      paths.socket,
      existing.workerId,
      existing.pid,
      config.workspaceRoot,
      expectedPermissionMode,
      useLaunchAgent,
    );
    if (replacement) return replacement;
    stoppedExisting = true;
  }
  if (stoppedExisting || !existsSync(paths.socket)) {
    config = migrateLegacyMimiDaemon(config);
    paths = mimiPaths(config);
  }
  if (useLaunchAgent) {
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await launchctl(['bootstrap', domain, launchAgentFile()], true);
    await launchctl(['kickstart', '-k', `${domain}/${MIMI_LAUNCH_AGENT_LABEL}`]);
  } else {
    const entry = process.argv[1];
    if (!entry) throw new Error('无法确定 MimiAgent 启动入口');
    mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    chmodSync(paths.root, 0o700);
    await rotateDaemonLogs(paths);
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
          MIMI_DAEMON_SUPERVISOR: 'detached',
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
      status = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 2_000);
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

export async function stopMimiDaemon(
  config: AppConfig,
  options: { force?: boolean } = {},
): Promise<boolean> {
  config = await resolveDaemonWorkspaceConfig(config);
  const paths = mimiPaths(config);
  let existing: DaemonStatusWire;
  try {
    existing = await mimiRpc<DaemonStatusWire>(paths.socket, 'status', undefined, 5_000);
  } catch {
    return false;
  }
  assertDaemonWorkspace(existing.workspaceRoot, config.workspaceRoot);
  await mimiRpc(paths.socket, 'shutdown', options.force ? { force: true } : undefined, 2_000);
  const replacement = await waitForDaemonOffline(
    paths.socket,
    existing.workerId,
    existing.pid,
    config.workspaceRoot,
    config.permissionMode ?? 'trusted',
    false,
  );
  if (replacement) {
    throw new Error(`MimiAgent 后台在停止过程中被重新启动（PID ${replacement.pid}）。`);
  }
  return true;
}

export async function restartMimiDaemon(
  config: AppConfig,
  options: { force?: boolean } = {},
): Promise<DaemonStatus> {
  config = await resolveDaemonWorkspaceConfig(config);
  await stopMimiDaemon(config, options);
  return startMimiDaemon(config);
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
