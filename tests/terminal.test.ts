import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentInputItem, RunStreamEvent } from '@openai/agents';
import { parseRunEvent, renderBanner, renderMarkdownLine, renderRecoveryCheckpoint, renderSessionTranscript, TerminalRenderer, type OutputLevel } from '../src/terminal.js';

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
  assert.equal(renderMarkdownLine('风向 |          东南风，2~5级', false, state), '风向 | 东南风，2~5级');
});

test('collapses repeated blank lines in streamed terminal answers', () => {
  const status = new BufferWriter();
  const answer = new BufferWriter();
  const renderer = new TerminalRenderer(status, answer);
  renderer.start();
  renderer.handle({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '第一段\n\n\n\n第二段\n' },
  } as RunStreamEvent);
  renderer.finish();

  assert.match(answer.value, /第一段\n\n第二段/);
  assert.doesNotMatch(answer.value, /第一段\n{3,}第二段/);
});

test('separates event blocks and uses semantic ANSI event colors in a TTY', () => {
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

  assert.match(status.value, /\x1b\[96m● 工具\x1b\[0m  read_file/);
  assert.match(answer.value, /\x1b\[95m◆ 回答\x1b\[0m/);
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

test('does not repeat the code gutter when one source line arrives in delayed chunks', async () => {
  const status = new BufferWriter();
  const answer = new BufferWriter();
  answer.isTTY = true;
  const renderer = new TerminalRenderer(status, answer);

  renderer.start();
  renderer.handle({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '```js\nconst store = require("./main' },
  } as RunStreamEvent);
  await new Promise((resolve) => setTimeout(resolve, 60));
  renderer.handle({
    type: 'raw_model_stream_event',
    data: { type: 'output_text_delta', delta: '/store.js");\n```\n' },
  } as RunStreamEvent);
  renderer.finish();

  const plain = answer.value.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /│ const store = require\("\.\/main\/store\.js"\);/);
  assert.doesNotMatch(plain, /main\s+│\s+\/store/);
  assert.equal((plain.match(/│/g) ?? []).length, 1);
});

test('keeps TTY run status static instead of redrawing during IME input', async () => {
  const status = new BufferWriter();
  status.isTTY = true;
  const renderer = new TerminalRenderer(status, new BufferWriter());

  renderer.start();
  status.value = '';
  await new Promise((resolve) => setTimeout(resolve, 90));

  assert.equal(status.value, '');
  renderer.stop();
});

test('renders a compact project banner without ANSI in plain output', () => {
  const banner = renderBanner({
    version: '0.5.0',
    provider: 'deepseek',
    model: 'deepseek-chat',
    sessionTitle: '优化终端交互',
    workspaceRoot: '/tmp/MimiAgent',
    skillCount: 2,
    mcpServers: ['filesystem'],
  }, false);

  assert.match(banner, /^MimiAgent v0\.5\.0\n全天候个人 Agent\n模型/m);
  assert.match(banner, /优化终端交互/);
  assert.doesNotMatch(banner, /◉|╭|Esc/);
  assert.doesNotMatch(banner, /\x1b/);
});

test('renders a recoverable session checkpoint', () => {
  const checkpoint = renderRecoveryCheckpoint({
    runId: 'run-1',
    status: 'interrupted',
    input: '继续开发',
    phase: '正在执行 read_file',
    lastEvent: 'src/core/context.ts',
    startedAt: '',
    updatedAt: '',
  }, false);
  assert.match(checkpoint, /^↻ 可恢复/);
  assert.match(checkpoint, /read_file.*context\.ts.*\/resume 继续/);
});

test('replays persisted user and assistant messages in chronological order', () => {
  const transcript = renderSessionTranscript([
    { type: 'message', role: 'user', content: '第一条问题' },
    { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
    { type: 'function_call_result', callId: 'call-1', name: 'read_file', status: 'completed', output: 'secret tool output' },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '### 第一条回答\n\n- 已完成' }],
    },
    { type: 'message', role: 'user', content: '最新问题' },
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '最新回答' }],
    },
  ] as AgentInputItem[], false);

  assert.match(transcript, /^▸ 第一条问题/m);
  assert.match(transcript, /◆ 回答\n\s*第一条回答\n\n• 已完成/);
  assert.ok(transcript.indexOf('第一条问题') < transcript.indexOf('最新问题'));
  assert.ok(transcript.indexOf('最新问题') < transcript.indexOf('最新回答'));
  assert.doesNotMatch(transcript, /secret tool output|###/);

  const styled = renderSessionTranscript([
    { type: 'message', role: 'user', content: '带样式的历史输入' },
  ] as AgentInputItem[], true);
  assert.match(styled, /^\x1b\[96m▸\x1b\[0m\x1b\[100;97m 带样式的历史输入 \x1b\[0m$/);
});

test('filters execution events by output level', () => {
  const render = (level: OutputLevel, tty = false) => {
    const status = new BufferWriter();
    const answer = new BufferWriter();
    status.isTTY = tty;
    answer.isTTY = tty;
    const renderer = new TerminalRenderer(status, answer, level);
    renderer.start('模型思考中', '读取 README.md 并总结');
    renderer.handle({
      type: 'raw_model_stream_event',
      data: { type: 'model', event: { choices: [{ delta: { reasoning_content: '需要先读取文件' } }] } },
    } as unknown as RunStreamEvent);
    renderer.handle({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { rawItem: { name: 'read_file', arguments: '{"path":"README.md"}' } },
    } as unknown as RunStreamEvent);
    renderer.handle({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: { rawItem: { name: 'read_file' }, output: 'MimiAgent 文件正文' },
    } as unknown as RunStreamEvent);
    renderer.handle({
      type: 'raw_model_stream_event',
      data: { type: 'output_text_delta', delta: '总结完成' },
    } as RunStreamEvent);
    renderer.finish();
    return { status: status.value, answer: answer.value };
  };

  const answer = render('answer');
  assert.equal(answer.status, '');
  assert.equal(answer.answer, '总结完成\n');

  const thinking = render('thinking');
  assert.match(thinking.status, /需要先读取文件/);
  assert.doesNotMatch(thinking.status, /read_file|README\.md/);

  const tools = render('tools');
  assert.match(tools.status, /read_file/);
  assert.match(tools.status, /● 工具  read_file  \{"path":"README\.md"\}/);
  assert.match(tools.status, /└ 结果  read_file  MimiAgent 文件正文/);

  const trace = render('trace');
  assert.match(trace.status, /读取 README\.md 并总结/);
  assert.match(trace.status, /\{"path":"README\.md"\}/);
  assert.match(trace.status, /MimiAgent 文件正文/);

  const colored = render('trace', true);
  assert.match(colored.status, /\x1b\[90m◆ Agent\x1b\[0m/);
  assert.match(colored.status, /\x1b\[94m✦ 思考\x1b\[0m/);
  assert.match(colored.status, /\x1b\[96m● 工具\x1b\[0m/);
  assert.match(colored.status, /\x1b\[92m└ 结果\x1b\[0m/);
  assert.match(colored.answer, /\x1b\[95m◆ 回答\x1b\[0m/);
  assert.match(colored.status, /\x1b\[92m✓ 完成\x1b\[0m/);
});

test('truncates long tool result summaries with three dots', () => {
  const event = parseRunEvent({
    type: 'run_item_stream_event',
    name: 'tool_output',
    item: { rawItem: { name: 'read_file' }, output: `文件开头-${'内容'.repeat(100)}-文件结尾` },
  } as unknown as RunStreamEvent);

  assert.equal(event?.kind, 'status');
  if (event?.kind !== 'status') return;
  assert.equal(event.detail?.length, 120);
  assert.match(event.detail ?? '', /^文件开头-/);
  assert.match(event.detail ?? '', /\.\.\.$/);
  assert.doesNotMatch(event.detail ?? '', /文件结尾/);
});

test('renders Ultra Team worker assignments and results as lifecycle events', () => {
  const status = new BufferWriter();
  status.isTTY = true;
  const renderer = new TerminalRenderer(status, new BufferWriter(), 'tools');
  renderer.handleRuntimeEvent({
    type: 'team_worker_event', sessionId: 'demo', taskId: 'inspect', role: 'explorer',
    description: '检查会话状态隔离实现', eventType: 'start',
  });
  renderer.handleRuntimeEvent({
    type: 'team_worker_event', sessionId: 'demo', taskId: 'inspect', role: 'explorer',
    description: '检查会话状态隔离实现', result: '确认 mode、model 和输出等级均按会话恢复', eventType: 'end',
  });
  renderer.handleRuntimeEvent({
    type: 'team_worker_event', sessionId: 'demo', taskId: 'test', role: 'tester',
    description: '运行测试', result: 'npm test 失败', eventType: 'error',
  });
  renderer.stop();

  assert.match(status.value, /\x1b\[90m◆ Agent\x1b\[0m  子代理 explorer · inspect  分配任务：检查会话状态隔离实现/);
  assert.match(status.value, /\x1b\[92m└ 结果\x1b\[0m  子代理 explorer · inspect  完成：确认 mode、model 和输出等级均按会话恢复/);
  assert.match(status.value, /\x1b\[91m× 失败\x1b\[0m  子代理 tester · test  失败：npm test 失败/);
});
