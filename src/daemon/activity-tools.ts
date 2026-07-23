import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { MimiStore } from './store.js';

export function createMimiActivityTools(store: MimiStore): Tool[] {
  return [tool({
    name: 'inspect_mimi_activity',
    description: '读取 MimiAgent 当前积压、失败、近期事件/执行/投递状态和状态变化。counts 是持久库当前保留窗口内的记录，不是本次进程启动以来的计数器。tasks 是所有可执行工作单元的统计，其中 conversation 表示一次需 Agent 处理的对话，并不等于后台任务；只有 background 才是委派的后台任务。回答数量时必须结合 tasksByType 和 recentTasks.source/eventType 区分，不要把 tasks.completed 总数称为后台任务数。只返回有界运行元数据，不返回其他事务正文、答案、投递内容或目标。',
    parameters: z.object({
      limit: z.number().int().min(1).max(20).describe('每类近期记录返回数量，通常使用 10'),
    }),
    execute: async ({ limit }) => store.activitySnapshot(limit),
  })];
}
