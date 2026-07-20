import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
import { taskWorkerConfig, taskWorkerInitSchema } from '../src/daemon/worker-protocol.js';

test('Task worker configuration excludes Computer Use capability', () => {
  const config = {
    provider: 'deepseek',
    workspaceRoot: '/workspace',
    dataRoot: '/data',
    daemonDataRoot: '/daemon',
    skillsRoot: '/workspace/skills',
    mcpConfig: '/workspace/mcp.json',
    historyLimit: 40,
    maxTurns: null,
    permissionMode: 'trusted',
    computer: {
      backend: 'cua',
      driverCommand: '/usr/local/bin/cua-driver',
      actionTimeoutMs: 15_000,
      maxActionsPerRun: 50,
      maxScreenshotsPerRun: 12,
      pauseWhenTargetFrontmost: true,
      defaultAccess: 'background',
      foregroundLeaseSeconds: 30,
      artifactMaxBytes: 1024 * 1024,
    },
  } satisfies AppConfig;

  const workerConfig = taskWorkerConfig(config);
  assert.equal('computer' in workerConfig, false);
  assert.doesNotThrow(() => taskWorkerInitSchema.parse({
    type: 'init',
    executor: 'codex',
    taskId: 'd4d0011b-d947-5963-b2ef-7982b303f612',
    database: '/daemon/mimi.db',
    assistantConfig: '/daemon/assistant.json',
    socket: '/daemon/mimi.sock',
    workerToken: 'a'.repeat(43),
    workspaceAccess: 'write',
    enableMcp: false,
    mcpEnvironment: {},
    config: workerConfig,
  }));
});
