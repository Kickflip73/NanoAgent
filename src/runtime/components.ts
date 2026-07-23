import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { preferredEnvironmentValue, type AppConfig } from '../config.js';
import { ContextManager } from '../core/context.js';
import { ExecutionLedger } from '../core/execution-ledger.js';
import { ProjectGuidanceLoader, SoulLoader } from '../core/guidance.js';
import type { MemoryHub } from '../core/memory.js';
import { PlanStore } from '../core/plan.js';
import { TeamTaskStore } from '../core/team.js';
import { TraceStore } from '../core/trace.js';
import { isMcpConfigurationTrusted, MCPManager } from '../extensions/mcp.js';
import { createRoutedMemoryHub } from '../extensions/memory/hub.js';
import { SkillLoader } from '../extensions/skills.js';
import { ComputerManager } from '../extensions/computer/manager.js';
import { CuaDriverClient } from '../extensions/computer/cua-driver-client.js';
import { createModel, type ModelRuntime } from './model.js';

export interface RuntimeComponents {
  modelRuntime: ModelRuntime;
  context: ContextManager;
  soul: SoulLoader;
  projectGuidance: ProjectGuidanceLoader;
  memory: MemoryHub;
  skills: SkillLoader;
  plans: PlanStore;
  team: TeamTaskStore;
  traces: TraceStore;
  ledger: ExecutionLedger;
  mcp: MCPManager;
  sessionId: string;
  computer?: ComputerManager;
}

export async function createRuntimeComponents(
  config: AppConfig,
  requestedSessionId?: string,
  options: {
    mcpEnvironment?: Readonly<Record<string, string>>;
    enableMcp?: boolean;
    releaseMcpEnvironmentAfterConnect?: boolean;
  } = {},
): Promise<RuntimeComponents> {
  const modelRuntime = createModel(config);
  const embeddingClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, fetch: globalThis.fetch })
    : undefined;
  const sessionId = requestedSessionId
    ?? preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION')
    ?? 'default';
  const skills = new SkillLoader(config.skillsRoot);
  const mcpTrusted = await isMcpConfigurationTrusted(
    config.mcpConfig,
    config.workspaceRoot,
    config.trustedWorkspaceMcp,
  );
  const mcpEnabled = options.enableMcp !== false && mcpTrusted;
  const mcpSecrets = Object.values(options.mcpEnvironment ?? {}).filter(Boolean);
  const mcp = new MCPManager(config.mcpConfig, config.workspaceRoot, {
    enabled: mcpEnabled,
    disabledReason: options.enableMcp === false
      ? '当前 Task 不允许 MCP'
      : '项目 MCP 默认不执行；确认仓库可信后把 MIMI_TRUST_WORKSPACE_MCP 设为该工作区绝对路径',
    // Trusting a workspace MCP configuration authorizes its declared transports.
    // Local file/Shell permission modes remain a separate boundary for built-in tools.
    allowStdio: mcpEnabled,
    resolveEnvironment: options.mcpEnvironment
      ? (name) => options.mcpEnvironment?.[name]
      : undefined,
    redactError: mcpSecrets.length > 0
      ? (message) => mcpSecrets.reduce(
          (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
          message,
        )
      : undefined,
  });
  const packagedSoulFile = fileURLToPath(new URL('../../MIMI.md', import.meta.url));
  const soul = new SoulLoader(path.join(config.dataRoot, 'MIMI.md'), packagedSoulFile);
  const memory = createRoutedMemoryHub({
    workspaceRoot: config.workspaceRoot,
    dataRoot: config.dataRoot,
    userSoulFile: soul.userFile,
    packagedSoulFile,
    embeddingClient,
    retrievalMode: process.env.MIMI_MEMORY_RETRIEVAL_MODE === 'lexical' ? 'lexical' : 'auto',
  });
  await Promise.all([skills.load(), mcp.connect()]);
  if (options.releaseMcpEnvironmentAfterConnect) mcpSecrets.length = 0;
  return {
    modelRuntime,
    context: new ContextManager(
      config.historyLimit,
      modelRuntime.profile.contextWindow,
      0.55,
      modelRuntime.profile.outputReserve,
    ),
    soul,
    projectGuidance: new ProjectGuidanceLoader(config.workspaceRoot),
    memory,
    skills,
    plans: new PlanStore(path.join(config.dataRoot, 'plans.json'), sessionId),
    team: new TeamTaskStore(path.join(config.dataRoot, 'teams.json'), sessionId),
    traces: new TraceStore(path.join(config.dataRoot, 'traces')),
    ledger: new ExecutionLedger(path.join(config.dataRoot, 'execution-ledger.json')),
    mcp,
    sessionId,
    ...(config.computer ? {
      computer: new ComputerManager(
        config.computer,
        new CuaDriverClient(config.computer.driverCommand, config.computer.actionTimeoutMs),
        config.dataRoot,
      ),
    } : {}),
  };
}
