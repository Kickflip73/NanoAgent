import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { ImmutableEvent, TaskRecord } from './types.js';

export interface MimiDeliveryControl {
  suppressed: boolean;
  reason?: string;
}

export function createMimiDeliveryTools(
  task: TaskRecord,
  _event: ImmutableEvent,
  control: MimiDeliveryControl,
): Tool[] {
  if (task.type === 'conversation') return [];
  return [tool({
    name: 'finish_mimi_silently',
    description: '仅用于自主巡检已完成、确认没有新变化、风险、已执行动作或需要 owner 关注事项时，安静结束本次任务。调用后本次成功结果仍保留在 MimiAgent 记录中，但不主动推送。不要用它隐藏错误，也不要在仍有值得汇报的信息时调用。',
    parameters: z.object({
      reason: z.string().trim().min(1).max(500).describe('为什么本次检查无需打扰 owner 的简短审计原因'),
    }),
    execute: async ({ reason }) => {
      control.suppressed = true;
      control.reason = reason;
      return { suppressed: true, reason };
    },
  })];
}
