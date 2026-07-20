import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { MimiStore } from './store.js';

export function createMimiSessionActivityTools(store: MimiStore, sessionKey: string): Tool[] {
  const inspect = tool({
    name: 'inspect_mimi_session_activity',
    description: '检索当前人物或会话 Session 最近处理过的事务及结果，用于恢复较早上下文、核对已经做过什么、继续未完成事项。只读取当前 Session 的有界结果，不返回外部事件原文、其他 Session、投递内容或 target。',
    parameters: z.object({
      query: z.string().trim().max(200).optional().describe('可选关键词，例如项目名、人物或动作；省略则返回最近结果'),
      limit: z.number().int().min(1).max(20).default(10),
    }),
    execute: async ({ query, limit }) => {
      const activities = store.sessionActivity(sessionKey, query ? 100 : limit);
      if (!query) return activities.slice(0, limit);
      const wanted = query.toLocaleLowerCase();
      return activities.filter((activity) => [
        activity.source, activity.answer, activity.error, activity.taskStatus, activity.runStatus,
      ].some((value) => value?.toLocaleLowerCase().includes(wanted))).slice(0, limit);
    },
  });
  const cancelInterrupted = tool({
    name: 'cancel_interrupted_mimi_task',
    description: '取消当前 Session 中已被新 owner 命令打断并重新排队的旧任务。先用 inspect_mimi_session_activity 找到 taskId；只能取消当前 Session 的 interrupted 任务，不能影响其他会话或正在执行的事务。',
    parameters: z.object({
      taskId: z.string().uuid(),
      reason: z.string().trim().min(1).max(500),
    }),
    execute: async ({ taskId, reason }) => ({
      taskId,
      cancelled: store.cancelInterruptedSessionTask(sessionKey, taskId, reason),
    }),
  });
  return [inspect, cancelInterrupted];
}
