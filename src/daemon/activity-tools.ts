import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { MimiStore } from './store.js';

export function createMimiActivityTools(store: MimiStore): Tool[] {
  return [tool({
    name: 'inspect_mimi_activity',
    description: '读取 MimiAgent 当前积压、失败、近期事件/执行/投递状态和状态变化。适合主动例程自检、回答最近做了什么、确认是否有失败需要 owner 关注。只返回有界运行元数据，不返回其他事务正文、答案、投递内容或目标。',
    parameters: z.object({
      limit: z.number().int().min(1).max(20).describe('每类近期记录返回数量，通常使用 10'),
    }),
    execute: async ({ limit }) => store.activitySnapshot(limit),
  })];
}
