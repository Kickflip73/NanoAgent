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
