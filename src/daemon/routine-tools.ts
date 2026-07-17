import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { AttentionEngine, mimiRoutineSchema } from './attention.js';

export function createMimiRoutineTools(attention: AttentionEngine): Tool[] {
  const list = tool({
    name: 'list_mimi_routines',
    description: '列出 MimiAgent 按本地时区运行的 Daily Routines，包括时间、工作日、任务指令和投递覆盖。用于查看、修改或删除固定时刻的主动工作。',
    parameters: z.object({}),
    execute: async () => attention.listRoutines(),
  });

  const upsert = tool({
    name: 'upsert_mimi_routine',
    description: '按稳定 ID 新增或完整更新一个 Daily Routine。适合“每天 9 点检查邮件”或“工作日下班前收尾”等固定本地时刻任务；修改前应先列出已有 Routine。',
    parameters: mimiRoutineSchema,
    execute: async (routine) => attention.upsertRoutine(routine),
  });

  const remove = tool({
    name: 'remove_mimi_routine',
    description: '按稳定 ID 删除一个 Daily Routine。已入队但未执行的旧触发会在执行前失效；历史 Event 仍保留。',
    parameters: z.object({ id: z.string().regex(/^[a-zA-Z0-9._-]+$/).min(1).max(60) }),
    execute: async ({ id }) => ({ id, removed: await attention.removeRoutine(id) }),
  });

  return [list, upsert, remove];
}
