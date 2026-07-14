import type { Tool } from '@openai/agents';
import type { AgentPermissionMode } from '../config.js';
import type { TeamRole } from '../core/team.js';
import type { AgentMode } from './instructions.js';

export type ToolCapability = 'read' | 'write' | 'execute' | 'network-read' | 'network-write' | 'control';
export type SubAgentRole = 'researcher' | 'reviewer' | 'architect';

interface ToolPolicy {
  capabilities?: readonly ToolCapability[];
  modes?: readonly AgentMode[];
  subAgents?: readonly SubAgentRole[];
  teamRoles?: readonly TeamRole[];
  teamRolesWithShell?: readonly TeamRole[];
  sideEffect?: true;
  displayedOrchestrationTool?: true;
}

const ALL_MODES = ['general', 'plan', 'ultra'] as const satisfies readonly AgentMode[];
const PLAN_AND_ULTRA = ['plan', 'ultra'] as const satisfies readonly AgentMode[];
const ULTRA_ONLY = ['ultra'] as const satisfies readonly AgentMode[];
const ALL_SUBAGENTS = ['researcher', 'architect', 'reviewer'] as const satisfies readonly SubAgentRole[];
const ALL_TEAM_ROLES = ['explorer', 'architect', 'builder', 'tester', 'reviewer'] as const satisfies readonly TeamRole[];

const TOOL_POLICY = {
  current_time: {
    modes: ALL_MODES,
    subAgents: ['researcher'],
    teamRoles: ['explorer', 'builder', 'tester'],
  },
  calculate: { modes: ALL_MODES, teamRoles: ['builder', 'tester'] },
  read_file: { capabilities: ['read'], modes: ALL_MODES, subAgents: ALL_SUBAGENTS, teamRoles: ALL_TEAM_ROLES },
  write_file: { capabilities: ['write'], teamRoles: ['builder'], sideEffect: true },
  edit_file: { capabilities: ['write'], teamRoles: ['builder'], sideEffect: true },
  move_file: { capabilities: ['write'], teamRoles: ['builder'], sideEffect: true },
  list_directory: { capabilities: ['read'], modes: ALL_MODES, subAgents: ALL_SUBAGENTS, teamRoles: ALL_TEAM_ROLES },
  search_files: { capabilities: ['read'], modes: ALL_MODES, subAgents: ALL_SUBAGENTS, teamRoles: ALL_TEAM_ROLES },
  run_shell: {
    capabilities: ['execute'],
    teamRolesWithShell: ['builder', 'tester', 'reviewer'],
    sideEffect: true,
  },
  http_get: {
    capabilities: ['network-read'],
    modes: ALL_MODES,
    subAgents: ['researcher'],
    teamRoles: ['explorer'],
  },
  web_search: {
    capabilities: ['network-read'],
    modes: ALL_MODES,
    subAgents: ['researcher', 'architect'],
    teamRoles: ['explorer', 'architect'],
  },
  http_request: { capabilities: ['network-read', 'network-write'], sideEffect: true },
  search_knowledge: { capabilities: ['read'], modes: ALL_MODES, subAgents: ALL_SUBAGENTS, teamRoles: ALL_TEAM_ROLES },
  index_knowledge: { sideEffect: true },

  recall: { modes: ALL_MODES },
  list_memories: { modes: ALL_MODES },
  remember: { sideEffect: true },
  forget: { sideEffect: true },

  list_skills: { modes: ALL_MODES },
  use_skill: { modes: ALL_MODES },
  read_skill_resource: { modes: ALL_MODES },
  reload_skills: {},
  list_mcp_resources: { modes: ALL_MODES },
  read_mcp_resource: { modes: ALL_MODES },

  update_plan: { modes: ALL_MODES, sideEffect: true },
  show_plan: { modes: ALL_MODES },
  set_goal: { sideEffect: true },
  update_goal: { sideEffect: true },
  show_goal: { modes: ALL_MODES },

  runtime_status: { modes: ALL_MODES },
  list_models: { modes: ALL_MODES },
  list_modes: { modes: ALL_MODES },
  switch_model: { capabilities: ['control'], modes: ALL_MODES, sideEffect: true },
  switch_mode: { capabilities: ['control'], modes: ALL_MODES, sideEffect: true },
  set_output_level: { modes: ALL_MODES, sideEffect: true },
  list_sessions: { modes: ALL_MODES },
  get_session_history: { modes: ALL_MODES },
  switch_session: { sideEffect: true },
  new_session: { sideEffect: true },
  clear_session: { sideEffect: true },
  reload_mcp: { sideEffect: true },
  request_exit: { sideEffect: true },

  delegate_research: { modes: ALL_MODES, displayedOrchestrationTool: true },
  delegate_architecture: { modes: PLAN_AND_ULTRA, displayedOrchestrationTool: true },
  delegate_review: { modes: ALL_MODES, displayedOrchestrationTool: true },

  set_team_tasks: { modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  show_team_tasks: { modes: ULTRA_ONLY, displayedOrchestrationTool: true },
  claim_team_task: { modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  update_team_task: { modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  retry_team_task: { modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  run_team: { modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
} as const satisfies Record<string, ToolPolicy>;

type RegisteredToolName = keyof typeof TOOL_POLICY;
const TOOL_POLICY_ENTRIES = Object.entries(TOOL_POLICY) as Array<[RegisteredToolName, ToolPolicy]>;

function policyFor(name: string): ToolPolicy | undefined {
  return TOOL_POLICY[name as RegisteredToolName];
}

function availableInMode(name: string, mode: AgentMode): boolean {
  const modes = policyFor(name)?.modes;
  if (modes) return modes.includes(mode);
  return mode !== 'plan';
}

export const TOOL_CAPABILITIES: Readonly<Record<string, readonly ToolCapability[]>> = Object.freeze(
  Object.fromEntries(TOOL_POLICY_ENTRIES
    .filter((entry) => entry[1].capabilities !== undefined)
    .map(([name, policy]) => [name, policy.capabilities!])),
);

export function isSideEffectTool(name: string): boolean {
  return policyFor(name)?.sideEffect === true;
}

export function subAgentToolNames(role: SubAgentRole): readonly string[] {
  return TOOL_POLICY_ENTRIES
    .filter((entry) => entry[1].subAgents?.includes(role))
    .map(([name]) => name);
}

export function teamRoleToolNames(role: TeamRole, allowUnsandboxedShell = false): readonly string[] {
  const names = TOOL_POLICY_ENTRIES
    .filter((entry) => entry[1].teamRoles?.includes(role))
    .map(([name]) => name);
  if (allowUnsandboxedShell) {
    names.push(...TOOL_POLICY_ENTRIES
      .filter((entry) => entry[1].teamRolesWithShell?.includes(role))
      .map(([name]) => name));
  }
  return names;
}

export function toolsForMode(mode: AgentMode, baseTools: Tool[], teamTools: Tool[] = []): Tool[] {
  const tools = mode === 'ultra' ? [...baseTools, ...teamTools] : baseTools;
  return tools.filter((tool) => availableInMode(tool.name, mode));
}

export function toolsForPermission(
  mode: AgentPermissionMode,
  tools: Tool[],
  customCapabilities: Readonly<Record<string, readonly ToolCapability[]>> = {},
): Tool[] {
  if (mode === 'trusted') return tools;
  return tools.filter((tool) => {
    const policy = policyFor(tool.name);
    const declared = customCapabilities[tool.name];
    if (!policy && !declared) return false;
    const capabilities = policy?.capabilities ?? declared ?? [];
    if (capabilities.includes('execute') || capabilities.includes('network-write')) return false;
    return mode !== 'read-only' || !capabilities.includes('write');
  });
}

export function toolNamesForMode(mode: AgentMode, baseTools: Tool[]): string[] {
  const names = toolsForMode(mode, baseTools).map((tool) => tool.name);
  names.push(...TOOL_POLICY_ENTRIES
    .filter(([name, policy]) => policy.displayedOrchestrationTool && availableInMode(name, mode))
    .map(([name]) => name));
  return [...new Set(names)].sort();
}
