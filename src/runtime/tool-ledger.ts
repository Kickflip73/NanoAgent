import type { Tool } from '@openai/agents';
import { createHash } from 'node:crypto';
import type { ExecutionLedger } from '../core/execution-ledger.js';
import { isSideEffectTool } from './tool-policy.js';

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

export function withExecutionLedger(
  tools: Tool[],
  ledger: ExecutionLedger,
  currentRun: () => RunIdentity | undefined,
): Tool[] {
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
        const argumentsJson = run?.semanticCallIds ? semanticArguments(input) : input;
        const callId = run?.semanticCallIds
          ? createHash('sha256').update(`${tool.name}\0${argumentsJson}`).digest('hex')
          : sdkCallId;
        const invokeAuthorized = async () => {
          await run?.authorizeSideEffect?.(tool.name, input);
          return originalInvoke(runContext, input, details);
        };
        if (!run || !callId) return invokeAuthorized();
        return ledger.executeOnce({
          sessionId: run.sessionId,
          runId: run.runId,
          toolName: tool.name,
          callId,
          ...(sdkCallId && sdkCallId !== callId ? { modelCallId: sdkCallId } : {}),
          argumentsJson,
        }, invokeAuthorized);
      },
    } as Tool;
  });
}
