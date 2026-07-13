import type { RunStreamEvent } from '@openai/agents';

type Writable = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

type StatusTone = 'agent' | 'thinking' | 'tool' | 'success';

export type DisplayEvent =
  | { kind: 'answer'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'status';
      tone: StatusTone;
      title: string;
      detail?: string;
      next: string;
    };

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  code: '\x1b[38;2;148;166;173m',
  gray: '\x1b[38;2;145;151;158m',
};

const badges: Record<StatusTone | 'answer' | 'done', { icon: string; label: string; rgb: string }> = {
  agent: { icon: '◆', label: 'Agent', rgb: '148;156;166' },
  thinking: { icon: '✦', label: '思考', rgb: '126;156;196' },
  tool: { icon: '●', label: '工具', rgb: '93;170;160' },
  success: { icon: '└', label: '结果', rgb: '124;170;122' },
  answer: { icon: '◆', label: '回答', rgb: '157;142;198' },
  done: { icon: '✓', label: '完成', rgb: '124;170;122' },
};

export interface BannerInfo {
  version: string;
  provider: string;
  model: string;
  sessionTitle: string;
  workspaceRoot: string;
  skillCount: number;
  mcpServers: string[];
}

export function renderBanner(info: BannerInfo, tty = true): string {
  const accent = (text: string) => tty ? `\x1b[38;2;93;170;160m${text}${ansi.reset}` : text;
  const muted = (text: string) => tty ? `${ansi.gray}${text}${ansi.reset}` : text;
  const strong = (text: string) => tty ? `${ansi.bold}${text}${ansi.reset}` : text;
  return [
    `  ${accent('╭──────╮')}   ${strong('NanoAgent')} ${muted(`v${info.version}`)}`,
    `  ${accent('│  ◉ ◉ │')}   轻量级 Agent 助手`,
    `  ${accent('│   ᴗ  │')}`,
    `  ${accent('╰──┬───╯')}   ${muted('Esc 中止 · / 查看命令')}`,
    `     ${accent('╵')}`,
    '',
    `  模型    ${info.provider} · ${info.model}`,
    `  对话    ${info.sessionTitle}`,
    `  扩展    Skills ${info.skillCount} · MCP ${info.mcpServers.length || '未连接'}`,
    `  工作区  ${info.workspaceRoot}`,
  ].join('\n');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function compact(value: unknown, limit = 160): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit)}…`;
}

function rawItem(event: RunStreamEvent): Record<string, unknown> | undefined {
  if (event.type !== 'run_item_stream_event') return undefined;
  return record(record(event.item)?.rawItem);
}

export function parseRunEvent(event: RunStreamEvent): DisplayEvent | undefined {
  if (event.type === 'agent_updated_stream_event') {
    return {
      kind: 'status',
      tone: 'agent',
      title: event.agent.name,
      next: 'Agent 工作中',
    };
  }

  if (event.type === 'run_item_stream_event') {
    const raw = rawItem(event);
    if (event.name === 'tool_called') {
      const name = typeof raw?.name === 'string' ? raw.name : 'unknown';
      return {
        kind: 'status',
        tone: 'tool',
        title: name,
        detail: compact(raw?.arguments),
        next: `正在执行 ${name}`,
      };
    }
    if (event.name === 'tool_output') {
      const item = record(event.item);
      const name = typeof raw?.name === 'string' ? raw.name : 'tool';
      return {
        kind: 'status',
        tone: 'success',
        title: name,
        detail: compact(item?.output, 120),
        next: '模型继续思考',
      };
    }
    if (event.name === 'reasoning_item_created') {
      return {
        kind: 'status',
        tone: 'thinking',
        title: '推理阶段完成',
        next: '生成回答',
      };
    }
    return undefined;
  }

  if (event.type !== 'raw_model_stream_event') return undefined;
  if (event.data.type === 'output_text_delta') {
    return { kind: 'answer', text: event.data.delta };
  }
  if (event.data.type !== 'model') return undefined;

  const providerEvent = record(event.data.event);
  const choices = Array.isArray(providerEvent?.choices) ? providerEvent.choices : undefined;
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

function inlineMarkdown(text: string, tty: boolean): string {
  let value = text.replace(/\x1b/g, '');
  value = value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)');
  value = value.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) =>
    tty ? `${label} ${ansi.dim}(${url})${ansi.reset}` : `${label} (${url})`,
  );
  value = value.replace(/`([^`]+)`/g, (_, code: string) =>
    tty ? `${ansi.code}${code}${ansi.reset}` : code,
  );
  value = value.replace(/\*\*([^*]+)\*\*/g, (_, content: string) =>
    tty ? `${ansi.bold}${content}${ansi.reset}` : content,
  );
  value = value.replace(/__([^_]+)__/g, (_, content: string) =>
    tty ? `${ansi.bold}${content}${ansi.reset}` : content,
  );
  value = value.replace(/~~([^~]+)~~/g, '$1');
  value = value.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, content: string) =>
    tty ? `${ansi.italic}${content}${ansi.reset}` : content,
  );
  return value;
}

export function renderMarkdownLine(
  source: string,
  tty = true,
  state: { code: boolean } = { code: false },
): string {
  const line = source.replace(/\x1b/g, '');
  const fence = line.match(/^\s*```\s*([^`]*)$/);
  if (fence) {
    state.code = !state.code;
    const language = fence[1]?.trim();
    if (state.code) return language ? `  ┌─ ${language}` : '  ┌─';
    return '  └─';
  }
  if (state.code) {
    return tty ? `  ${ansi.gray}│ ${line}${ansi.reset}` : `  │ ${line}`;
  }

  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if (heading) {
    const text = inlineMarkdown(heading[2]!, tty);
    const indent = heading[1]!.length > 2 ? '  ' : '';
    return tty ? `${indent}${ansi.bold}${text}${ansi.reset}` : `${indent}${text}`;
  }
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return tty ? `${ansi.dim}${'─'.repeat(48)}${ansi.reset}` : '─'.repeat(48);
  }

  const tableDivider = line.match(/^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/);
  if (tableDivider) return tty ? `${ansi.dim}${'─'.repeat(48)}${ansi.reset}` : '─'.repeat(48);
  if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
    const cells = line.trim().slice(1, -1).split('|').map((cell) => inlineMarkdown(cell.trim(), tty));
    return `  ${cells.join('  │  ')}`;
  }

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) {
    const text = inlineMarkdown(quote[1]!, tty);
    return tty ? `${ansi.gray}│ ${text}${ansi.reset}` : `│ ${text}`;
  }
  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) return `${task[1]}${task[2]!.toLowerCase() === 'x' ? '✓' : '○'} ${inlineMarkdown(task[3]!, tty)}`;
  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${inlineMarkdown(bullet[2]!, tty)}`;
  return inlineMarkdown(line, tty);
}

class MarkdownStream {
  private buffer = '';
  private readonly state = { code: false };
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly output: Writable,
    private readonly tty: boolean,
  ) {}

  write(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.output.write(`${renderMarkdownLine(line, this.tty, this.state)}\n`);
      newline = this.buffer.indexOf('\n');
    }
    this.scheduleFlush();
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.buffer) return false;
    this.output.write(renderMarkdownLine(this.buffer, this.tty, this.state));
    this.buffer = '';
    return true;
  }

  private scheduleFlush(): void {
    if (!this.buffer || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.canFlushPartial()) {
        this.scheduleFlush();
        return;
      }
      this.output.write(renderMarkdownLine(this.buffer, this.tty, this.state));
      this.buffer = '';
    }, 45);
    this.timer.unref();
  }

  private canFlushPartial(): boolean {
    const trimmed = this.buffer.trim();
    if (!trimmed) return false;
    if (/^#{1,6}$/.test(trimmed) || trimmed.startsWith('```')) return false;
    const boldMarkers = (this.buffer.match(/\*\*/g) ?? []).length;
    const codeMarkers = (this.buffer.match(/(?<!`)`(?!`)/g) ?? []).length;
    return boldMarkers % 2 === 0 && codeMarkers % 2 === 0;
  }
}

function badge(tone: keyof typeof badges, tty: boolean): string {
  const item = badges[tone];
  if (!tty) return `${item.icon} ${item.label}`;
  return `\x1b[38;2;${item.rgb}m${item.icon} ${item.label}${ansi.reset}`;
}

export class TerminalRenderer {
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private label = '';
  private active?: 'answer' | 'reasoning';
  private markdown?: MarkdownStream;
  private hasBlock = false;
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
      this.hasBlock = true;
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
      this.closeActive();
      this.beginBlock(this.status);
      this.status.write(`${badge(display.tone, Boolean(this.status.isTTY))}  ${display.title}${display.detail ? `\n  ${this.muted(display.detail, this.status)}` : ''}\n`);
      this.start(display.next);
      return;
    }

    this.stopSpinner();
    if (display.kind === 'reasoning') {
      if (this.active !== 'reasoning') {
        this.closeActive();
        this.beginBlock(this.status);
        this.status.write(`${badge('thinking', Boolean(this.status.isTTY))}\n`);
        this.active = 'reasoning';
        this.markdown = new MarkdownStream(this.status, Boolean(this.status.isTTY));
      }
      this.markdown?.write(display.text);
      return;
    }

    if (this.active !== 'answer') {
      this.closeActive();
      this.beginBlock(this.answer);
      this.answer.write(`${badge('answer', Boolean(this.answer.isTTY))}\n`);
      this.active = 'answer';
      this.markdown = new MarkdownStream(this.answer, Boolean(this.answer.isTTY));
    }
    this.markdown?.write(display.text);
  }

  finish(): void {
    this.stopSpinner();
    this.closeActive();
    const seconds = ((Date.now() - this.startedAt) / 1_000).toFixed(1);
    this.beginBlock(this.status);
    this.status.write(`${badge('done', Boolean(this.status.isTTY))}  ${this.muted(`${seconds}s`, this.status)}\n`);
  }

  stop(): void {
    this.stopSpinner();
    this.closeActive();
  }

  private beginBlock(output: Writable): void {
    if (this.hasBlock) output.write('\n');
    this.hasBlock = true;
  }

  private closeActive(): void {
    if (!this.active) return;
    const wroteTail = this.markdown?.flush() ?? false;
    if (wroteTail) (this.active === 'answer' ? this.answer : this.status).write('\n');
    this.active = undefined;
    this.markdown = undefined;
  }

  private muted(text: string, output: Writable): string {
    return output.isTTY ? `${ansi.gray}${text}${ansi.reset}` : text;
  }

  private draw(): void {
    const icon = this.frames[this.frame % this.frames.length];
    this.frame += 1;
    this.status.write(`\r\x1b[2K${ansi.gray}${icon} ${this.label}${ansi.reset}`);
  }

  private stopSpinner(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.status.isTTY && this.label) this.status.write('\r\x1b[2K');
    this.label = '';
  }
}
