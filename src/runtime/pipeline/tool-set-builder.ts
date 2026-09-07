import type { AgentInputItem, Tool } from '@openai/agents';
import type { AgentMode } from '../instructions.js';
import {
  toolsForMode,
  toolsForRunPolicy,
  type RunToolPolicy,
} from '../tool-policy.js';

export function isPersonalMessageFallbackTool(name: string): boolean {
  return name === 'run_shell'
    || name === 'computer_observe'
    || name === 'computer_act'
    || /(?:^|[_-])(?:mcp|cua|computer|desktop|browser)(?:[_-]|$)/iu.test(name);
}

export function withoutPersonalMessageDesktopFallback(tools: Tool[]): Tool[] {
  return tools.filter((tool) => !isPersonalMessageFallbackTool(tool.name));
}

export function withoutPersonalMessageFallbackHistory(items: AgentInputItem[]): AgentInputItem[] {
  const turns: AgentInputItem[][] = [];
  let current: AgentInputItem[] = [];
  for (const item of items) {
    if ('role' in item && item.role === 'user' && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) turns.push(current);
  return turns.flatMap((turn, index) => {
    if (index === turns.length - 1) return turn;
    const usedFallback = turn.some((item) => {
      const value = item as unknown as Record<string, unknown>;
      return (value.type === 'function_call' || value.type === 'function_call_result')
        && typeof value.name === 'string'
        && isPersonalMessageFallbackTool(value.name);
    });
    return usedFallback ? [] : turn;
  });
}

export interface ClassifiedToolSet {
  direct: Tool[];
  deferred: Tool[];
}

export class ToolSetBuilder {
  classify(
    tools: Tool[],
    policy?: RunToolPolicy,
    additionalNames: readonly string[] = [],
  ): ClassifiedToolSet {
    const alwaysDeferred = new Set([
      'inspect_mimi_capabilities',
      'connector_capability',
      'connector_action',
      'inspect_runtime_capabilities',
      'invoke_runtime_capability',
    ]);
    const core = new Set([
      'current_time',
      'read_file',
      'write_file',
      'edit_file',
      'apply_patch',
      'move_file',
      'list_directory',
      'search_files',
      'inspect_changes',
      'run_shell',
      'http_get',
      'web_search',
      'code_interpreter',
      'browser_open',
      'browser_observe',
      'browser_act',
      'browser_wait',
      'browser_assert',
      'browser_close',
      'computer_observe',
      'computer_act',
      'inspect_capabilities',
      'invoke_capability',
      'read_context_artifact',
      'task_history',
      'speech',
      'model_control',
      'memory_search',
      'remember',
      ...(policy?.allowedTools ?? []),
      ...additionalNames,
    ]);
    const direct = tools.filter((candidate) => core.has(candidate.name)
      && !alwaysDeferred.has(candidate.name)
      && !candidate.name.includes('skill')
      && !candidate.name.startsWith('mcp_'));
    const directNames = new Set(direct.map((candidate) => candidate.name));
    return {
      direct,
      deferred: tools.filter((candidate) => !directNames.has(candidate.name)),
    };
  }

  sdkTools(classified: ClassifiedToolSet, gatewayTools: readonly Tool[]): Tool[] {
    return [...classified.direct, ...gatewayTools];
  }

  scoped(
    tools: Tool[],
    policy: RunToolPolicy | undefined,
    computerEnabled: boolean,
  ): Tool[] {
    return toolsForRunPolicy(tools, policy).filter((tool) => computerEnabled
      || (tool.name !== 'computer_observe' && tool.name !== 'computer_act'));
  }

  final(
    mode: AgentMode,
    baseTools: Tool[],
    teamTools: Tool[],
    subAgentTools: Tool[],
    policy?: RunToolPolicy,
  ): Tool[] {
    const modeTools = toolsForRunPolicy(
      toolsForMode(mode, baseTools, teamTools),
      policy,
    );
    const delegated = toolsForRunPolicy(subAgentTools, policy);
    return [...modeTools, ...delegated];
  }
}
