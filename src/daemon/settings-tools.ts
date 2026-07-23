import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import { AttentionEngine, mimiSettingsSchema } from './attention.js';

export function createMimiSettingsTools(attention: AttentionEngine): Tool[] {
  const get = tool({
    name: 'get_mimi_settings',
    description: '读取 MimiAgent 当前 owner 画像、时区、静默时段、自治预算、告警阈值、运行超时、历史保留和主动简报设置。修改设置前必须先调用本工具取得完整快照。',
    parameters: mimiSettingsSchema.pick({}).strict(),
    execute: async () => attention.getSettings(),
  });

  const update = tool({
    name: 'update_mimi_settings',
    description: '用完整快照更新 MimiAgent 助手设置。必须先读取当前设置，只修改需要调整的字段并原样保留其余字段；人物、规则、例程和 Standing Orders 不在此工具范围内，不会被覆盖。',
    parameters: mimiSettingsSchema,
    execute: async (settings) => attention.updateSettings(settings),
  });

  const getSnooze = tool({
    name: 'get_mimi_snooze',
    description: '读取 MimiAgent 当前临时免打扰状态、到期时间和可选原因。',
    parameters: mimiSettingsSchema.pick({}).strict(),
    execute: async () => attention.snoozeStatus(),
  });

  const snooze = tool({
    name: 'snooze_mimi',
    description: '临时暂停 MimiAgent 的非紧急自主处理和主动简报，到期自动恢复；owner 当前直接命令和达到 urgentPriority 的事件不受影响。',
    parameters: z.object({
      minutes: z.number().int().min(1).max(43_200),
      reason: z.string().trim().min(1).max(200).optional(),
    }).strict(),
    execute: async ({ minutes, reason }) => attention.snoozeFor(minutes, reason),
  });

  const clearSnooze = tool({
    name: 'clear_mimi_snooze',
    description: '立即结束 MimiAgent 临时免打扰并恢复普通 Attention 处理。',
    parameters: mimiSettingsSchema.pick({}).strict(),
    execute: async () => attention.clearSnooze(),
  });

  return [get, update, getSnooze, snooze, clearSnooze];
}
