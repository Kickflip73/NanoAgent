import type { Tool } from '@openai/agents';
import type { ExecutionLedger } from '../core/execution-ledger.js';
import { isSideEffectTool } from './tool-policy.js';

interface RunIdentity {
  sessionId: string;
  runId: string;
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

export function withExecutionLedger(
  tools: Tool[],
  ledger: ExecutionLedger,
  currentRun: () => RunIdentity | undefined,
): Tool[] {
  return tools.map((tool) => {
    if (!isSideEffectTool(tool.name) || !isInvokable(tool)) return tool;
    const originalInvoke = tool.invoke.bind(tool);
    return {
      ...tool,
      invoke: async (runContext, input, details) => {
        const run = currentRun();
        const callId = details?.toolCall?.callId;
        if (!run || !callId) return originalInvoke(runContext, input, details);
        return ledger.executeOnce({
          sessionId: run.sessionId,
          runId: run.runId,
          toolName: tool.name,
          callId,
          argumentsJson: input,
        }, () => originalInvoke(runContext, input, details));
      },
    } as Tool;
  });
}
