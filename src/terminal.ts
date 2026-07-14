import type { AgentInputItem, RunStreamEvent } from '@openai/agents';
import type { RunCheckpoint } from './core/session.js';
import type { RuntimeEvent } from './runtime/hooks.js';

type Writable = {
  write(chunk: string): unknown;
  isTTY?: boolean;
};

type StatusTone = 'agent' | 'thinking' | 'tool' | 'success' | 'failure';

export const OUTPUT_LEVELS = [
  { id: 'answer', label: '答案', description: '只显示最终答案', rank: 0 },
  { id: 'thinking', label: '思考', description: '显示思考过程和最终答案', rank: 1 },
  { id: 'tools', label: '工具', description: '显示工具调用和简要结果', rank: 2 },
  { id: 'trace', label: '详细', description: '显示输入、工具参数和完整结果', rank: 3 },
] as const;

export type OutputLevel = typeof OUTPUT_LEVELS[number]['id'];

export function normalizeOutputLevel(value?: string): OutputLevel {
  return OUTPUT_LEVELS.some((level) => level.id === value) ? value as OutputLevel : 'tools';
}

export type DisplayEvent =
  | { kind: 'answer'; text: string }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'status';
      tone: StatusTone;
      title: string;
      detail?: string;
      fullDetail?: string;
      next: string;
    };

const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  code: '\x1b[38;2;148;166;173m',
  gray: '\x1b[90m',
};

const badges: Record<StatusTone | 'answer' | 'done', { icon: string; label: string; color: string }> = {
  agent: { icon: '◆', label: 'Agent', color: '\x1b[90m' },
  thinking: { icon: '✦', label: '思考', color: '\x1b[94m' },
  tool: { icon: '●', label: '工具', color: '\x1b[96m' },
  success: { icon: '└', label: '结果', color: '\x1b[92m' },
  failure: { icon: '×', label: '失败', color: '\x1b[91m' },
  answer: { icon: '◆', label: '回答', color: '\x1b[95m' },
  done: { icon: '✓', label: '完成', color: '\x1b[92m' },
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
  const muted = (text: string) => tty ? `${ansi.gray}${text}${ansi.reset}` : text;
  const strong = (text: string) => tty ? `${ansi.bold}${text}${ansi.reset}` : text;
  return [
    `${strong('NanoAgent')} ${muted(`v${info.version}`)}`,
    '轻量级 Agent 助手',
    `模型    ${info.provider} · ${info.model}`,
    `对话    ${info.sessionTitle}`,
    `扩展    Skills ${info.skillCount} · MCP ${info.mcpServers.length || '未连接'}`,
    `工作区  ${info.workspaceRoot}`,
  ].join('\n');
}

function sessionItemText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const value = record(part);
    if (typeof value?.text === 'string') return value.text;
    if (value?.type === 'input_image') return '[图片]';
    if (value?.type === 'input_file') return '[附件]';
    return '';
  }).filter(Boolean).join('\n');
}

export function renderUserInput(value: string, tty = true): string {
  const lines = value.replace(/\x1b/g, '').trim().split(/\r?\n/);
  if (!tty) return lines.map((line, index) => `${index === 0 ? '▸' : ' '} ${line}`).join('\n');
  const marker = '\x1b[96m▸\x1b[0m';
  return lines.map((line, index) => {
    const content = `\x1b[100;97m ${line} \x1b[0m`;
    return `${index === 0 ? marker : ' '}${content}`;
  }).join('\n');
}

export function renderRecoveryCheckpoint(checkpoint: RunCheckpoint | undefined, tty = true): string {
  if (!checkpoint || checkpoint.status === 'completed') return '';
  const label = tty ? '\x1b[96m↻ 可恢复\x1b[0m' : '↻ 可恢复';
  const detail = [checkpoint.phase, checkpoint.lastEvent].filter(Boolean).join(' · ');
  return `${label}  ${detail || checkpoint.input}  ${tty ? '\x1b[90m/resume 继续\x1b[0m' : '/resume 继续'}`;
}

/** Render persisted user/assistant messages for terminal scrollback after a session switch. */
export function renderSessionTranscript(items: AgentInputItem[], tty = true): string {
  const blocks: string[] = [];
  for (const item of items) {
    if (!('role' in item) || (item.role !== 'user' && item.role !== 'assistant') || !('content' in item)) continue;
    const text = sessionItemText(item.content).replace(/\x1b/g, '').trim();
    if (!text) continue;
    if (item.role === 'user') {
      blocks.push(renderUserInput(text, tty));
      continue;
    }
    const state = { code: false };
    const answer = text.split(/\r?\n/).map((line) => renderMarkdownLine(line, tty, state)).join('\n');
    blocks.push(`${badge('answer', tty)}\n${answer}`);
  }
  return blocks.join('\n\n');
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
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, Math.max(0, limit - 3))}...`;
}

function detailed(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
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
        fullDetail: detailed(raw?.arguments),
        next: `正在执行 ${name}`,
      };
    }
    if (event.name === 'tool_output') {
      const item = record(event.item);
      const name = typeof raw?.name === 'string' ? raw.name : 'tool';
      if (name === 'run_team') {
        return {
          kind: 'status',
          tone: 'success',
          title: 'Ultra Team',
          detail: '本轮并行任务已结束',
          fullDetail: detailed(item?.output),
          next: '模型继续思考',
        };
      }
      return {
        kind: 'status',
        tone: 'success',
        title: name,
        detail: compact(item?.output, 120),
        fullDetail: detailed(item?.output),
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
  let value = text.replace(/\x1b/g, '').replace(/[ \t]{3,}/g, ' ');
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
  private previousBlank = false;

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
      const blank = line.trim() === '';
      if (!blank || !this.previousBlank) {
        this.output.write(`${renderMarkdownLine(line, this.tty, this.state)}\n`);
      }
      this.previousBlank = blank;
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
    this.previousBlank = false;
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
  return `${item.color}${item.icon} ${item.label}${ansi.reset}`;
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
  private readonly levelRank: number;

  constructor(
    private readonly status: Writable = process.stderr,
    private readonly answer: Writable = process.stdout,
    private readonly level: OutputLevel = 'tools',
  ) {
    this.levelRank = OUTPUT_LEVELS.find((item) => item.id === level)?.rank ?? 2;
  }

  start(label = '模型思考中', input?: string): void {
    this.stopSpinner();
    if (this.levelRank >= 3 && input) {
      this.beginBlock(this.status);
      this.status.write(`${badge('agent', Boolean(this.status.isTTY))}  任务\n  ${this.limitDetail(input)}\n`);
    }
    this.label = label;
    if (!this.status.isTTY) {
      if (this.levelRank > 0) {
        this.status.write(`[运行] ${label}\n`);
        this.hasBlock = true;
      }
      return;
    }
    this.draw();
    this.timer = setInterval(() => this.draw(), 80);
    this.timer.unref();
  }

  handle(event: RunStreamEvent): void {
    const display = parseRunEvent(event);
    if (!display) return;

    if (display.kind === 'reasoning' && this.levelRank < 1) return;
    if (display.kind === 'status') {
      if (display.tone === 'agent' && this.levelRank < 3) return;
      if (display.tone === 'thinking' && this.levelRank < 1) return;
      if (display.tone === 'tool' && this.levelRank < 2) return;
      if (display.tone === 'success' && this.levelRank < 2) return;
    }

    if (display.kind === 'status') {
      this.renderStatus(display.tone, display.title, display.detail, display.fullDetail, display.next);
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
      if (this.levelRank > 0) {
        this.beginBlock(this.answer);
        this.answer.write(`${badge('answer', Boolean(this.answer.isTTY))}\n`);
      }
      this.active = 'answer';
      this.markdown = new MarkdownStream(this.answer, Boolean(this.answer.isTTY));
    }
    this.markdown?.write(display.text);
  }

  handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type !== 'team_worker_event' || this.levelRank < 2) return;
    const name = `子代理 ${event.role} · ${event.taskId}`;
    if (event.eventType === 'start') {
      this.renderStatus('agent', name, `分配任务：${compact(event.description, 160)}`, event.description, `${event.role} 子代理执行中`);
      return;
    }
    const result = event.result || (event.eventType === 'error' ? '未返回错误信息' : '未返回结果摘要');
    const failed = event.eventType === 'error';
    this.renderStatus(
      failed ? 'failure' : 'success',
      name,
      `${failed ? '失败' : '完成'}：${compact(result, 180)}`,
      result,
      'Ultra Team 继续执行',
    );
  }

  finish(): void {
    this.stopSpinner();
    this.closeActive();
    if (this.levelRank > 0) {
      const seconds = ((Date.now() - this.startedAt) / 1_000).toFixed(1);
      this.beginBlock(this.status);
      this.status.write(`${badge('done', Boolean(this.status.isTTY))}  ${this.muted(`${seconds}s`, this.status)}\n`);
    }
  }

  stop(): void {
    this.stopSpinner();
    this.closeActive();
  }

  private beginBlock(output: Writable): void {
    if (this.hasBlock) output.write('\n');
    this.hasBlock = true;
  }

  private renderStatus(tone: StatusTone, title: string, detail: string | undefined, fullDetail: string | undefined, next: string): void {
    this.stopSpinner();
    this.closeActive();
    this.beginBlock(this.status);
    const value = this.levelRank >= 3 ? fullDetail : detail;
    const renderedDetail = value
      ? this.levelRank >= 3 ? `\n${this.renderDetail(value)}` : `  ${value}`
      : '';
    this.status.write(`${badge(tone, Boolean(this.status.isTTY))}  ${title}${renderedDetail}\n`);
    this.start(next);
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

  private renderDetail(value: string): string {
    return this.limitDetail(value)
      .split(/\r?\n/)
      .map((line) => `  ${this.muted(`│ ${line}`, this.status)}`)
      .join('\n');
  }

  private limitDetail(value: string): string {
    const limit = 20_000;
    return value.length <= limit ? value : `${value.slice(0, limit)}\n...[详情已截断，共 ${value.length} 字符]`;
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
