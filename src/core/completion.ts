import { z } from 'zod';

export const completionEvidenceTypeSchema = z.enum(['tool_receipt', 'artifact', 'test', 'semantic']);
export const completionCriterionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1_000),
  requiredEvidence: completionEvidenceTypeSchema,
  expectedTool: z.string().trim().min(1).max(100).optional(),
  expectedArgumentsContain: z.array(z.string().trim().min(1).max(500)).min(1).max(8).optional(),
}).strict();
export const completionContractSchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  kind: z.enum(['answer', 'artifact', 'external_action', 'long_running']),
  criteria: z.array(completionCriterionSchema).min(1).max(8),
}).strict().superRefine((contract, context) => {
  const evidence = new Set(contract.criteria.map((criterion) => criterion.requiredEvidence));
  if (contract.kind === 'external_action' && !evidence.has('tool_receipt')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['criteria'],
      message: '外部动作至少需要一条 tool_receipt 验收条件',
    });
  }
  for (const [index, criterion] of contract.criteria.entries()) {
    if (criterion.requiredEvidence !== 'semantic'
      && (!criterion.expectedTool || !criterion.expectedArgumentsContain?.length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria', index],
        message: '客观证据必须绑定 expectedTool 和 expectedArgumentsContain，避免用无关工具调用冒充完成',
      });
    }
  }
  if (contract.kind === 'artifact' && !evidence.has('artifact')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['criteria'],
      message: '产物任务至少需要一条 artifact 验收条件',
    });
  }
  if (contract.kind === 'long_running' && evidence.size === 1 && evidence.has('semantic')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['criteria'],
      message: '长期任务至少需要一条可由工具、产物或测试验证的验收条件',
    });
  }
});
const completionProofSchema = z.object({
  criterionId: z.string().trim().min(1).max(100),
  evidence: z.string().trim().min(1).max(4_000),
  toolCallIds: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
}).strict();
const completionBlockerSchema = z.object({
  requiresUser: z.boolean(),
  reason: z.string().trim().min(1).max(2_000),
  question: z.string().trim().min(1).max(1_000),
  attemptedAlternatives: z.array(z.string().trim().min(1).max(1_000)).min(1).max(10),
}).strict();
export const completionReportSchema = z.object({
  status: z.enum(['completed', 'continue', 'blocked']),
  proofs: z.array(completionProofSchema).max(8).default([]),
  blocker: completionBlockerSchema.optional(),
}).strict();

export type CompletionEvidenceType = z.infer<typeof completionEvidenceTypeSchema>;
export type CompletionCriterion = z.infer<typeof completionCriterionSchema>;
export type CompletionContract = z.infer<typeof completionContractSchema>;
export type CompletionReport = z.infer<typeof completionReportSchema>;
export type CompletionKind = CompletionContract['kind'];

export interface CompletionEvidence {
  toolName: string;
  callId: string;
  aliases?: string[];
  argumentsJson: string;
  status: 'started' | 'succeeded' | 'failed' | 'uncertain';
  output?: unknown;
  error?: string;
}
export interface CompletionGateDecision {
  decision: 'pass' | 'continue' | 'blocked' | 'uncertain';
  reason: string;
  unmetCriteria: string[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function receiptOutcome(value: unknown): string | undefined {
  const record = objectValue(value);
  return typeof record?.outcome === 'string' ? record.outcome : undefined;
}
function isConfirmedActionReceipt(item: CompletionEvidence): boolean {
  const receipt = objectValue(item.output);
  return item.toolName === 'connector_action'
    && receipt?.outcome === 'confirmed'
    && receipt.tool === item.toolName
    && typeof receipt.operationId === 'string'
    && receipt.operationId.trim().length > 0
    && typeof receipt.occurredAt === 'string'
    && !Number.isNaN(Date.parse(receipt.occurredAt));
}
function citedEvidence(
  proof: CompletionReport['proofs'][number],
  evidence: readonly CompletionEvidence[],
): CompletionEvidence[] {
  // MCP transport calls do not expose their SDK call id at the transport
  // boundary. Locked tool/argument constraints remain authoritative even when
  // the report cannot cite an id.
  if (!proof.toolCallIds.length) return [...evidence];
  const requested = new Set(proof.toolCallIds);
  return evidence.filter((item) => requested.has(item.callId)
    || item.aliases?.some((alias) => requested.has(alias)));
}
function matchesCriterion(item: CompletionEvidence, criterion: CompletionCriterion): boolean {
  if (criterion.expectedTool && item.toolName !== criterion.expectedTool) return false;
  return (criterion.expectedArgumentsContain ?? []).every((fragment) => item.argumentsJson.includes(fragment));
}
function criterionSatisfied(
  contract: CompletionContract,
  criterion: CompletionCriterion,
  proof: CompletionReport['proofs'][number],
  evidence: readonly CompletionEvidence[],
): { satisfied: boolean; uncertain: boolean } {
  if (criterion.requiredEvidence === 'semantic') {
    return { satisfied: proof.evidence.trim().length > 0, uncertain: false };
  }
  const cited = citedEvidence(proof, evidence).filter((item) => matchesCriterion(item, criterion));
  const uncertain = cited.some((item) => receiptOutcome(item.output) === 'uncertain'
    || item.status === 'started' || item.status === 'uncertain');
  if (uncertain) return { satisfied: false, uncertain: true };
  const succeeded = cited.filter((item) => item.status === 'succeeded');
  if (criterion.requiredEvidence === 'tool_receipt') {
    if (contract.kind === 'external_action') {
      const confirmed = succeeded.some(isConfirmedActionReceipt);
      const accepted = succeeded.some((item) => receiptOutcome(item.output) === 'accepted');
      return { satisfied: confirmed, uncertain: !confirmed && accepted };
    }
    return {
      satisfied: succeeded.some((item) => {
        const outcome = receiptOutcome(item.output);
        return outcome === undefined || outcome === 'accepted' || outcome === 'confirmed';
      }),
      uncertain: false,
    };
  }
  if (criterion.requiredEvidence === 'artifact') {
    return {
      satisfied: succeeded.some((item) => ['write_file', 'edit_file', 'move_file'].includes(item.toolName)
        || (item.toolName === 'run_shell' && objectValue(item.output)?.exitCode === 0)),
      uncertain: false,
    };
  }
  return {
    satisfied: succeeded.some((item) => item.toolName === 'run_shell' && objectValue(item.output)?.exitCode === 0),
    uncertain: false,
  };
}

export function evaluateCompletion(
  contract: CompletionContract | undefined,
  report: CompletionReport | undefined,
  evidence: readonly CompletionEvidence[],
  incompletePlanSteps: readonly string[] = [],
  requireDurableBlocker = false,
): CompletionGateDecision {
  if (!contract) return {
    decision: 'continue', reason: '任务尚未建立 Completion Contract；必须先生成验收条件', unmetCriteria: [],
  };
  if (!report) return {
    decision: 'continue', reason: '任务尚未调用 finish_task 提交验收证据',
    unmetCriteria: contract.criteria.map((criterion) => criterion.id),
  };
  if (report.status === 'blocked') {
    const blocker = report.blocker;
    const durableBlocker = evidence.some((item) => (
      item.toolName === 'request_background_task_input' && item.status === 'succeeded'
    ));
    if (blocker?.requiresUser && blocker.attemptedAlternatives.length > 0
      && (!requireDurableBlocker || durableBlocker)) {
      return { decision: 'blocked', reason: blocker.reason, unmetCriteria: contract.criteria.map((item) => item.id) };
    }
    return {
      decision: 'continue',
      reason: requireDurableBlocker && !durableBlocker
        ? '后台任务必须调用 request_background_task_input 持久化阻塞状态'
        : '暂停条件不成立：没有证据表明必须由用户操作',
      unmetCriteria: contract.criteria.map((item) => item.id),
    };
  }
  if (report.status === 'continue') return {
    decision: 'continue', reason: '执行器声明任务仍需继续',
    unmetCriteria: contract.criteria.map((item) => item.id),
  };
  const proofs = new Map(report.proofs.map((proof) => [proof.criterionId, proof]));
  const unmet: string[] = [];
  let uncertain = false;
  for (const criterion of contract.criteria) {
    const proof = proofs.get(criterion.id);
    if (!proof) {
      unmet.push(criterion.id);
      continue;
    }
    const result = criterionSatisfied(contract, criterion, proof, evidence);
    if (!result.satisfied) unmet.push(criterion.id);
    uncertain ||= result.uncertain;
  }
  if (incompletePlanSteps.length) unmet.push(...incompletePlanSteps.map((id) => `plan:${id}`));
  if (unmet.length) return {
    decision: uncertain ? 'uncertain' : 'continue',
    reason: uncertain
      ? '存在结果不确定的副作用，禁止宣称成功或自动重放'
      : '验收条件尚未全部获得可验证证据',
    unmetCriteria: [...new Set(unmet)],
  };
  return { decision: 'pass', reason: '全部验收条件已有可验证证据', unmetCriteria: [] };
}

export class CompletionGateError extends Error {
  readonly name = 'CompletionGateError';
  constructor(readonly gate: CompletionGateDecision) {
    super(`${gate.reason}${gate.unmetCriteria.length ? `；未满足：${gate.unmetCriteria.join(', ')}` : ''}`);
  }
}

export function requiresCompletionContract(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return false;
  return /(?:^\/goal\b|修复|升级|实现|创建|生成|编写|修改|发送|发给|通知|删除|清空|移动|改名|部署|安装|运行|执行|测试|验证|导出|预订|购买|提交|发布|迁移|重构|打开|关闭|关掉|把.+(?:放|移|改|写|存|关|开))/u.test(normalized)
    || /\b(?:fix|build|create|write|edit|send|delete|deploy|install|run|test|verify|export|submit|implement|open|close|turn|notify|purchase|book|pay|publish|develop|migrate|refactor)\b/u.test(normalized);
}

export function requiresPersistentGoal(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return /^\/goal\b/u.test(normalized)
    || /(?:长期|持续(?:任务|研究|跟进|监控|执行|处理)|跨轮|多阶段|完整项目|long[- ]?running|multi[- ]?step)/u.test(normalized);
}

export function expectedCompletionKind(input: string): CompletionKind {
  const normalized = input.trim().toLowerCase();
  if (/(?:发送|发给|告诉|说我|通知|购买|预订|下单|支付|发布|上线|部署|提交到|打开|关闭|关掉)/u.test(normalized)
    || /\b(?:send|notify|purchase|book|pay|publish|deploy|open|close|turn)\b/u.test(normalized)) {
    return 'external_action';
  }
  if (/(?:修复|升级|实现|创建|生成|编写|修改|编辑|开发|构建|迁移|改造|重构)/u.test(normalized)
    || /\b(?:fix|build|create|write|edit|implement|develop|migrate|refactor)\b/u.test(normalized)) {
    return 'artifact';
  }
  return requiresPersistentGoal(normalized) ? 'long_running' : 'answer';
}

export function assertCompletionContractForTask(
  input: string,
  proposed: CompletionContract,
  current?: CompletionContract,
): CompletionContract {
  if (current) {
    if (JSON.stringify(current) !== JSON.stringify(proposed)) {
      throw new Error('Completion Contract 已锁定；执行过程中不得重写或降低验收标准');
    }
    return current;
  }
  const expected = expectedCompletionKind(input);
  if (proposed.kind !== expected) {
    throw new Error(`任务类型必须为 ${expected}，不能用 ${proposed.kind} 降低验收证据要求`);
  }
  const requiredEvidence = new Set<CompletionEvidenceType>();
  const normalized = input.toLowerCase();
  if (/(?:修复|升级|实现|创建|生成|编写|修改|编辑|开发|构建|迁移|改造|重构)/u.test(normalized)
    || /\b(?:fix|build|create|write|edit|implement|develop|migrate|refactor)\b/u.test(normalized)) {
    requiredEvidence.add('artifact');
  }
  if (/(?:发送|发给|告诉|说我|通知|购买|预订|下单|支付|发布|上线|部署|提交到|打开|关闭|关掉)/u.test(normalized)
    || /\b(?:send|notify|purchase|book|pay|publish|deploy|open|close|turn)\b/u.test(normalized)) {
    requiredEvidence.add('tool_receipt');
  }
  if (/(?:删除|清空|安装|运行|执行|导出|移动|改名)/u.test(normalized)
    || /\b(?:delete|clear|install|run|execute|export|move|rename)\b/u.test(normalized)) {
    requiredEvidence.add('tool_receipt');
  }
  const provided = new Set(proposed.criteria.map((criterion) => criterion.requiredEvidence));
  const missing = [...requiredEvidence].filter((evidence) => !provided.has(evidence));
  if (missing.length) {
    throw new Error(`复合任务的 Completion Contract 缺少证据类型：${missing.join(', ')}`);
  }
  return proposed;
}
