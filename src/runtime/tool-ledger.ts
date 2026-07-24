import type { Tool } from '@openai/agents';
import { createHash } from 'node:crypto';
import type { ExecutionLedger } from '../core/execution-ledger.js';
import { TOOL_LEDGER_ARGUMENTS } from '../core/tool-metadata.js';
import { isSideEffectTool } from './tool-policy.js';

export { TOOL_LEDGER_ARGUMENTS } from '../core/tool-metadata.js';

interface RunIdentity {
  sessionId: string;
  runId: string;
  semanticCallIds?: boolean;
  authorizeTool?: (toolName: string, argumentsJson: string) => Promise<void>;
  authorizeSideEffect?: (toolName: string, argumentsJson: string) => Promise<void>;
}

type InvokableTool = Tool & {
  name: string;
  invoke: (
    runContext: unknown,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

type LedgerAwareTool = Tool & {
  [TOOL_LEDGER_ARGUMENTS]?: (rawInput: string) => string;
};

function isInvokable(tool: Tool): tool is InvokableTool {
  return 'invoke' in tool && typeof tool.invoke === 'function';
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  )).join(',')}}`;
}

function semanticArguments(input: string): string {
  try {
    return stableJson(JSON.parse(input) as unknown);
  } catch {
    // The SDK/tool schema remains responsible for rejecting invalid JSON. Keep
    // a deterministic raw identity so the ledger never broadens execution.
    return input;
  }
}

function alreadyExecutedResult(result: unknown): unknown {
  const replay = {
    mimiStatus: 'already_executed',
    message: '相同操作已经成功执行且其后没有新的副作用；本次未重复执行，请使用 previousResult 继续回答。',
    previousResult: result,
  };
  return result && typeof result === 'object' && !Array.isArray(result)
    ? { ...result as Record<string, unknown>, ...replay }
    : replay;
}

export function withExecutionLedger(
  tools: Tool[],
  ledger: ExecutionLedger,
  currentRun: () => RunIdentity | undefined,
): Tool[] {
  const semanticOccurrences = new Map<string, number>();
  let previousSemanticKey: string | undefined;
  return tools.map((tool) => {
    if (!isInvokable(tool)) return tool;
    const sideEffect = isSideEffectTool(tool.name);
    const originalInvoke = tool.invoke.bind(tool);
    return {
      ...tool,
      invoke: async (runContext, input, details) => {
        const run = currentRun();
        await run?.authorizeTool?.(tool.name, input);
        if (!sideEffect) return originalInvoke(runContext, input, details);
        const sdkCallId = details?.toolCall?.callId;
        const ledgerInput = (tool as LedgerAwareTool)[TOOL_LEDGER_ARGUMENTS]?.(input) ?? input;
        const argumentsJson = run?.semanticCallIds ? semanticArguments(ledgerInput) : ledgerInput;
        const semanticKey = `${tool.name}\0${argumentsJson}`;
        const consecutiveDuplicate = run?.semanticCallIds && previousSemanticKey === semanticKey;
        const occurrence = run?.semanticCallIds
          ? consecutiveDuplicate
            ? semanticOccurrences.get(semanticKey) ?? 1
            : (semanticOccurrences.get(semanticKey) ?? 0) + 1
          : undefined;
        if (occurrence !== undefined) {
          semanticOccurrences.set(semanticKey, occurrence);
          previousSemanticKey = semanticKey;
        }
        const callId = run?.semanticCallIds
          ? createHash('sha256').update(`${semanticKey}\0${occurrence}`).digest('hex')
          : sdkCallId;
        const invokeAuthorized = async () => {
          await run?.authorizeSideEffect?.(tool.name, input);
          return originalInvoke(runContext, input, details);
        };
        if (!run || !callId) return invokeAuthorized();
        const result = await ledger.executeOnce({
          sessionId: run.sessionId,
          runId: run.runId,
          toolName: tool.name,
          callId,
          ...(sdkCallId && sdkCallId !== callId ? { modelCallId: sdkCallId } : {}),
          argumentsJson,
        }, invokeAuthorized);
        return consecutiveDuplicate ? alreadyExecutedResult(result) : result;
      },
    } as Tool;
  });
}
