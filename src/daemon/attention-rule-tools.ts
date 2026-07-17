import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { AttentionEngine, mimiAttentionRuleSchema } from './attention.js';

const ruleIdSchema = z.string().min(1).max(100);
const upsertRuleSchema = mimiAttentionRuleSchema.extend({ beforeId: ruleIdSchema.optional() });

export function createMimiAttentionRuleTools(attention: AttentionEngine): Tool[] {
  const list = tool({
    name: 'list_mimi_attention_rules',
    description: '按实际匹配顺序列出 MimiAgent 的确定性注意力规则。第一条匹配规则决定事件 run、digest、notify 或 ignore；修改前应先列出。',
    parameters: z.object({}),
    execute: async () => attention.listAttentionRules(),
  });

  const upsert = tool({
    name: 'upsert_mimi_attention_rule',
    description: '按稳定 ID 新增或完整更新一条注意力规则。source 支持 *，可按事件类型和优先级范围匹配；beforeId 可把规则放在另一条规则前。更新默认保留原位置，新规则默认追加。',
    parameters: upsertRuleSchema,
    execute: async ({ beforeId, ...rule }) => attention.upsertAttentionRule(rule, beforeId),
  });

  const remove = tool({
    name: 'remove_mimi_attention_rule',
    description: '按稳定 ID 删除一条注意力规则，只影响后续事件。',
    parameters: z.object({ id: ruleIdSchema }),
    execute: async ({ id }) => ({ id, removed: await attention.removeAttentionRule(id) }),
  });

  return [list, upsert, remove];
}
