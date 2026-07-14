import os from 'node:os';
import path from 'node:path';
import type { Tool } from '@openai/agents';
import type { AgentPermissionMode } from '../config.js';
import type { TeamTask } from '../core/team.js';
import { createTools } from '../tools.js';

export interface TeamWorkerToolOptions {
  workspaceRoot: string;
  dataRoot: string;
  permissionMode: AgentPermissionMode;
  task: TeamTask;
  searchKnowledgeTool?: Tool;
}

export function createTeamWorkerTools(options: TeamWorkerToolOptions): Tool[] {
  const canWrite = options.task.role === 'builder' && options.permissionMode !== 'read-only';
  return [
    ...createTools(
      options.workspaceRoot,
      false,
      [options.dataRoot, path.join(os.homedir(), '.nano-agent')],
      {
        readablePaths: ['.'],
        writablePaths: canWrite ? options.task.paths : [],
        allowWrite: canWrite,
        allowShell: false,
      },
    ),
    ...(options.searchKnowledgeTool ? [options.searchKnowledgeTool] : []),
  ];
}
