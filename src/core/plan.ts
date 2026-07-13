import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@openai/agents';
import { z } from 'zod';

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export type GoalStatus = 'active' | 'paused' | 'completed' | 'failed';

export interface Goal {
  objective: string;
  status: GoalStatus;
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

export class PlanStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private sessionId: string,
  ) {}

  useSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  async get(): Promise<PlanStep[]> {
    await this.writeQueue;
    return (await this.load())[this.sessionId]?.steps ?? [];
  }

  async update(steps: PlanStep[]): Promise<PlanStep[]> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      plans[sessionId] = { ...plans[sessionId], steps };
      return steps;
    });
  }

  async getGoal(): Promise<Goal | undefined> {
    await this.writeQueue;
    return (await this.load())[this.sessionId]?.goal;
  }

  async setGoal(objective: string): Promise<Goal> {
    const sessionId = this.sessionId;
    return this.mutate((plans) => {
      const now = new Date().toISOString();
      const goal: Goal = {
        objective: objective.trim(),
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      plans[sessionId] = { steps: [], goal };
      return goal;
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

  createTools() {
    const step = z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      status: z.enum(['pending', 'running', 'completed', 'failed']),
    });
    return [
      tool({
        name: 'update_plan',
        description: '为多步骤任务创建或更新简洁的执行计划；简单问题无需使用。',
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
        description: '为需要跨多轮或跨重启继续的长任务设置持久 Goal；普通单轮任务不要使用。',
        parameters: z.object({ objective: z.string().min(1).max(2_000) }),
        execute: async ({ objective }) => this.setGoal(objective),
      }),
      tool({
        name: 'update_goal',
        description: '保存长期 Goal 的状态、下一步和简短检查点，供之后 /resume 恢复。',
        parameters: z.object({
          status: z.enum(['active', 'paused', 'completed', 'failed']).optional(),
          nextAction: z.string().max(2_000).optional(),
          checkpoint: z.string().max(8_000).optional(),
        }),
        execute: async (update) => this.checkpoint(update),
      }),
      tool({
        name: 'show_goal',
        description: '查看当前会话的长期 Goal、检查点和计划。',
        parameters: z.object({}),
        execute: async () => ({ goal: await this.getGoal(), steps: await this.get() }),
      }),
    ];
  }

  private async load(): Promise<Plans> {
    try {
      const stored = JSON.parse(await readFile(this.file, 'utf8')) as StoredPlans;
      return Object.fromEntries(Object.entries(stored).map(([session, value]) => [
        session,
        Array.isArray(value) ? { steps: value } : { steps: value.steps ?? [], goal: value.goal },
      ]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private mutate<T>(mutation: (plans: Plans) => T): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const plans = await this.load();
      const result = mutation(plans);
      await this.save(plans);
      return result;
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async save(plans: Plans): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(plans, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}
