import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunContext } from '@openai/agents';
import {
  applyLocalPatch,
  createTools,
  editLocalFile,
  inspectWorkspaceChanges,
  moveLocalFile,
  readLocalFile,
  readLocalFileView,
  requestUrl,
  runShellCommand,
  searchLocalFiles,
  searchWorkspaceFiles,
  writeLocalFile,
} from '../src/tools.js';
import { createRuntimeControlTools, type RuntimeAction } from '../src/runtime/control.js';
import { PRE_MIMI_DATA_DIRECTORY } from '../src/core/mimi-legacy.js';
import { sessionIdSchema } from '../src/core/session-id.js';

test('uses one Session ID contract across public entry points', () => {
  assert.equal(sessionIdSchema.parse('Archive_2026'), 'Archive_2026');
  assert.throws(() => sessionIdSchema.parse('constructor'), /保留名称/);
  assert.throws(() => sessionIdSchema.parse('../escape'), /字母、数字、下划线和连字符/);
});

test('exposes CLI-equivalent runtime controls to the Agent', async () => {
  const actions: RuntimeAction[] = [];
  const tools = createRuntimeControlTools({
    status: () => ({ model: 'demo-model' }),
    models: () => ['demo-model', 'next-model'],
    modes: () => [{ id: 'ultra', label: 'Ultra Team', description: '大型任务' }],
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
  const descriptions = tools.map((tool) => (
    'description' in tool && typeof tool.description === 'string' ? tool.description : ''
  )).join('\n');
  assert.match(descriptions, /MimiAgent/);
  assert.deepEqual(await invoke('switch_model', { model: 'next-model' }), {
    model: 'next-model', effective: 'next_turn', available: ['demo-model', 'next-model'],
  });
  assert.deepEqual(await invoke('switch_mode', { mode: 'ultra' }), {
    mode: 'ultra', effective: 'next_turn',
    available: [{ id: 'ultra', label: 'Ultra Team', description: '大型任务' }],
  });
  await invoke('set_output_level', { level: 'trace' });
  await invoke('switch_session', { sessionId: 'archive' });
  assert.deepEqual(actions, [
    { type: 'switch_model', model: 'next-model' },
    { type: 'switch_mode', mode: 'ultra' },
    { type: 'set_output_level', level: 'trace' },
    { type: 'switch_session', sessionId: 'archive' },
  ]);
  assert.match(String(await invoke('switch_model', { model: '../bad model' })), /模型名称格式无效/);
  assert.match(String(await invoke('switch_mode', { mode: 'unknown' })), /未知模式/);
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
    listSessions: () => [], history: async () => [], canClearSession: () => false,
    schedule: (action) => actions.push(action),
  });
  const selected = tools.find((tool) => tool.name === 'clear_session');
  assert.ok(selected && 'invoke' in selected);
  assert.match(String(await selected.invoke(new RunContext({}), '{}')), /没有明确要求清空/);
  assert.deepEqual(actions, []);
});

test('reads files using relative and absolute paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-'));
  const target = path.join(root, 'note.txt');
  await writeFile(target, '你好，Agent');

  assert.equal(await readLocalFile(root, 'note.txt'), '你好，Agent');
  assert.equal(await readLocalFile('/', target), '你好，Agent');
});

test('reads bounded line ranges with stable file metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-read-range-'));
  await writeFile(path.join(root, 'note.txt'), 'one\ntwo\nthree\nfour\n');

  const view = await readLocalFileView(root, 'note.txt', { startLine: 2, maxLines: 2 });
  assert.equal(view.content, 'two\nthree');
  assert.equal(view.startLine, 2);
  assert.equal(view.endLine, 3);
  assert.equal(view.totalLines, 5);
  assert.equal(view.truncated, true);
  assert.match(view.sha256, /^[a-f0-9]{64}$/u);
});

test('blocks file and shell tools from reading private MimiAgent and MimiAgent runtime data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-private-tools-'));
  const legacyRuntime = path.join(root, PRE_MIMI_DATA_DIRECTORY);
  const modernRuntime = path.join(root, '.mimi-agent');
  const customRuntime = path.join(root, 'custom-runtime-data');
  await writeFile(path.join(root, 'public.txt'), 'PUBLIC_OK');
  await mkdir(path.join(legacyRuntime, 'sessions'), { recursive: true });
  await mkdir(path.join(modernRuntime, 'sessions'), { recursive: true });
  await mkdir(customRuntime);
  await writeFile(path.join(legacyRuntime, 'sessions', 'private.json'), 'LEGACY_PRIVATE_SESSION_SENTINEL');
  await writeFile(path.join(modernRuntime, 'sessions', 'private.json'), 'MODERN_PRIVATE_SESSION_SENTINEL');
  await writeFile(path.join(customRuntime, 'private.txt'), 'CUSTOM_PRIVATE_SENTINEL');
  const tools = createTools(root, false, [legacyRuntime, modernRuntime, customRuntime]);
  const invoke = async (name: string, input: object) => {
    const selected = tools.find((item) => item.name === name);
    if (!selected || !('invoke' in selected)) throw new Error(`工具不可调用：${name}`);
    const result = await selected.invoke(new RunContext({}), JSON.stringify(input));
    return typeof result === 'string' ? result : JSON.stringify(result);
  };

  assert.match(await invoke('read_file', { path: 'public.txt' }), /PUBLIC_OK/);
  assert.match(await invoke('read_file', { path: 'public.txt', includeMetadata: true }), /"sha256":"[a-f0-9]{64}"/u);
  assert.match(await invoke('read_file', { path: `${PRE_MIMI_DATA_DIRECTORY}/sessions/private.json` }), /MimiAgent 私有运行数据（含旧目录）/);
  assert.match(await invoke('read_file', { path: '.mimi-agent/sessions/private.json' }), /MimiAgent 私有运行数据（含旧目录）/);
  assert.match(await invoke('search_files', { query: 'PRIVATE', path: PRE_MIMI_DATA_DIRECTORY, maxResults: 10 }), /MimiAgent 私有运行数据（含旧目录）/);
  assert.match(await invoke('search_files', { query: 'PRIVATE', path: '.mimi-agent', maxResults: 10 }), /MimiAgent 私有运行数据（含旧目录）/);
  assert.doesNotMatch(await invoke('search_files', { query: 'CUSTOM_PRIVATE', path: '.', maxResults: 10 }), /CUSTOM_PRIVATE_SENTINEL/u);
  const shell = await runShellCommand(root, `cat ${PRE_MIMI_DATA_DIRECTORY}/sessions/private.json .mimi-agent/sessions/private.json`, 5, undefined, [legacyRuntime, modernRuntime]);
  assert.notEqual(shell.exitCode, 0);
  assert.doesNotMatch(shell.stdout, /PRIVATE_SESSION_SENTINEL/);
});

test('blocks canonical aliases of a symlinked private runtime directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-private-symlink-'));
  const runtime = path.join(root, 'runtime-real');
  await mkdir(path.join(runtime, 'sessions'), { recursive: true });
  await writeFile(path.join(runtime, 'sessions', 'private.json'), 'SECRET_SENTINEL');
  await symlink(runtime, path.join(root, PRE_MIMI_DATA_DIRECTORY));
  const tools = createTools(root, false, [path.join(root, PRE_MIMI_DATA_DIRECTORY)]);
  const read = tools.find((item) => item.name === 'read_file');
  assert.ok(read && 'invoke' in read);

  const result = String(await read.invoke(
    new RunContext({}),
    JSON.stringify({ path: 'runtime-real/sessions/private.json' }),
  ));
  assert.match(result, /MimiAgent 私有运行数据（含旧目录）/);
  assert.doesNotMatch(result, /SECRET_SENTINEL/);
});

test('opens the full shell boundary only after an explicit trusted opt-in', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-trusted-shell-'));
  const runtime = path.join(root, PRE_MIMI_DATA_DIRECTORY);
  await mkdir(runtime);
  await writeFile(path.join(runtime, 'trusted.txt'), 'TRUSTED_OK');
  const tools = createTools(root, false, [runtime], {
    allowProtectedPathShellAccess: true,
  });
  const shell = tools.find((item) => item.name === 'run_shell');
  assert.ok(shell && 'invoke' in shell);

  const result = await shell.invoke(
    new RunContext({}),
    JSON.stringify({ command: `cat ${PRE_MIMI_DATA_DIRECTORY}/trusted.txt`, timeoutSeconds: 5 }),
  );
  assert.match(JSON.stringify(result), /TRUSTED_OK/);
});

test('Shell uses an explicitly isolated environment when provided', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-shell-env-'));
  const result = await runShellCommand(root, 'printf %s "$VISIBLE:$SECRET_TOKEN"', 5, undefined, [], {
    PATH: process.env.PATH,
    VISIBLE: 'yes',
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'yes:');
});

test('Shell rejects commands that intentionally detach work from MimiAgent ownership', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-shell-detach-'));
  for (const command of [
    'nohup long-job > /tmp/job.log 2>&1 &',
    'long-job &',
    'long-job & disown',
    'setsid long-job',
  ]) {
    const result = await runShellCommand(root, command, 5);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /delegate_background_task|后台任务/);
  }
  const foreground = await runShellCommand(root, 'printf ok && printf done', 5);
  assert.equal(foreground.exitCode, 0);
  assert.equal(foreground.stdout, 'okdone');
});

test('creates parent directories and writes files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-'));
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
    const result = await selected.invoke(new RunContext({}), JSON.stringify(input));
    return typeof result === 'string' ? result : JSON.stringify(result);
  };

  assert.ok(!tools.some((item) => item.name === 'run_shell'));
  assert.match(await invoke('write_file', { path: 'allowed/ok.txt', content: 'ok' }), /已写入/);
  assert.match(await invoke('apply_patch', {
    patch: ['--- a/allowed/ok.txt', '+++ b/allowed/ok.txt', '@@ -1 +1 @@', '-ok', '+OK'].join('\n'),
    expectedFiles: [],
  }), /"path":"allowed\/ok\.txt"/u);
  assert.match(await invoke('write_file', { path: 'not-allowed.txt', content: 'no' }), /超出.*paths/);
  assert.match(await invoke('apply_patch', {
    patch: ['--- /dev/null', '+++ b/not-allowed.txt', '@@ -0,0 +1 @@', '+no'].join('\n'),
    expectedFiles: [],
  }), /超出.*paths/);
  assert.match(await invoke('write_file', { path: path.join(outside, 'absolute.txt'), content: 'no' }), /不能超出当前工作区/);
  assert.match(await invoke('write_file', { path: 'allowed/escape/link.txt', content: 'no' }), /符号链接.*超出/);
  assert.equal(await readFile(path.join(root, 'allowed', 'ok.txt'), 'utf8'), 'OK');
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
    const result = await selected.invoke(new RunContext({}), JSON.stringify(input));
    return typeof result === 'string' ? result : JSON.stringify(result);
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
  assert.ok(names.includes('inspect_changes'));
  assert.ok(names.includes('http_get'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('edit_file'));
  assert.ok(!names.includes('apply_patch'));
  assert.ok(!names.includes('move_file'));
  assert.ok(!names.includes('run_shell'));
});

test('keeps HTTP tool schemas portable across OpenAI and Chat Completions providers', () => {
  const tools = createTools(process.cwd(), false, []);
  for (const name of ['http_get', 'http_request']) {
    const selected = tools.find((item) => item.name === name) as { parameters?: unknown } | undefined;
    assert.ok(selected);
    const serialized = JSON.stringify(selected.parameters);
    assert.doesNotMatch(serialized, /"format":"uri"|"propertyNames"/);
    const parameters = selected.parameters as {
      properties?: { headers?: { type?: string; items?: unknown } };
    };
    assert.equal(parameters.properties?.headers?.type, 'array');
    assert.ok(parameters.properties?.headers?.items);
  }
});

test('edits, searches and moves local files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-'));
  await writeFile(path.join(root, 'note.txt'), 'MimiAgent uses TypeScript.');

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
  assert.equal(await readFile(path.join(root, 'docs/moved.txt'), 'utf8'), 'MimiAgent uses Node.js.');
});

test('searches code with regex, globs and bounded context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-search-code-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'agent.ts'), 'before\nexport function runAgent() {}\nafter\n');
  await writeFile(path.join(root, 'src', 'agent.md'), 'runAgent is documented');

  const matches = await searchWorkspaceFiles(root, 'function\\s+runAgent', '.', 20, undefined, {
    regex: true,
    globs: ['**/*.ts'],
    contextLines: 1,
  });
  const content = matches.find((match) => match.match === 'content');
  assert.equal(content?.path, 'src/agent.ts');
  assert.equal(content?.line, 2);
  assert.deepEqual(content?.context?.map((line) => line.line), [1, 2, 3]);
});

test('lists bounded recursive directory entries and filters paths without reading content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-list-code-'));
  await mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await mkdir(path.join(root, '.mimi-agent'), { recursive: true });
  await writeFile(path.join(root, 'src', 'agent.ts'), 'SECRET_CONTENT');
  await writeFile(path.join(root, 'src', 'nested', 'agent.test.ts'), 'SECRET_TEST_CONTENT');
  await writeFile(path.join(root, '.mimi-agent', 'private.ts'), 'PRIVATE');
  const tools = createTools(root, false, [path.join(root, '.mimi-agent')]);
  const invoke = async (name: string, input: object): Promise<string> => {
    const selected = tools.find((item) => item.name === name);
    if (!selected || !('invoke' in selected)) throw new Error(`工具不可调用：${name}`);
    return JSON.stringify(await selected.invoke(new RunContext({}), JSON.stringify(input)));
  };

  const listing = await invoke('list_directory', { path: '.', depth: 3, globs: ['**/*.test.ts'] });
  assert.match(listing, /src\/nested\/agent\.test\.ts/u);
  assert.doesNotMatch(listing, /agent\.ts"/u);
  assert.doesNotMatch(listing, /private\.ts/u);

  const paths = await searchWorkspaceFiles(root, '', '.', 20, undefined, {
    pathsOnly: true,
    globs: ['**/*.ts'],
    excludedPaths: [path.join(root, '.mimi-agent')],
    maxReadBytes: 1,
  });
  assert.deepEqual(paths.map((match) => match.path).sort(), ['src/agent.ts', 'src/nested/agent.test.ts']);
  assert.ok(paths.every((match) => match.match === 'path' && match.text === undefined));
});

test('applies validated multi-file patches and rejects stale digests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-patch-'));
  const note = path.join(root, 'note.txt');
  await writeFile(note, 'alpha\nbeta\ngamma\n');
  const digest = (await readLocalFileView(root, 'note.txt')).sha256;
  const result = await applyLocalPatch(root, [
    '--- a/note.txt',
    '+++ b/note.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+BETA',
    ' gamma',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+created',
    '+file',
  ].join('\n'), [{ path: 'note.txt', sha256: digest }]);

  assert.deepEqual(result.files.map((file) => [file.path, file.created]), [
    ['note.txt', false], ['new.txt', true],
  ]);
  assert.equal(await readFile(note, 'utf8'), 'alpha\nBETA\ngamma\n');
  assert.equal(await readFile(path.join(root, 'new.txt'), 'utf8'), 'created\nfile\n');
  await assert.rejects(applyLocalPatch(root, [
    '--- a/note.txt',
    '+++ b/note.txt',
    '@@ -1,1 +1,1 @@',
    '-alpha',
    '+ALPHA',
  ].join('\n'), [{ path: 'note.txt', sha256: digest }]), /文件已变化/);
  assert.equal(await readFile(note, 'utf8'), 'alpha\nBETA\ngamma\n');

  await writeFile(path.join(root, 'other.txt'), 'actual\n');
  await assert.rejects(applyLocalPatch(root, [
    '--- a/note.txt',
    '+++ b/note.txt',
    '@@ -1 +1 @@',
    '-alpha',
    '+ALPHA',
    '--- a/other.txt',
    '+++ b/other.txt',
    '@@ -1 +1 @@',
    '-expected',
    '+changed',
  ].join('\n')), /上下文不匹配/);
  assert.equal(await readFile(note, 'utf8'), 'alpha\nBETA\ngamma\n');
});

test('inspects Git changes without exposing a write-capable shell tool', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-inspect-changes-'));
  await writeFile(path.join(root, 'note.txt'), 'before\n');
  assert.equal((await runShellCommand(root, 'git init -q && git add note.txt', 5)).exitCode, 0);
  await writeFile(path.join(root, 'note.txt'), 'after\n');

  const changes = await inspectWorkspaceChanges(root);
  assert.equal(changes.git, true);
  assert.match(changes.status, /note\.txt/u);
  assert.match(changes.diff ?? '', /before|after/u);
});

test('excludes private runtime paths from Git change inspection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-inspect-private-'));
  await mkdir(path.join(root, '.mimi-agent'));
  await writeFile(path.join(root, 'public.txt'), 'public-before\n');
  await writeFile(path.join(root, '.mimi-agent', 'private.txt'), 'PRIVATE_BEFORE\n');
  assert.equal((await runShellCommand(root, 'git init -q && git add public.txt && git add -f .mimi-agent/private.txt', 5)).exitCode, 0);
  await writeFile(path.join(root, 'public.txt'), 'public-after\n');
  await writeFile(path.join(root, '.mimi-agent', 'private.txt'), 'PRIVATE_SECRET\n');

  const changes = await inspectWorkspaceChanges(root);
  assert.match(changes.diff ?? '', /public-(?:before|after)/u);
  assert.doesNotMatch(JSON.stringify(changes), /PRIVATE_/u);
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
    await assert.rejects(
      requestUrl(`http://127.0.0.1:${address.port}/health`, 'GET', {}, undefined, 5),
      /只允许访问公网地址/,
    );
    const result = await requestUrl(
      `http://127.0.0.1:${address.port}/health`, 'GET', {}, undefined, 5, undefined, true,
    );
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
    const result = await requestUrl(
      `http://127.0.0.1:${address.port}/large`, 'GET', {}, undefined, 5, undefined, true,
    );
    assert.match(result.body, /响应已截断/);
    assert.ok(Buffer.byteLength(result.body, 'utf8') < 201_000);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('redirects do not forward write bodies across origins', async () => {
  let destinationRequests = 0;
  const destination = createServer((_request, response) => {
    destinationRequests += 1;
    response.end('unexpected');
  });
  await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
  const destinationAddress = destination.address();
  assert.ok(destinationAddress && typeof destinationAddress === 'object');
  const origin = createServer((_request, response) => {
    response.statusCode = 307;
    response.setHeader('location', `http://127.0.0.1:${destinationAddress.port}/receive`);
    response.end();
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originAddress = origin.address();
  assert.ok(originAddress && typeof originAddress === 'object');
  try {
    await assert.rejects(requestUrl(
      `http://127.0.0.1:${originAddress.port}/send`, 'POST',
      { 'x-api-key': 'secret', 'content-type': 'text/plain' }, 'payload', 5, undefined, true,
    ), /跨源重定向写请求/);
    assert.equal(destinationRequests, 0);
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => origin.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => destination.close((error) => error ? reject(error) : resolve())),
    ]);
  }
});

test('303 redirects convert POST to a header-clean GET', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/start') {
      response.statusCode = 303;
      response.setHeader('location', '/finish');
      response.end();
      return;
    }
    response.end(JSON.stringify({
      method: request.method,
      contentLength: request.headers['content-length'],
      contentType: request.headers['content-type'],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const result = await requestUrl(
      `http://127.0.0.1:${address.port}/start`, 'POST',
      { 'content-length': '7', 'content-type': 'text/plain' }, 'payload', 5, undefined, true,
    );
    assert.deepEqual(JSON.parse(result.body), { method: 'GET' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('rejects hexadecimal IPv4-mapped IPv6 loopback targets', async () => {
  await assert.rejects(
    requestUrl('http://[::ffff:7f00:1]/', 'GET', {}, undefined, 1),
    /只允许访问公网地址/,
  );
});

test('runs shell commands in the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-'));
  const result = await runShellCommand(root, 'pwd', 5);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), await realpath(root));
});

test('stops a running shell tool when the Agent task is aborted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-agent-'));
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

test('kills background shell children after a successful parent shell exit', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-shell-success-tree-'));
  const childScript = path.join(root, 'late-write.cjs');
  const marker = path.join(root, 'should-not-exist.txt');
  await writeFile(childScript, "process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(process.argv[2], 'late'), 250);\n");
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)} ${JSON.stringify(marker)} >/dev/null 2>&1 & echo done`;

  const result = await runShellCommand(root, command, 5);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'done');
  await assert.rejects(access(marker), /ENOENT/);
});
