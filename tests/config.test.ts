import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  adoptWorkspaceConfig,
  loadConfig,
  loadEnvironment,
  privateRuntimePaths,
  resolveEnvironmentFile,
  type AppConfig,
} from '../src/config.js';
import { normalizeModelInput, resolveModelProfile } from '../src/runtime/model.js';
import {
  PRE_MIMI_DAEMON_DIRECTORY,
  PRE_MIMI_DAEMON_FILES,
  PRE_MIMI_DATA_DIRECTORY,
} from '../src/core/mimi-legacy.js';
import { migrateLegacyMimiDaemon, mimiPaths } from '../src/daemon/client-runtime.js';

const ISOLATED_HOME = path.join(os.tmpdir(), `mimi-config-tests-${process.pid}`);

test('loads the unified environment when launched from any workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nano-config-'));
  const environmentFile = path.join(root, '.env');
  const launchDirectory = path.join(root, 'workspace');
  await writeFile(environmentFile, 'MODEL_PROVIDER=deepseek\nDEEPSEEK_API_KEY=test-key\n');
  await mkdir(launchDirectory);

  const previousProvider = process.env.MODEL_PROVIDER;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousConfigPath = process.env.DOTENV_CONFIG_PATH;
  const previousDirectory = process.cwd();
  delete process.env.MODEL_PROVIDER;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DOTENV_CONFIG_PATH;
  process.chdir(launchDirectory);

  try {
    loadEnvironment(environmentFile);
    assert.equal(process.env.MODEL_PROVIDER, 'deepseek');
    assert.equal(process.env.DEEPSEEK_API_KEY, 'test-key');
    assert.equal((await stat(environmentFile)).mode & 0o777, 0o600);
  } finally {
    process.chdir(previousDirectory);
    if (previousProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousConfigPath === undefined) delete process.env.DOTENV_CONFIG_PATH;
    else process.env.DOTENV_CONFIG_PATH = previousConfigPath;
  }
});

test('resolves model-specific context profiles and override precedence', () => {
  const config: AppConfig = {
    provider: 'deepseek' as const,
    workspaceRoot: process.cwd(), dataRoot: '.mimi-agent', daemonDataRoot: '.mimi-agent/daemon', skillsRoot: 'skills', mcpConfig: 'mcp.json',
    historyLimit: 40, maxTurns: 20,
  };
  const keys = ['CONTEXT_WINDOW', 'OUTPUT_TOKEN_RESERVE', 'DEEPSEEK_V4_PRO_CONTEXT_WINDOW', 'DEEPSEEK_V4_PRO_OUTPUT_RESERVE'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.deepEqual(resolveModelProfile(config, 'deepseek-v4-pro'), {
      contextWindow: 1_048_576, outputReserve: 65_536,
    });
    assert.deepEqual(resolveModelProfile(config, 'deepseek-v4-flash'), {
      contextWindow: 128_000, outputReserve: 16_384,
    });
    config.contextWindow = 256_000;
    config.outputReserve = 24_000;
    process.env.DEEPSEEK_V4_PRO_CONTEXT_WINDOW = '512000';
    process.env.DEEPSEEK_V4_PRO_OUTPUT_RESERVE = '48000';
    assert.deepEqual(resolveModelProfile(config, 'deepseek-v4-pro'), {
      contextWindow: 512_000, outputReserve: 48_000,
    });
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('removes non-OpenAI message ids when a persisted session changes provider', () => {
  const deepSeekMessage = {
    type: 'message', role: 'assistant', id: 'bca45ecf-c171-4a57-8025-38ba9e552613',
    status: 'completed', content: [{ type: 'output_text', text: '旧回复' }],
  };
  const openAiMessage = {
    type: 'message', role: 'assistant', id: 'msg_existing',
    status: 'completed', content: [{ type: 'output_text', text: '新回复' }],
  };
  const functionCall = {
    type: 'function_call', callId: 'call_1', name: 'inspect', arguments: '{}',
  };
  const items = [deepSeekMessage, openAiMessage, functionCall] as never[];

  const normalized = normalizeModelInput('openai', items) as unknown as Array<Record<string, unknown>>;
  assert.equal(Object.hasOwn(normalized[0]!, 'id'), false);
  assert.equal(normalized[1]?.id, 'msg_existing');
  assert.equal(normalized[2], functionCall);
  assert.equal(deepSeekMessage.id, 'bca45ecf-c171-4a57-8025-38ba9e552613');
  assert.equal(normalizeModelInput('deepseek', items), items);
});

test('fails fast on invalid runtime environment values', () => {
  const keys = [
    'MIMI_CONFIG_VERSION', 'MODEL_PROVIDER', 'HISTORY_LIMIT', 'CONTEXT_WINDOW', 'OUTPUT_TOKEN_RESERVE',
    'MAX_TURNS', 'TEAM_MAX_CONCURRENCY', 'AGENT_PERMISSION_MODE', 'TRUST_WORKSPACE_MCP',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const invalid = [
      ['MIMI_CONFIG_VERSION', 'two'],
      ['HISTORY_LIMIT', 'oops'],
      ['CONTEXT_WINDOW', '0'],
      ['OUTPUT_TOKEN_RESERVE', '-1'],
      ['MAX_TURNS', '1.5'],
      ['TEAM_MAX_CONCURRENCY', '5'],
      ['MODEL_PROVIDER', 'opneai'],
      ['AGENT_PERMISSION_MODE', 'root'],
      ['TRUST_WORKSPACE_MCP', 'yes'],
    ] as const;
    for (const [key, value] of invalid) {
      process.env[key] = value;
      assert.throws(() => loadConfig(ISOLATED_HOME), new RegExp(key));
      delete process.env[key];
    }
    process.env.CONTEXT_WINDOW = '1000';
    process.env.OUTPUT_TOKEN_RESERVE = '1000';
    assert.throws(() => loadConfig(ISOLATED_HOME), /OUTPUT_TOKEN_RESERVE.*CONTEXT_WINDOW/);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('parses valid runtime limits once at startup', () => {
  const keys = [
    'HISTORY_LIMIT', 'CONTEXT_WINDOW', 'OUTPUT_TOKEN_RESERVE', 'MAX_TURNS',
    'TEAM_MAX_CONCURRENCY', 'AGENT_PERMISSION_MODE', 'TRUST_WORKSPACE_MCP',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.HISTORY_LIMIT = '60';
    process.env.CONTEXT_WINDOW = '128000';
    process.env.OUTPUT_TOKEN_RESERVE = '16000';
    process.env.MAX_TURNS = '120';
    process.env.TEAM_MAX_CONCURRENCY = '3';
    process.env.AGENT_PERMISSION_MODE = 'read-only';
    process.env.TRUST_WORKSPACE_MCP = process.cwd();
    const config = loadConfig(ISOLATED_HOME);
    assert.deepEqual(
      [
        config.historyLimit, config.contextWindow, config.outputReserve, config.maxTurns,
        config.teamMaxConcurrency, config.permissionMode, config.trustedWorkspaceMcp,
      ],
      [60, 128_000, 16_000, 120, 3, 'read-only', process.cwd()],
    );
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('gives the local owner full execution capability by default', () => {
  const previousModern = process.env.MIMI_PERMISSION_MODE;
  const previousLegacy = process.env.AGENT_PERMISSION_MODE;
  delete process.env.MIMI_PERMISSION_MODE;
  delete process.env.AGENT_PERMISSION_MODE;
  try {
    assert.equal(loadConfig(ISOLATED_HOME).permissionMode, 'trusted');
  } finally {
    if (previousModern === undefined) delete process.env.MIMI_PERMISSION_MODE;
    else process.env.MIMI_PERMISSION_MODE = previousModern;
    if (previousLegacy === undefined) delete process.env.AGENT_PERMISSION_MODE;
    else process.env.AGENT_PERMISSION_MODE = previousLegacy;
  }
});

test('migrates old template workspace defaults without overriding versioned restrictions', () => {
  const previousModern = process.env.MIMI_PERMISSION_MODE;
  const previousLegacy = process.env.AGENT_PERMISSION_MODE;
  const previousConfigVersion = process.env.MIMI_CONFIG_VERSION;
  try {
    delete process.env.MIMI_CONFIG_VERSION;
    delete process.env.MIMI_PERMISSION_MODE;
    process.env.AGENT_PERMISSION_MODE = 'workspace';
    assert.equal(loadConfig(ISOLATED_HOME).permissionMode, 'trusted');

    process.env.AGENT_PERMISSION_MODE = 'read-only';
    assert.equal(loadConfig(ISOLATED_HOME).permissionMode, 'read-only');

    process.env.MIMI_PERMISSION_MODE = 'workspace';
    assert.equal(loadConfig(ISOLATED_HOME).permissionMode, 'trusted');

    process.env.MIMI_CONFIG_VERSION = '2';
    assert.equal(loadConfig(ISOLATED_HOME).permissionMode, 'workspace');

    delete process.env.MIMI_PERMISSION_MODE;
    process.env.AGENT_PERMISSION_MODE = 'workspace';
    assert.equal(loadConfig(ISOLATED_HOME).permissionMode, 'workspace');
  } finally {
    if (previousModern === undefined) delete process.env.MIMI_PERMISSION_MODE;
    else process.env.MIMI_PERMISSION_MODE = previousModern;
    if (previousLegacy === undefined) delete process.env.AGENT_PERMISSION_MODE;
    else process.env.AGENT_PERMISSION_MODE = previousLegacy;
    if (previousConfigVersion === undefined) delete process.env.MIMI_CONFIG_VERSION;
    else process.env.MIMI_CONFIG_VERSION = previousConfigVersion;
  }
});

test('migrates the version-2 generated max-turn default without overriding explicit modern values', () => {
  const previousTurns = process.env.MIMI_MAX_TURNS;
  const previousVersion = process.env.MIMI_CONFIG_VERSION;
  try {
    process.env.MIMI_CONFIG_VERSION = '2';
    process.env.MIMI_MAX_TURNS = '200';
    assert.equal(loadConfig(ISOLATED_HOME).maxTurns, 32);

    process.env.MIMI_MAX_TURNS = '120';
    assert.equal(loadConfig(ISOLATED_HOME).maxTurns, 120);
    process.env.MIMI_CONFIG_VERSION = '3';
    process.env.MIMI_MAX_TURNS = '200';
    assert.equal(loadConfig(ISOLATED_HOME).maxTurns, 200);
  } finally {
    if (previousTurns === undefined) delete process.env.MIMI_MAX_TURNS;
    else process.env.MIMI_MAX_TURNS = previousTurns;
    if (previousVersion === undefined) delete process.env.MIMI_CONFIG_VERSION;
    else process.env.MIMI_CONFIG_VERSION = previousVersion;
  }
});

test('rebuilds workspace-derived paths when the CLI adopts an existing Host workspace', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-adopt-config-'));
  const localWorkspace = path.join(home, 'local');
  const daemonWorkspace = path.join(home, 'daemon');
  await mkdir(localWorkspace);
  await mkdir(path.join(daemonWorkspace, PRE_MIMI_DATA_DIRECTORY), { recursive: true });
  await writeFile(path.join(daemonWorkspace, PRE_MIMI_DATA_DIRECTORY, 'sessions.json'), '{}');
  const keys = [
    'MIMI_WORKSPACE', 'AGENT_WORKSPACE', 'MIMI_DATA_DIR', 'AGENT_DATA_DIR',
    'MIMI_SKILLS_DIR', 'AGENT_SKILLS_DIR', 'MIMI_MCP_CONFIG', 'MCP_CONFIG',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const previousDirectory = process.cwd();
  try {
    for (const key of keys) delete process.env[key];
    process.chdir(localWorkspace);
    const local = loadConfig(home);
    const adopted = adoptWorkspaceConfig(local, daemonWorkspace, home);
    assert.equal(adopted.workspaceRoot, daemonWorkspace);
    assert.equal(adopted.dataRoot, path.join(daemonWorkspace, '.mimi-agent'));
    assert.equal(await readFile(path.join(adopted.dataRoot, 'sessions.json'), 'utf8'), '{}');
    assert.equal(adopted.skillsRoot, path.join(daemonWorkspace, 'skills'));
    assert.equal(adopted.mcpConfig, path.join(daemonWorkspace, 'mcp.json'));
    assert.equal(adopted.daemonDataRoot, local.daemonDataRoot);
  } finally {
    process.chdir(previousDirectory);
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('prefers MIMI environment names, keeps legacy aliases, and expands home paths', () => {
  const keys = [
    'MIMI_MODEL_PROVIDER', 'MODEL_PROVIDER',
    'MIMI_WORKSPACE', 'AGENT_WORKSPACE',
    'MIMI_DATA_DIR', 'AGENT_DATA_DIR',
    'MIMI_DAEMON_DATA_DIR',
    'MIMI_SKILLS_DIR', 'AGENT_SKILLS_DIR',
    'MIMI_MCP_CONFIG', 'MCP_CONFIG',
    'MIMI_HISTORY_LIMIT', 'HISTORY_LIMIT',
    'MIMI_MAX_TURNS', 'MAX_TURNS',
    'MIMI_TEAM_MAX_CONCURRENCY', 'TEAM_MAX_CONCURRENCY',
    'MIMI_PERMISSION_MODE', 'AGENT_PERMISSION_MODE',
    'MIMI_TRUST_WORKSPACE_MCP', 'TRUST_WORKSPACE_MCP',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.MIMI_MODEL_PROVIDER = 'deepseek';
    process.env.MODEL_PROVIDER = 'openai';
    process.env.MIMI_WORKSPACE = '~/mimi-modern-workspace';
    process.env.AGENT_WORKSPACE = '/legacy/workspace';
    process.env.MIMI_DATA_DIR = '~/mimi-modern-data';
    process.env.AGENT_DATA_DIR = '/legacy/data';
    process.env.MIMI_DAEMON_DATA_DIR = '~/mimi-modern-daemon';
    process.env.MIMI_SKILLS_DIR = '~/mimi-modern-skills';
    process.env.AGENT_SKILLS_DIR = '/legacy/skills';
    process.env.MIMI_MCP_CONFIG = '~/mimi-modern-mcp.json';
    process.env.MCP_CONFIG = '/legacy/mcp.json';
    process.env.MIMI_HISTORY_LIMIT = '17';
    process.env.HISTORY_LIMIT = 'invalid-legacy-value';
    process.env.MIMI_MAX_TURNS = '23';
    process.env.MAX_TURNS = '99';
    process.env.MIMI_TEAM_MAX_CONCURRENCY = '2';
    process.env.TEAM_MAX_CONCURRENCY = '4';
    process.env.MIMI_PERMISSION_MODE = 'read-only';
    process.env.AGENT_PERMISSION_MODE = 'trusted';
    process.env.MIMI_TRUST_WORKSPACE_MCP = '~/mimi-modern-workspace';
    process.env.TRUST_WORKSPACE_MCP = '/legacy/workspace';

    const config = loadConfig();
    assert.equal(config.provider, 'deepseek');
    assert.equal(config.workspaceRoot, path.join(os.homedir(), 'mimi-modern-workspace'));
    assert.equal(config.dataRoot, path.join(os.homedir(), 'mimi-modern-data'));
    assert.equal(config.daemonDataRoot, path.join(os.homedir(), 'mimi-modern-daemon'));
    assert.equal(config.skillsRoot, path.join(os.homedir(), 'mimi-modern-skills'));
    assert.equal(config.mcpConfig, path.join(os.homedir(), 'mimi-modern-mcp.json'));
    assert.equal(config.historyLimit, 17);
    assert.equal(config.maxTurns, 23);
    assert.equal(config.teamMaxConcurrency, 2);
    assert.equal(config.permissionMode, 'read-only');
    assert.equal(config.trustedWorkspaceMcp, path.join(os.homedir(), 'mimi-modern-workspace'));
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('uses the new runtime directory, ignores empty migration residue, and rejects split state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-directory-migration-'));
  const freshWorkspace = path.join(root, 'fresh');
  const legacyWorkspace = path.join(root, 'legacy');
  const emptyModernWorkspace = path.join(root, 'empty-modern');
  const conflictWorkspace = path.join(root, 'conflict');
  await mkdir(freshWorkspace);
  await mkdir(path.join(legacyWorkspace, PRE_MIMI_DATA_DIRECTORY), { recursive: true });
  await writeFile(path.join(legacyWorkspace, PRE_MIMI_DATA_DIRECTORY, 'sessions.json'), '{}');
  await mkdir(path.join(emptyModernWorkspace, PRE_MIMI_DATA_DIRECTORY), { recursive: true });
  await mkdir(path.join(emptyModernWorkspace, '.mimi-agent'), { recursive: true });
  await writeFile(path.join(emptyModernWorkspace, PRE_MIMI_DATA_DIRECTORY, 'memories.json'), '[]');
  await mkdir(path.join(conflictWorkspace, PRE_MIMI_DATA_DIRECTORY), { recursive: true });
  await mkdir(path.join(conflictWorkspace, '.mimi-agent'), { recursive: true });
  await writeFile(path.join(conflictWorkspace, PRE_MIMI_DATA_DIRECTORY, 'sessions.json'), '{}');
  await writeFile(path.join(conflictWorkspace, '.mimi-agent', 'sessions.json'), '{}');
  const keys = ['MIMI_WORKSPACE', 'AGENT_WORKSPACE', 'MIMI_DATA_DIR', 'AGENT_DATA_DIR', 'MIMI_DAEMON_DATA_DIR'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.MIMI_DAEMON_DATA_DIR = path.join(root, 'daemon');

    process.env.MIMI_WORKSPACE = freshWorkspace;
    assert.equal(loadConfig().dataRoot, path.join(freshWorkspace, '.mimi-agent'));

    process.env.MIMI_WORKSPACE = legacyWorkspace;
    assert.equal(loadConfig().dataRoot, path.join(legacyWorkspace, '.mimi-agent'));
    assert.equal(await readFile(path.join(legacyWorkspace, '.mimi-agent', 'sessions.json'), 'utf8'), '{}');

    process.env.MIMI_WORKSPACE = emptyModernWorkspace;
    assert.equal(loadConfig().dataRoot, path.join(emptyModernWorkspace, '.mimi-agent'));
    assert.equal(await readFile(path.join(emptyModernWorkspace, '.mimi-agent', 'memories.json'), 'utf8'), '[]');

    process.env.MIMI_WORKSPACE = conflictWorkspace;
    assert.throws(loadConfig, /同时存在新目录.*旧目录/);

    process.env.MIMI_DATA_DIR = '~/explicit-mimi-state';
    assert.equal(loadConfig().dataRoot, path.join(os.homedir(), 'explicit-mimi-state'));
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rejects symlinks for automatically discovered workspace runtime roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-directory-symlink-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await symlink(outside, path.join(workspace, '.mimi-agent'));
  const keys = ['MIMI_WORKSPACE', 'MIMI_DATA_DIR', 'AGENT_DATA_DIR', 'MIMI_DAEMON_DATA_DIR'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.MIMI_WORKSPACE = workspace;
    process.env.MIMI_DAEMON_DATA_DIR = path.join(root, 'daemon');
    assert.throws(loadConfig, /不能包含符号链接.*\.mimi-agent/);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('applies the same safe fallback to long-running daemon state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-daemon-directory-migration-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const keys = [
    'MIMI_WORKSPACE', 'MIMI_DATA_DIR', 'AGENT_DATA_DIR',
    'MIMI_DAEMON_DATA_DIR',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.MIMI_WORKSPACE = workspace;

    const freshHome = path.join(root, 'fresh-home');
    assert.equal(loadConfig(freshHome).daemonDataRoot, path.join(freshHome, '.mimi-agent', 'daemon'));

    const legacyHome = path.join(root, 'legacy-home');
    await mkdir(path.join(legacyHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY), { recursive: true });
    await writeFile(path.join(legacyHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY, 'old.db'), 'legacy');
    assert.equal(loadConfig(legacyHome).daemonDataRoot,
      path.join(legacyHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY));
    assert.equal(await readFile(path.join(
      legacyHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY, 'old.db',
    ), 'utf8'), 'legacy');

    const emptyModernHome = path.join(root, 'empty-modern-home');
    await mkdir(path.join(emptyModernHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY), { recursive: true });
    await mkdir(path.join(emptyModernHome, '.mimi-agent', 'daemon'), { recursive: true });
    await writeFile(path.join(emptyModernHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY, 'old.db'), 'legacy');
    assert.equal(loadConfig(emptyModernHome).daemonDataRoot,
      path.join(emptyModernHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY));

    const conflictHome = path.join(root, 'conflict-home');
    await mkdir(path.join(conflictHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY), { recursive: true });
    await mkdir(path.join(conflictHome, '.mimi-agent', 'daemon'), { recursive: true });
    await writeFile(path.join(conflictHome, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY, 'old.db'), 'legacy');
    await writeFile(path.join(conflictHome, '.mimi-agent', 'daemon', 'mimi.db'), 'modern');
    assert.throws(() => loadConfig(conflictHome), /同时存在新目录.*旧目录/);

    process.env.MIMI_DAEMON_DATA_DIR = '~/explicit-daemon';
    assert.equal(loadConfig(conflictHome).daemonDataRoot, path.join(conflictHome, 'explicit-daemon'));
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('migrates legacy daemon files only at the explicit stopped-daemon boundary', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-stopped-daemon-migration-'));
  const legacyRoot = path.join(home, PRE_MIMI_DATA_DIRECTORY, PRE_MIMI_DAEMON_DIRECTORY);
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(path.join(legacyRoot, PRE_MIMI_DAEMON_FILES.database), 'durable-state');
  const config = {
    provider: 'openai' as const,
    workspaceRoot: home,
    dataRoot: path.join(home, PRE_MIMI_DATA_DIRECTORY),
    daemonDataRoot: legacyRoot,
    skillsRoot: path.join(home, 'skills'),
    mcpConfig: path.join(home, 'mcp.json'),
    historyLimit: 40,
    maxTurns: 20,
  };
  assert.equal(mimiPaths(config).database, path.join(legacyRoot, PRE_MIMI_DAEMON_FILES.database));
  const migrated = migrateLegacyMimiDaemon(config, home);
  assert.equal(migrated.daemonDataRoot, path.join(home, '.mimi-agent', 'daemon'));
  assert.equal(await readFile(mimiPaths(migrated).database, 'utf8'), 'durable-state');
});

test('rejects symlinks for automatically discovered daemon runtime roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-daemon-symlink-'));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(home, '.mimi-agent'), { recursive: true });
  await mkdir(outside);
  await mkdir(workspace);
  await symlink(outside, path.join(home, '.mimi-agent', 'daemon'));
  const keys = ['MIMI_WORKSPACE', 'MIMI_DATA_DIR', 'AGENT_DATA_DIR', 'MIMI_DAEMON_DATA_DIR'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.MIMI_WORKSPACE = workspace;
    assert.throws(() => loadConfig(home), /不能包含符号链接.*daemon/);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('rejects symlinked parents for automatically discovered daemon runtime roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mimi-daemon-parent-symlink-'));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  const workspace = path.join(root, 'workspace');
  await mkdir(home);
  await mkdir(path.join(outside, 'daemon'), { recursive: true });
  await mkdir(workspace);
  await symlink(outside, path.join(home, '.mimi-agent'));
  const keys = ['MIMI_WORKSPACE', 'MIMI_DATA_DIR', 'AGENT_DATA_DIR', 'MIMI_DAEMON_DATA_DIR'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.MIMI_WORKSPACE = workspace;
    assert.throws(() => loadConfig(home), /不能包含符号链接.*\.mimi-agent/);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('resolves dotenv as explicit, existing new, legacy, then the new default', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mimi-environment-migration-'));
  const modern = path.join(home, '.mimi-agent', '.env');
  const legacy = path.join(home, PRE_MIMI_DATA_DIRECTORY, '.env');
  const keys = ['MIMI_ENV_FILE', 'DOTENV_CONFIG_PATH'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(resolveEnvironmentFile(undefined, home), modern);

    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, 'SOURCE=legacy\n');
    assert.equal(resolveEnvironmentFile(undefined, home), modern);
    assert.equal(await readFile(modern, 'utf8'), 'SOURCE=legacy\n');

    await mkdir(path.dirname(modern), { recursive: true });
    await writeFile(modern, 'SOURCE=modern\n');
    assert.equal(resolveEnvironmentFile(undefined, home), modern);

    process.env.DOTENV_CONFIG_PATH = '~/legacy-explicit.env';
    process.env.MIMI_ENV_FILE = '~/modern-explicit.env';
    assert.equal(resolveEnvironmentFile(undefined, home), path.join(home, 'modern-explicit.env'));
    assert.equal(resolveEnvironmentFile('~/argument.env', home), path.join(home, 'argument.env'));
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('protects explicit state plus both MimiAgent and MimiAgent private roots', () => {
  const home = path.join(os.tmpdir(), 'mimi-protected-home');
  const workspace = path.join(os.tmpdir(), 'mimi-protected-workspace');
  const config: AppConfig = {
    provider: 'openai', workspaceRoot: workspace,
    dataRoot: path.join(os.tmpdir(), 'explicit-agent-state'),
    daemonDataRoot: path.join(os.tmpdir(), 'explicit-daemon-state'),
    skillsRoot: path.join(workspace, 'skills'), mcpConfig: path.join(workspace, 'mcp.json'),
    historyLimit: 40, maxTurns: 20,
  };
  const protectedPaths = new Set(privateRuntimePaths(config, home));
  for (const expected of [
    config.dataRoot,
    config.daemonDataRoot!,
    path.join(workspace, '.mimi-agent'),
    path.join(workspace, PRE_MIMI_DATA_DIRECTORY),
    path.join(home, '.mimi-agent'),
    path.join(home, PRE_MIMI_DATA_DIRECTORY),
  ]) assert.ok(protectedPaths.has(expected), expected);
});
