import { randomUUID } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import type {
  BuiltInstructions,
  ContextManifest,
  EffectiveHistoryResult,
  RequestBudget,
} from '../../core/context.js';
import { estimateTokens } from '../../core/context.js';
import type { ContextArchive } from '../../core/session.js';
import type { RunScope } from './run-scope.js';

export interface ContextManifestInput {
  scope: RunScope;
  budget: RequestBudget;
  instructions: BuiltInstructions;
  effective: EffectiveHistoryResult;
  archive?: ContextArchive;
  archiveInput: AgentInputItem[];
  currentInput: AgentInputItem[];
  toolCount: number;
}

export class ContextAssembler {
  manifest(input: ContextManifestInput): ContextManifest {
    const archiveTokens = Math.min(
      input.archiveInput.length ? estimateTokens(input.archiveInput) : 0,
      input.effective.effectiveTokens,
    );
    const currentInputTokens = Math.min(
      estimateTokens(input.currentInput),
      Math.max(0, input.effective.effectiveTokens - archiveTokens),
    );
    const historyTokens = Math.max(
      0,
      input.effective.effectiveTokens - archiveTokens - currentInputTokens,
    );
    const estimatedInputTokens = input.budget.toolSchemaTokens
      + input.budget.protocolReserveTokens
      + estimateTokens(input.instructions.text)
      + input.effective.effectiveTokens;
    return {
      requestId: randomUUID(),
      sessionId: input.scope.sessionId,
      runId: input.scope.runId,
      provider: input.scope.provider,
      model: input.scope.model,
      estimator: 'mimi-char-v1',
      contextWindow: input.budget.contextWindow,
      outputReserve: input.budget.outputReserveTokens,
      availableInputBudget: input.budget.inputBudget,
      sections: [
        ...input.instructions.sections,
        ...(archiveTokens ? [{
          id: 'archive' as const,
          estimatedTokens: archiveTokens,
          itemCount: input.archive?.coveredItems,
          truncated: false,
        }] : []),
        {
          id: 'recent-history',
          estimatedTokens: historyTokens,
          itemCount: Math.max(0, input.effective.items.length - input.currentInput.length),
          truncated: input.effective.records.some((record) => record.strategy === 'turn-truncation'),
        },
        {
          id: 'current-input',
          estimatedTokens: currentInputTokens,
          itemCount: input.currentInput.length,
          truncated: input.effective.records.some((record) => record.strategy === 'input-fit'),
        },
        {
          id: 'tool-schemas',
          estimatedTokens: input.budget.toolSchemaTokens,
          itemCount: input.toolCount,
          truncated: false,
        },
        {
          id: 'protocol-reserve',
          estimatedTokens: input.budget.protocolReserveTokens,
          truncated: false,
        },
      ],
      compression: input.effective.records,
      estimatedInputTokens,
      createdAt: new Date().toISOString(),
    };
  }
}
