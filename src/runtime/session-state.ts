import type { Goal, PlanStep } from '../core/plan.js';
import type { RunCheckpoint } from '../core/session.js';
import type { TeamTask } from '../core/team.js';
import type { RuntimeOutputLevel } from './control.js';
import type { AgentMode } from './instructions.js';

export function recoverySummary(checkpoint?: RunCheckpoint): string {
  if (!checkpoint || checkpoint.status === 'completed') return '';
  return [
    `状态：${checkpoint.status}`,
    `任务：${checkpoint.input}`,
    `阶段：${checkpoint.phase}`,
    checkpoint.lastEvent ? `最后进展：${checkpoint.lastEvent}` : '',
    checkpoint.error ? `停止原因：${checkpoint.error}` : '',
    checkpoint.nextAction ? `建议下一步：${checkpoint.nextAction}` : '',
    `更新时间：${checkpoint.updatedAt}`,
  ].filter(Boolean).join('\n');
}

export function buildResumePrompt(state: {
  goal?: Goal;
  steps: PlanStep[];
  checkpoint?: RunCheckpoint;
  teamSummary: string;
  teamTasks: TeamTask[];
}): string {
  const recoverable = recoverySummary(state.checkpoint);
  const incompletePlan = state.steps.some((step) => step.status !== 'completed');
  const incompleteTeam = state.teamTasks.some((task) => task.status !== 'completed');
  if (!recoverable && (!state.goal || state.goal.status === 'completed') && !incompletePlan && !incompleteTeam) {
    throw new Error('当前会话没有可恢复的未完成任务');
  }
  const plan = state.steps.map((step) => `[${step.status}] ${step.id}. ${step.description}`).join('\n');
  return [
    recoverable ? `恢复最近一次未完成运行：\n${recoverable}` : '',
    state.goal && state.goal.status !== 'completed' ? `继续长期目标：[${state.goal.status}] ${state.goal.objective}` : '',
    state.goal?.checkpoint ? `Goal 检查点：${state.goal.checkpoint}` : '',
    state.goal?.nextAction ? `Goal 下一步：${state.goal.nextAction}` : '',
    plan ? `当前计划：\n${plan}` : '',
    state.teamSummary ? `当前 Ultra Team task list：\n${state.teamSummary}` : '',
    '这是根据 checkpoint、Goal、Plan 与 Team 状态生成的 best-effort 任务续跑，不是任意中断点的指令级精确恢复。',
    '请先核对持久化进展与当前工作区状态，再从最新未完成点继续；不要重复已经完成的步骤。',
  ].filter(Boolean).join('\n\n');
}

export function sessionStateSummary(state: {
  plan: PlanStep[];
  goal?: Goal;
  hasTeam: boolean;
  run: { sessionId: string; mode: AgentMode; modeLabel: string; modelName: string };
  outputLevel: RuntimeOutputLevel;
}): string {
  const completed = state.plan.filter((step) => step.status === 'completed').length;
  const current = state.plan.find((step) => step.status === 'running')
    ?? state.plan.find((step) => step.status === 'pending');
  return [
    `Session：${state.run.sessionId}`,
    `Mode：${state.run.modeLabel} (${state.run.mode}) · Model：${state.run.modelName} · Output：${state.outputLevel}`,
    'Run：running',
    state.plan.length
      ? `Plan：${completed}/${state.plan.length} completed${current ? ` · 当前阶段：${current.id} ${current.description}` : ''}`
      : 'Plan：未建立',
    state.goal ? `Goal：[${state.goal.status}] ${state.goal.objective}` : 'Goal：未设置',
    `Ultra Team：${state.hasTeam ? '已有任务状态，详见下方 task list' : '未启用'}`,
  ].join('\n');
}
