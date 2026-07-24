import type { TeamRole } from './team.js';

export type SubAgentRole = 'researcher' | 'reviewer' | 'architect';

const SHARED_READ_TOOLS = [
  'read_file',
  'list_directory',
  'search_files',
  'inspect_changes',
  'memory_search',
  'memory_read',
  'memory_links',
] as const;

const SUBAGENT_TOOLS: Record<SubAgentRole, readonly string[]> = {
  researcher: [
    'current_time',
    ...SHARED_READ_TOOLS.slice(0, 4),
    'http_get',
    'web_search',
    ...SHARED_READ_TOOLS.slice(4),
  ],
  architect: [
    ...SHARED_READ_TOOLS.slice(0, 4),
    'web_search',
    ...SHARED_READ_TOOLS.slice(4),
  ],
  reviewer: SHARED_READ_TOOLS,
};

const TEAM_ROLE_TOOLS: Record<TeamRole, readonly string[]> = {
  explorer: SUBAGENT_TOOLS.researcher,
  architect: SUBAGENT_TOOLS.architect,
  builder: [
    'current_time',
    'calculate',
    'read_file',
    'write_file',
    'edit_file',
    'apply_patch',
    'move_file',
    'list_directory',
    'search_files',
    'inspect_changes',
    'memory_search',
    'memory_read',
    'memory_links',
  ],
  tester: [
    'current_time',
    'calculate',
    ...SHARED_READ_TOOLS,
  ],
  reviewer: SHARED_READ_TOOLS,
};

const TEAM_SHELL_ROLES = new Set<TeamRole>(['builder', 'tester', 'reviewer']);

export function subAgentToolNames(role: SubAgentRole): readonly string[] {
  return SUBAGENT_TOOLS[role];
}

export function teamRoleToolNames(role: TeamRole, allowUnsandboxedShell = false): readonly string[] {
  const names = TEAM_ROLE_TOOLS[role];
  return allowUnsandboxedShell && TEAM_SHELL_ROLES.has(role) ? [...names, 'run_shell'] : names;
}
