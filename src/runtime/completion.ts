import { tool, type Tool } from '@openai/agents';
import {
  completionContractSchema,
  completionReportSchema,
  type CompletionContract,
  type CompletionGateDecision,
  type CompletionReport,
} from '../core/completion.js';

export * from '../core/completion.js';

export function createCompletionTools(callbacks: {
  prepare: (contract: CompletionContract) => Promise<void>;
  finish: (report: CompletionReport) => Promise<CompletionGateDecision>;
}): Tool[] {
  return [
    tool({
      name: 'prepare_task',
      description: '仅为已经存在或刚由 set_goal 创建的持久 Goal 建立 Completion Contract。普通问答和短操作禁止调用。Goal 创建后、执行副作用前给出 1-8 条可验证验收条件。',
      parameters: completionContractSchema,
      execute: async (contract) => {
        await callbacks.prepare(contract);
        return { accepted: true, contract };
      },
    }),
    tool({
      name: 'finish_task',
      description: '仅为持久 Goal 提交完成证据。只有 decision=pass 才能把 Goal 标记完成；其他结果保留 Goal 和检查点但不自动重跑整个 Event，uncertain 禁止重放副作用。',
      parameters: completionReportSchema,
      execute: callbacks.finish,
    }),
  ];
}
