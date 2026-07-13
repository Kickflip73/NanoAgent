import type { RunStreamEvent } from '@openai/agents';

type Writable = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

export type DisplayEvent =
  | { kind: 'answer'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'status'; text: string; next: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact(value: unknown, limit = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= limit
    ? singleLine
    : `${singleLine.slice(0, limit)}…`;
}

function rawItem(event: RunStreamEvent): Record<string, unknown> | undefined {
  if (event.type !== 'run_item_stream_event') return undefined;
  return record(record(event.item)?.rawItem);
}

export function parseRunEvent(event: RunStreamEvent): DisplayEvent | undefined {
  if (event.type === 'agent_updated_stream_event') {
    return {
      kind: 'status',
      text: `🤖 当前 Agent：${event.agent.name}`,
      next: 'Agent 工作中',
    };
  }

  if (event.type === 'run_item_stream_event') {
    const raw = rawItem(event);
    if (event.name === 'tool_called') {
      const name = typeof raw?.name === 'string' ? raw.name : 'unknown';
      const args = compact(raw?.arguments);
      return {
        kind: 'status',
        text: `🔧 调用工具 ${name}${args ? ` ${args}` : ''}`,
        next: `正在执行 ${name}`,
      };
    }
    if (event.name === 'tool_output') {
      const item = record(event.item);
      const name = typeof raw?.name === 'string' ? raw.name : 'tool';
      const output = compact(item?.output, 120);
      return {
        kind: 'status',
        text: `✓ 工具完成 ${name}${output ? ` → ${output}` : ''}`,
        next: '模型继续思考',
      };
    }
    if (event.name === 'reasoning_item_created') {
      return { kind: 'status', text: '💭 推理阶段完成', next: '生成回答' };
    }
    return undefined;
  }

  if (event.type !== 'raw_model_stream_event') return undefined;
  if (event.data.type === 'output_text_delta') {
    return { kind: 'answer', text: event.data.delta };
  }
  if (event.data.type !== 'model') return undefined;

  const providerEvent = record(event.data.event);
  const choices = Array.isArray(providerEvent?.choices)
    ? providerEvent.choices
    : undefined;
  const choice = record(choices?.[0]);
  const delta = record(choice?.delta);
  if (typeof delta?.reasoning_content === 'string') {
    return { kind: 'reasoning', text: delta.reasoning_content };
  }

  if (
    providerEvent?.type === 'response.reasoning_summary_text.delta' &&
    typeof providerEvent.delta === 'string'
  ) {
    return { kind: 'reasoning', text: providerEvent.delta };
  }
  return undefined;
}

export class TerminalRenderer {
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private label = '';
  private line: 'answer' | 'reasoning' | undefined;
  private readonly startedAt = Date.now();

  constructor(
    private readonly status: Writable = process.stderr,
    private readonly answer: Writable = process.stdout,
  ) {}

  start(label = '模型思考中'): void {
    this.stopSpinner();
    this.label = label;
    if (!this.status.isTTY) {
      this.status.write(`[运行] ${label}\n`);
      return;
    }
    this.draw();
    this.timer = setInterval(() => this.draw(), 80);
    this.timer.unref();
  }

  handle(event: RunStreamEvent): void {
    const display = parseRunEvent(event);
    if (!display) return;

    if (display.kind === 'status') {
      this.stopSpinner();
      this.closeLine();
      this.status.write(`${display.text}\n`);
      this.start(display.next);
      return;
    }

    this.stopSpinner();
    if (display.kind === 'reasoning') {
      if (this.line !== 'reasoning') {
        this.closeLine();
        this.status.write('💭 思考> ');
        this.line = 'reasoning';
      }
      this.status.write(display.text);
      return;
    }

    if (this.line !== 'answer') {
      this.closeLine();
      this.answer.write('助手> ');
      this.line = 'answer';
    }
    this.answer.write(display.text);
  }

  finish(): void {
    this.stopSpinner();
    this.closeLine();
    const seconds = ((Date.now() - this.startedAt) / 1_000).toFixed(1);
    this.status.write(`✓ 任务完成 · ${seconds}s\n`);
  }

  stop(): void {
    this.stopSpinner();
    this.closeLine();
  }

  private draw(): void {
    const icon = this.frames[this.frame % this.frames.length];
    this.frame += 1;
    this.status.write(`\r\x1b[2K${icon} ${this.label}`);
  }

  private stopSpinner(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.status.isTTY && this.label) {
      this.status.write('\r\x1b[2K');
    }
    this.label = '';
  }

  private closeLine(): void {
    if (this.line === 'answer') this.answer.write('\n');
    if (this.line === 'reasoning') this.status.write('\n');
    this.line = undefined;
  }
}
