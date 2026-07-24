import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
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

  const packageRoot = path.join(temporary, 'node_modules', 'mimi-agent');
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
    access(path.join(packageRoot, 'MIMI.md')),
    access(path.join(packageRoot, 'skills', 'manifest.json')),
    access(path.join(packageRoot, 'knowledge', 'mimi-agent.md')),
    access(path.join(packageRoot, 'docs', 'BENCHMARKS.md')),
    access(path.join(packageRoot, 'docs', 'PROVIDER_CANARY.md')),
    access(path.join(packageRoot, 'docs', 'PROVIDER_CONTRACTS.md')),
    access(path.join(packageRoot, 'docs', 'PUBLIC_API.md')),
    access(path.join(packageRoot, 'docs', 'REPOSITORY_BOUNDARIES.md')),
    access(path.join(packageRoot, 'docs', 'SECURITY_EVALS.md')),
    access(path.join(packageRoot, 'examples', 'connectors', 'daxiang-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'qq-napcat-connector.mjs')),
    access(path.join(packageRoot, 'scripts', 'install-napcat-macos.mjs'), constants.X_OK),
    access(path.join(packageRoot, 'scripts', 'setup-qq-connector.sh'), constants.X_OK),
    access(path.join(packageRoot, 'scripts', 'setup-qq-desktop-connector.sh'), constants.X_OK),
    access(path.join(packageRoot, 'examples', 'connectors', 'http-action-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-system-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-life-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-life-eventkit.swift')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-mail-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-messages-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-contacts-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-notes-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-shortcuts-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-desktop-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-browser-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-screen-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-screen-ocr.swift')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-voice-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'macos-voice-recognizer.swift')),
    access(path.join(packageRoot, 'examples', 'connectors', 'radar-connector.mjs')),
    access(path.join(packageRoot, 'examples', 'connectors', 'file-radar-connector.mjs')),
    access(path.join(packageRoot, 'mimi.radar.example.json')),
    access(path.join(packageRoot, 'mimi.files.example.json')),
    access(path.join(packageRoot, 'mimi.connectors.example.json')),
  ]);
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const apiContract = JSON.parse(
    await readFile(path.join(packageRoot, 'evals', 'public-api-contract.json'), 'utf8'),
  );
  assert.equal(manifest.name, 'mimi-agent');
  assert.equal(apiContract.packageVersion, manifest.version);
  assert.deepEqual(manifest.bin, { mimi: 'dist/index.js' });
  assert.deepEqual(await readdir(path.join(packageRoot, 'knowledge')), ['mimi-agent.md']);
  const cliTarget = path.join(packageRoot, manifest.bin.mimi);
  let cliCommand = process.execPath;
  let cliArguments = [cliTarget];
  if (process.platform !== 'win32') {
    const cliMode = (await stat(cliTarget)).mode;
    assert.notEqual(cliMode & 0o111, 0, 'packed mimi entry is not executable');
    await access(cliTarget, constants.X_OK);
    const binRoot = path.join(temporary, 'bin');
    await mkdir(binRoot);
    const mimi = path.join(binRoot, 'mimi');
    await symlink(cliTarget, mimi);
    cliCommand = mimi;
    cliArguments = [];
  }
  for (const option of ['--help', '--version']) {
    const result = await execFileAsync(cliCommand, [...cliArguments, option], {
      cwd: temporary,
      env: { ...process.env, NODE_NO_WARNINGS: '0', NODE_OPTIONS: '' },
      maxBuffer: 10_000_000,
    });
    assert.doesNotMatch(result.stderr, /ExperimentalWarning|node:sqlite/, `mimi ${option} loaded node:sqlite`);
    assert.ok(result.stdout.trim(), `mimi ${option} returned no output`);
  }
  const clientImport = await execFileAsync(process.execPath, ['--input-type=module', '--eval', `
    await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dist', 'daemon', 'chat-client.js')).href)});
  `], {
    cwd: temporary,
    env: { ...process.env, NODE_NO_WARNINGS: '0', NODE_OPTIONS: '' },
    maxBuffer: 10_000_000,
  });
  assert.doesNotMatch(clientImport.stderr, /ExperimentalWarning|node:sqlite/, 'steady-state chat client loaded node:sqlite');

  const daemonRoot = path.join(temporary, 'daemon-state');
  await mkdir(daemonRoot, { recursive: true });
  const { MimiIpcServer } = await import(pathToFileURL(path.join(packageRoot, 'dist', 'daemon', 'ipc.js')).href);
  const statusServer = new MimiIpcServer(path.join(daemonRoot, 'mimi.sock'), (method) => {
    assert.equal(method, 'status');
    return {
      protocolVersion: 5,
      permissionMode: 'trusted',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      workerId: 'package-smoke',
      events: { queued: 0, running: 0, paused: 0, blocked: 0, completed: 0, ignored: 0, digested: 0, dead_letter: 0, archived: 0 },
      outbox: { pending: 0, sending: 0, sent: 0, dead_letter: 0, archived: 0 },
      enabledSchedules: 0,
      activeHostMutations: 0,
      workspaceRoot: temporary,
    };
  });
  await statusServer.start();
  try {
    const status = await execFileAsync(cliCommand, [...cliArguments, 'daemon', 'status', '--json'], {
      cwd: temporary,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '0',
        NODE_OPTIONS: '',
        MIMI_DAEMON_DATA_DIR: daemonRoot,
        MIMI_WORKSPACE: temporary,
        MIMI_DATA_DIR: path.join(temporary, 'agent-state'),
      },
      maxBuffer: 10_000_000,
    });
    assert.doesNotMatch(status.stderr, /ExperimentalWarning|node:sqlite/, 'mimi daemon status loaded node:sqlite');
    assert.equal(JSON.parse(status.stdout).protocolVersion, 5);
  } finally {
    await statusServer.close();
  }
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    const root = await import('mimi-agent');
    const orchestration = await import('mimi-agent/orchestration');
    const contract = JSON.parse(await readFile(
      new URL('./node_modules/mimi-agent/evals/public-api-contract.json', import.meta.url),
      'utf8',
    ));
    assert.deepEqual(Object.keys(root).sort(), contract.entrypoints['.'].runtimeExports);
    assert.deepEqual(
      Object.keys(orchestration).sort(),
      contract.entrypoints['./orchestration'].runtimeExports,
    );
    assert.equal(typeof root.MimiAgent, 'function');
    assert.equal(typeof root.loadConfig, 'function');
    assert.equal(typeof root.TeamTaskStore, 'function');
    assert.equal(typeof orchestration.createTeamTools, 'function');
    assert.equal(typeof orchestration.runTeamWave, 'function');
  `], { cwd: temporary, maxBuffer: 10_000_000 });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
