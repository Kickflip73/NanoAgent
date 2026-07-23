import type { Tool } from '@openai/agents';
import { privateRuntimePaths, type AgentPermissionMode } from '../config.js';
import type { TeamTask } from '../core/team.js';
import { createTools } from '../tools.js';

export interface TeamWorkerToolOptions {
  workspaceRoot: string;
  dataRoot: string;
  permissionMode: AgentPermissionMode;
  task: TeamTask;
  memorySearchTool?: Tool;
}

export function createTeamWorkerTools(options: TeamWorkerToolOptions): Tool[] {
  const canWrite = options.task.role === 'builder' && options.permissionMode !== 'read-only';
  return [
    ...createTools(
      options.workspaceRoot,
      false,
      privateRuntimePaths(options),
      {
        readablePaths: ['.'],
        writablePaths: canWrite ? options.task.paths : [],
        allowWrite: canWrite,
        allowShell: false,
      },
    ),
    ...(options.memorySearchTool ? [options.memorySearchTool] : []),
  ];
}
