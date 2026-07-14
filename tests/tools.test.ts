import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import {
  createTools,
  editLocalFile,
  moveLocalFile,
  readLocalFile,
  requestUrl,
  runShellCommand,
  searchLocalFiles,
  writeLocalFile,
} from '../src/tools.js';
import { createRuntimeControlTools, type RuntimeAction } from '../src/runtime/control.js';
import { sessionIdSchema } from '../src/core/session-id.js';

test('uses one Session ID contract across public entry points', () => {
  assert.equal(sessionIdSchema.parse('Archive_2026'), 'Archive_2026');
  assert.throws(() => sessionIdSchema.parse('constructor'), /保留名称/);
  assert.throws(() => sessionIdSchema.parse('../escape'), /字母、数字、下划线和连字符/);
});

test('exposes CLI-equivalent runtime controls to the Agent', async () => {
  const actions: RuntimeAction[] = [];
  const switched: string[] = [];
  const tools = createRuntimeControlTools({
    status: () => ({ model: 'demo-model' }),
    models: () => ['demo-model', 'next-model'],
    modes: () => [{ id: 'ultra', label: 'Ultra Team', description: '大型任务' }],
    switchModel: (model) => { switched.push(`model:${model}`); },
    switchMode: (mode) => { switched.push(`mode:${mode}`); },
    listSessions: () => [{ id: 'demo' }],
    history: async () => [],
    schedule: (action) => actions.push(action),
  });
  const invoke = async (name: string, input: object) => {
    const selected = tools.find((item) => item.name === name);
    if (!selected || !('invoke' in selected)) throw new Error(`工具不可调用：${name}`);
    return selected.invoke(new RunContext({}), JSON.stringify(input));
  };

  assert.deepEqual(tools.map((tool) => tool.name), [
    'runtime_status', 'switch_model', 'switch_mode', 'set_output_level', 'list_sessions',
    'get_session_history', 'switch_session', 'new_session', 'clear_session', 'reload_mcp', 'request_exit',
  ]);
  await invoke('switch_model', { model: 'next-model' });
  await invoke('switch_mode', { mode: 'ultra' });
  await invoke('set_output_level', { level: 'trace' });
  await invoke('switch_session', { sessionId: 'archive' });
  assert.deepEqual(switched, ['model:next-model', 'mode:ultra']);
  assert.deepEqual(actions, [
    { type: 'set_output_level', level: 'trace' },
    { type: 'switch_session', sessionId: 'archive' },
  ]);
});

test('exposes unique tool names for OpenAI and compatible providers', () => {
  for (const openAI of [true, false]) {
    const names = createTools(process.cwd(), openAI).map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes('web_search'));
  }
});

test('does not expose another session unless the user requested session access', async () => {
  const tools = createRuntimeControlTools({
    status: () => ({}), models: () => [], modes: () => [],
    switchModel: () => undefined, switchMode: () => undefined,
    listSessions: () => [{ id: 'private-session', preview: 'PRIVATE_SENTINEL' }],
    history: async () => [], canAccessSessions: () => false,
    schedule: () => undefined,
  });
  const selected = tools.find((item) => item.name === 'list_sessions');
  assert.ok(selected && 'invoke' in selected);
  assert.match(String(await selected.invoke(new RunContext({}), '{}')), /没有要求访问其他 Session/);
});

test('does not let the model clear a Session without explicit user intent', async () => {
  const actions: RuntimeAction[] = [];
  const tools = createRuntimeControlTools({
    status: () => ({}), models: () => [], modes: () => [],
    switchModel: () => undefined, switchMode: () => undefined,
    listSessions: () => [], history: async () => [], canClearSession: () => false,
    schedule: (action) => actions.push(action),
  });
  const selected = tools.find((tool) => tool.name === 'clear_session');
  assert.ok(selected && 'invoke' in selected);
  assert.match(String(await selected.invoke(new RunContext({}), '{}')), /没有明确要求清空/);
  assert.deepEqual(actions, []);
});

test('reads files using relative and absolute paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  const target = path.join(root, 'note.txt');
  await writeFile(target, '你好，Agent');

  assert.equal(await readLocalFile(root, 'note.txt'), '你好，Agent');
  assert.equal(await readLocalFile('/', target), '你好，Agent');
});

test('blocks file and shell tools from reading private NanoAgent runtime data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-private-tools-'));
  const runtime = path.join(root, '.nano-agent');
  await writeFile(path.join(root, 'public.txt'), 'PUBLIC_OK');
  await mkdir(path.join(runtime, 'sessions'), { recursive: true });
  await writeFile(path.join(runtime, 'sessions', 'private.json'), 'PRIVATE_SESSION_SENTINEL');
  const tools = createTools(root, false, [runtime]);
  const invoke = async (name: string, input: object) => {
    const selected = tools.find((item) => item.name === name);
    if (!selected || !('invoke' in selected)) throw new Error(`工具不可调用：${name}`);
    return String(await selected.invoke(new RunContext({}), JSON.stringify(input)));
  };

  assert.match(await invoke('read_file', { path: 'public.txt' }), /PUBLIC_OK/);
  assert.match(await invoke('read_file', { path: '.nano-agent/sessions/private.json' }), /私有运行数据/);
  assert.match(await invoke('search_files', { query: 'PRIVATE', path: '.nano-agent', maxResults: 10 }), /私有运行数据/);
  const shell = await runShellCommand(root, 'cat .nano-agent/sessions/private.json', 5, undefined, [runtime]);
  assert.notEqual(shell.exitCode, 0);
  assert.doesNotMatch(shell.stdout, /PRIVATE_SESSION_SENTINEL/);
});

test('blocks canonical aliases of a symlinked private runtime directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-private-symlink-'));
  const runtime = path.join(root, 'runtime-real');
  await mkdir(path.join(runtime, 'sessions'), { recursive: true });
  await writeFile(path.join(runtime, 'sessions', 'private.json'), 'SECRET_SENTINEL');
  await symlink(runtime, path.join(root, '.nano-agent'));
  const tools = createTools(root, false, [path.join(root, '.nano-agent')]);
  const read = tools.find((item) => item.name === 'read_file');
  assert.ok(read && 'invoke' in read);

  const result = String(await read.invoke(
    new RunContext({}),
    JSON.stringify({ path: 'runtime-real/sessions/private.json' }),
  ));
  assert.match(result, /私有运行数据/);
  assert.doesNotMatch(result, /SECRET_SENTINEL/);
});

test('opens the full shell boundary only after an explicit trusted opt-in', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-trusted-shell-'));
  const runtime = path.join(root, '.nano-agent');
  await mkdir(runtime);
  await writeFile(path.join(runtime, 'trusted.txt'), 'TRUSTED_OK');
  const tools = createTools(root, false, [runtime], {
    allowProtectedPathShellAccess: true,
  });
  const shell = tools.find((item) => item.name === 'run_shell');
  assert.ok(shell && 'invoke' in shell);

  const result = await shell.invoke(
    new RunContext({}),
    JSON.stringify({ command: 'cat .nano-agent/trusted.txt', timeoutSeconds: 5 }),
  );
  assert.match(JSON.stringify(result), /TRUSTED_OK/);
});

test('creates parent directories and writes files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  await writeLocalFile(root, 'output/note.txt', 'done');

  assert.equal(await readFile(path.join(root, 'output/note.txt'), 'utf8'), 'done');
});

test('enforces Team builder write paths and disables unsandboxed Shell', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-scoped-tools-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'nano-scoped-outside-'));
  await mkdir(path.join(root, 'allowed'));
  await symlink(outside, path.join(root, 'allowed', 'escape'));
  const tools = createTools(root, false, [], { writablePaths: ['allowed'], allowShell: false });
  const invoke = async (name: string, input: object) => {
    const selected = tools.find((item) => item.name === name);
    if (!selected || !('invoke' in selected)) throw new Error(`工具不可调用：${name}`);
    return String(await selected.invoke(new RunContext({}), JSON.stringify(input)));
  };

  assert.ok(!tools.some((item) => item.name === 'run_shell'));
  assert.match(await invoke('write_file', { path: 'allowed/ok.txt', content: 'ok' }), /已写入/);
  assert.match(await invoke('write_file', { path: 'not-allowed.txt', content: 'no' }), /超出.*paths/);
  assert.match(await invoke('write_file', { path: path.join(outside, 'absolute.txt'), content: 'no' }), /不能超出当前工作区/);
  assert.match(await invoke('write_file', { path: 'allowed/escape/link.txt', content: 'no' }), /符号链接.*超出/);
  assert.equal(await readFile(path.join(root, 'allowed', 'ok.txt'), 'utf8'), 'ok');
  await assert.rejects(access(path.join(outside, 'link.txt')), /ENOENT/);
});

test('scopes local reads to the workspace and rejects symlink escapes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-scoped-reads-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'nano-scoped-read-outside-'));
  await writeFile(path.join(root, 'inside.txt'), 'INSIDE');
  await writeFile(path.join(outside, 'outside.txt'), 'OUTSIDE');
  await symlink(outside, path.join(root, 'escape'));
  const tools = createTools(root, false, [], {
    readablePaths: ['.'], writablePaths: ['.'], allowShell: false,
  });
  const invoke = async (name: string, input: object) => {
    const selected = tools.find((item) => item.name === name);
    if (!selected || !('invoke' in selected)) throw new Error(`工具不可调用：${name}`);
    return String(await selected.invoke(new RunContext({}), JSON.stringify(input)));
  };

  assert.match(await invoke('read_file', { path: 'inside.txt' }), /INSIDE/);
  assert.match(await invoke('read_file', { path: path.join(outside, 'outside.txt') }), /读取路径不能超出当前工作区/);
  assert.match(await invoke('read_file', { path: 'escape/outside.txt' }), /符号链接.*读取范围/);
  assert.match(await invoke('list_directory', { path: outside }), /读取路径不能超出当前工作区/);
  assert.match(await invoke('search_files', { query: 'OUTSIDE', path: 'escape', maxResults: 10 }), /符号链接.*读取范围/);
});

test('can remove all local mutation and shell tools for read-only runtimes', () => {
  const names = createTools(process.cwd(), false, [], {
    readablePaths: ['.'], writablePaths: [], allowWrite: false, allowShell: false,
  }).map((tool) => tool.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('http_get'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('edit_file'));
  assert.ok(!names.includes('move_file'));
  assert.ok(!names.includes('run_shell'));
});

test('edits, searches and moves local files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  await writeFile(path.join(root, 'note.txt'), 'NanoAgent uses TypeScript.');

  assert.deepEqual(
    await editLocalFile(root, 'note.txt', 'TypeScript', 'Node.js'),
    { path: path.join(root, 'note.txt'), replacements: 1 },
  );
  const matches = await searchLocalFiles(root, 'Node.js');
  assert.equal(matches[0]?.path, 'note.txt');
  assert.equal(matches[0]?.line, 1);
  assert.deepEqual(
    await moveLocalFile(root, 'note.txt', 'docs/moved.txt'),
    { from: path.join(root, 'note.txt'), to: path.join(root, 'docs/moved.txt') },
  );
  assert.equal(await readFile(path.join(root, 'docs/moved.txt'), 'utf8'), 'NanoAgent uses Node.js.');
});

test('serializes concurrent edits without losing either mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-edit-lock-'));
  await writeFile(path.join(root, 'note.txt'), 'alpha beta');

  await Promise.all([
    editLocalFile(root, 'note.txt', 'alpha', 'ALPHA'),
    editLocalFile(root, 'note.txt', 'beta', 'BETA'),
  ]);

  assert.equal(await readFile(path.join(root, 'note.txt'), 'utf8'), 'ALPHA BETA');
});

test('bounds local reads and recursive search work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-tool-limits-'));
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(200_001));
  await assert.rejects(readLocalFile(root, 'large.txt'), /200000 字节限制/);
  await assert.rejects(searchLocalFiles(root, 'x', '.', 10, undefined, { maxScannedEntries: 1 }), /扫描项超过 1/);
  const controller = new AbortController();
  controller.abort(new Error('search cancelled'));
  await assert.rejects(searchLocalFiles(root, 'x', '.', 10, controller.signal), /search cancelled/);
});

test('sends HTTP requests with the dedicated tool helper', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ method: request.method, ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const result = await requestUrl(`http://127.0.0.1:${address.port}/health`, 'GET', {}, undefined, 5);
    assert.equal(result.status, 200);
    assert.match(result.body, /"ok":true/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('streams and truncates oversized HTTP responses', async () => {
  const server = createServer((_request, response) => response.end('x'.repeat(250_000)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const result = await requestUrl(`http://127.0.0.1:${address.port}/large`, 'GET', {}, undefined, 5);
    assert.match(result.body, /响应已截断/);
    assert.ok(Buffer.byteLength(result.body, 'utf8') < 201_000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('runs shell commands in the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  const result = await runShellCommand(root, 'pwd', 5);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), await realpath(root));
});

test('stops a running shell tool when the Agent task is aborted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-agent-'));
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runShellCommand(root, 'sleep 10', 30, controller.signal);
  setTimeout(() => controller.abort(), 30);
  const result = await running;

  assert.equal(result.exitCode, 1);
  assert.ok(Date.now() - startedAt < 2_000);
});

test('kills background shell children when the Agent task is aborted', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-shell-tree-'));
  const childScript = path.join(root, 'late-write.cjs');
  const marker = path.join(root, 'should-not-exist.txt');
  await writeFile(childScript, "setTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'late'), 250);\n");
  const controller = new AbortController();
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)} ${JSON.stringify(marker)} & wait`;
  const running = runShellCommand(root, command, 30, controller.signal);
  setTimeout(() => controller.abort(new Error('stop tree')), 30);

  const result = await running;
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(result.exitCode, 1);
  await assert.rejects(access(marker), /ENOENT/);
});
