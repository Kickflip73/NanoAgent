import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const installer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/install-napcat-macos.mjs');

interface Fixture {
  root: string;
  qqApp: string;
  packageFile: string;
  archive: string;
  digest: string;
  documentsDir: string;
  workDir: string;
  envFile: string;
  launchAgentsDir: string;
  launchLabel: string;
  launchctlLog: string;
  launchctlStub: string;
  codesignLog: string;
  codesignStub: string;
}

function createFixture(buildVersion = 50_000): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'mimi-napcat-installer-'));
  const qqApp = path.join(root, 'QQ.app');
  const resources = path.join(qqApp, 'Contents', 'Resources', 'app');
  const binaryDir = path.join(qqApp, 'Contents', 'MacOS');
  mkdirSync(path.join(resources, 'application.asar', 'app_launcher'), { recursive: true });
  mkdirSync(binaryDir, { recursive: true });
  const packageFile = path.join(resources, 'package.json');
  writeFileSync(packageFile, `${JSON.stringify({
    name: 'qq-chat',
    version: `6.9.96-${buildVersion}`,
    main: './application.asar/app_launcher/index.js',
    buildVersion: String(buildVersion),
  }, null, 2)}\n`);
  writeFileSync(path.join(resources, 'application.asar', 'app_launcher', 'index.js'), 'global.launcher = {};\n');
  writeFileSync(path.join(binaryDir, 'QQ'), `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(path.join(root, 'qq-launched'))}\n`);
  chmodSync(path.join(binaryDir, 'QQ'), 0o755);
  writeFileSync(path.join(qqApp, 'Contents', 'Info.plist'), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.tencent.qq</string></dict></plist>',
    '',
  ].join('\n'));

  const shellSource = path.join(root, 'shell-source');
  mkdirSync(path.join(shellSource, 'static'), { recursive: true });
  writeFileSync(
    path.join(shellSource, 'napcat.mjs'),
    `globalThis.__napcatFixture = true; // "6.9.96-${buildVersion}-${process.arch}"\n`,
  );
  writeFileSync(path.join(shellSource, 'package.json'), '{"name":"napcat","type":"module"}\n');
  writeFileSync(path.join(shellSource, 'static', 'index.html'), '<!doctype html>\n');
  const archive = path.join(root, 'NapCat.Shell.zip');
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', shellSource, archive]);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const codesignLog = path.join(root, 'codesign.log');
  const codesignStub = path.join(root, 'codesign-stub.sh');
  writeFileSync(codesignStub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(codesignLog)}\n`);
  chmodSync(codesignStub, 0o700);
  const launchctlLog = path.join(root, 'launchctl.log');
  const launchctlStub = path.join(root, 'launchctl-stub.sh');
  writeFileSync(launchctlStub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(launchctlLog)}\n`);
  chmodSync(launchctlStub, 0o700);

  return {
    root,
    qqApp,
    packageFile,
    archive,
    digest,
    documentsDir: path.join(root, 'Documents'),
    workDir: path.join(root, 'NapCat-MimiAgent'),
    envFile: path.join(root, '.mimi-agent', '.env'),
    launchAgentsDir: path.join(root, 'LaunchAgents'),
    launchLabel: `com.mimiagent.napcat.qq.test.${process.pid}.${path.basename(root).replace(/[^A-Za-z0-9.-]/g, '-')}`,
    launchctlLog,
    launchctlStub,
    codesignLog,
    codesignStub,
  };
}

function invoke(fixture: Fixture, command: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [installer, ...command], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.root,
      MIMI_ENV_FILE: fixture.envFile,
      NAPCAT_QQ_APP: fixture.qqApp,
      NAPCAT_SYSTEM_QQ_APP: path.join(fixture.root, 'SystemQQ.app'),
      NAPCAT_DOCUMENTS_DIR: fixture.documentsDir,
      NAPCAT_WORKDIR: fixture.workDir,
      NAPCAT_LAUNCH_AGENTS_DIR: fixture.launchAgentsDir,
      NAPCAT_TEST_LAUNCH_LABEL: fixture.launchLabel,
      NAPCAT_TEST_LAUNCHCTL_BIN: fixture.launchctlStub,
      NAPCAT_SHELL_ARCHIVE: fixture.archive,
      NAPCAT_SHELL_DIGEST: `sha256:${fixture.digest}`,
      NAPCAT_RELEASE_VERSION: 'v-test',
      NAPCAT_TEST_CODESIGN_BIN: fixture.codesignStub,
      NODE_ENV: 'test',
      NAPCAT_TEST_ALLOW_UNSIGNED_QQ: '1',
      NC_TEST_SENTINEL: 'must-not-leak',
      ...extraEnv,
    },
  });
}

test('macOS NapCat installer patches and restores QQ with a background-only LaunchAgent', () => {
  const fixture = createFixture();
  mkdirSync(path.dirname(fixture.envFile), { recursive: true });
  writeFileSync(fixture.envFile, [
    'NC_HTTP_URL=http://127.0.0.1:32100',
    'NC_WS_PORT=32101',
    'NC_ACCESS_TOKEN=fixture-http-secret',
    'NC_WS_ACCESS_TOKEN=fixture-ws-secret',
    '',
  ].join('\n'), { mode: 0o600 });
  const existingConfigDir = path.join(fixture.workDir, 'config');
  mkdirSync(existingConfigDir, { recursive: true });
  writeFileSync(path.join(existingConfigDir, 'onebot11.json'), JSON.stringify({
    network: {
      httpServers: [{ name: 'mimi-http', port: 32100, token: 'legacy' }],
      websocketClients: [{ name: 'mimi-reverse-ws', url: 'ws://127.0.0.1:32101/', token: 'legacy' }],
    },
  }));
  try {
    const original = readFileSync(fixture.packageFile, 'utf8');
    const installed = invoke(fixture, ['install', '--no-start'], { NAPCAT_MIN_QQ_BUILD: '40768' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.doesNotMatch(`${installed.stdout}${installed.stderr}`, /fixture-(?:http|ws)-secret/);

    const backup = `${fixture.packageFile}.mimi-napcat.bak`;
    assert.equal(readFileSync(backup, 'utf8'), original);
    const patched = JSON.parse(readFileSync(fixture.packageFile, 'utf8')) as Record<string, unknown>;
    assert.match(String(patched.main), /loadMimiNapCat\.cjs$/);
    assert.deepEqual(readFileSync(fixture.codesignLog, 'utf8').trim().split('\n'), [
      `--force --deep --sign - ${fixture.qqApp}`,
      `--verify --deep --strict ${fixture.qqApp}`,
    ]);

    const shellEntry = path.join(fixture.documentsDir, 'napcat', 'napcat.mjs');
    const loader = path.join(fixture.documentsDir, 'loadMimiNapCat.cjs');
    const runner = path.join(fixture.root, '.mimi-agent', 'runtime', 'qq', 'runMimiNapCat.sh');
    const oneBot = path.join(fixture.workDir, 'config', 'onebot11.json');
    const launchAgent = path.join(fixture.launchAgentsDir, `${fixture.launchLabel}.plist`);
    const installerState = path.join(fixture.root, '.mimi-agent', 'napcat-installer.json');
    assert.equal(existsSync(shellEntry), true);
    assert.match(readFileSync(loader, 'utf8'), /process\.argv\.includes\('--no-sandbox'\)/);
    assert.match(readFileSync(loader, 'utf8'), /setActivationPolicy\('prohibited'\)/);
    assert.match(readFileSync(loader, 'utf8'), /requires the macOS prohibited activation policy/);
    assert.doesNotMatch(readFileSync(loader, 'utf8'), /osascript|activate|screenshot|OCR/i);
    assert.match(readFileSync(runner, 'utf8'), /refusing to launch QQ UI/);
    assert.match(readFileSync(runner, 'utf8'), /exec \/usr\/bin\/script -q \/dev\/null "\$qq_binary" --no-sandbox/);
    assert.equal(statSync(runner).mode & 0o777, 0o700);

    const config = JSON.parse(readFileSync(oneBot, 'utf8')) as {
      network: {
        httpServers: Array<Record<string, unknown>>;
        websocketClients: Array<Record<string, unknown>>;
      };
    };
    assert.deepEqual(config.network.httpServers, [{
      name: 'mimiagent-http', enable: true, port: 32100, host: '127.0.0.1', enableCors: false,
      enableWebsocket: false, messagePostFormat: 'array', token: 'fixture-http-secret', debug: false,
    }]);
    assert.equal(config.network.websocketClients[0]?.url, 'ws://127.0.0.1:32101/');
    assert.equal(config.network.websocketClients[0]?.token, 'fixture-ws-secret');
    writeFileSync(path.join(fixture.workDir, 'config', 'napcat_12345678.json'), JSON.stringify({
      fileLog: true,
      consoleLog: true,
      fileLogLevel: 'debug',
      consoleLogLevel: 'info',
    }));
    const configuredAgain = invoke(fixture, ['configure']);
    assert.equal(configuredAgain.status, 0, configuredAgain.stderr);
    const idempotent = JSON.parse(readFileSync(oneBot, 'utf8')) as typeof config;
    assert.equal(idempotent.network.httpServers.length, 1);
    assert.equal(idempotent.network.websocketClients.length, 1);
    assert.equal(idempotent.network.httpServers[0]?.enable, false);
    assert.equal(idempotent.network.websocketClients[0]?.enable, false);
    const accountOneBot = JSON.parse(readFileSync(
      path.join(fixture.workDir, 'config', 'onebot11_12345678.json'), 'utf8',
    )) as typeof config;
    assert.equal(accountOneBot.network.httpServers[0]?.enable, true);
    assert.equal(accountOneBot.network.websocketClients[0]?.enable, true);
    assert.equal(statSync(oneBot).mode & 0o777, 0o600);
    const napCat = JSON.parse(readFileSync(
      path.join(fixture.workDir, 'config', 'napcat_12345678.json'), 'utf8',
    )) as Record<string, unknown>;
    assert.equal(napCat.fileLog, false);
    assert.equal(napCat.consoleLog, false);
    const quickLogin = path.join(fixture.root, '.mimi-agent', 'runtime', 'qq', 'quick-login-account');
    assert.equal(readFileSync(quickLogin, 'utf8'), '12345678\n');
    assert.equal(statSync(quickLogin).mode & 0o777, 0o600);
    assert.equal(readFileSync(`${quickLogin}.enabled`, 'utf8'), 'enabled\n');

    const staleQr = path.join(fixture.workDir, 'cache', 'qrcode.png');
    mkdirSync(path.dirname(staleQr), { recursive: true });
    writeFileSync(staleQr, 'stale-qr');
    const started = invoke(fixture, ['start']);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(existsSync(staleQr), false);
    const launchctlCalls = readFileSync(fixture.launchctlLog, 'utf8');
    assert.match(launchctlCalls, new RegExp(`bootout gui/\\d+/${fixture.launchLabel.replaceAll('.', '\\.')}`));
    assert.match(launchctlCalls, /bootstrap gui\/\d+ /);
    assert.match(launchctlCalls, new RegExp(`kickstart -k gui/\\d+/${fixture.launchLabel.replaceAll('.', '\\.')}`));

    const plist = readFileSync(launchAgent, 'utf8');
    assert.match(plist, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
    assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/);
    assert.match(plist, /<key>HOME<\/key>/);
    assert.match(plist, /<key>USER<\/key>/);
    assert.match(plist, /<key>LOGNAME<\/key>/);
    assert.match(plist, /<key>PATH<\/key>/);
    assert.match(plist, /<key>__CF_USER_TEXT_ENCODING<\/key>/);
    assert.match(plist, /<key>TMPDIR<\/key>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>/);
    assert.match(plist, /<key>StandardOutPath<\/key><string>\/dev\/null<\/string>/);
    assert.match(plist, /<key>StandardErrorPath<\/key><string>\/dev\/null<\/string>/);
    assert.match(plist, /runMimiNapCat\.sh/);
    assert.doesNotMatch(plist, /Documents\/runMimiNapCat\.sh/);
    assert.doesNotMatch(plist, /osascript|open -|activate|fixture-(?:http|ws)-secret/i);
    assert.equal(statSync(launchAgent).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(installerState, 'utf8')), {
      version: 1,
      qqApp: fixture.qqApp,
    });
    assert.equal(statSync(installerState).mode & 0o777, 0o600);

    const status = invoke(fixture, ['status', '--json']);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal((report.qq as Record<string, unknown>).managed, true);
    assert.equal(report.shellPresent, true);
    assert.equal(report.launchAgentInstalled, true);

    const rememberedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fixture.root,
      MIMI_ENV_FILE: fixture.envFile,
      NAPCAT_SYSTEM_QQ_APP: fixture.qqApp,
      NAPCAT_DOCUMENTS_DIR: fixture.documentsDir,
      NAPCAT_WORKDIR: fixture.workDir,
      NAPCAT_LAUNCH_AGENTS_DIR: fixture.launchAgentsDir,
      NAPCAT_TEST_LAUNCH_LABEL: fixture.launchLabel,
      NAPCAT_TEST_LAUNCHCTL_BIN: fixture.launchctlStub,
      NODE_ENV: 'test',
    };
    delete rememberedEnv.NAPCAT_QQ_APP;
    const remembered = spawnSync(process.execPath, [installer, 'status', '--json'], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      encoding: 'utf8',
      env: rememberedEnv,
    });
    assert.equal(remembered.status, 0, remembered.stderr);
    const rememberedReport = JSON.parse(remembered.stdout) as {
      qq: { present: boolean; build: number; managed: boolean; main: string };
      paths: { qqApp: string };
    };
    assert.deepEqual(rememberedReport.qq, {
      present: true,
      build: 50_000,
      managed: true,
      main: JSON.parse(readFileSync(fixture.packageFile, 'utf8')).main,
    });
    assert.equal(rememberedReport.paths.qqApp, fixture.qqApp);

    const launchedMarker = path.join(fixture.root, 'qq-launched');
    assert.match(readFileSync(runner, 'utf8'), /--no-sandbox -- -q "\$quick_login"/);
    writeFileSync(fixture.packageFile, original);
    execFileSync(runner);
    assert.equal(existsSync(launchedMarker), false, 'guard must not launch ordinary QQ after its entry resets');

    const restored = invoke(fixture, ['restore']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readFileSync(fixture.packageFile, 'utf8'), original);
    assert.equal(existsSync(launchAgent), false);
    assert.equal(existsSync(loader), false);
    assert.equal(existsSync(runner), false);
    assert.equal(existsSync(shellEntry), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('macOS NapCat installer rejects an incompatible QQ build before persistent writes', () => {
  const fixture = createFixture(36_580);
  try {
    const original = readFileSync(fixture.packageFile, 'utf8');
    const result = invoke(fixture, ['install', '--no-start'], { NAPCAT_MIN_QQ_BUILD: '40768' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /build 36580.*40768/);
    assert.equal(readFileSync(fixture.packageFile, 'utf8'), original);
    assert.equal(existsSync(`${fixture.packageFile}.mimi-napcat.bak`), false);
    assert.equal(existsSync(fixture.envFile), false);
    assert.equal(existsSync(path.join(fixture.documentsDir, 'napcat')), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('macOS NapCat installer rejects an unsigned custom QQ copy before persistent writes', () => {
  const fixture = createFixture();
  try {
    const original = readFileSync(fixture.packageFile, 'utf8');
    const result = invoke(fixture, ['install', '--no-start'], {
      NODE_ENV: 'production',
      NAPCAT_TEST_ALLOW_UNSIGNED_QQ: '0',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /codesign.*执行失败/);
    assert.equal(readFileSync(fixture.packageFile, 'utf8'), original);
    assert.equal(existsSync(`${fixture.packageFile}.mimi-napcat.bak`), false);
    assert.equal(existsSync(fixture.envFile), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('macOS NapCat installer fails closed on a release digest mismatch', () => {
  const fixture = createFixture();
  try {
    const original = readFileSync(fixture.packageFile, 'utf8');
    const result = invoke(fixture, ['install', '--no-start'], {
      NAPCAT_MIN_QQ_BUILD: '0',
      NAPCAT_SHELL_DIGEST: `sha256:${'0'.repeat(64)}`,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA-256 校验失败/);
    assert.equal(readFileSync(fixture.packageFile, 'utf8'), original);
    assert.equal(existsSync(`${fixture.packageFile}.mimi-napcat.bak`), false);
    assert.equal(existsSync(fixture.envFile), false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
