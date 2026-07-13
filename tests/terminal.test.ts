import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunStreamEvent } from '@openai/agents';
import { parseRunEvent, renderBanner, renderMarkdownLine, TerminalRenderer } from '../src/terminal.js';

class BufferWriter {
  isTTY = false;
  value = '';

  write(chunk: string): void {
    this.value += chunk;
  }
}

test('parses text and DeepSeek reasoning deltas', () => {
  const text = {
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '你好' },
  } as RunStreamEvent;
  const reasoning = {
    type: 'raw_model_stream_event',
    data: {
      type: 'model',
      event: { choices: [{ delta: { reasoning_content: '分析中' } }] },
    },
  } as RunStreamEvent;

  assert.deepEqual(parseRunEvent(text), { kind: 'answer', text: '你好' });
  assert.deepEqual(parseRunEvent(reasoning), {
    kind: 'reasoning',
    text: '分析中',
  });
});

test('renders non-TTY status and streamed answer without ANSI animation', () => {
  const status = new BufferWriter();
  const answer = new BufferWriter();
  const renderer = new TerminalRenderer(status, answer);

  renderer.start();
  renderer.handle({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '流式' },
  } as RunStreamEvent);
  renderer.handle({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '输出' },
  } as RunStreamEvent);
  renderer.finish();

  assert.match(status.value, /^\[运行\] 模型思考中\n/);
  assert.doesNotMatch(status.value, /\x1b/);
  assert.match(status.value, /✓ 完成/);
  assert.equal(answer.value, '\n◆ 回答\n流式输出\n');
});

test('renders common Markdown as readable terminal text', () => {
  const state = { code: false };
  assert.equal(renderMarkdownLine('### 配置说明', false, state), '  配置说明');
  assert.equal(renderMarkdownLine('- **模型**: `gpt-5`', false, state), '• 模型: gpt-5');
  assert.equal(renderMarkdownLine('[文档](https://example.com)', false, state), '文档 (https://example.com)');
  assert.equal(renderMarkdownLine('```ts', false, state), '  ┌─ ts');
  assert.equal(renderMarkdownLine('const ok = true;', false, state), '  │ const ok = true;');
  assert.equal(renderMarkdownLine('```', false, state), '  └─');
});

test('separates event blocks and uses subtle ANSI badges in a TTY', () => {
  const status = new BufferWriter();
  const answer = new BufferWriter();
  status.isTTY = true;
  answer.isTTY = true;
  const renderer = new TerminalRenderer(status, answer);

  renderer.start();
  renderer.handle({
    type: 'run_item_stream_event',
    name: 'tool_called',
    item: { rawItem: { name: 'read_file', arguments: '{"path":"README.md"}' } },
  } as unknown as RunStreamEvent);
  renderer.handle({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '### 结果\n\n- **完成**' },
  } as RunStreamEvent);
  renderer.finish();

  assert.match(status.value, /\x1b\[38;2;93;170;160m/);
  assert.match(answer.value, /\x1b\[38;2;157;142;198m/);
  assert.doesNotMatch(answer.value, /###|\*\*/);
  const plain = answer.value.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /结果\n\n•/);
});

test('flushes a one-line answer incrementally before completion', async () => {
  const status = new BufferWriter();
  const answer = new BufferWriter();
  status.isTTY = true;
  answer.isTTY = true;
  const renderer = new TerminalRenderer(status, answer);

  renderer.start();
  renderer.handle({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '这是一段没有换行的流式回答' },
  } as RunStreamEvent);
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.match(answer.value, /这是一段没有换行的流式回答/);
  renderer.stop();
});

test('renders a compact robot banner without ANSI in plain output', () => {
  const banner = renderBanner({
    version: '0.5.0',
    provider: 'deepseek',
    model: 'deepseek-chat',
    sessionTitle: '优化终端交互',
    workspaceRoot: '/tmp/NanoAgent',
    skillCount: 2,
    mcpServers: ['filesystem'],
  }, false);

  assert.match(banner, /◉ ◉/);
  assert.match(banner, /NanoAgent/);
  assert.match(banner, /优化终端交互/);
  assert.doesNotMatch(banner, /\x1b/);
});
