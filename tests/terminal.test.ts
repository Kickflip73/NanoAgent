import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunStreamEvent } from '@openai/agents';
import { parseRunEvent, TerminalRenderer } from '../src/terminal.js';

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
  assert.equal(answer.value, '助手> 流式输出\n');
});
