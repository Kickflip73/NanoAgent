import os from 'node:os';
import path from 'node:path';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import {
  PRE_MIMI_DAEMON_DIRECTORY,
  PRE_MIMI_DATA_DIRECTORY,
} from './core/mimi-legacy.js';
import type { ComputerConfig } from './extensions/computer/types.js';

export type AgentPermissionMode = 'workspace' | 'read-only' | 'trusted';
export type SecurityProfile = 'safe' | 'workstation' | 'full-owner';

export interface SecurityProfileSummary {
  id: SecurityProfile;
  label: string;
  permissionMode: AgentPermissionMode;
  shell: boolean;
  externalTransactions: boolean;
  computerUse: boolean;
  trustedWorkspaceMcp: boolean;
}

export const SECURITY_PROFILES: Readonly<Record<SecurityProfile, SecurityProfileSummary>> = Object.freeze({
  safe: Object.freeze({
    id: 'safe',
    label: 'Safe',
    permissionMode: 'read-only',
    shell: false,
    externalTransactions: false,
    computerUse: false,
    trustedWorkspaceMcp: false,
  }),
  workstation: Object.freeze({
    id: 'workstation',
    label: 'Workstation',
    permissionMode: 'workspace',
    shell: false,
    externalTransactions: true,
    computerUse: false,
    trustedWorkspaceMcp: false,
  }),
  'full-owner': Object.freeze({
    id: 'full-owner',
    label: 'Full Owner',
    permissionMode: 'trusted',
    shell: true,
    externalTransactions: true,
    computerUse: true,
    trustedWorkspaceMcp: true,
  }),
});

export interface AppConfig {
  provider: 'openai' | 'deepseek';
  workspaceRoot: string;
  dataRoot: string;
  daemonDataRoot?: string;
  skillsRoot: string;
  mcpConfig: string;
  historyLimit: number;
  contextWindow?: number;
  outputReserve?: number;
  maxTurns: number | null;
  teamMaxConcurrency?: number;
  sessionMaxConcurrency?: number;
  permissionMode?: AgentPermissionMode;
  securityProfile?: SecurityProfile;
  trustedWorkspaceMcp?: string;
  computer?: ComputerConfig;
}

interface EnvironmentEntry {
  name: string;
  value: string;
}

function environmentEntry(primary: string, ...legacy: string[]): EnvironmentEntry | undefined {
  for (const name of [primary, ...legacy]) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return { name, value };
  }
  return undefined;
}

export function preferredEnvironmentValue(primary: string, ...legacy: string[]): string | undefined {
  return environmentEntry(primary, ...legacy)?.value;
}

function expandHome(value: string, homeDirectory = os.homedir()): string {
  if (value === '~') return path.resolve(homeDirectory);
  if (/^~[\\/]/.test(value)) return path.resolve(homeDirectory, value.slice(2));
  if (value.startsWith('~')) throw new Error('路径中的 ~ 只支持单独使用或 ~/path 形式');
  return path.resolve(value);
}

function pathExists(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function directoryExists(target: string, trustedRoot: string): boolean {
  const root = path.resolve(trustedRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`自动运行数据路径必须位于可信根目录内：${resolved}`);
  }
  let current = root;
  const components = relative.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error(`自动运行数据路径不能包含符号链接：${current}`);
      if (!info.isDirectory()) throw new Error(`运行数据路径不是目录：${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (index === components.length - 1) return true;
  }
  return false;
}

function directoryHasEntries(target: string): boolean {
  return readdirSync(target).length > 0;
}

function compatibleDirectory(
  modern: string,
  legacy: string,
  label: string,
  trustedRoot: string,
  migrate = true,
): string {
  const modernExists = directoryExists(modern, trustedRoot);
  const legacyExists = directoryExists(legacy, trustedRoot);
  if (modernExists && legacyExists) {
    const modernHasState = directoryHasEntries(modern);
    const legacyHasState = directoryHasEntries(legacy);
    if (!modernHasState && legacyHasState) {
      if (!migrate) return legacy;
      rmdirSync(modern);
      renameSync(legacy, modern);
      return modern;
    }
    if (!legacyHasState) return modern;
    throw new Error(`${label}同时存在新目录 ${modern} 和旧目录 ${legacy}；请显式设置 MIMI_*_DIR 选择唯一数据源`);
  }
  if (modernExists) return modern;
  if (legacyExists) {
    if (!migrate) return legacy;
    mkdirSync(path.dirname(modern), { recursive: true, mode: 0o700 });
    renameSync(legacy, modern);
    return modern;
  }
  return modern;
}

function positiveSafeInteger(names: readonly [string, ...string[]], fallback?: number): number | undefined {
  const selected = environmentEntry(names[0], ...names.slice(1));
  if (!selected) return fallback;
  if (!/^\d+$/.test(selected.value)) throw new Error(`${selected.name} 必须是正安全整数`);
  const value = Number(selected.value);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${selected.name} 必须是正安全整数`);
  return value;
}

function modelProvider(): AppConfig['provider'] {
  const selected = environmentEntry('MIMI_MODEL_PROVIDER', 'MODEL_PROVIDER');
  const value = selected?.value ?? 'openai';
  if (value !== 'openai' && value !== 'deepseek') {
    throw new Error(`${selected?.name ?? 'MIMI_MODEL_PROVIDER'} 只能是 openai 或 deepseek`);
  }
  return value;
}

function configurationVersion(): number | undefined {
  const configVersion = environmentEntry('MIMI_CONFIG_VERSION');
  if (configVersion && (!/^\d+$/.test(configVersion.value)
    || !Number.isSafeInteger(Number(configVersion.value))
    || Number(configVersion.value) <= 0)) {
    throw new Error('MIMI_CONFIG_VERSION 必须是正安全整数');
  }
  return configVersion ? Number(configVersion.value) : undefined;
}

function configuredSecurityProfile(): SecurityProfile | undefined {
  const selected = environmentEntry('MIMI_SECURITY_PROFILE');
  if (!selected) return undefined;
  if (!['safe', 'workstation', 'full-owner'].includes(selected.value)) {
    throw new Error('MIMI_SECURITY_PROFILE 只能是 safe、workstation 或 full-owner');
  }
  return selected.value as SecurityProfile;
}

function permissionMode(profile?: SecurityProfile): AgentPermissionMode {
  const modern = environmentEntry('MIMI_PERMISSION_MODE');
  const legacy = environmentEntry('AGENT_PERMISSION_MODE');
  const selected = modern ?? legacy;
  const version = configurationVersion();
  // Older templates wrote workspace even when the owner made no choice. That
  // default appeared under both the legacy and modern names, so only a current
  // template marker can distinguish a deliberate workspace restriction.
  const oldTemplateWorkspace = !profile && selected?.value === 'workspace' && (version ?? 0) < 2;
  const value = oldTemplateWorkspace
    ? 'trusted'
    : selected?.value ?? SECURITY_PROFILES[profile ?? 'safe'].permissionMode;
  if (value !== 'workspace' && value !== 'read-only' && value !== 'trusted') {
    throw new Error(`${selected?.name ?? 'MIMI_PERMISSION_MODE'} 只能是 workspace、read-only 或 trusted`);
  }
  if (profile && value !== SECURITY_PROFILES[profile].permissionMode) {
    throw new Error(
      `MIMI_SECURITY_PROFILE=${profile} 要求 MIMI_PERMISSION_MODE=${SECURITY_PROFILES[profile].permissionMode}`,
    );
  }
  return value;
}

function inferredSecurityProfile(mode: AgentPermissionMode): SecurityProfile {
  if (mode === 'read-only') return 'safe';
  if (mode === 'workspace') return 'workstation';
  return 'full-owner';
}

export function securityProfileSummary(
  config: Pick<AppConfig, 'securityProfile' | 'permissionMode' | 'computer' | 'trustedWorkspaceMcp'>,
): SecurityProfileSummary {
  const mode = config.permissionMode ?? 'trusted';
  const id = config.securityProfile ?? inferredSecurityProfile(mode);
  const base = SECURITY_PROFILES[id];
  return {
    ...base,
    permissionMode: mode,
    computerUse: base.computerUse && config.computer !== undefined,
    trustedWorkspaceMcp: base.trustedWorkspaceMcp && config.trustedWorkspaceMcp !== undefined,
  };
}

function optionalAbsolutePath(names: readonly [string, ...string[]], homeDirectory: string): string | undefined {
  const selected = environmentEntry(names[0], ...names.slice(1));
  if (!selected) return undefined;
  if (!selected.value.startsWith('~') && !path.isAbsolute(selected.value)) {
    throw new Error(`${selected.name} 必须是可信工作区的绝对路径`);
  }
  const expanded = expandHome(selected.value, homeDirectory);
  return expanded;
}

function booleanEnvironment(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} 只能是 true 或 false`);
}

function computerConfig(homeDirectory: string): ComputerConfig | undefined {
  const backend = process.env.MIMI_COMPUTER_BACKEND;
  if (backend === undefined || backend === '') return undefined;
  if (backend !== 'cua') throw new Error('MIMI_COMPUTER_BACKEND 第一阶段只能是 cua');
  const selectedCommand = process.env.MIMI_CUA_DRIVER_COMMAND;
  if (!selectedCommand) throw new Error('启用 Computer Use 时必须设置 MIMI_CUA_DRIVER_COMMAND');
  if (!selectedCommand.startsWith('~') && !path.isAbsolute(selectedCommand)) {
    throw new Error('MIMI_CUA_DRIVER_COMMAND 必须是可执行文件的绝对路径');
  }
  const driverCommand = expandHome(selectedCommand, homeDirectory);
  const info = statSync(driverCommand);
  if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error('MIMI_CUA_DRIVER_COMMAND 必须指向可执行普通文件');
  const defaultAccess = process.env.MIMI_COMPUTER_DEFAULT_ACCESS ?? 'background';
  if (!['none', 'observe', 'background', 'foreground', 'admin'].includes(defaultAccess)) {
    throw new Error('MIMI_COMPUTER_DEFAULT_ACCESS 必须是 none、observe、background、foreground 或 admin');
  }
  return {
    backend,
    driverCommand,
    actionTimeoutMs: positiveSafeInteger(['MIMI_COMPUTER_ACTION_TIMEOUT_MS'], 15_000)!,
    maxActionsPerRun: positiveSafeInteger(['MIMI_COMPUTER_MAX_ACTIONS_PER_RUN'], 50)!,
    maxScreenshotsPerRun: positiveSafeInteger(['MIMI_COMPUTER_MAX_SCREENSHOTS_PER_RUN'], 12)!,
    pauseWhenTargetFrontmost: booleanEnvironment('MIMI_COMPUTER_PAUSE_WHEN_TARGET_FRONTMOST', true),
    defaultAccess: defaultAccess as ComputerConfig['defaultAccess'],
    foregroundLeaseSeconds: positiveSafeInteger(['MIMI_COMPUTER_FOREGROUND_LEASE_SECONDS'], 30)!,
    artifactMaxBytes: positiveSafeInteger(['MIMI_COMPUTER_ARTIFACT_MAX_MIB'], 1_024)! * 1024 * 1024,
  };
}

export function resolveEnvironmentFile(
  environmentFile?: string,
  homeDirectory = os.homedir(),
): string {
  const explicit = environmentFile ?? preferredEnvironmentValue('MIMI_ENV_FILE', 'DOTENV_CONFIG_PATH');
  if (explicit) return expandHome(explicit, homeDirectory);
  const modern = path.join(homeDirectory, '.mimi-agent', '.env');
  const legacy = path.join(homeDirectory, PRE_MIMI_DATA_DIRECTORY, '.env');
  if (pathExists(modern)) return modern;
  if (pathExists(legacy)) {
    mkdirSync(path.dirname(modern), { recursive: true, mode: 0o700 });
    renameSync(legacy, modern);
  }
  return modern;
}

export function loadEnvironment(environmentFile?: string, homeDirectory = os.homedir()): void {
  const resolved = resolveEnvironmentFile(environmentFile, homeDirectory);
  try {
    if (statSync(resolved).isFile()) chmodSync(resolved, 0o600);
    const parent = path.dirname(resolved);
    const privateRoots = [
      path.join(homeDirectory, '.mimi-agent'),
      path.join(homeDirectory, PRE_MIMI_DATA_DIRECTORY),
    ];
    if (privateRoots.includes(parent) && statSync(parent).isDirectory()) chmodSync(parent, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  loadDotenv({ path: resolved, quiet: true });
}

export function privateRuntimePaths(
  config: Pick<AppConfig, 'workspaceRoot' | 'dataRoot' | 'daemonDataRoot'>,
  homeDirectory = os.homedir(),
): string[] {
  return [...new Set([
    config.dataRoot,
    config.daemonDataRoot,
    path.join(config.workspaceRoot, '.mimi-agent'),
    path.join(config.workspaceRoot, PRE_MIMI_DATA_DIRECTORY),
    path.join(homeDirectory, '.mimi-agent'),
    path.join(homeDirectory, PRE_MIMI_DATA_DIRECTORY),
  ].filter((value): value is string => Boolean(value)).map((value) => path.resolve(value)))];
}

export function adoptWorkspaceConfig(
  config: AppConfig,
  workspaceRoot: string,
  homeDirectory = os.homedir(),
): AppConfig {
  const workspace = path.resolve(workspaceRoot);
  const explicitDataRoot = preferredEnvironmentValue('MIMI_DATA_DIR', 'AGENT_DATA_DIR');
  const explicitSkillsRoot = preferredEnvironmentValue('MIMI_SKILLS_DIR', 'AGENT_SKILLS_DIR');
  const explicitMcpConfig = preferredEnvironmentValue('MIMI_MCP_CONFIG', 'MCP_CONFIG');
  return {
    ...config,
    workspaceRoot: workspace,
    dataRoot: explicitDataRoot
      ? config.dataRoot
      : compatibleDirectory(
          path.join(workspace, '.mimi-agent'),
          path.join(workspace, PRE_MIMI_DATA_DIRECTORY),
          '工作区运行数据',
          workspace,
        ),
    skillsRoot: explicitSkillsRoot ? config.skillsRoot : path.join(workspace, 'skills'),
    mcpConfig: explicitMcpConfig ? config.mcpConfig : path.join(workspace, 'mcp.json'),
  };
}

export function loadConfig(homeDirectory = os.homedir()): AppConfig {
  const explicitWorkspace = preferredEnvironmentValue('MIMI_WORKSPACE', 'AGENT_WORKSPACE');
  const workspaceRoot = explicitWorkspace ? expandHome(explicitWorkspace, homeDirectory) : path.resolve(process.cwd());
  const explicitDataRoot = preferredEnvironmentValue('MIMI_DATA_DIR', 'AGENT_DATA_DIR');
  const dataRoot = explicitDataRoot
    ? expandHome(explicitDataRoot, homeDirectory)
    : compatibleDirectory(
        path.join(workspaceRoot, '.mimi-agent'),
        path.join(workspaceRoot, PRE_MIMI_DATA_DIRECTORY),
        '工作区运行数据',
        workspaceRoot,
      );
  const explicitDaemonDataRoot = preferredEnvironmentValue('MIMI_DAEMON_DATA_DIR');
  const daemonDataRoot = explicitDaemonDataRoot
    ? expandHome(explicitDaemonDataRoot, homeDirectory)
    : compatibleDirectory(
        path.join(homeDirectory, '.mimi-agent', 'daemon'),
        path.join(homeDirectory, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY),
        '常驻运行数据',
        homeDirectory,
        false,
      );
  const contextWindow = positiveSafeInteger(['MIMI_CONTEXT_WINDOW', 'CONTEXT_WINDOW']);
  const outputReserve = positiveSafeInteger(['MIMI_OUTPUT_TOKEN_RESERVE', 'OUTPUT_TOKEN_RESERVE']);
  const teamMaxConcurrency = positiveSafeInteger(['MIMI_TEAM_MAX_CONCURRENCY', 'TEAM_MAX_CONCURRENCY'], 4)!;
  if (teamMaxConcurrency > 4) throw new Error('MIMI_TEAM_MAX_CONCURRENCY 必须在 1～4 之间');
  const sessionMaxConcurrency = positiveSafeInteger(['MIMI_SESSION_MAX_CONCURRENCY'], 4)!;
  if (sessionMaxConcurrency > 16) throw new Error('MIMI_SESSION_MAX_CONCURRENCY 必须在 1～16 之间');
  if (contextWindow !== undefined && outputReserve !== undefined && outputReserve >= contextWindow) {
    throw new Error('MIMI_OUTPUT_TOKEN_RESERVE 必须小于 MIMI_CONTEXT_WINDOW');
  }
  const skillsRoot = preferredEnvironmentValue('MIMI_SKILLS_DIR', 'AGENT_SKILLS_DIR');
  const mcpConfig = preferredEnvironmentValue('MIMI_MCP_CONFIG', 'MCP_CONFIG');
  const selectedMaxTurns = environmentEntry('MIMI_MAX_TURNS', 'MAX_TURNS');
  const configVersion = configurationVersion();
  const requestedSecurityProfile = configuredSecurityProfile();
  const selectedPermissionMode = permissionMode(requestedSecurityProfile);
  const selectedSecurityProfile = requestedSecurityProfile ?? inferredSecurityProfile(selectedPermissionMode);
  const generatedTurnLimit = selectedMaxTurns?.name === 'MIMI_MAX_TURNS' && (
    (selectedMaxTurns.value === '200' && configVersion === 2)
    || (selectedMaxTurns.value === '32' && (configVersion ?? 0) <= 3)
  );
  const maxTurns = !selectedMaxTurns || generatedTurnLimit
    ? null
    : positiveSafeInteger(['MIMI_MAX_TURNS', 'MAX_TURNS'])!;
  const trustedWorkspaceMcp = optionalAbsolutePath(
    ['MIMI_TRUST_WORKSPACE_MCP', 'TRUST_WORKSPACE_MCP'],
    homeDirectory,
  );
  const computer = computerConfig(homeDirectory);
  if (selectedSecurityProfile !== 'full-owner' && computer) {
    throw new Error(`MIMI_SECURITY_PROFILE=${selectedSecurityProfile} 不允许启用 Computer Use`);
  }
  if (selectedSecurityProfile !== 'full-owner' && trustedWorkspaceMcp) {
    throw new Error(`MIMI_SECURITY_PROFILE=${selectedSecurityProfile} 不允许信任工作区 MCP`);
  }
  return {
    provider: modelProvider(),
    workspaceRoot,
    dataRoot,
    daemonDataRoot,
    skillsRoot: skillsRoot ? expandHome(skillsRoot, homeDirectory) : path.join(workspaceRoot, 'skills'),
    mcpConfig: mcpConfig ? expandHome(mcpConfig, homeDirectory) : path.join(workspaceRoot, 'mcp.json'),
    historyLimit: positiveSafeInteger(['MIMI_HISTORY_LIMIT', 'HISTORY_LIMIT'], 40)!,
    contextWindow,
    outputReserve,
    maxTurns,
    teamMaxConcurrency,
    sessionMaxConcurrency,
    permissionMode: selectedPermissionMode,
    securityProfile: selectedSecurityProfile,
    trustedWorkspaceMcp,
    computer,
  };
}
