import path from 'node:path';
import { Agent, Runner, tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { TeamRole, TeamTask, TeamTaskStore } from '../core/team.js';
import type { AgentModel } from '../runtime/model.js';

const ROLE_TOOLS: Record<TeamRole, string[]> = {
  explorer: ['current_time', 'read_file', 'list_directory', 'search_files', 'http_request', 'web_search', 'search_knowledge'],
  architect: ['read_file', 'list_directory', 'search_files', 'web_search', 'search_knowledge'],
  builder: ['current_time', 'calculate', 'read_file', 'write_file', 'edit_file', 'move_file', 'list_directory', 'search_files', 'run_shell', 'search_knowledge'],
  tester: ['current_time', 'calculate', 'read_file', 'list_directory', 'search_files', 'run_shell', 'search_knowledge'],
  reviewer: ['read_file', 'list_directory', 'search_files', 'run_shell', 'search_knowledge'],
};

const ROLE_INSTRUCTIONS: Record<TeamRole, string> = {
  explorer: '调查代码、资料与事实，给出证据、来源和明确结论；保持只读。',
  architect: '分析边界、数据流与取舍，产出可实施设计和风险；保持只读。',
  builder: '只实现分配给你的子任务，尊重路径边界，保持改动小而清晰并自行验证。',
  tester: '独立运行相关检查和测试，定位失败原因；保持只读，不替 builder 修改文件。',
  reviewer: '审查正确性、兼容性、安全性和测试缺口，按严重程度给出证据；保持只读。',
};

export interface TeamWorkerResult {
  taskId: string;
  role: TeamRole;
  status: 'completed' | 'failed';
  output: string;
}

export interface TeamToolsOptions {
  store: TeamTaskStore;
  model: AgentModel;
  tools: Tool[];
  workspaceRoot: string;
  persistentInstructions?: string;
  maxConcurrency?: number;
  signal?: AbortSignal;
  onEvent?: (task: TeamTask, event: 'start' | 'end' | 'error') => void | Promise<void>;
  runWorker?: (task: TeamTask, prompt: string, tools: Tool[], signal?: AbortSignal) => Promise<string>;
}

function selectTools(tools: Tool[], names: string[]): Tool[] {
  const allowed = new Set(names);
  return tools.filter((item) => allowed.has(item.name));
}

function overlap(left: string, right: string): boolean {
  const a = path.normalize(left).replace(/[/\\]+$/, '');
  const b = path.normalize(right).replace(/[/\\]+$/, '');
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

export function assertParallelSafe(tasks: TeamTask[]): void {
  const builders = tasks.filter((task) => task.role === 'builder');
  for (const task of builders) {
    if (!task.paths.length) throw new Error(`builder task ${task.id} 必须声明 paths，才能安全并行`);
  }
  for (let index = 0; index < builders.length; index += 1) {
    for (let other = index + 1; other < builders.length; other += 1) {
      const left = builders[index]!;
      const right = builders[other]!;
      if (left.paths.some((a) => right.paths.some((b) => overlap(a, b)))) {
        throw new Error(`builder tasks ${left.id} 与 ${right.id} 的 paths 重叠，不能并行`);
      }
    }
  }
}

function workerPrompt(task: TeamTask, allTasks: TeamTask[], workspaceRoot: string, persistent?: string): string {
  const dependencies = task.dependencies.map((id) => allTasks.find((item) => item.id === id)).filter(Boolean) as TeamTask[];
  return [
    persistent,
    `你是 NanoAgent Ultra Team 的 ${task.role} worker。${ROLE_INSTRUCTIONS[task.role]}`,
    '你拥有独立上下文，不得继续委派、改动 Team task list 或扩大任务范围。',
    `工作区：${workspaceRoot}`,
    `任务 ID：${task.id}\n任务：${task.description}`,
    task.paths.length ? `允许负责的路径：${task.paths.join(', ')}` : '此任务没有文件写入权限。',
    dependencies.length ? `依赖结果：\n${dependencies.map((item) => `- ${item.id}: ${item.result ?? '已完成'}`).join('\n')}` : '',
    '最终返回紧凑结构：结论；变更文件（如有）；验证；风险或未完成项。不要声称完成未执行的操作。',
  ].filter(Boolean).join('\n\n');
}

async function defaultWorker(options: TeamToolsOptions, task: TeamTask, prompt: string, workerTools: Tool[]): Promise<string> {
  const agent = new Agent({ name: `Nano ${task.role} · ${task.id}`, model: options.model, instructions: prompt, tools: workerTools });
  const runner = new Runner({ workflowName: `NanoAgent Ultra · ${task.role}`, tracingDisabled: true, traceIncludeSensitiveData: false });
  const result = await runner.run(agent, task.description, {
    maxTurns: task.role === 'builder' ? 24 : task.role === 'tester' ? 20 : 16,
    signal: options.signal,
    toolExecution: { maxFunctionToolConcurrency: task.role === 'builder' ? 1 : 2 },
  });
  return String(result.finalOutput ?? 'Worker 未返回摘要');
}

export async function runTeamWave(options: TeamToolsOptions, taskIds: string[]): Promise<TeamWorkerResult[]> {
  const allTasks = await options.store.list();
  const selected = taskIds.map((id) => {
    const task = allTasks.find((item) => item.id === id);
    if (!task) throw new Error(`Team task 不存在：${id}`);
    return task;
  });
  if (new Set(taskIds).size !== taskIds.length) throw new Error('run_team 的 taskIds 不能重复');
  const ready = new Set((await options.store.ready()).map((item) => item.id));
  const blocked = selected.filter((task) => !ready.has(task.id));
  if (blocked.length) throw new Error(`以下 Team task 尚未 ready：${blocked.map((task) => task.id).join(', ')}`);
  assertParallelSafe(selected);

  const claimed: TeamTask[] = [];
  for (const task of selected) claimed.push(await options.store.claim(task.id, `${task.role}-${task.id}`));
  const results: TeamWorkerResult[] = new Array(claimed.length);
  let cursor = 0;
  const requested = Number.isFinite(options.maxConcurrency) ? options.maxConcurrency! : 4;
  const concurrency = Math.max(1, Math.min(4, Math.floor(requested), claimed.length));
  const execute = async (): Promise<void> => {
    while (cursor < claimed.length) {
      const index = cursor++;
      const task = claimed[index]!;
      try {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error('Ultra Team 已中止');
        await options.onEvent?.(task, 'start');
        const prompt = workerPrompt(task, allTasks, options.workspaceRoot, options.persistentInstructions);
        const workerTools = selectTools(options.tools, ROLE_TOOLS[task.role]);
        const output = await (options.runWorker
          ? options.runWorker(task, prompt, workerTools, options.signal)
          : defaultWorker(options, task, prompt, workerTools));
        await options.store.update(task.id, 'completed', output);
        await options.onEvent?.(task, 'end');
        results[index] = { taskId: task.id, role: task.role, status: 'completed', output };
      } catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        await options.store.update(task.id, 'failed', output);
        await options.onEvent?.(task, 'error');
        results[index] = { taskId: task.id, role: task.role, status: 'failed', output };
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, execute));
  return results;
}

export function createTeamTools(options: TeamToolsOptions): Tool[] {
  return [
    ...options.store.createTools(),
    tool({
      name: 'run_team',
      description: '并行执行当前 task list 中 2～4 个依赖已完成且路径不冲突的 ready 子任务；返回每个 worker 的独立结果。',
      parameters: z.object({ taskIds: z.array(z.string().min(1).max(80)).min(2).max(4) }),
      execute: async ({ taskIds }) => ({ results: await runTeamWave(options, taskIds) }),
    }),
  ];
}
