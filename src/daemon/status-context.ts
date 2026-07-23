import type { Goal, PlanStep } from '../core/plan.js';
import type { MimiStore } from './store.js';

const MAX_STATUS_CONTEXT_CHARS = 6_000;

function objectiveText(objective: unknown): string | undefined {
  if (typeof objective === 'string') return objective.slice(0, 160);
  if (!objective || typeof objective !== 'object' || Array.isArray(objective)) return undefined;
  const value = objective as Record<string, unknown>;
  for (const key of ['objective', 'prompt', 'text']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim().slice(0, 160);
  }
  return undefined;
}

export function buildOwnerStatusAnswer(
  store: MimiStore,
  sessionId: string,
  currentTaskId?: string,
  state?: { plan: readonly PlanStep[]; goal?: Goal },
): string {
  const sessionActivity = store.sessionActivity(sessionId, 4)
    .filter((activity) => activity.taskId !== currentTaskId)
    .slice(0, 3)
    .map((activity) => ({
    taskId: activity.taskId,
    taskStatus: activity.taskStatus,
    runStatus: activity.runStatus,
    completedAt: activity.completedAt,
    answer: activity.answer?.slice(0, 500),
    error: activity.error?.slice(0, 300),
    }));
  const backgroundTasks = store.listTasks(30)
    .filter((task) => task.type === 'background')
    .slice(0, 8)
    .map((task) => ({
      taskId: task.id,
      status: task.status,
      objective: objectiveText(task.objective),
      updatedAt: task.updatedAt,
      error: task.error?.slice(0, 160),
    }));
  const activeStatuses = new Set(['queued', 'running', 'paused', 'blocked']);
  const activeTasks = backgroundTasks.filter((task) => activeStatuses.has(task.status));
  const recentTerminal = backgroundTasks.filter((task) => !activeStatuses.has(task.status)).slice(0, 3);
  const lines = [
    activeTasks.length
      ? `当前有 ${activeTasks.length} 个后台任务仍在处理：`
      : '当前没有正在处理的后台任务。',
  ];
  for (const task of activeTasks.slice(0, 5)) {
    lines.push(`- ${task.objective ?? task.taskId}：${task.status}${task.error ? `（${task.error}）` : ''}`);
  }
  if (state?.goal && state.goal.status !== 'completed') {
    lines.push(`当前 Goal：${state.goal.objective}（${state.goal.status}）`);
  }
  const incompletePlan = state?.plan.filter((step) => step.status !== 'completed') ?? [];
  if (incompletePlan.length) {
    lines.push(`Plan 还有 ${incompletePlan.length} 步未完成：${incompletePlan.slice(0, 3).map((step) => step.description).join('；')}`);
  }
  if (recentTerminal.length) {
    lines.push('最近的后台结果：');
    for (const task of recentTerminal) {
      lines.push(`- ${task.objective ?? task.taskId}：${task.status}${task.error ? `（${task.error}）` : ''}`);
    }
  } else if (!activeTasks.length && sessionActivity[0]) {
    const latest = sessionActivity[0];
    lines.push(`当前 Session 最近一次处理结果：${latest.answer ?? latest.error ?? latest.runStatus}`);
  }
  return lines.join('\n').slice(0, MAX_STATUS_CONTEXT_CHARS);
}
