import type { RunStreamEvent } from '@openai/agents';
import type { RuntimeEffect } from './control.js';
import type { RuntimeEvent } from './hooks.js';
import type {
  CompletionDeliveryDisposition,
  ContextUsageSnapshot,
  MimiAgent,
  MimiRunOptions,
} from './mimi-agent.js';
import { CompletionGateError } from '../core/completion.js';
import { assertRunCanComplete, isRunInterrupted, isTerminalRunInterruption } from './run-outcome.js';

export interface AgentRunRequest {
  input: string;
  signal?: AbortSignal;
  options?: MimiRunOptions;
}

export interface AgentRunResult {
  answer: string;
  effects: RuntimeEffect[];
  usage?: ContextUsageSnapshot;
  delivery?: CompletionDeliveryDisposition;
}

export interface AgentRunObserver {
  onStart?: (input: string) => void | Promise<void>;
  onStreamEvent?: (event: RunStreamEvent) => void | Promise<void>;
  onRuntimeEvent?: (event: RuntimeEvent) => void | Promise<void>;
  onComplete?: (result: AgentRunResult) => void | Promise<void>;
  onError?: (error: unknown) => void | Promise<void>;
}

type RunStream = Awaited<ReturnType<MimiAgent['stream']>>;

function usageFrom(stream: RunStream | undefined): ContextUsageSnapshot | undefined {
  if (!stream) return undefined;
  const last = stream.rawResponses.at(-1)?.usage;
  const total = stream.runContext.usage;
  const usage = {
    lastRequestInputTokens: last?.inputTokens || undefined,
    lastRequestOutputTokens: last?.outputTokens || undefined,
    runInputTokens: total.inputTokens || undefined,
    runOutputTokens: total.outputTokens || undefined,
    runTotalTokens: total.totalTokens || undefined,
  };
  return Object.values(usage).some((value) => typeof value === 'number' && value > 0) ? usage : undefined;
}

function answerDelta(event: RunStreamEvent): string {
  return event.type === 'raw_model_stream_event'
    && event.data.type === 'output_text_delta'
    ? event.data.delta
    : '';
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function progressFrom(event: RunStreamEvent): Record<string, unknown> | undefined {
  if (event.type === 'agent_updated_stream_event') {
    return { kind: 'status', tone: 'agent', title: event.agent.name, next: 'Agent 工作中' };
  }
  if (event.type !== 'run_item_stream_event') return undefined;
  const raw = record(record(event.item)?.rawItem);
  if (event.name === 'tool_called') {
    const name = typeof raw?.name === 'string' ? raw.name : 'unknown';
    return {
      kind: 'status',
      tone: 'tool',
      title: name,
      detail: typeof raw?.arguments === 'string' ? raw.arguments.slice(0, 1_000) : raw?.arguments,
      next: `正在执行 ${name}`,
    };
  }
  if (event.name === 'tool_output') {
    const name = typeof raw?.name === 'string' ? raw.name : 'tool';
    return { kind: 'status', tone: 'success', title: name, next: '模型继续思考' };
  }
  return undefined;
}

async function observe<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
  if (!callback) return;
  try {
    await callback(value);
  } catch {
    // Presentation and telemetry observers must not corrupt durable run state.
  }
}

export class AgentRunService {
  constructor(private readonly agent: MimiAgent) {}

  async execute(request: AgentRunRequest, observer: AgentRunObserver = {}): Promise<AgentRunResult> {
    let stream: RunStream | undefined;
    let streamedAnswer = '';
    const stopRuntimeEvents = this.agent.onRuntimeEvent((event) => observe(observer.onRuntimeEvent, event));
    await observe(observer.onStart, request.input);
    try {
      stream = await this.agent.stream(request.input, request.signal, request.options);
      for await (const event of stream) {
        streamedAnswer += answerDelta(event);
        const hiddenCandidate = this.agent.completionGateRequired
          && event.type === 'raw_model_stream_event'
          && event.data.type === 'output_text_delta';
        if (!hiddenCandidate) await observe(observer.onStreamEvent, event);
        const progress = progressFrom(event);
        if (progress) await this.agent.recordEvent('status', progress);
      }
      await stream.completed;
      assertRunCanComplete(stream, request.signal);
      const finalOutput = stream.finalOutput;
      const answer = (typeof finalOutput === 'string'
        ? finalOutput
        : finalOutput === undefined ? streamedAnswer : JSON.stringify(finalOutput)).slice(0, 20_000);
      const usage = usageFrom(stream);
      const effects = await this.agent.completeRun(answer, usage);
      const result = {
        answer,
        effects,
        usage,
        delivery: request.options?.completionDelivery?.(),
      } satisfies AgentRunResult;
      await observe(observer.onComplete, result);
      return result;
    } catch (error) {
      if (error instanceof CompletionGateError) {
        await this.agent.deferRunForCompletion(error, usageFrom(stream));
        await observe(observer.onError, error);
        throw error;
      }
      const terminalReason = request.signal?.aborted
        && isTerminalRunInterruption(request.signal.reason)
        ? request.signal.reason
        : undefined;
      await this.agent.failRun(
        isTerminalRunInterruption(error) ? error : terminalReason ?? error,
        isRunInterrupted(error, request.signal),
        usageFrom(stream),
      );
      await observe(observer.onError, error);
      throw error;
    } finally {
      stopRuntimeEvents();
    }
  }
}
