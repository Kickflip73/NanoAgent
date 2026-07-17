import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  completionContractSchema,
  assertCompletionContractForTask,
  evaluateCompletion,
  expectedCompletionKind,
  type CompletionContract,
  type CompletionEvidence,
  type CompletionReport,
} from '../src/runtime/completion.js';

const contract: CompletionContract = {
  objective: '给好友发送一条微信消息',
  kind: 'external_action',
  criteria: [{
    id: 'message-sent',
    description: '消息已提交到微信发送界面',
    requiredEvidence: 'tool_receipt',
    expectedTool: 'connector_action',
    expectedArgumentsContain: ['wechat', '好友'],
  }],
};

const report: CompletionReport = {
  status: 'completed',
  proofs: [{
    criterionId: 'message-sent',
    evidence: '微信 Connector 返回 confirmed 回执',
    toolCallIds: ['send-1'],
  }],
};

function actionEvidence(outcome: 'accepted' | 'confirmed' | 'uncertain' | 'failed'): CompletionEvidence[] {
  return [{
    toolName: 'connector_action',
    callId: 'send-1',
    argumentsJson: '{"connector":"wechat","target":"好友"}',
    status: outcome === 'failed' ? 'failed' : 'succeeded',
    output: {
      outcome,
      operationId: 'wechat-1',
      tool: 'connector_action',
      occurredAt: '2026-07-16T00:00:00.000Z',
    },
  }];
}

test('completion gate requires a contract and an explicit completion report', () => {
  assert.equal(evaluateCompletion(undefined, undefined, []).decision, 'continue');
  assert.match(evaluateCompletion(contract, undefined, []).reason, /finish_task/);
});

test('completion gate accepts verified external action receipts', () => {
  assert.deepEqual(evaluateCompletion(contract, report, actionEvidence('confirmed')), {
    decision: 'pass',
    reason: '全部验收条件已有可验证证据',
    unmetCriteria: [],
  });
  assert.equal(evaluateCompletion(contract, report, actionEvidence('accepted')).decision, 'uncertain');
});

test('completion contract requires objective evidence for side effects and artifacts', () => {
  assert.throws(() => completionContractSchema.parse({
    objective: '发送微信消息',
    kind: 'external_action',
    criteria: [{ id: 'claimed', description: '声称已发送', requiredEvidence: 'semantic' }],
  }), /tool_receipt/);
  assert.throws(() => completionContractSchema.parse({
    objective: '修改代码',
    kind: 'artifact',
    criteria: [{ id: 'claimed', description: '声称已修改', requiredEvidence: 'semantic' }],
  }), /artifact/);
});

test('completion gate never accepts uncertain or failed external actions', () => {
  const uncertain = evaluateCompletion(contract, report, actionEvidence('uncertain'));
  assert.equal(uncertain.decision, 'uncertain');
  assert.deepEqual(uncertain.unmetCriteria, ['message-sent']);

  const failed = evaluateCompletion(contract, report, actionEvidence('failed'));
  assert.equal(failed.decision, 'continue');
  assert.deepEqual(failed.unmetCriteria, ['message-sent']);
});

test('completion gate rejects unstructured or forged external receipts', () => {
  const missingTrace = actionEvidence('confirmed');
  missingTrace[0]!.output = { outcome: 'confirmed' };
  assert.equal(evaluateCompletion(contract, report, missingTrace).decision, 'continue');

  const forged = actionEvidence('confirmed');
  forged[0]!.toolName = 'calculate';
  assert.equal(evaluateCompletion(contract, report, forged).decision, 'continue');
});

test('host derives evidence strength from user intent and locks the first contract', () => {
  assert.equal(expectedCompletionKind('帮我发送一条微信消息'), 'external_action');
  assert.equal(expectedCompletionKind('修复登录页代码并运行测试'), 'artifact');
  assert.equal(expectedCompletionKind('持续研究这个议题'), 'long_running');
  assert.equal(expectedCompletionKind('分析这段错误日志'), 'answer');

  assert.throws(() => assertCompletionContractForTask('发送微信消息', {
    objective: '发送微信消息',
    kind: 'answer',
    criteria: [{ id: 'claimed', description: '声称成功', requiredEvidence: 'semantic' }],
  }), /必须为 external_action/);
  assert.throws(() => assertCompletionContractForTask('发送微信消息', {
    ...contract,
    criteria: [{
      id: 'weaker', description: '另一份标准', requiredEvidence: 'tool_receipt',
      expectedTool: 'connector_action', expectedArgumentsContain: ['wechat'],
    }],
  }, contract), /已锁定/);
  assert.equal(assertCompletionContractForTask('发送微信消息', contract, contract), contract);
});

test('completion gate only permits blockers that really require user action', () => {
  const fakeBlock = evaluateCompletion(contract, {
    status: 'blocked', proofs: [], blocker: {
      requiresUser: false, reason: '暂时不想继续', question: '要继续吗？', attemptedAlternatives: ['无'],
    },
  }, []);
  assert.equal(fakeBlock.decision, 'continue');

  const realBlock = evaluateCompletion(contract, {
    status: 'blocked', proofs: [], blocker: {
      requiresUser: true,
      reason: '微信尚未登录，需要 owner 在本机完成扫码',
      question: '请完成微信扫码登录后告诉我。',
      attemptedAlternatives: ['检查现有登录态', '检查 Connector readiness'],
    },
  }, []);
  assert.equal(realBlock.decision, 'blocked');

  assert.equal(evaluateCompletion(contract, {
    status: 'blocked', proofs: [], blocker: {
      requiresUser: true,
      reason: '后台需要 owner 登录',
      question: '请完成登录。',
      attemptedAlternatives: ['检查现有凭证'],
    },
  }, [], [], true).decision, 'continue');
  assert.equal(evaluateCompletion(contract, {
    status: 'blocked', proofs: [], blocker: {
      requiresUser: true,
      reason: '后台需要 owner 登录',
      question: '请完成登录。',
      attemptedAlternatives: ['检查现有凭证'],
    },
  }, [{
    toolName: 'request_background_task_input',
    callId: 'block-1',
    argumentsJson: '{"question":"请完成登录"}',
    status: 'succeeded',
  }], [], true).decision, 'blocked');
});
