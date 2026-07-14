import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(path.join(projectRoot, '.package-smoke-'));

try {
  await execFileAsync('npm', [
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    temporary,
  ], { cwd: projectRoot, maxBuffer: 10_000_000 });
  const archiveName = (await readdir(temporary)).find((name) => name.endsWith('.tgz'));
  assert.ok(archiveName, 'npm pack did not produce an archive');

  const packageRoot = path.join(temporary, 'node_modules', 'nano-agent');
  await mkdir(packageRoot, { recursive: true });
  await execFileAsync('tar', [
    '-xzf',
    path.join(temporary, archiveName),
    '--strip-components=1',
    '-C',
    packageRoot,
  ]);

  await Promise.all([
    access(path.join(packageRoot, 'dist', 'agent.d.ts')),
    access(path.join(packageRoot, 'dist', 'orchestration.d.ts')),
  ]);
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const root = await import('nano-agent');
    const orchestration = await import('nano-agent/orchestration');
    assert.equal(typeof root.NanoAgent, 'function');
    assert.equal(typeof root.loadConfig, 'function');
    assert.equal(typeof root.TeamTaskStore, 'function');
    assert.equal(typeof orchestration.createTeamTools, 'function');
    assert.equal(typeof orchestration.runTeamWave, 'function');
  `], { cwd: temporary, maxBuffer: 10_000_000 });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
