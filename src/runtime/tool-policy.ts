import type { Tool } from '@openai/agents';
import type { AgentMode } from './instructions.js';

const PLAN_TOOLS = new Set([
  'current_time', 'calculate', 'read_file', 'list_directory', 'search_files', 'web_search',
  'search_knowledge', 'recall', 'list_memories', 'list_skills', 'use_skill', 'read_skill_resource',
  'list_mcp_resources', 'read_mcp_resource',
  'update_plan', 'show_plan', 'show_goal', 'runtime_status', 'list_models', 'list_modes',
  'switch_model', 'switch_mode', 'set_output_level', 'list_sessions', 'get_session_history',
]);

export function toolsForMode(mode: AgentMode, baseTools: Tool[], teamTools: Tool[] = []): Tool[] {
  if (mode === 'plan') return baseTools.filter((item) => PLAN_TOOLS.has(item.name));
  return mode === 'ultra' ? [...baseTools, ...teamTools] : baseTools;
}
