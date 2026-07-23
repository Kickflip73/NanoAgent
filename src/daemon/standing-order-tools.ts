import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { AttentionEngine, mimiInstructionSchema } from './attention.js';

export function createMimiStandingOrderTools(attention: AttentionEngine): Tool[] {
  const list = tool({
    name: 'list_mimi_standing_orders',
    description: '列出 MimiAgent 当前代表 owner 处理所有 Daemon 事务时遵循的长期 Standing Orders。用于新增或删除前核对现有规则。',
    parameters: z.object({}),
    execute: async () => attention.listStandingOrders(),
  });

  const add = tool({
    name: 'add_mimi_standing_order',
    description: '添加一条长期替身规则，例如“能直接完成就代我完成”或“涉及时间承诺时先检查日历”。相同规则幂等，不会重复添加；owner 当前直接命令仍优先。',
    parameters: z.object({ instruction: mimiInstructionSchema }),
    execute: async ({ instruction }) => attention.addStandingOrder(instruction),
  });

  const remove = tool({
    name: 'remove_mimi_standing_order',
    description: '按完整文本删除一条长期 Standing Order。删除前先列出规则以取得准确文本。',
    parameters: z.object({ instruction: mimiInstructionSchema }),
    execute: async ({ instruction }) => attention.removeStandingOrder(instruction),
  });

  return [list, add, remove];
}
