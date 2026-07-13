import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('prints nano help and version without requiring an API key', () => {
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.DEEPSEEK_API_KEY;
  environment.DOTENV_CONFIG_PATH = '/dev/null';

  const help = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--help'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });
  const version = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--version'], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
  });

  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /nano "任务"/);
  assert.match(help.stdout, /\/status/);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/);
});
