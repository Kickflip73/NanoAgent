import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig, loadEnvironment, type AppConfig } from '../src/config.js';
import { resolveModelProfile } from '../src/runtime/model.js';

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
    workspaceRoot: process.cwd(), dataRoot: '.nano-agent', skillsRoot: 'skills', mcpConfig: 'mcp.json',
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

test('fails fast on invalid runtime environment values', () => {
  const keys = [
    'MODEL_PROVIDER', 'HISTORY_LIMIT', 'CONTEXT_WINDOW', 'OUTPUT_TOKEN_RESERVE',
    'MAX_TURNS', 'TEAM_MAX_CONCURRENCY', 'AGENT_PERMISSION_MODE', 'TRUST_WORKSPACE_MCP',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    const invalid = [
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
      assert.throws(loadConfig, new RegExp(key));
      delete process.env[key];
    }
    process.env.CONTEXT_WINDOW = '1000';
    process.env.OUTPUT_TOKEN_RESERVE = '1000';
    assert.throws(loadConfig, /OUTPUT_TOKEN_RESERVE.*CONTEXT_WINDOW/);
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
    const config = loadConfig();
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

test('uses a workspace-scoped local permission mode by default', () => {
  const previous = process.env.AGENT_PERMISSION_MODE;
  delete process.env.AGENT_PERMISSION_MODE;
  try {
    assert.equal(loadConfig().permissionMode, 'workspace');
  } finally {
    if (previous === undefined) delete process.env.AGENT_PERMISSION_MODE;
    else process.env.AGENT_PERMISSION_MODE = previous;
  }
});
