import { createHash } from 'node:crypto';
import {
  evaluateCompletion,
  type CompletionContract,
  type CompletionGateDecision,
  type CompletionReport,
} from '../core/completion.js';
import type { ExecutionCallRecord } from '../core/execution-ledger.js';
import type { PlanStep } from '../core/plan.js';
import type { TeamTask } from '../core/team.js';

export interface CompletionLedgerPort {
  listCalls(sessionId: string, runId: string): Promise<ExecutionCallRecord[]>;
}

export interface CompletionPlanPort {
  get(): Promise<PlanStep[]>;
}

export interface CompletionTeamPort {
  list(): Promise<TeamTask[]>;
}

export interface CompletionEvaluationRequest {
  sessionId: string;
  runId: string;
  executionKey?: string;
  recoveryRunId?: string;
  completionContract?: CompletionContract;
  completionReport?: CompletionReport;
  requireDurableBlocker: boolean;
  goalOwned: boolean;
  planOwned: boolean;
  teamOwned: boolean;
  plans: CompletionPlanPort;
  team: CompletionTeamPort;
}

export class CompletionCoordinator {
  constructor(private readonly ledger: CompletionLedgerPort) {}

  async evaluate(
    request: CompletionEvaluationRequest,
  ): Promise<{ gate: CompletionGateDecision; progressFingerprint: string }> {
    const evidenceRunId = request.executionKey ?? request.runId;
    let [calls, steps, teamTasks] = await Promise.all([
      this.ledger.listCalls(request.sessionId, evidenceRunId),
      request.goalOwned || request.planOwned ? request.plans.get() : Promise.resolve([]),
      request.goalOwned || request.teamOwned ? request.team.list() : Promise.resolve([]),
    ]);
    // A manually resumed Goal may rely on evidence retained by its prior checkpoint.
    if (calls.length === 0 && request.recoveryRunId && request.recoveryRunId !== request.runId) {
      calls = await this.ledger.listCalls(request.sessionId, request.recoveryRunId);
    }
    const evidence = calls.map((call) => ({
      toolName: call.toolName,
      callId: call.modelCallId ?? call.callId,
      aliases: [...new Set([call.callId, ...(call.modelCallIds ?? [])])],
      argumentsJson: call.argumentsJson,
      status: call.status,
      output: call.output,
      error: call.error,
    }));
    const incompleteSteps = steps.filter((step) => step.status !== 'completed').map((step) => step.id);
    const gate = evaluateCompletion(
      request.completionContract,
      request.completionReport,
      evidence,
      incompleteSteps,
      request.requireDurableBlocker,
      teamTasks.filter((task) => task.status !== 'completed').map((task) => task.id),
    );
    const progressFingerprint = createHash('sha256').update(JSON.stringify({
      contract: request.completionContract,
      gate: { decision: gate.decision, unmetCriteria: gate.unmetCriteria },
      evidence: evidence.map((item) => ({
        toolName: item.toolName,
        callId: item.callId,
        argumentsJson: item.argumentsJson,
        status: item.status,
        output: item.output,
      })),
      steps: steps.map((step) => ({ id: step.id, status: step.status })),
      team: teamTasks.map((task) => ({ id: task.id, status: task.status })),
    })).digest('hex');
    return { gate, progressFingerprint };
  }
}

export function incompleteCompletionAnswer(gate: CompletionGateDecision): string {
  const unmet = gate.unmetCriteria.length ? `；未满足：${gate.unmetCriteria.join(', ')}` : '';
  if (gate.decision === 'uncertain') {
    return `长期 Goal 的完成状态仍不确定，已保留 Goal 且不会自动重放副作用：${gate.reason}${unmet}`;
  }
  if (gate.decision === 'blocked') {
    return `长期 Goal 尚未完成并已保留检查点：${gate.reason}${unmet}。补充所需信息后可用 /resume 继续。`;
  }
  return `长期 Goal 尚未通过验收，已保留当前 Goal 和检查点，不会从头自动重跑：${gate.reason}${unmet}。可用 /resume 继续。`;
}
