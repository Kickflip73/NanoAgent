import type { Tool } from '@openai/agents';
import type { AgentPermissionMode } from '../config.js';
import type { TeamRole } from '../core/team.js';
import type { AgentMode } from './instructions.js';

export type ToolCapability =
  | 'read'
  | 'write'
  | 'execute'
  | 'network-read'
  | 'network-write'
  | 'memory-read'
  | 'memory-write'
  | 'state-read'
  | 'state-write'
  | 'delivery-control'
  | 'control';
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
  inspect_mimi_capabilities: { capabilities: ['state-read'], modes: ALL_MODES },
  set_mimi_connector_enabled: { capabilities: ['state-write'], sideEffect: true },
  reload_mimi_connectors: { capabilities: ['state-write'], sideEffect: true },
  connector_action: { capabilities: ['state-write'], sideEffect: true },
  search_knowledge: { capabilities: ['read'], modes: ALL_MODES, subAgents: ALL_SUBAGENTS, teamRoles: ALL_TEAM_ROLES },
  index_knowledge: { sideEffect: true },

  recall: { capabilities: ['memory-read'], modes: ALL_MODES },
  list_memories: { capabilities: ['memory-read'], modes: ALL_MODES },
  remember: { capabilities: ['memory-write'], sideEffect: true },
  forget: { capabilities: ['memory-write'], sideEffect: true },

  list_skills: { capabilities: ['read'], modes: ALL_MODES },
  use_skill: { capabilities: ['read'], modes: ALL_MODES },
  read_skill_resource: { capabilities: ['read'], modes: ALL_MODES },
  reload_skills: { capabilities: ['control'], sideEffect: true },
  list_mcp_resources: { capabilities: ['read'], modes: ALL_MODES },
  read_mcp_resource: { capabilities: ['read'], modes: ALL_MODES },

  update_plan: { capabilities: ['state-write'], modes: ALL_MODES, sideEffect: true },
  prepare_task: { capabilities: ['state-read'], modes: ALL_MODES },
  finish_task: { capabilities: ['state-read'], modes: ALL_MODES },
  show_plan: { capabilities: ['state-read'], modes: ALL_MODES },
  set_goal: { capabilities: ['state-write'], sideEffect: true },
  update_goal: { capabilities: ['state-write'], sideEffect: true },
  show_goal: { capabilities: ['state-read'], modes: ALL_MODES },

  schedule_mimi_follow_up: { capabilities: ['state-write'], sideEffect: true },
  schedule_mimi_routine: { capabilities: ['state-write'], sideEffect: true },
  schedule_mimi_watch: { capabilities: ['state-write'], sideEffect: true },
  complete_current_mimi_schedule: { capabilities: ['state-write'], sideEffect: true },
  get_mimi_settings: { capabilities: ['state-read'], modes: ALL_MODES },
  update_mimi_settings: { capabilities: ['state-write'], sideEffect: true },
  get_mimi_snooze: { capabilities: ['state-read'], modes: ALL_MODES },
  snooze_mimi: { capabilities: ['state-write'], sideEffect: true },
  clear_mimi_snooze: { capabilities: ['state-write'], sideEffect: true },
  list_mimi_attention_rules: { capabilities: ['state-read'], modes: ALL_MODES },
  upsert_mimi_attention_rule: { capabilities: ['state-write'], sideEffect: true },
  remove_mimi_attention_rule: { capabilities: ['state-write'], sideEffect: true },
  list_mimi_routines: { capabilities: ['state-read'], modes: ALL_MODES },
  upsert_mimi_routine: { capabilities: ['state-write'], sideEffect: true },
  remove_mimi_routine: { capabilities: ['state-write'], sideEffect: true },
  list_mimi_people: { capabilities: ['state-read'], modes: ALL_MODES },
  upsert_mimi_person: { capabilities: ['state-write'], sideEffect: true },
  remove_mimi_person: { capabilities: ['state-write'], sideEffect: true },
  list_mimi_source_policies: { capabilities: ['state-read'], modes: ALL_MODES },
  upsert_mimi_source_policy: { capabilities: ['state-write'], sideEffect: true },
  remove_mimi_source_policy: { capabilities: ['state-write'], sideEffect: true },
  list_mimi_standing_orders: { capabilities: ['state-read'], modes: ALL_MODES },
  add_mimi_standing_order: { capabilities: ['state-write'], sideEffect: true },
  remove_mimi_standing_order: { capabilities: ['state-write'], sideEffect: true },
  finish_mimi_silently: { capabilities: ['delivery-control'], modes: ALL_MODES },
  inspect_mimi_activity: { capabilities: ['state-read'], modes: ALL_MODES },
  inspect_mimi_session_activity: { capabilities: ['state-read'], modes: ALL_MODES },
  cancel_interrupted_mimi_task: { capabilities: ['state-write'], sideEffect: true },
  list_mimi_schedules: { capabilities: ['state-read'], modes: ALL_MODES },
  cancel_mimi_schedule: { capabilities: ['state-write'], sideEffect: true },
  request_mimi_briefing: { capabilities: ['state-write'], sideEffect: true },
  delegate_background_task: { capabilities: ['state-write'], sideEffect: true, displayedOrchestrationTool: true },
  list_background_tasks: { capabilities: ['state-read'], modes: ALL_MODES },
  inspect_background_task: { capabilities: ['state-read'], modes: ALL_MODES },
  cancel_background_task: { capabilities: ['state-write'], sideEffect: true },
  pause_background_task: { capabilities: ['state-write'], sideEffect: true },
  resume_background_task: { capabilities: ['state-write'], sideEffect: true },
  request_background_task_input: { capabilities: ['state-write'], sideEffect: true },
  runtime_status: { capabilities: ['control'], modes: ALL_MODES },
  list_models: { capabilities: ['control'], modes: ALL_MODES },
  list_modes: { capabilities: ['control'], modes: ALL_MODES },
  switch_model: { capabilities: ['control'], modes: ALL_MODES, sideEffect: true },
  switch_mode: { capabilities: ['control'], modes: ALL_MODES, sideEffect: true },
  set_output_level: { capabilities: ['control'], modes: ALL_MODES, sideEffect: true },
  list_sessions: { capabilities: ['control'], modes: ALL_MODES },
  get_session_history: { capabilities: ['control'], modes: ALL_MODES },
  switch_session: { capabilities: ['control'], sideEffect: true },
  new_session: { capabilities: ['control'], sideEffect: true },
  clear_session: { capabilities: ['control'], sideEffect: true },
  reload_mcp: { capabilities: ['control'], sideEffect: true },
  request_exit: { capabilities: ['control'], sideEffect: true },

  delegate_research: { capabilities: ['read'], modes: ALL_MODES, displayedOrchestrationTool: true },
  delegate_architecture: { capabilities: ['read'], modes: PLAN_AND_ULTRA, displayedOrchestrationTool: true },
  delegate_review: { capabilities: ['read'], modes: ALL_MODES, displayedOrchestrationTool: true },

  set_team_tasks: { capabilities: ['state-write'], modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  show_team_tasks: { capabilities: ['state-read'], modes: ULTRA_ONLY, displayedOrchestrationTool: true },
  claim_team_task: { capabilities: ['state-write'], modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  update_team_task: { capabilities: ['state-write'], modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  retry_team_task: { capabilities: ['state-write'], modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
  run_team: { capabilities: ['execute', 'state-write'], modes: ULTRA_ONLY, sideEffect: true, displayedOrchestrationTool: true },
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
    // Deployment read-only limits MimiAgent's local durable state. Connector
    // transactions are separately authorized by owner/system provenance and
    // the per-run event policy, so reusing the file permission switch here
    // would make configured messaging channels mysteriously unavailable.
    return mode !== 'read-only' || tool.name === 'connector_action' || !capabilities.some((capability) => (
      capability === 'write' || capability === 'memory-write' || capability === 'state-write'
    ));
  });
}

export interface RunToolPolicy {
  allowedCapabilities: readonly ToolCapability[];
  allowedTools?: readonly string[];
  allowSideEffects?: boolean;
  allowedSideEffectTools?: readonly string[];
  allowUnknownTools?: boolean;
}

export function toolsForRunPolicy(tools: Tool[], policy?: RunToolPolicy): Tool[] {
  if (!policy) return tools;
  const allowed = new Set(policy.allowedCapabilities);
  const allowedTools = policy.allowedTools ? new Set(policy.allowedTools) : undefined;
  const allowedSideEffects = policy.allowedSideEffectTools
    ? new Set(policy.allowedSideEffectTools)
    : undefined;
  return tools.filter((tool) => {
    if (allowedTools && !allowedTools.has(tool.name)) return false;
    const registered = policyFor(tool.name);
    if (!registered) return policy.allowUnknownTools === true;
    if (registered.sideEffect && policy.allowSideEffects !== true) return false;
    if (registered.sideEffect && allowedSideEffects && !allowedSideEffects.has(tool.name)) return false;
    return (registered.capabilities ?? []).every((capability) => allowed.has(capability));
  });
}

export function toolNamesForMode(
  mode: AgentMode,
  baseTools: Tool[],
  permissionMode: AgentPermissionMode = 'trusted',
): string[] {
  const names = toolsForMode(mode, toolsForPermission(permissionMode, baseTools)).map((tool) => tool.name);
  names.push(...TOOL_POLICY_ENTRIES
    .filter(([name, policy]) => policy.displayedOrchestrationTool && availableInMode(name, mode))
    .filter(([name]) => toolsForPermission(permissionMode, [{ name } as Tool]).length === 1)
    .map(([name]) => name));
  return [...new Set(names)].sort();
}
