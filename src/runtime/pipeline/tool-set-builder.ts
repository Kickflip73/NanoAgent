import type { Tool } from '@openai/agents';
import type { AgentPermissionMode, SecurityProfile } from '../../config.js';
import type { AgentMode } from '../instructions.js';
import {
  toolsForMode,
  toolsForPermission,
  toolsForRunPolicy,
  type RunToolPolicy,
} from '../tool-policy.js';

export class ToolSetBuilder {
  scoped(
    tools: Tool[],
    permissionMode: AgentPermissionMode,
    securityProfile: SecurityProfile,
    policy: RunToolPolicy | undefined,
    computerEnabled: boolean,
  ): Tool[] {
    return toolsForRunPolicy(
      toolsForPermission(permissionMode, tools, {}, securityProfile),
      policy,
    ).filter((tool) => computerEnabled
      || (tool.name !== 'computer_observe' && tool.name !== 'computer_act'));
  }

  final(
    mode: AgentMode,
    baseTools: Tool[],
    teamTools: Tool[],
    subAgentTools: Tool[],
    permissionMode: AgentPermissionMode,
    securityProfile: SecurityProfile,
    policy?: RunToolPolicy,
  ): Tool[] {
    const modeTools = toolsForRunPolicy(
      toolsForPermission(
        permissionMode,
        toolsForMode(mode, baseTools, teamTools),
        {},
        securityProfile,
      ),
      policy,
    );
    const delegated = toolsForRunPolicy(
      toolsForPermission(permissionMode, subAgentTools, {}, securityProfile),
      policy,
    );
    return [...modeTools, ...delegated];
  }
}
