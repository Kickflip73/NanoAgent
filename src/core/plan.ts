import { tool } from '@openai/agents';
import { z } from 'zod';
import { assertSessionId } from './session-id.js';
import { AtomicJsonStore } from './state-file.js';
import { completionCriterionSchema, type CompletionCriterion } from './completion.js';

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface Goal {
  objective: string;
  status: GoalStatus;
  acceptanceCriteria?: CompletionCriterion[];
  completionEvidence?: string;
  nextAction?: string;
  checkpoint?: string;
  createdAt: string;
  updatedAt: string;
}

interface TaskState {
  steps: PlanStep[];
  goal?: Goal;
}

type StoredPlans = Record<string, PlanStep[] | TaskState>;
type Plans = Record<string, TaskState>;
type PlanListener = (sessionId: string, steps: PlanStep[]) => void | Promise<void>;

const planStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
});
const goalSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'completed', 'failed']),
  acceptanceCriteria: z.array(completionCriterionSchema).max(8).optional(),
  completionEvidence: z.string().optional(),
  nextAction: z.string().optional(),
  checkpoint: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const taskStateSchema = z.object({ steps: z.array(planStepSchema).default([]), goal: goalSchema.optional() });
const storedPlansSchema = z.record(z.string(), z.union([z.array(planStepSchema), taskStateSchema]));

function decodePlans(value: unknown): Plans {
  const stored = storedPlansSchema.parse(value) as StoredPlans;
  return Object.assign(Object.create(null), Object.fromEntries(Object.entries(stored).map(([session, state]) => [
    session,
    Array.isArray(state) ? { steps: state } : { steps: state.steps ?? [], goal: state.goal },
  ]))) as Plans;
}

export class PlanStore {
  private readonly state: AtomicJsonStore<Plans>;
  private listeners = new Set<PlanListener>();

  constructor(
    file: string,
    private sessionId: string,
  ) {
    assertSessionId(sessionId);
    this.state = new AtomicJsonStore(file, {
      defaultValue: () => Object.create(null) as Plans,
      decode: decodePlans,
      recoverCorrupt: true,
    });
  }

  useSession(sessionId: string): void {
    assertSessionId(sessionId);
    this.sessionId = sessionId;
  }

  async get(): Promise<PlanStep[]> {
    const sessionId = this.sessionId;
    return (await this.state.read())[sessionId]?.steps ?? [];
  }

  async update(steps: PlanStep[]): Promise<PlanStep[]> {
    const sessionId = this.sessionId;
    const updated = await this.mutate((plans) => {
      plans[sessionId] = { ...plans[sessionId], steps };
      return steps;
    });
    await this.notify(sessionId, updated);
    return updated;
  }

  onChange(listener: PlanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getGoal(): Promise<Goal | undefined> {
    const sessionId = this.sessionId;
    return (await this.state.read())[sessionId]?.goal;
  }

  async setGoal(objective: string, acceptanceCriteria?: CompletionCriterion[]): Promise<Goal> {
    const sessionId = this.sessionId;
    const goal = await this.mutate((plans) => {
      const now = new Date().toISOString();
      const goal: Goal = {
        objective: objective.trim(),
        status: 'active',
        ...(acceptanceCriteria?.length ? { acceptanceCriteria } : {}),
        createdAt: now,
        updatedAt: now,
      };
      plans[sessionId] = { steps: [], goal };
      return goal;
    });
    await this.notify(sessionId, []);
    return goal;
  }

  async setGoalAcceptance(criteria: CompletionCriterion[]): Promise<Goal | undefined> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal || state.goal.status === 'completed') return undefined;
      state.goal = {
        ...state.goal,
        acceptanceCriteria: criteria,
        updatedAt: new Date().toISOString(),
      };
      return state.goal;
    });
  }

  async completeGoalFromGate(evidence: string, expectedCreatedAt: string): Promise<Goal | undefined> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal || state.goal.status === 'completed') return state?.goal;
      if (state.goal.createdAt !== expectedCreatedAt) return state.goal;
      const now = new Date().toISOString();
      state.goal = {
        ...state.goal,
        status: 'completed',
        completionEvidence: evidence.trim().slice(0, 8_000),
        checkpoint: evidence.trim().slice(0, 8_000),
        nextAction: '验收已通过',
        updatedAt: now,
      };
      return state.goal;
    });
  }

  async checkpoint(update: {
    status?: GoalStatus;
    nextAction?: string;
    checkpoint?: string;
  }): Promise<Goal> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const state = plans[sessionId];
      if (!state?.goal) throw new Error('当前会话没有 Goal，请先使用 set_goal');
      state.goal = {
        ...state.goal,
        ...update,
        nextAction: update.nextAction?.trim() || state.goal.nextAction,
        checkpoint: update.checkpoint?.trim() || state.goal.checkpoint,
        updatedAt: new Date().toISOString(),
      };
      plans[sessionId] = state;
      return state.goal;
    });
  }

  async resumePrompt(): Promise<string> {
    const [goal, steps] = await Promise.all([this.getGoal(), this.get()]);
    if (!goal) throw new Error('当前会话没有可恢复的 Goal');
    if (goal.status === 'completed') throw new Error('当前 Goal 已完成');
    const plan = steps.map((step) => `[${step.status}] ${step.id}. ${step.description}`).join('\n');
    return [
      `继续执行当前长期目标：${goal.objective}`,
      goal.checkpoint ? `上次检查点：${goal.checkpoint}` : '',
      goal.nextAction ? `下一步：${goal.nextAction}` : '',
      plan ? `当前计划：\n${plan}` : '',
      '请从未完成处继续，自主执行并在关键阶段更新 Goal checkpoint 和计划状态。',
    ].filter(Boolean).join('\n\n');
  }

  async clear(sessionId = this.sessionId): Promise<void> {
    assertSessionId(sessionId);
    await this.state.update((plans) => {
      delete plans[sessionId];
    });
    await this.notify(sessionId, []);
  }

  createTools() {
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
        execute: async ({ steps }) => this.update(steps),
      }),
      tool({
        name: 'show_plan',
        description: '查看当前会话的任务计划。',
        parameters: z.object({}),
        execute: async () => this.get(),
      }),
      tool({
        name: 'set_goal',
        description: '为需要跨多轮或跨重启继续的长任务设置持久 Goal，并在开始执行前给出可验证验收条件。',
        parameters: z.object({
          objective: z.string().min(1).max(2_000),
          acceptanceCriteria: z.array(completionCriterionSchema).min(1).max(8),
        }),
        execute: async ({ objective, acceptanceCriteria }) => this.setGoal(objective, acceptanceCriteria),
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
          return this.checkpoint(update);
        },
      }),
      tool({
        name: 'show_goal',
        description: '查看当前会话的长期 Goal、检查点和计划。',
        parameters: z.object({}),
        execute: async () => ({ goal: await this.getGoal(), steps: await this.get() }),
      }),
    ];
  }

  private mutate<T>(mutation: (plans: Plans) => T): Promise<T> {
    return this.state.update(mutation);
  }

  private async notify(sessionId: string, steps: PlanStep[]): Promise<void> {
    const snapshot = steps.map((step) => ({ ...step }));
    await Promise.all([...this.listeners].map((listener) => listener(sessionId, snapshot)));
  }

}
