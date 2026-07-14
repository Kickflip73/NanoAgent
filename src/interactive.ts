import readline from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';

export interface CompletionItem {
  value: string;
  description: string;
}

export interface SelectItem {
  value: string;
  label: string;
  detail?: string;
}

export interface RuntimeStatus {
  mode: string;
  model: string;
  contextUsed: number;
  contextWindow: number;
}

type Key = { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string };

const clearLine = '\r\x1b[2K';
const selectionCursor = '\x1b[38;2;0;0;0m›\x1b[0m';

function displayWidth(value: string): number {
  const plain = value.replace(/\x1b\[[0-9;]*m/g, '');
  return Array.from(plain).reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const wide = codePoint >= 0x1f300 || /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(character);
    return width + (wide ? 2 : 1);
  }, 0);
}

export class InteractiveTerminal {
  private buffer: string[] = [];
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private completionIndex = 0;
  private busy = false;
  private transient = '';
  private runtime: RuntimeStatus = { mode: '标准', model: '未配置', contextUsed: 0, contextWindow: 0 };
  private statusFrame = 0;
  private statusTimer?: NodeJS.Timeout;
  private queued: string[] = [];
  private outputOpen = false;
  private outputOpenWidth = 0;
  private renderedRows = 0;
  private started = false;
  private closed = false;
  private selectState?: {
    items: SelectItem[];
    index: number;
    title: string;
    resolve: (value?: string) => void;
  };

  constructor(
    private readonly completions: CompletionItem[],
    private readonly input: ReadStream = process.stdin,
    private readonly output: WriteStream = process.stdout,
  ) {}

  start(handlers: { onLine: (line: string) => void; onEscape: () => void; onExit: () => void }): void {
    this.started = true;
    readline.emitKeypressEvents(this.input);
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on('keypress', (text: string, key: Key) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
        handlers.onExit();
        return;
      }
      if (this.selectState) {
        this.handleSelection(key);
        return;
      }
      if (key.name === 'escape') {
        handlers.onEscape();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        const line = this.buffer.join('').trim();
        this.eraseUi();
        this.output.write('\n');
        this.outputOpen = false;
        this.buffer = [];
        this.cursor = 0;
        this.completionIndex = 0;
        if (line) {
          this.history.push(line);
          this.historyIndex = this.history.length;
        }
        this.draw();
        if (line) handlers.onLine(line);
        return;
      }
      if (key.name === 'tab' && this.suggestions.length) {
        this.setBuffer(`${this.suggestions[this.completionIndex]?.value ?? ''} `);
        return;
      }
      if ((key.name === 'up' || key.name === 'down') && this.suggestions.length) {
        const direction = key.name === 'up' ? -1 : 1;
        this.completionIndex = (this.completionIndex + direction + this.suggestions.length) % this.suggestions.length;
        this.redraw();
        return;
      }
      if (key.name === 'up' || key.name === 'down') {
        if (!this.history.length) return;
        this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
        this.setBuffer(this.history[this.historyIndex] ?? '');
        return;
      }
      if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
      else if (key.name === 'right') this.cursor = Math.min(this.buffer.length, this.cursor + 1);
      else if (key.name === 'backspace' && this.cursor > 0) {
        this.buffer.splice(--this.cursor, 1);
        this.completionIndex = 0;
      } else if (key.name === 'delete' && this.cursor < this.buffer.length) {
        this.buffer.splice(this.cursor, 1);
        this.completionIndex = 0;
      } else if (text && !key.ctrl && text >= ' ') {
        this.buffer.splice(this.cursor, 0, ...Array.from(text));
        this.cursor += Array.from(text).length;
        this.completionIndex = 0;
      } else return;
      this.redraw();
    });
    this.draw();
  }

  createWriter(stream: WriteStream): { isTTY: boolean; write: (chunk: string) => void } {
    return { isTTY: Boolean(stream.isTTY), write: (chunk) => this.write(chunk, stream) };
  }

  write(chunk: string, stream: WriteStream = this.output): void {
    if (this.closed) return;
    if (chunk.startsWith(clearLine) && !chunk.includes('\n')) {
      const plain = chunk.slice(clearLine.length).replace(/\x1b\[[0-9;]*m/g, '').trim();
      this.transient = chunk === clearLine ? '' : plain.replace(/^\S+\s*/, '');
      this.redraw();
      return;
    }
    this.eraseUi();
    const wasOpen = this.outputOpen;
    if (wasOpen) {
      const width = Math.max(1, this.output.columns ?? 80);
      const column = this.outputOpenWidth % width;
      this.output.write(`\x1b[1A\r${column ? `\x1b[${column}C` : ''}`);
    }
    stream.write(chunk);
    this.outputOpen = !chunk.endsWith('\n');
    if (this.outputOpen) {
      const lastLine = chunk.slice(Math.max(chunk.lastIndexOf('\n'), chunk.lastIndexOf('\r')) + 1);
      this.outputOpenWidth = (wasOpen && !chunk.includes('\n') ? this.outputOpenWidth : 0) + displayWidth(lastLine);
      this.output.write('\n');
    } else {
      this.outputOpenWidth = 0;
    }
    this.draw();
  }

  notify(message: string): void {
    this.write(`${message}\n`);
  }

  recordInput(input: string): void {
    const text = input.replace(/\x1b/g, '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const marker = this.output.isTTY ? '\x1b[38;2;148;166;173m>\x1b[0m' : '>';
    this.write(`${marker} ${text}\n`);
  }

  setBusy(value: boolean): void {
    if (this.busy === value) return;
    this.busy = value;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    if (value) {
      this.statusTimer = setInterval(() => {
        this.statusFrame += 1;
        this.redraw();
      }, 80);
      this.statusTimer.unref();
    } else {
      this.transient = '';
      this.statusFrame = 0;
    }
    this.redraw();
  }

  setRuntimeStatus(status: RuntimeStatus): void {
    this.runtime = status;
    this.redraw();
  }

  setQueue(items: string[]): void {
    this.queued = [...items];
    this.redraw();
  }

  clearScreen(content = ''): void {
    this.outputOpen = false;
    this.outputOpenWidth = 0;
    this.output.write('\x1b[2J\x1b[H');
    if (content) this.output.write(`${content}\n\n`);
    this.draw();
  }

  async select(items: SelectItem[], title = '选择'): Promise<string | undefined> {
    if (!items.length) return undefined;
    this.eraseUi();
    return new Promise((resolve) => {
      this.selectState = { items, index: 0, title, resolve };
      this.draw();
    });
  }

  close(): void {
    if (this.closed) return;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.eraseUi();
    this.closed = true;
    this.output.write('\n');
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
  }

  private get suggestions(): CompletionItem[] {
    const value = this.buffer.join('');
    if (!value.startsWith('/') || value.includes(' ')) return [];
    return this.completions.filter((item) => item.value.startsWith(value));
  }

  private handleSelection(key: Key): void {
    const state = this.selectState!;
    if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'up' ? -1 : 1;
      state.index = (state.index + direction + state.items.length) % state.items.length;
      this.redraw();
      return;
    }
    if (key.name !== 'return' && key.name !== 'enter' && key.name !== 'escape') return;
    const value = key.name === 'escape' ? undefined : state.items[state.index]?.value;
    this.eraseUi();
    this.selectState = undefined;
    state.resolve(value);
    this.draw();
  }

  private setBuffer(value: string): void {
    this.buffer = Array.from(value);
    this.cursor = this.buffer.length;
    this.completionIndex = 0;
    this.redraw();
  }

  private redraw(): void {
    if (this.closed || !this.started) return;
    this.eraseUi();
    this.draw();
  }

  private eraseUi(): void {
    if (this.closed || !this.started) return;
    this.output.write(clearLine);
    for (let row = 1; row < this.renderedRows; row += 1) this.output.write('\x1b[1A\r\x1b[2K');
    this.renderedRows = 0;
  }

  private draw(): void {
    if (this.closed || !this.started) return;
    const rows: string[] = [];
    rows.push(...this.queued.map((item) => `\x1b[2m↳ 排队  ${this.compactQueueItem(item)}\x1b[0m`));

    if (this.selectState) {
      const state = this.selectState;
      const visible = this.window(state.items, state.index, 7);
      rows.push(`${state.title} · ↑↓ 移动，Enter 确认，Esc 取消`);
      for (const { item, index } of visible) {
        const marker = index === state.index ? selectionCursor : ' ';
        rows.push(`${marker} ${item.label}${item.detail ? `  \x1b[2m${item.detail}\x1b[0m` : ''}`);
      }
      rows.push(this.statusLine());
      const input = this.inputBox();
      rows.push(input.line);
      this.output.write(rows.join('\n'));
      this.renderedRows = rows.length;
      this.output.write(`\r\x1b[${input.cursorColumn}C`);
      return;
    }

    const suggestions = this.suggestions;
    const visible = this.window(suggestions, this.completionIndex, 7);
    for (const { item, index } of visible) {
      const active = index === this.completionIndex;
      rows.push(`${active ? selectionCursor : ' '} ${item.value.padEnd(12)} \x1b[2m${item.description}\x1b[0m`);
    }
    rows.push(this.statusLine());
    const input = this.inputBox();
    rows.push(input.line);
    this.output.write(rows.join('\n'));
    this.renderedRows = rows.length;
    this.output.write(`\r\x1b[${input.cursorColumn}C`);
  }

  private inputBox(): { line: string; cursorColumn: number } {
    const width = Math.max(24, (this.output.columns ?? 80) - 1);
    const prefix = '┊ > ';
    const suffix = ' ┊';
    const available = width - displayWidth(prefix) - displayWidth(suffix);
    let start = this.cursor;
    while (start > 0 && displayWidth(this.buffer.slice(start - 1, this.cursor).join('')) <= available) start -= 1;
    if (displayWidth(this.buffer.slice(start, this.cursor).join('')) > available) start += 1;
    const visible: string[] = [];
    let used = 0;
    for (const character of this.buffer.slice(start)) {
      const characterWidth = displayWidth(character);
      if (used + characterWidth > available) break;
      visible.push(character);
      used += characterWidth;
    }
    const value = visible.join('');
    const padding = ' '.repeat(Math.max(0, available - displayWidth(value)));
    return {
      line: `\x1b[38;2;145;151;158m┊\x1b[0m > ${value}${padding} \x1b[38;2;145;151;158m┊\x1b[0m`,
      cursorColumn: displayWidth(prefix) + displayWidth(this.buffer.slice(start, this.cursor).join('')),
    };
  }

  private compactQueueItem(value: string): string {
    const clean = value.replace(/\s+/g, ' ').trim();
    const width = Math.max(20, (this.output.columns ?? 80) - 14);
    if (displayWidth(clean) <= width) return clean;
    const visible: string[] = [];
    let used = 0;
    for (const character of Array.from(clean)) {
      const characterWidth = displayWidth(character);
      if (used + characterWidth > width - 3) break;
      visible.push(character);
      used += characterWidth;
    }
    return `${visible.join('')}...`;
  }

  private statusLine(): string {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const icon = this.busy ? frames[this.statusFrame % frames.length] : '◇';
    const state = this.busy ? (this.transient || '运行中') : '就绪';
    const model = this.truncateDisplay(this.runtime.model, 24);
    const text = `${icon} ${state} · 模式 ${this.runtime.mode} · 模型 ${model} · 上下文 ${this.formatTokens(this.runtime.contextUsed)}/${this.formatTokens(this.runtime.contextWindow)}`;
    const color = this.busy ? '126;156;196' : '145;151;158';
    return `\x1b[38;2;${color}m${this.truncateDisplay(text, Math.max(24, (this.output.columns ?? 80) - 1))}\x1b[0m`;
  }

  private formatTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
    return String(value);
  }

  private truncateDisplay(value: string, width: number): string {
    if (displayWidth(value) <= width) return value;
    const visible: string[] = [];
    let used = 0;
    for (const character of Array.from(value)) {
      const characterWidth = displayWidth(character);
      if (used + characterWidth > width - 3) break;
      visible.push(character);
      used += characterWidth;
    }
    return `${visible.join('')}...`;
  }

  private window<T>(items: T[], selected: number, size: number): Array<{ item: T; index: number }> {
    const start = Math.max(0, Math.min(selected - Math.floor(size / 2), items.length - size));
    return items.slice(start, start + size).map((item, offset) => ({ item, index: start + offset }));
  }
}
