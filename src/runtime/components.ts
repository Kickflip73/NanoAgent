import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import type { AppConfig } from '../config.js';
import { ContextManager } from '../core/context.js';
import { ExecutionLedger } from '../core/execution-ledger.js';
import { GuidanceLoader } from '../core/guidance.js';
import { MemoryStore } from '../core/memory.js';
import { PlanStore } from '../core/plan.js';
import { TeamTaskStore } from '../core/team.js';
import { TraceStore } from '../core/trace.js';
import { MCPManager } from '../extensions/mcp.js';
import { RagStore } from '../extensions/rag.js';
import { SkillLoader } from '../extensions/skills.js';
import { createModel, type ModelRuntime } from './model.js';

async function isWorkspaceConfig(configFile: string, workspaceRoot: string): Promise<boolean> {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(configFile);
  const lexical = path.relative(root, target);
  if (lexical === '' || (!lexical.startsWith('..') && !path.isAbsolute(lexical))) return true;
  try {
    const { realpath } = await import('node:fs/promises');
    const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(target)]);
    const relative = path.relative(canonicalRoot, canonicalTarget);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

async function canonicalPath(value: string): Promise<string> {
  try {
    const { realpath } = await import('node:fs/promises');
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

export interface RuntimeComponents {
  modelRuntime: ModelRuntime;
  context: ContextManager;
  guidance: GuidanceLoader;
  memory: MemoryStore;
  skills: SkillLoader;
  rag: RagStore;
  plans: PlanStore;
  team: TeamTaskStore;
  traces: TraceStore;
  ledger: ExecutionLedger;
  mcp: MCPManager;
  sessionId: string;
}

export async function createRuntimeComponents(config: AppConfig): Promise<RuntimeComponents> {
  const modelRuntime = createModel(config);
  const embeddingClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch })
    : undefined;
  const sessionId = process.env.AGENT_SESSION ?? 'default';
  const protectedPaths = [config.dataRoot, path.join(os.homedir(), '.nano-agent')];
  const skills = new SkillLoader(config.skillsRoot);
  const workspaceMcp = await isWorkspaceConfig(config.mcpConfig, config.workspaceRoot);
  const workspaceTrusted = config.trustedWorkspaceMcp !== undefined
    && await canonicalPath(config.trustedWorkspaceMcp) === await canonicalPath(config.workspaceRoot);
  const mcp = new MCPManager(config.mcpConfig, config.workspaceRoot, {
    enabled: !workspaceMcp || workspaceTrusted,
    disabledReason: '项目 MCP 默认不执行；确认仓库可信后把 TRUST_WORKSPACE_MCP 设为该工作区绝对路径',
  });
  await Promise.all([skills.load(), mcp.connect()]);
  return {
    modelRuntime,
    context: new ContextManager(
      config.historyLimit,
      modelRuntime.profile.contextWindow,
      0.55,
      modelRuntime.profile.outputReserve,
    ),
    guidance: new GuidanceLoader(config.workspaceRoot),
    memory: new MemoryStore(path.join(config.dataRoot, 'memories.json')),
    skills,
    rag: new RagStore(
      config.workspaceRoot,
      path.join(config.dataRoot, 'rag-index.json'),
      embeddingClient,
      protectedPaths,
      config.permissionMode === 'trusted',
    ),
    plans: new PlanStore(path.join(config.dataRoot, 'plans.json'), sessionId),
    team: new TeamTaskStore(path.join(config.dataRoot, 'teams.json'), sessionId),
    traces: new TraceStore(path.join(config.dataRoot, 'traces')),
    ledger: new ExecutionLedger(path.join(config.dataRoot, 'execution-ledger.json')),
    mcp,
    sessionId,
  };
}
