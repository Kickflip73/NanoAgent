import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { InteractiveTerminal } from '../src/interactive.js';

class FakeInput extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
}

class FakeOutput extends PassThrough {
  isTTY = true;
  columns = 52;
  value = '';

  override write(chunk: string | Uint8Array): boolean {
    this.value += chunk.toString();
    return true;
  }
}

test('shows slash commands, navigates them and completes with tab', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([
    { value: '/status', description: '状态' },
    { value: '/new', description: '新对话' },
  ], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  const initial = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(initial, /┊ >/);
  assert.doesNotMatch(initial, /你>/);

  input.emit('keypress', '/', { sequence: '/' });
  assert.match(output.value, /\/status/);
  assert.match(output.value, /\/new/);
  assert.match(output.value, /\x1b\[38;2;0;0;0m›/);
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '\t', { name: 'tab' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['/new']);
  terminal.close();
});

test('keeps queue and animated runtime status above the bottom input box', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 100;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.setRuntimeStatus({ mode: '编码', model: 'deepseek-chat', contextUsed: 1200, contextWindow: 128000 });
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  terminal.setBusy(true);
  output.value = '';
  terminal.setQueue([
    '排队中的第一条对话内容',
    '这是一条非常长的排队消息，需要在终端宽度之外使用省略号隐藏多出的内容以保持单行展示，而且无论继续补充多少文字都不能换行破坏底部区域',
  ]);

  const plain = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /↳ 排队  排队中的第一条对话内容\n↳ 排队.*\.\.\.\n⠋ 运行中 · 模式 编码 · 模型 deepseek-chat · 上下文 1\.2k\/128k\n┊ >/);
  output.value = '';
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.match(output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), /⠙ 运行中/);
  terminal.close();
});

test('selects a conversation with arrow keys and enter', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const selected = terminal.select([
    { value: 'first', label: '第一个对话' },
    { value: 'second', label: '第二个对话', detail: '最近内容' },
  ]);

  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '\r', { name: 'return' });
  assert.equal(await selected, 'second');
  terminal.close();
});

test('records submitted user input as a permanent conversation line', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  terminal.recordInput('  帮我检查\n当前项目  ');
  const plain = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /> 帮我检查 当前项目\n/);
  assert.match(plain, /◇ 就绪.*\n┊ >/);
  terminal.close();
});
