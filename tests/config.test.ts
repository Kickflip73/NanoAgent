import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadEnvironment } from '../src/config.js';

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
