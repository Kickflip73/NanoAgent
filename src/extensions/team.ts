import path from 'node:path';
import { realpathSync } from 'node:fs';
import { Agent, Runner, tool, type Tool } from '@openai/agents';
import { z } from 'zod';
import type { TeamRole, TeamTask, TeamTaskStore } from '../core/team.js';
import { teamRoleToolNames } from '../core/tool-role-policy.js';
import type { AgentModel } from './model-port.js';

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
  allowUnsandboxedShell?: boolean;
  workerToolFactory?: (task: TeamTask) => Tool[];
  onEvent?: (task: TeamTask, event: 'start' | 'end' | 'error') => void | Promise<void>;
  runWorker?: (task: TeamTask, prompt: string, tools: Tool[], signal?: AbortSignal) => Promise<string>;
}

export function createTeamTaskTools(store: TeamTaskStore): Tool[] {
  const input = z.object({
    id: z.string().min(1).max(80),
    description: z.string().min(1).max(2_000),
    role: z.enum(['explorer', 'architect', 'builder', 'tester', 'reviewer']),
    dependencies: z.array(z.string().min(1).max(80)).max(10).default([]),
    paths: z.array(z.string().min(1).max(500)).max(30).default([]),
  });
  return [
    tool({
      name: 'set_team_tasks',
      description: '在 Ultra Team 模式创建 2～6 个有角色、依赖和路径边界的子任务；会替换当前 Team task list。',
      parameters: z.object({ tasks: z.array(input).min(2).max(6) }),
      execute: async ({ tasks }) => store.set(tasks),
    }),
    tool({
      name: 'show_team_tasks',
      description: '查看当前会话的 Team task list、依赖、负责人和结果。',
      parameters: z.object({}),
      execute: async () => ({ tasks: await store.list(), ready: (await store.ready()).map((item) => item.id) }),
    }),
    tool({
      name: 'claim_team_task',
      description: '原子领取一个依赖已完成的 pending Team task，避免重复执行。',
      parameters: z.object({ id: z.string().min(1), owner: z.string().min(1).max(100) }),
      execute: async ({ id, owner }) => store.claim(id, owner),
    }),
    tool({
      name: 'update_team_task',
      description: '使用领取时返回的 claimId 更新 Team task，防止迟到 worker 覆盖新领取。',
      parameters: z.object({
        id: z.string().min(1),
        claimId: z.string().min(1),
        status: z.enum(['running', 'completed', 'failed']),
        result: z.string().max(12_000).optional(),
      }),
      execute: async ({ id, claimId, status, result }) => store.update(id, status, result, claimId),
    }),
    tool({
      name: 'retry_team_task',
      description: '把一个 failed Team task 重置为 pending，供修正方案后重新执行；completed task 不会被重复运行。',
      parameters: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => store.retry(id),
    }),
  ];
}

function selectTools(tools: Tool[], names: readonly string[]): Tool[] {
  const allowed = new Set(names);
  return tools.filter((item) => allowed.has(item.name));
}

function canonicalOwnershipPath(workspaceRoot: string, value: string): string {
  let current = path.resolve(workspaceRoot, value);
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = path.join(realpathSync(current), ...suffix).replace(/[/\\]+$/, '');
      return process.platform === 'darwin' || process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return path.resolve(workspaceRoot, value);
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(workspaceRoot, value);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function overlap(left: string, right: string, workspaceRoot: string): boolean {
  const a = canonicalOwnershipPath(workspaceRoot, left);
  const b = canonicalOwnershipPath(workspaceRoot, right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

export function assertParallelSafe(tasks: TeamTask[], workspaceRoot = process.cwd()): void {
  const builders = tasks.filter((task) => task.role === 'builder');
  for (const task of builders) {
    if (!task.paths.length) throw new Error(`builder task ${task.id} 必须声明 paths，才能安全并行`);
  }
  for (let index = 0; index < builders.length; index += 1) {
    for (let other = index + 1; other < builders.length; other += 1) {
      const left = builders[index]!;
      const right = builders[other]!;
      if (left.paths.some((a) => right.paths.some((b) => overlap(a, b, workspaceRoot)))) {
        throw new Error(`builder tasks ${left.id} 与 ${right.id} 的 paths 重叠，不能并行`);
      }
    }
  }
}

function workerPrompt(task: TeamTask, allTasks: TeamTask[], workspaceRoot: string, persistent?: string): string {
  const dependencies = task.dependencies.map((id) => allTasks.find((item) => item.id === id)).filter(Boolean) as TeamTask[];
  return [
    persistent,
    `你是 MimiAgent Ultra Team 的 ${task.role} worker。${ROLE_INSTRUCTIONS[task.role]}`,
    '你拥有独立上下文，不得继续委派、改动 Team task list 或扩大任务范围。',
    `工作区：${workspaceRoot}`,
    `任务 ID：${task.id}\n任务：${task.description}`,
    task.paths.length ? `允许负责的路径：${task.paths.join(', ')}` : '此任务没有文件写入权限。',
    dependencies.length ? `依赖结果：\n${dependencies.map((item) => `- ${item.id}: ${item.result ?? '已完成'}`).join('\n')}` : '',
    '最终返回紧凑结构：结论；变更文件（如有）；验证；风险或未完成项。不要声称完成未执行的操作。',
  ].filter(Boolean).join('\n\n');
}

async function defaultWorker(
  options: TeamToolsOptions,
  task: TeamTask,
  prompt: string,
  workerTools: Tool[],
  signal?: AbortSignal,
): Promise<string> {
  const agent = new Agent({ name: `Mimi ${task.role} · ${task.id}`, model: options.model, instructions: prompt, tools: workerTools });
  const runner = new Runner({ workflowName: `MimiAgent Ultra · ${task.role}`, tracingDisabled: true, traceIncludeSensitiveData: false });
  const result = await runner.run(agent, task.description, {
    maxTurns: null,
    signal,
    toolExecution: { maxFunctionToolConcurrency: task.role === 'builder' ? 1 : 2 },
  });
  return String(result.finalOutput ?? 'Worker 未返回摘要');
}

async function emitWorkerEvent(
  options: TeamToolsOptions,
  task: TeamTask,
  event: 'start' | 'end' | 'error',
): Promise<void> {
  try {
    await options.onEvent?.(task, event);
  } catch {
    // Observability callbacks must not change the durable worker outcome.
  }
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
  assertParallelSafe(selected, options.workspaceRoot);
  if (selected.some((task) => task.role === 'builder') && !options.workerToolFactory) {
    throw new Error('builder worker 必须使用带 paths 强制约束的 workerToolFactory');
  }

  const claimed = await options.store.claimMany(selected.map((task) => ({
    id: task.id,
    owner: `${task.role}-${task.id}`,
  })));
  const results: TeamWorkerResult[] = new Array(claimed.length);
  let cursor = 0;
  const requested = Number.isFinite(options.maxConcurrency) ? options.maxConcurrency! : 4;
  const concurrency = Math.max(1, Math.min(4, Math.floor(requested), claimed.length));
  const workerControllers = new Map(claimed.map((task) => [task.id, new AbortController()]));
  const heartbeat = setInterval(() => {
    for (const task of claimed) {
      const controller = workerControllers.get(task.id);
      if (!controller || controller.signal.aborted) continue;
      void options.store.renew(task.id, task.claimId!).catch((error) => {
        controller.abort(error instanceof Error ? error : new Error(String(error)));
      });
    }
  }, 5_000);
  heartbeat.unref();
  const execute = async (): Promise<void> => {
    while (cursor < claimed.length) {
      const index = cursor++;
      const task = claimed[index]!;
      const controller = workerControllers.get(task.id)!;
      const signals = [controller.signal, AbortSignal.timeout(10 * 60_000)];
      if (options.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);
      try {
        signal.throwIfAborted();
        await emitWorkerEvent(options, task, 'start');
        const prompt = workerPrompt(task, allTasks, options.workspaceRoot, options.persistentInstructions);
        const availableTools = options.workerToolFactory?.(task) ?? options.tools;
        const workerTools = selectTools(
          availableTools,
          teamRoleToolNames(task.role, options.allowUnsandboxedShell === true),
        );
        const output = await (options.runWorker
          ? options.runWorker(task, prompt, workerTools, signal)
          : defaultWorker(options, task, prompt, workerTools, signal));
        signal.throwIfAborted();
        const completed = await options.store.update(task.id, 'completed', output, task.claimId);
        await emitWorkerEvent(options, completed, 'end');
        results[index] = { taskId: task.id, role: task.role, status: 'completed', output };
      } catch (error) {
        let output = error instanceof Error ? error.message : String(error);
        let failed = task;
        try {
          failed = await options.store.update(task.id, 'failed', output, task.claimId);
        } catch (stateError) {
          const detail = stateError instanceof Error ? stateError.message : String(stateError);
          output = `${output}\n状态提交失败：${detail}`;
          failed = (await options.store.list().catch(() => []))
            .find((item) => item.id === task.id) ?? task;
        }
        await emitWorkerEvent(options, failed, 'error');
        results[index] = { taskId: task.id, role: task.role, status: 'failed', output };
      } finally {
        workerControllers.delete(task.id);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, execute));
  } finally {
    clearInterval(heartbeat);
  }
  return results;
}

export function createTeamTools(options: TeamToolsOptions): Tool[] {
  return [
    ...createTeamTaskTools(options.store),
    tool({
      name: 'run_team',
      description: '执行当前 task list 中 1～4 个依赖已完成且路径不冲突的 ready 子任务；多个任务并行，单个任务用于推进依赖流水线。',
      parameters: z.object({ taskIds: z.array(z.string().min(1).max(80)).min(1).max(4) }),
      execute: async ({ taskIds }) => ({ results: await runTeamWave(options, taskIds) }),
    }),
  ];
}
