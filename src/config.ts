import os from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

export interface AppConfig {
  provider: 'openai' | 'deepseek';
  workspaceRoot: string;
  dataRoot: string;
  skillsRoot: string;
  mcpConfig: string;
  historyLimit: number;
  maxTurns: number;
}

export function loadEnvironment(
  environmentFile = process.env.DOTENV_CONFIG_PATH ?? path.join(os.homedir(), '.nano-agent', '.env'),
): void {
  loadDotenv({ path: path.resolve(environmentFile), quiet: true });
}

export function loadConfig(): AppConfig {
  const workspaceRoot = path.resolve(process.env.AGENT_WORKSPACE ?? process.cwd());
  return {
    provider: process.env.MODEL_PROVIDER === 'deepseek' ? 'deepseek' : 'openai',
    workspaceRoot,
    dataRoot: path.resolve(process.env.AGENT_DATA_DIR ?? path.join(workspaceRoot, '.nano-agent')),
    skillsRoot: path.resolve(process.env.AGENT_SKILLS_DIR ?? path.join(workspaceRoot, 'skills')),
    mcpConfig: path.resolve(process.env.MCP_CONFIG ?? path.join(workspaceRoot, 'mcp.json')),
    historyLimit: Number(process.env.HISTORY_LIMIT ?? 40),
    maxTurns: Number(process.env.MAX_TURNS ?? 200),
  };
}
