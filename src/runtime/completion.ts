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
      description: '在执行有明确完成态的任务前建立 Completion Contract。必须先给出 1-8 条可验证验收条件，再调用任何有副作用的工具。',
      parameters: completionContractSchema,
      execute: async (contract) => {
        await callbacks.prepare(contract);
        return { accepted: true, contract };
      },
    }),
    tool({
      name: 'finish_task',
      description: '提交任务完成证据并请求 Host 验收。只有返回 decision=pass 才能向用户宣称完成；continue 必须在当前任务内继续执行并再次验收；uncertain 禁止重放副作用，只能核验现状；blocked 仅限确实必须用户操作。',
      parameters: completionReportSchema,
      execute: callbacks.finish,
    }),
  ];
}
