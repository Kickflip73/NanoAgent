import os from 'node:os';
import path from 'node:path';
import { chmodSync, statSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

export type AgentPermissionMode = 'workspace' | 'read-only' | 'trusted';

export interface AppConfig {
  provider: 'openai' | 'deepseek';
  workspaceRoot: string;
  dataRoot: string;
  skillsRoot: string;
  mcpConfig: string;
  historyLimit: number;
  contextWindow?: number;
  outputReserve?: number;
  maxTurns: number;
  teamMaxConcurrency?: number;
  permissionMode?: AgentPermissionMode;
  trustedWorkspaceMcp?: string;
}

function positiveSafeInteger(name: string, fallback?: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是正安全整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正安全整数`);
  return value;
}

function modelProvider(): AppConfig['provider'] {
  const value = process.env.MODEL_PROVIDER ?? 'openai';
  if (value !== 'openai' && value !== 'deepseek') {
    throw new Error('MODEL_PROVIDER 只能是 openai 或 deepseek');
  }
  return value;
}

function permissionMode(): AgentPermissionMode {
  const value = process.env.AGENT_PERMISSION_MODE ?? 'workspace';
  if (value !== 'workspace' && value !== 'read-only' && value !== 'trusted') {
    throw new Error('AGENT_PERMISSION_MODE 只能是 workspace、read-only 或 trusted');
  }
  return value;
}

function optionalAbsolutePath(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  if (!path.isAbsolute(value)) throw new Error(`${name} 必须是可信工作区的绝对路径`);
  return path.resolve(value);
}

export function loadEnvironment(
  environmentFile = process.env.DOTENV_CONFIG_PATH ?? path.join(os.homedir(), '.nano-agent', '.env'),
): void {
  const resolved = path.resolve(environmentFile);
  try {
    if (statSync(resolved).isFile()) chmodSync(resolved, 0o600);
    const defaultDirectory = path.join(os.homedir(), '.nano-agent');
    if (path.dirname(resolved) === defaultDirectory && statSync(defaultDirectory).isDirectory()) {
      chmodSync(defaultDirectory, 0o700);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  loadDotenv({ path: resolved, quiet: true });
}

export function loadConfig(): AppConfig {
  const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE ?? process.cwd());
  const contextWindow = positiveSafeInteger('CONTEXT_WINDOW');
  const outputReserve = positiveSafeInteger('OUTPUT_TOKEN_RESERVE');
  const teamMaxConcurrency = positiveSafeInteger('TEAM_MAX_CONCURRENCY', 4)!;
  if (teamMaxConcurrency > 4) throw new Error('TEAM_MAX_CONCURRENCY 必须在 1～4 之间');
  if (contextWindow !== undefined && outputReserve !== undefined && outputReserve >= contextWindow) {
    throw new Error('OUTPUT_TOKEN_RESERVE 必须小于 CONTEXT_WINDOW');
  }
  return {
    provider: modelProvider(),
    workspaceRoot,
    dataRoot: path.resolve(process.env.AGENT_DATA_DIR ?? path.join(workspaceRoot, '.nano-agent')),
    skillsRoot: path.resolve(process.env.AGENT_SKILLS_DIR ?? path.join(workspaceRoot, 'skills')),
    mcpConfig: path.resolve(process.env.MCP_CONFIG ?? path.join(workspaceRoot, 'mcp.json')),
    historyLimit: positiveSafeInteger('HISTORY_LIMIT', 40)!,
    contextWindow,
    outputReserve,
    maxTurns: positiveSafeInteger('MAX_TURNS', 200)!,
    teamMaxConcurrency,
    permissionMode: permissionMode(),
    trustedWorkspaceMcp: optionalAbsolutePath('TRUST_WORKSPACE_MCP'),
  };
}
