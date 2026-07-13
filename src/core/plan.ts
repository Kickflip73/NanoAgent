import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tool } from '@openai/agents';
import { z } from 'zod';

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

type Plans = Record<string, PlanStep[]>;

export class PlanStore {
  constructor(
    private readonly file: string,
    private sessionId: string,
  ) {}

  useSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  async get(): Promise<PlanStep[]> {
    return (await this.load())[this.sessionId] ?? [];
  }

  async update(steps: PlanStep[]): Promise<PlanStep[]> {
    const plans = await this.load();
    plans[this.sessionId] = steps;
    await this.save(plans);
    return steps;
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
    ];
  }

  private async load(): Promise<Plans> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Plans;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  private async save(plans: Plans): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(plans, null, 2)}\n`, 'utf8');
    await rename(temporary, this.file);
  }
}
