import type { Tool } from '@openai/agents';
import type { ExecutionCallRecord } from '../../core/execution-ledger.js';
import { toolResultFailure, toolResultUncertain } from '../../core/tool-result.js';

type InvokableTool = Tool & {
  name: string;
  invoke: (
    context: unknown,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

interface ObservedCall {
  toolName: string;
  callId: string;
  argumentsJson: string;
  status: 'succeeded' | 'failed' | 'uncertain';
  output?: unknown;
  error?: string;
}

function invokable(candidate: Tool): candidate is InvokableTool {
  return 'invoke' in candidate && typeof candidate.invoke === 'function';
}

/** Captures every model-visible tool result without turning reads into replay-protected effects. */
export class RunFactCollector {
  private readonly observed: ObservedCall[] = [];
  private sequence = 0;

  wrap(tools: readonly Tool[], persist?: (call: ObservedCall) => Promise<void>): Tool[] {
    return tools.map((candidate) => {
      if (!invokable(candidate)) return candidate;
      const invoke = candidate.invoke.bind(candidate);
      return {
        ...candidate,
        invoke: async (context, input, details) => {
          const callId = details?.toolCall?.callId ?? `observed:${++this.sequence}`;
          let output: unknown;
          try {
            output = await invoke(context, input, details);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const observed: ObservedCall = {
              toolName: candidate.name,
              callId,
              argumentsJson: input,
              status: 'failed',
              error: message.slice(0, 2_000),
            };
            this.observed.push(observed);
            await persist?.(observed);
            throw error;
          }
          const error = toolResultFailure(output);
          const observed: ObservedCall = {
            toolName: candidate.name, callId, argumentsJson: input,
            status: toolResultUncertain(output) ? 'uncertain' : error ? 'failed' : 'succeeded',
            output, ...(error ? { error } : {}),
          };
          this.observed.push(observed);
          await persist?.(observed);
          return output;
        },
      } as Tool;
    });
  }

  calls(sessionId: string, runId: string): ExecutionCallRecord[] {
    return this.observed.map((call) => ({ sessionId, runId, ...call }));
  }
}

export function mergeRunCalls(
  observed: readonly ExecutionCallRecord[],
  ledger: readonly ExecutionCallRecord[],
): ExecutionCallRecord[] {
  const remaining = [...observed];
  const merged = ledger.map((durable) => {
    const match = remaining.findIndex((candidate) => (
      candidate.callId === durable.callId
      || candidate.callId === durable.modelCallId
      || durable.modelCallIds?.includes(candidate.callId)
    ));
    if (match < 0) return durable;
    const [modelFact] = remaining.splice(match, 1);
    return {
      ...durable,
      ...(durable.status === 'succeeded' && modelFact?.status !== undefined ? { status: modelFact.status } : {}),
      ...(modelFact?.output !== undefined ? { output: modelFact.output } : {}),
      ...(durable.error === undefined && modelFact?.error ? { error: modelFact.error } : {}),
    };
  });
  return [...merged, ...remaining];
}
