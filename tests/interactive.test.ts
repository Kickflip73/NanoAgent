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
  assert.match(initial, /┊>/);
  assert.doesNotMatch(initial, /你>/);

  input.emit('keypress', '/', { sequence: '/' });
  assert.match(output.value, /\/status/);
  assert.match(output.value, /\/new/);
  assert.match(output.value, /\x1b\[96m›/);
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '\t', { name: 'tab' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['/new']);
  terminal.close();
});

test('runs the highlighted slash command directly with enter', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([
    { value: '/status', description: '状态' },
    { value: '/new', description: '新对话' },
  ], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  input.emit('keypress', '/', { sequence: '/' });
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['/new']);
  terminal.close();
});

test('cycles mode with shift+tab without changing the input', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  let cycles = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: (line) => lines.push(line),
    onEscape: () => undefined,
    onExit: () => undefined,
    onModeCycle: () => { cycles += 1; },
  });

  input.emit('keypress', '', { name: 'tab', shift: true, sequence: '\x1b[Z' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.equal(cycles, 1);
  assert.deepEqual(lines, []);
  terminal.close();
});

test('keeps pasted newlines in the editor until a manual enter submits', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  input.emit('data', Buffer.from('\x1b[200~第一行\n第二行\x1b[201~'));
  assert.deepEqual(lines, []);
  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(plain, /┊> 第一行\n┊  第二行/);

  await Promise.resolve();
  input.emit('keypress', '\r', { name: 'return' });
  assert.deepEqual(lines, ['第一行\n第二行']);
  terminal.close();
});

test('supports shift-enter newlines and command-arrow line jumps', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  for (const character of 'abc') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '\r', { name: 'return', shift: true });
  for (const character of 'xyz') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '', { name: 'left', meta: true, sequence: '\x1b[1;9D' });
  input.emit('keypress', '>', { sequence: '>' });
  input.emit('keypress', '', { name: 'right', meta: true, sequence: '\x1b[1;9C' });
  input.emit('keypress', '<', { sequence: '<' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['abc\n>xyz<']);
  terminal.close();
});

test('clears editable input with double escape without cancelling the active task', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  let escapes = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: (line) => lines.push(line),
    onEscape: () => { escapes += 1; },
    onExit: () => undefined,
  });

  for (const character of '需要清空') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '', { name: 'escape' });
  input.emit('keypress', '', { name: 'escape' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.equal(escapes, 0);
  assert.deepEqual(lines, []);
  terminal.close();
});

test('preserves the single escape action after the double-escape window', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let escapes = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({
    onLine: () => undefined,
    onEscape: () => { escapes += 1; },
    onExit: () => undefined,
  });

  input.emit('keypress', '草', { sequence: '草' });
  input.emit('keypress', '', { name: 'escape' });
  await new Promise((resolve) => setTimeout(resolve, 380));

  assert.equal(escapes, 1);
  terminal.close();
});

test('keeps editable input history isolated by session', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.useSession('first');
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  for (const character of 'first message') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '\r', { name: 'return' });
  terminal.useSession('second');
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '\r', { name: 'return' });
  for (const character of 'second message') input.emit('keypress', character, { sequence: character });
  input.emit('keypress', '\r', { name: 'return' });
  terminal.useSession('first');
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['first message', 'second message', 'first message']);
  terminal.close();
});

test('continues browsing history when a recalled entry matches slash command suggestions', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([
    { value: '/help', description: '帮助' },
    { value: '/history', description: '历史' },
  ], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });

  for (const value of ['普通历史', '/help']) {
    for (const character of value) input.emit('keypress', character, { sequence: character });
    input.emit('keypress', '\r', { name: 'return' });
  }
  output.value = '';
  input.emit('keypress', '', { name: 'up' });
  assert.doesNotMatch(output.value, /帮助|历史/);
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '\r', { name: 'return' });

  assert.deepEqual(lines, ['普通历史', '/help', '普通历史']);
  terminal.close();
});

test('keeps queue and static runtime status above the bottom input box', async () => {
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
  assert.match(plain, /↳ 排队  排队中的第一条对话内容\n↳ 排队.*\.\.\.\n● 运行中 · 模式 编码 · 模型 deepseek-chat · 上下文 1\.2k\/128k\n┊>/);
  output.value = '';
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(output.value, '');
  terminal.close();
});

test('keeps the input cursor away from the right edge for IME composition', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 32;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  for (const character of 'a'.repeat(80)) input.emit('keypress', character, { sequence: character });

  const cursorColumns = [...output.value.matchAll(/\x1b\[(\d+)C/g)]
    .map((match) => Number(match[1]));
  assert.ok(cursorColumns.length > 0);
  assert.ok(cursorColumns.every((column) => column <= 16));
  terminal.close();
});

test('soft-wraps long editable input to the current terminal width', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 32;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });

  for (const character of 'abcdefghijklmnopqrst') input.emit('keypress', character, { sequence: character });
  output.value = '';
  terminal.setRuntimeStatus({ mode: '标准', model: 'test', contextUsed: 0, contextWindow: 0 });

  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(plain, /┊> abcdefghijklm\n┊  nopqrst/);
  assert.match(output.value, /\x1b\[10C$/);

  output.value = '';
  output.columns = 52;
  output.emit('resize');
  const resized = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(resized, /┊> abcdefghijklmnopqrst/);
  assert.doesNotMatch(resized, /┊  nopqrst/);
  terminal.close();
});

test('uses a readable fallback width while the TTY reports zero columns', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 0;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  for (const character of 'abcdefghijklmnopqrstuvwxyz') {
    input.emit('keypress', character, { sequence: character });
  }

  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(plain, /┊> abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(plain, /\n┊  /);
  terminal.close();
});

test('wraps wide characters without splitting explicit input lines', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 32;
  const lines: string[] = [];
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: (line) => lines.push(line), onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  input.emit('data', Buffer.from('\x1b[200~甲乙丙丁戊己庚\n辛壬癸\x1b[201~'));

  const plain = output.value.replace(/\x1b\[[?0-9;]*[A-Za-z~]/g, '');
  assert.match(plain, /┊> 甲乙丙丁戊己\n┊  庚\n┊  辛壬癸/);
  await Promise.resolve();
  input.emit('keypress', '\r', { name: 'return' });
  assert.deepEqual(lines, ['甲乙丙丁戊己庚\n辛壬癸']);
  terminal.close();
});

test('shows the current plan above the input and collapses it after completion', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 44;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  output.value = '';

  terminal.setTasks([
    { id: 'inspect', description: '检查现有任务规划和终端渲染机制', status: 'completed' },
    { id: 'build', description: '实现一个非常长的任务进度展示区域并确保内容不会破坏输入框布局', status: 'running' },
    { id: 'test', description: '运行完整测试', status: 'pending' },
  ]);
  let plain = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /任务 1\/3\n/);
  assert.doesNotMatch(plain, /当前：/);
  assert.match(plain, /✓ 检查现有任务规划和终端渲染机制/);
  assert.match(plain, /● 实现一个非常长的任务进度展示区域.*\.\.\./);
  assert.match(plain, /○ 运行完整测试/);
  assert.ok(plain.indexOf('○ 运行完整测试') < plain.indexOf('◇ 就绪'));
  assert.ok(plain.indexOf('◇ 就绪') < plain.indexOf('┊>'));

  output.value = '';
  terminal.setTasks([
    { id: 'inspect', description: '检查机制', status: 'completed' },
    { id: 'build', description: '实现任务面板', status: 'completed' },
  ]);
  plain = output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(plain, /✓ 任务 2\/2 · 已全部完成/);
  assert.doesNotMatch(plain, /●|○/);
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

test('cancels an active selection when the terminal closes', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const selected = terminal.select([{ value: 'history', label: '历史对话' }]);

  terminal.close();

  assert.equal(await selected, undefined);
});

test('keeps every selection item on one terminal row and truncates overflow', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 24;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const selected = terminal.select([
    { value: 'first', label: '很长的第一个对话标题', detail: '这是一段同样很长的最近内容预览' },
    { value: 'second', label: '第二个对话', detail: '另一段很长的最近内容预览' },
  ]);
  output.value = '';

  input.emit('keypress', '', { name: 'down' });

  const cursorUps = output.value.match(/\x1b\[1A/g) ?? [];
  assert.equal(cursorUps.length, 4, 'header, two items, status and input must each occupy one row');
  assert.match(output.value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), /\.\.\./);
  assert.doesNotMatch(output.value, /这是一段同样很长的最近内容预览/);
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
  assert.match(output.value, /\x1b\[96m▸\x1b\[0m\x1b\[100;97m 帮我检查 当前项目 \x1b\[0m/);
  assert.match(plain, /▸ 帮我检查 当前项目 \n/);
  assert.match(plain, /◇ 就绪.*\n┊>/);
  terminal.close();
});

test('appends streamed chunks at the real text column without padding to the terminal edge', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  output.columns = 120;
  const terminal = new InteractiveTerminal([], input as never, output as never);
  terminal.start({ onLine: () => undefined, onEscape: () => undefined, onExit: () => undefined });
  const writer = terminal.createWriter(output as never);
  output.value = '';

  writer.write('从此');
  writer.write(' 7×24 自动接单');

  assert.doesNotMatch(output.value, /\x1b\[999C/);
  assert.match(output.value, /\x1b\[1A\r\x1b\[4C/);
  terminal.close();
});
