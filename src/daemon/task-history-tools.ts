import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { tool } from '../tool-factory.js';
import { toolResultObject } from '../core/tool-result.js';
import { runFinalizationRecordSchema } from '../core/run-finalization.js';
import type { ImmutableEvent, TaskRecord } from './types.js';
import type { MimiStore } from './store.js';

/** Query the existing Task records; never invent a second task/artifact database. */
export function createTaskHistoryTools(store: MimiStore, event: ImmutableEvent, currentTaskId?: string): Tool[] {
  if (event.trust !== 'owner') return [];
  return [tool({
    name: 'task_history',
    description: '查询本人的跨会话历史结果，包含对话、后台和定时任务。list 用 query 查目标/结果，inspect 按 taskId 取实际结果、业务终态与产物路径。查既有成果先用此工具，不把仅列后台任务的空结果当作没有记录。文件路径是历史工具回执，不保证现在仍存在或业务验收通过。',
    parameters: z.object({
      action: z.enum(['list', 'inspect']),
      query: z.string().trim().min(1).max(200).optional(),
      type: z.enum(['conversation', 'background', 'scheduled', 'briefing', 'memory_maintenance']).optional(),
      scheduleId: z.string().uuid().optional(),
      sessionId: z.string().trim().min(1).max(200).optional(),
      taskId: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(30).default(10),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    execute: ({ action, query, type, scheduleId, sessionId, taskId, limit, offset }) => {
      const summary = (task: TaskRecord) => {
        const objective = toolResultObject(task.objective);
        const result = toolResultObject(task.result);
        const finalization = runFinalizationRecordSchema.safeParse(result?.finalization);
        return { taskId: task.id, type: task.type, status: task.status,
          outcome: finalization.success ? finalization.data.outcome : 'unknown',
          objective: String(objective?.objective ?? objective?.prompt ?? '').slice(0, 600),
          sessionId: task.sessionKey, scheduleId: objective?.scheduleId,
          createdAt: task.createdAt, updatedAt: task.updatedAt,
          error: task.error?.slice(0, 1_000),
          artifacts: finalization.success ? (finalization.data.artifacts ?? []).slice(0, 30) : [],
        };
      };
      if (action === 'list') {
        const tasks = store.listTasks(limit + 1, { profileId: event.profileId, query, type,
          scheduleId, sessionKey: sessionId, excludeId: currentTaskId, offset });
        return { scope: { profileId: event.profileId, type: type ?? 'all', query, sessionId, scheduleId },
          tasks: tasks.slice(0, limit).map((task) => ({ ...summary(task), artifacts: undefined })),
          truncated: tasks.length > limit,
          ...(tasks.length > limit ? { nextOffset: offset + limit } : {}),
          next: 'inspect relevant taskId; task status completed alone is not proof of requested deliverables',
        };
      }
      if (!taskId) throw new Error('inspect 需要 taskId');
      const task = store.getTask(taskId);
      if (!task || task.profileId !== event.profileId) throw new Error('任务不存在');
      const body = JSON.stringify(task.result ?? null);
      return { ...summary(task), resultJson: body.slice(offset, offset + 12_000),
        resultTruncated: body.length > offset + 12_000,
        ...(body.length > offset + 12_000 ? { nextOffset: offset + 12_000 } : {}),
        next: 'Use existing artifacts for the requested operation; verify their date/content/existence. Missing output is not permission to regenerate the original task.',
      };
    },
  })];
}
