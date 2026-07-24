import { Agent, type Tool } from '@openai/agents';
import type { MCPManager } from '../../extensions/mcp.js';
import type { AgentModel } from '../model.js';

export interface AgentRequestInput {
  model: AgentModel;
  instructions: string;
  tools: Tool[];
  mcpServers: MCPManager['servers'];
  outputReserve: number;
  focusedOutputLimit?: number;
}

export interface PreparedAgentRequest {
  agent: Agent;
  maxTokens: number;
  toolNames: readonly string[];
}

export class AgentRequestFactory {
  create(input: AgentRequestInput): PreparedAgentRequest {
    const maxTokens = input.focusedOutputLimit === undefined
      ? input.outputReserve
      : Math.min(input.outputReserve, input.focusedOutputLimit);
    const agent = new Agent({
      name: 'MimiAgent',
      model: input.model,
      modelSettings: { maxTokens },
      instructions: input.instructions,
      tools: input.tools,
      mcpServers: input.mcpServers,
      mcpConfig: { includeServerInToolNames: true },
    });
    return {
      agent,
      maxTokens,
      toolNames: Object.freeze(input.tools.map((tool) => tool.name)),
    };
  }
}
