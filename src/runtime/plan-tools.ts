import { tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import {
  completionCriterionSchema,
  type CompletionContract,
} from '../core/completion.js';
import type { Goal, PlanStore } from '../core/plan.js';

export interface PlanToolOptions {
  beforeGoalSet?: () => void | Promise<void>;
  completionContract?: () => CompletionContract | undefined;
  onGoalSet?: (goal: Goal) => void | Promise<void>;
}

export function createPlanTools(store: PlanStore, options: PlanToolOptions = {}): Tool[] {
  const step = z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    status: z.enum(['pending', 'running', 'completed', 'failed']),
  });
  return [
    tool({
      name: 'update_plan',
      description: '为多步骤任务创建或更新执行计划。阶段开始前将对应步骤设为 running，结束后立即设为 completed 或 failed，再推进下一步；返回的完整列表是本轮后续执行的当前权威状态。简单问题无需使用。',
      parameters: z.object({ steps: z.array(step).max(20) }),
      execute: async ({ steps }) => store.update(steps),
    }),
    tool({
      name: 'show_plan',
      description: '查看当前会话的任务计划。',
      parameters: z.object({}),
      execute: async () => store.get(),
    }),
    tool({
      name: 'set_goal',
      description: '为需要跨多轮或跨重启继续的长任务设置持久 Goal，并在开始执行前给出可验证验收条件。',
      parameters: z.object({
        objective: z.string().min(1).max(2_000),
        acceptanceCriteria: z.array(completionCriterionSchema).min(1).max(8),
      }),
      execute: async ({ objective, acceptanceCriteria }) => {
        await options.beforeGoalSet?.();
        const goal = await store.setGoal(
          objective,
          acceptanceCriteria,
          options.completionContract?.(),
        );
        await options.onGoalSet?.(goal);
        return goal;
      },
    }),
    tool({
      name: 'update_goal',
      description: '保存长期 Goal 的状态、下一步和简短检查点，供之后 /resume 恢复。',
      parameters: z.object({
        status: z.enum(['active', 'paused', 'completed', 'failed']).optional(),
        nextAction: z.string().max(2_000).optional(),
        checkpoint: z.string().max(8_000).optional(),
      }),
      execute: async (update) => {
        if (update.status === 'completed') {
          throw new Error('Goal 不能由模型直接标记 completed；请调用 finish_task 通过 Completion Gate');
        }
        return store.checkpoint(update);
      },
    }),
    tool({
      name: 'show_goal',
      description: '查看当前会话的长期 Goal、检查点和计划。',
      parameters: z.object({}),
      execute: async () => ({ goal: await store.getGoal(), steps: await store.get() }),
    }),
  ];
}
