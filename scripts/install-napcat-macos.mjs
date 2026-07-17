#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_LABEL = 'com.mimiagent.napcat.qq';
const requestedTestLabel = process.env.NODE_ENV === 'test' ? process.env.NAPCAT_TEST_LAUNCH_LABEL : undefined;
const LABEL = requestedTestLabel && /^[A-Za-z0-9.-]{1,200}$/.test(requestedTestLabel)
  ? requestedTestLabel
  : DEFAULT_LABEL;
const DEFAULT_QQ_APP = '/Applications/QQ.app';
const DEFAULT_MIN_QQ_BUILD = 40768;
const EXPECTED_QQ_TEAM_ID = 'FN2V63AD2J';
const RELEASE_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest';
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const ORIGINAL_LOADERS = new Set([
  './application.asar/app_launcher/index.js',
  './application/app_launcher/index.js',
  './app_launcher/index.js',
]);

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const flags = new Set(args.slice(1));
const home = resolve(process.env.HOME || homedir());
const installerStateFile = resolve(process.env.NAPCAT_INSTALLER_STATE_FILE
  || join(home, '.mimi-agent', 'napcat-installer.json'));
const rememberedState = !process.env.NAPCAT_QQ_APP && existsSync(installerStateFile)
  ? readJson(installerStateFile, 'NapCat 安装器状态')
  : undefined;
const rememberedQqApp = rememberedState?.qqApp;
if (rememberedQqApp !== undefined && (typeof rememberedQqApp !== 'string' || !isAbsolute(rememberedQqApp))) {
  fail('NapCat 安装器状态中的 qqApp 必须是绝对路径');
}
const qqApp = resolve(process.env.NAPCAT_QQ_APP || rememberedQqApp || DEFAULT_QQ_APP);
const qqResources = join(qqApp, 'Contents', 'Resources', 'app');
const qqBinary = join(qqApp, 'Contents', 'MacOS', 'QQ');
const systemQqApp = resolve(process.env.NAPCAT_SYSTEM_QQ_APP || DEFAULT_QQ_APP);
const systemQqBinary = join(systemQqApp, 'Contents', 'MacOS', 'QQ');
const packageFile = join(qqResources, 'package.json');
const backupFile = `${packageFile}.mimi-napcat.bak`;
const documentsDir = resolve(process.env.NAPCAT_DOCUMENTS_DIR
  || join(home, '.mimi-agent', 'runtime', 'qq'));
const shellDir = join(documentsDir, 'napcat');
const loaderFile = join(documentsDir, 'loadMimiNapCat.cjs');
const legacyDocumentsDir = join(home, 'Library', 'Containers', 'com.tencent.qq', 'Data', 'Documents');
const legacyLoaderFile = join(legacyDocumentsDir, 'loadMimiNapCat.cjs');
const legacyRunnerFile = join(documentsDir, 'runMimiNapCat.sh');
const runnerFile = resolve(process.env.NAPCAT_RUNNER_FILE
  || join(home, '.mimi-agent', 'runtime', 'qq', 'runMimiNapCat.sh'));
const workDir = resolve(process.env.NAPCAT_WORKDIR
  || join(home, '.mimi-agent', 'runtime', 'qq', 'napcat-workdir'));
const qrCodeFile = join(workDir, 'cache', 'qrcode.png');
const quickLoginFile = resolve(process.env.NAPCAT_QUICK_LOGIN_FILE
  || join(home, '.mimi-agent', 'runtime', 'qq', 'quick-login-account'));
const quickLoginEnabledFile = `${quickLoginFile}.enabled`;
const envFile = resolve(process.env.MIMI_ENV_FILE || join(home, '.mimi-agent', '.env'));
const launchAgentsDir = resolve(process.env.NAPCAT_LAUNCH_AGENTS_DIR || join(home, 'Library', 'LaunchAgents'));
const launchAgentFile = join(launchAgentsDir, `${LABEL}.plist`);
const logDir = resolve(process.env.NAPCAT_LOG_DIR || join(home, '.mimi-agent', 'logs', 'napcat'));
const patchedCodesign = process.env.NODE_ENV === 'test' && process.env.NAPCAT_TEST_CODESIGN_BIN
  ? resolve(process.env.NAPCAT_TEST_CODESIGN_BIN)
  : '/usr/bin/codesign';
const launchctlBin = process.env.NODE_ENV === 'test' && process.env.NAPCAT_TEST_LAUNCHCTL_BIN
  ? resolve(process.env.NAPCAT_TEST_LAUNCHCTL_BIN)
  : '/bin/launchctl';
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const launchDomain = `gui/${uid}`;
const launchUser = /^[A-Za-z0-9._-]+$/.test(process.env.USER || '') ? process.env.USER : 'user';
const launchTextEncoding = process.env.__CF_USER_TEXT_ENCODING
  || `0x${uid.toString(16).toUpperCase()}:0x0:0x0`;

function fail(message) {
  throw new Error(message);
}

function readJson(file, description = file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`${description} 必须是 JSON 对象`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes('必须是 JSON 对象')) throw error;
    fail(`无法读取 ${description}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeAtomic(file, contents, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(temporary, contents, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function run(executable, commandArgs, options = {}) {
  const result = spawnSync(executable, commandArgs, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`${executable} 执行失败${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function canWrite(file) {
  try {
    accessSync(file, constants.W_OK);
    accessSync(dirname(file), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let sudoValidated = false;
function ensureSudo() {
  if (sudoValidated || canWrite(packageFile)) return;
  process.stdout.write('需要一次管理员授权，以备份并修改 QQ 的 Electron 入口；密码只由 sudo 读取。\n');
  run('/usr/bin/sudo', ['-v'], { stdio: 'inherit' });
  sudoValidated = true;
}

function copyPrivileged(source, destination, mode = '0644') {
  if (canWrite(packageFile)) {
    const temporary = `${destination}.tmp-${process.pid}`;
    copyFileSync(source, temporary);
    chmodSync(temporary, Number.parseInt(mode, 8));
    renameSync(temporary, destination);
    return;
  }
  ensureSudo();
  const temporary = `${destination}.mimi-new-${process.pid}`;
  try {
    run('/usr/bin/sudo', ['/usr/bin/install', '-o', 'root', '-g', 'wheel', '-m', mode, source, temporary], { stdio: 'inherit' });
    run('/usr/bin/sudo', ['/bin/mv', '-f', temporary, destination], { stdio: 'inherit' });
  } catch (error) {
    run('/usr/bin/sudo', ['/bin/rm', '-f', temporary], { allowFailure: true });
    throw error;
  }
}

function copyBackup() {
  if (existsSync(backupFile)) return;
  if (canWrite(packageFile)) {
    copyFileSync(packageFile, backupFile, constants.COPYFILE_EXCL);
    chmodSync(backupFile, 0o644);
    return;
  }
  ensureSudo();
  run('/usr/bin/sudo', ['/bin/cp', '-p', packageFile, backupFile], { stdio: 'inherit' });
}

function managedMainFor(file) {
  let value = relative(qqResources, file).split(sep).join('/');
  if (!value.startsWith('.')) value = `./${value}`;
  return value;
}

function managedMain() {
  return managedMainFor(loaderFile);
}

function validateOriginalPackage(file, description) {
  const pkg = readJson(file, description);
  if (!ORIGINAL_LOADERS.has(pkg.main)) {
    fail(`${description} 的 main 不是已知 QQ 原始入口，拒绝覆盖: ${String(pkg.main)}`);
  }
  const build = Number.parseInt(String(pkg.buildVersion || ''), 10);
  if (!Number.isSafeInteger(build) || build <= 0) fail(`${description} 缺少有效 buildVersion`);
  return { pkg, build, main: pkg.main };
}

function inspectPackage() {
  if (!existsSync(packageFile) || !existsSync(qqBinary)) {
    fail(`未找到完整 QQ.app: ${qqApp}`);
  }
  const current = readJson(packageFile, 'QQ package.json');
  const currentMain = String(current.main || '');
  if (currentMain === managedMain() || currentMain === managedMainFor(legacyLoaderFile)) {
    if (!existsSync(backupFile)) fail('QQ 已指向 MimiAgent NapCat loader，但原始备份缺失；拒绝继续');
    const original = validateOriginalPackage(backupFile, 'QQ 原始备份');
    return { ...original, current, managed: true };
  }
  if (!ORIGINAL_LOADERS.has(currentMain)) {
    fail(`QQ package.json 已被其他工具修改，拒绝覆盖 main: ${currentMain}`);
  }
  const build = Number.parseInt(String(current.buildVersion || ''), 10);
  if (!Number.isSafeInteger(build) || build <= 0) fail('QQ package.json 缺少有效 buildVersion');
  if (existsSync(backupFile)) {
    const original = validateOriginalPackage(backupFile, 'QQ 原始备份');
    if (original.build !== build) {
      fail(`QQ 已升级到 build ${build}，但旧备份属于 build ${original.build}；请先人工核对备份`);
    }
  }
  return { pkg: current, build, main: currentMain, current, managed: false };
}

function verifyOfficialAppBeforePatch(state) {
  if (state.managed) return;
  if (process.env.NODE_ENV === 'test' && process.env.NAPCAT_TEST_ALLOW_UNSIGNED_QQ === '1') return;
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', qqApp]);
  const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', qqApp], { allowFailure: true });
  const signature = `${details.stdout || ''}\n${details.stderr || ''}`;
  if (details.status !== 0 || !signature.includes(`TeamIdentifier=${EXPECTED_QQ_TEAM_ID}`)) {
    fail(`QQ.app 不是预期的腾讯签名（TeamIdentifier=${EXPECTED_QQ_TEAM_ID}），拒绝修改`);
  }
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', qqApp]);
}

function parseEnv(contents) {
  return Object.fromEntries(contents.split(/\r?\n/).flatMap((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function upsertEnv(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, `${key}=${value}`);
  const prefix = contents && !contents.endsWith('\n') ? '\n' : '';
  return `${contents}${prefix}${key}=${value}\n`;
}

function ensureConnectorSecrets() {
  let contents = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const values = parseEnv(contents);
  const sharedToken = values.NC_ACCESS_TOKEN || randomBytes(32).toString('base64url');
  const httpUrl = values.NC_HTTP_URL || 'http://127.0.0.1:3000';
  const wsPort = values.NC_WS_PORT || '3080';
  let url;
  try {
    url = new URL(httpUrl);
  } catch {
    fail('NC_HTTP_URL 必须是有效 URL');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    fail('NC_HTTP_URL 必须是 loopback 明文 HTTP；NapCat 凭证不得暴露到局域网');
  }
  const httpPort = Number.parseInt(url.port || '80', 10);
  const reverseWsPort = Number.parseInt(wsPort, 10);
  if (![httpPort, reverseWsPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) {
    fail('NC_HTTP_URL/NC_WS_PORT 中的端口无效');
  }
  const wsToken = values.NC_WS_ACCESS_TOKEN || sharedToken;
  contents = upsertEnv(contents, 'NC_HTTP_URL', httpUrl);
  contents = upsertEnv(contents, 'NC_WS_PORT', String(reverseWsPort));
  contents = upsertEnv(contents, 'NC_ACCESS_TOKEN', sharedToken);
  contents = upsertEnv(contents, 'NC_WS_ACCESS_TOKEN', wsToken);
  writeAtomic(envFile, contents, 0o600);
  return { httpPort, reverseWsPort, sharedToken, wsToken };
}

function mergeOneBotConfig(file, secrets) {
  const config = existsSync(file) ? readJson(file, `NapCat 配置 ${file}`) : {};
  const network = config.network && typeof config.network === 'object' && !Array.isArray(config.network)
    ? config.network
    : {};
  const httpServers = Array.isArray(network.httpServers) ? network.httpServers : [];
  const websocketClients = Array.isArray(network.websocketClients) ? network.websocketClients : [];
  const managedHttpNames = new Set(['mimiagent-http', 'mimi-http']);
  const managedWsNames = new Set(['mimiagent-reverse-ws', 'mimi-reverse-ws']);
  const managedHttp = {
    name: 'mimiagent-http',
    enable: true,
    port: secrets.httpPort,
    host: '127.0.0.1',
    enableCors: false,
    enableWebsocket: false,
    messagePostFormat: 'array',
    token: secrets.sharedToken,
    debug: false,
  };
  const managedWs = {
    name: 'mimiagent-reverse-ws',
    enable: true,
    url: `ws://127.0.0.1:${secrets.reverseWsPort}/`,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    reconnectInterval: 5_000,
    token: secrets.wsToken,
    debug: false,
    heartInterval: 30_000,
  };
  network.httpServers = [...httpServers.filter((item) => !managedHttpNames.has(item?.name)), managedHttp];
  network.websocketClients = [...websocketClients.filter((item) => !managedWsNames.has(item?.name)), managedWs];
  network.httpSseServers = Array.isArray(network.httpSseServers) ? network.httpSseServers : [];
  network.httpClients = Array.isArray(network.httpClients) ? network.httpClients : [];
  network.websocketServers = Array.isArray(network.websocketServers) ? network.websocketServers : [];
  network.plugins = Array.isArray(network.plugins) ? network.plugins : [];
  config.network = network;
  writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

function configureOneBot(secrets) {
  const configDir = join(workDir, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const files = new Set([join(configDir, 'onebot11.json')]);
  const rememberedAccount = readQuickLoginAccount();
  if (rememberedAccount) {
    files.add(join(configDir, `onebot11_${rememberedAccount}.json`));
  } else {
    for (const name of readdirSync(configDir)) {
      if (/^onebot11_[0-9]+\.json$/.test(name)) files.add(join(configDir, name));
    }
  }
  for (const file of files) mergeOneBotConfig(file, secrets);
}

function readQuickLoginAccount() {
  if (!existsSync(quickLoginFile)) return undefined;
  const account = readFileSync(quickLoginFile, 'utf8').trim();
  return /^\d{5,20}$/.test(account) ? account : undefined;
}

function quickLoginSupported(state) {
  const version = String(state.current.version || '');
  const shellEntry = join(shellDir, 'napcat.mjs');
  if (!/^\d+\.\d+\.\d+-\d+$/.test(version) || !existsSync(shellEntry)) return false;
  return readFileSync(shellEntry, 'utf8').includes(`"${version}-${process.arch}"`);
}

function configureNapCatPrivacyAndQuickLogin(state) {
  const configDir = join(workDir, 'config');
  if (!existsSync(configDir)) return;
  const accountIds = new Set();
  const rememberedAccount = readQuickLoginAccount();
  const names = rememberedAccount
    ? [`napcat_${rememberedAccount}.json`]
    : readdirSync(configDir);
  for (const name of names) {
    const match = /^napcat_(\d{5,20})\.json$/.exec(name);
    if (!match) continue;
    accountIds.add(match[1]);
    const file = join(configDir, name);
    if (!existsSync(file)) continue;
    const config = readJson(file, `NapCat 配置 ${file}`);
    config.fileLog = false;
    config.consoleLog = false;
    writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  }
  if (accountIds.size === 1) {
    writeAtomic(quickLoginFile, `${[...accountIds][0]}\n`, 0o600);
  }
  if (accountIds.size === 1 && quickLoginSupported(state)) {
    writeAtomic(quickLoginEnabledFile, 'enabled\n', 0o600);
  } else {
    rmSync(quickLoginEnabledFile, { force: true });
  }
}

function configureInstalledOneBot() {
  const state = inspectPackage();
  if (!state.managed || !existsSync(join(shellDir, 'napcat.mjs'))) {
    fail('NapCat 尚未完整安装，不能配置 OneBot');
  }
  configureOneBot(ensureConnectorSecrets());
  configureNapCatPrivacyAndQuickLogin(state);
  createRunner();
  process.stdout.write('已原子更新 NapCat OneBot 配置、关闭消息正文日志并记录可用的快速登录账号。\n');
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function validateDigest(expected) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(expected || ''));
  if (!match) fail('NapCat Shell 缺少 GitHub SHA-256 digest，拒绝安装');
  return match[1].toLowerCase();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'MimiAgent-NapCat-Installer',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`GitHub API 请求失败: HTTP ${response.status}`);
  return response.json();
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'MimiAgent-NapCat-Installer' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) fail(`NapCat Shell 下载失败: HTTP ${response.status}`);
  const declared = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (declared > MAX_ARCHIVE_BYTES) fail('NapCat Shell 压缩包超过 256 MiB 上限');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0 || data.length > MAX_ARCHIVE_BYTES) fail('NapCat Shell 压缩包大小无效');
  writeFileSync(destination, data, { mode: 0o600 });
}

async function acquireArchive(temporaryDir) {
  const localArchive = process.env.NAPCAT_SHELL_ARCHIVE;
  if (localArchive) {
    const source = resolve(localArchive);
    if (!existsSync(source)) fail(`NAPCAT_SHELL_ARCHIVE 不存在: ${source}`);
    return {
      archive: source,
      digest: validateDigest(process.env.NAPCAT_SHELL_DIGEST),
      version: process.env.NAPCAT_RELEASE_VERSION || 'local-verified',
      releaseBody: '',
    };
  }
  const release = await fetchJson(RELEASE_API);
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate?.name === 'NapCat.Shell.zip')
    : undefined;
  if (!asset?.browser_download_url) fail('NapCat 最新 Release 缺少 NapCat.Shell.zip');
  const archive = join(temporaryDir, 'NapCat.Shell.zip');
  await downloadFile(asset.browser_download_url, archive);
  return {
    archive,
    digest: validateDigest(asset.digest),
    version: String(release.tag_name || release.name || 'unknown'),
    releaseBody: String(release.body || ''),
  };
}

function minimumBuild(releaseBody) {
  if (process.env.NAPCAT_MIN_QQ_BUILD !== undefined) {
    const configured = Number.parseInt(process.env.NAPCAT_MIN_QQ_BUILD, 10);
    if (!Number.isSafeInteger(configured) || configured < 0) fail('NAPCAT_MIN_QQ_BUILD 必须是非负整数');
    return configured;
  }
  const matches = [...releaseBody.matchAll(/最低(?:可以)?使用\D{0,20}(\d{5})/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter(Number.isSafeInteger);
  return matches.length > 0 ? Math.max(...matches) : DEFAULT_MIN_QQ_BUILD;
}

function validateArchiveEntries(archive) {
  const listed = run('/usr/bin/unzip', ['-Z1', archive]);
  const entries = String(listed.stdout).split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > 20_000) fail('NapCat Shell 压缩包目录无效');
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      fail(`NapCat Shell 压缩包包含不安全路径: ${entry}`);
    }
  }
}

function locateExtractedShell(extractDir) {
  if (existsSync(join(extractDir, 'napcat.mjs'))) return extractDir;
  const children = readdirSync(extractDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (children.length === 1) {
    const nested = join(extractDir, children[0].name);
    if (existsSync(join(nested, 'napcat.mjs'))) return nested;
  }
  fail('NapCat Shell 解压后缺少 napcat.mjs');
}

function installShell(archive, extractRoot) {
  validateArchiveEntries(archive);
  run('/usr/bin/ditto', ['-x', '-k', archive, extractRoot]);
  const extracted = locateExtractedShell(extractRoot);
  if (!existsSync(join(extracted, 'package.json'))) fail('NapCat Shell 解压后缺少 package.json');
  readJson(join(extracted, 'package.json'), 'NapCat Shell package.json');
  const previous = `${shellDir}.previous-${process.pid}`;
  mkdirSync(dirname(shellDir), { recursive: true, mode: 0o700 });
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(shellDir)) renameSync(shellDir, previous);
  try {
    renameSync(extracted, shellDir);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(shellDir, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, shellDir);
    throw error;
  }
}

function createLoader(originalMain) {
  const originalEntry = resolve(qqResources, originalMain);
  const shellEntry = join(shellDir, 'napcat.mjs');
  const contents = `'use strict';\n`
    + `const originalMain = ${JSON.stringify(originalMain)};\n`
    + `if (process.argv.includes('--no-sandbox')) {\n`
    + `  const { app } = require('electron');\n`
    + `  if (process.platform !== 'darwin' || typeof app?.setActivationPolicy !== 'function') {\n`
    + `    throw new Error('MimiAgent NapCat requires the macOS prohibited activation policy');\n`
    + `  }\n`
    + `  app.setActivationPolicy('prohibited');\n`
    + `  import(${JSON.stringify(pathToFileURL(shellEntry).href)}).catch((error) => { console.error(error); process.exitCode = 1; });\n`
    + `} else {\n`
    + `  require(${JSON.stringify(originalEntry)});\n`
    + `  setImmediate(() => {\n`
    + `    if (global.launcher?.installPathPkgJson) global.launcher.installPathPkgJson.main = originalMain;\n`
    + `  });\n`
    + `}\n`;
  writeAtomic(loaderFile, contents, 0o600);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function createRunner() {
  const expectedMain = managedMain();
  const shellEntry = join(shellDir, 'napcat.mjs');
  const contents = `#!/bin/sh\nset -eu\n`
    + `package_file=${shellQuote(packageFile)}\n`
    + `expected_main=${shellQuote(expectedMain)}\n`
    + `shell_entry=${shellQuote(shellEntry)}\n`
    + `qq_binary=${shellQuote(qqBinary)}\n`
    + `quick_login_file=${shellQuote(quickLoginFile)}\n`
    + `quick_login_enabled_file=${shellQuote(quickLoginEnabledFile)}\n`
    + `current_main=$(/usr/bin/sed -nE 's/^[[:space:]]*"main"[[:space:]]*:[[:space:]]*"([^"]+)".*$/\\1/p' "$package_file" | /usr/bin/head -n 1)\n`
    + `if [ "$current_main" != "$expected_main" ] || [ ! -f "$shell_entry" ]; then\n`
    + `  echo "MimiAgent NapCat guard: managed QQ entry or shell is missing; refusing to launch QQ UI." >&2\n`
    + `  exit 0\n`
    + `fi\n`
    + `if [ -r "$quick_login_file" ] && [ -f "$quick_login_enabled_file" ]; then\n`
    + `  quick_login=$(/bin/cat "$quick_login_file")\n`
    + `  case "$quick_login" in ''|*[!0-9]*) echo "MimiAgent NapCat guard: invalid quick-login account; refusing to launch." >&2; exit 0;; esac\n`
    + `  exec /usr/bin/script -q /dev/null "$qq_binary" --no-sandbox -- -q "$quick_login"\n`
    + `fi\n`
    + `exec /usr/bin/script -q /dev/null "$qq_binary" --no-sandbox\n`;
  writeAtomic(runnerFile, contents, 0o700);
  if (legacyRunnerFile !== runnerFile) rmSync(legacyRunnerFile, { force: true });
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function createLaunchAgent() {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  createRunner();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n`
    + `<plist version="1.0">\n<dict>\n`
    + `  <key>Label</key><string>${LABEL}</string>\n`
    + `  <key>ProgramArguments</key><array><string>${xml(runnerFile)}</string></array>\n`
    + `  <key>EnvironmentVariables</key><dict>`
    + `<key>HOME</key><string>${xml(home)}</string>`
    + `<key>LANG</key><string>C.UTF-8</string>`
    + `<key>LC_CTYPE</key><string>C.UTF-8</string>`
    + `<key>LOGNAME</key><string>${xml(launchUser)}</string>`
    + `<key>NAPCAT_WORKDIR</key><string>${xml(workDir)}</string>`
    + `<key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>`
    + `<key>SHELL</key><string>/bin/zsh</string>`
    + `<key>TMPDIR</key><string>${xml(tmpdir())}</string>`
    + `<key>USER</key><string>${xml(launchUser)}</string>`
    + `<key>__CF_USER_TEXT_ENCODING</key><string>${xml(launchTextEncoding)}</string>`
    + `</dict>\n`
    + `  <key>WorkingDirectory</key><string>${xml(home)}</string>\n`
    + `  <key>RunAtLoad</key><true/>\n`
    + `  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n`
    + `  <key>ThrottleInterval</key><integer>10</integer>\n`
    + `  <key>LimitLoadToSessionType</key><string>Aqua</string>\n`
    + `  <key>ProcessType</key><string>Interactive</string>\n`
    + `  <key>Umask</key><integer>63</integer>\n`
    + `  <key>StandardOutPath</key><string>/dev/null</string>\n`
    + `  <key>StandardErrorPath</key><string>/dev/null</string>\n`
    + `</dict>\n</plist>\n`;
  writeAtomic(launchAgentFile, plist, 0o600);
  run('/usr/bin/plutil', ['-lint', launchAgentFile]);
}

function stopLaunchAgent() {
  run(launchctlBin, ['bootout', `${launchDomain}/${LABEL}`], { allowFailure: true });
}

function normalQqIsRunning() {
  const processes = run('/bin/ps', ['-axo', 'command=']);
  const normalBinaries = new Set([qqBinary, systemQqBinary]);
  return String(processes.stdout).split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return [...normalBinaries].some((binary) => (
      (trimmed === binary || trimmed.startsWith(`${binary} `))
      && !trimmed.includes('--no-sandbox')
    ));
  });
}

function startLaunchAgent() {
  const state = inspectPackage();
  if (!state.managed || !existsSync(join(shellDir, 'napcat.mjs'))) {
    fail('NapCat 尚未完整安装，不能启动');
  }
  if (normalQqIsRunning()) {
    fail('检测到普通 QQ 正在运行；为避免抢焦点或打断操作，未退出 QQ、也未启动 NapCat。请先自行退出 QQ 一次，再执行 start');
  }
  createLaunchAgent();
  stopLaunchAgent();
  rmSync(qrCodeFile, { force: true });
  run(launchctlBin, ['bootstrap', launchDomain, launchAgentFile]);
  run(launchctlBin, ['kickstart', '-k', `${launchDomain}/${LABEL}`]);
}

function patchPackage(state) {
  copyBackup();
  const original = validateOriginalPackage(backupFile, 'QQ 原始备份');
  createLoader(original.main);
  const patched = { ...state.current, main: managedMain() };
  const temporaryDir = mkdtempSync(join(tmpdir(), 'mimi-napcat-package-'));
  const staged = join(temporaryDir, 'package.json');
  try {
    writeFileSync(staged, `${JSON.stringify(patched, null, 2)}\n`, { mode: 0o600 });
    copyPrivileged(staged, packageFile);
    const installed = readJson(packageFile, '已安装 QQ package.json');
    if (installed.main !== managedMain()) fail('QQ package.json 写入后校验失败');
  } catch (error) {
    if (existsSync(backupFile)) copyPrivileged(backupFile, packageFile);
    throw error;
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function signPatchedApp() {
  run(patchedCodesign, ['--force', '--deep', '--sign', '-', qqApp]);
  run(patchedCodesign, ['--verify', '--deep', '--strict', qqApp]);
}

async function install() {
  if (process.platform !== 'darwin') fail('此安装器仅支持 macOS');
  const state = inspectPackage();
  verifyOfficialAppBeforePatch(state);
  const temporaryDir = mkdtempSync(join(tmpdir(), 'mimi-napcat-install-'));
  try {
    const release = await acquireArchive(temporaryDir);
    const actualDigest = sha256(release.archive);
    if (actualDigest !== release.digest) fail('NapCat Shell SHA-256 校验失败，未修改 QQ');
    const requiredBuild = minimumBuild(release.releaseBody);
    if (state.build < requiredBuild) {
      fail(`当前 QQ build ${state.build} 低于 NapCat ${release.version} 要求的 ${requiredBuild}；请先从腾讯官方渠道升级 QQ`);
    }
    if (!flags.has('--no-start') && normalQqIsRunning()) {
      fail('检测到普通 QQ 正在运行；为避免抢焦点或打断操作，未退出 QQ、也未修改安装。请先自行退出 QQ 一次，再执行 install');
    }
    const extractRoot = join(temporaryDir, 'extracted');
    mkdirSync(extractRoot, { recursive: true, mode: 0o700 });
    const secrets = ensureConnectorSecrets();
    installShell(release.archive, extractRoot);
    configureOneBot(secrets);
    patchPackage(state);
    signPatchedApp();
    createLaunchAgent();
    writeAtomic(installerStateFile, `${JSON.stringify({ version: 1, qqApp }, null, 2)}\n`, 0o600);
    process.stdout.write(`NapCat ${release.version} 已安装；QQ 原始入口已备份到 ${backupFile}\n`);
    if (!flags.has('--no-start')) {
      startLaunchAgent();
      process.stdout.write('NapCat 已由用户级 LaunchAgent 在后台启动；未使用截图、OCR、键盘或点击。\n');
    } else {
      process.stdout.write('已按 --no-start 跳过启动。\n');
    }
  } finally {
    rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function restore() {
  stopLaunchAgent();
  rmSync(launchAgentFile, { force: true });
  const current = inspectPackage();
  if (!existsSync(backupFile)) {
    if (current.managed) fail('QQ 原始备份缺失，拒绝恢复');
    process.stdout.write('QQ 已使用原始入口，无需恢复。\n');
    return;
  }
  validateOriginalPackage(backupFile, 'QQ 原始备份');
  if (!current.managed && !ORIGINAL_LOADERS.has(String(current.current.main || ''))) {
    fail('QQ 入口已被其他工具修改，拒绝覆盖');
  }
  copyPrivileged(backupFile, packageFile);
  validateOriginalPackage(packageFile, '恢复后的 QQ package.json');
  rmSync(loaderFile, { force: true });
  if (legacyLoaderFile !== loaderFile) rmSync(legacyLoaderFile, { force: true });
  rmSync(runnerFile, { force: true });
  if (legacyRunnerFile !== runnerFile) rmSync(legacyRunnerFile, { force: true });
  process.stdout.write('已停止 MimiAgent NapCat LaunchAgent，并恢复 QQ 原始入口；NapCat 数据与备份保留。\n');
}

async function status() {
  let packageState;
  try {
    const inspected = inspectPackage();
    packageState = {
      present: true,
      build: inspected.build,
      managed: inspected.managed,
      main: String(inspected.current.main || ''),
    };
  } catch (error) {
    packageState = { present: false, error: error instanceof Error ? error.message : String(error) };
  }
  const launchctl = run(launchctlBin, ['print', `${launchDomain}/${LABEL}`], { allowFailure: true });
  const values = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const base = values.NC_HTTP_URL || 'http://127.0.0.1:3000';
  let httpReady = false;
  try {
    const headers = { 'content-type': 'application/json' };
    if (values.NC_ACCESS_TOKEN) headers.authorization = `Bearer ${values.NC_ACCESS_TOKEN}`;
    const response = await fetch(`${base.replace(/\/$/, '')}/get_status`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.json();
    httpReady = response.ok && (body?.status === 'ok' || body?.retcode === 0);
  } catch {}
  const report = {
    qq: packageState,
    backupPresent: existsSync(backupFile),
    shellPresent: existsSync(join(shellDir, 'napcat.mjs')),
    launchAgentInstalled: existsSync(launchAgentFile),
    launchAgentRunning: launchctl.status === 0,
    httpReady,
    paths: { qqApp, shellDir, workDir, launchAgentFile, installerStateFile },
  };
  if (flags.has('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    `QQ: ${packageState.present ? `build ${packageState.build}, ${packageState.managed ? 'NapCat 入口' : '原始入口'}` : packageState.error}`,
    `NapCat Shell: ${report.shellPresent ? '已安装' : '未安装'}`,
    `LaunchAgent: ${report.launchAgentRunning ? '运行中' : report.launchAgentInstalled ? '已安装但未运行' : '未安装'}`,
    `OneBot HTTP: ${httpReady ? 'ready' : 'unavailable'}`,
  ].join('\n') + '\n');
}

function usage() {
  process.stdout.write(`用法: node scripts/install-napcat-macos.mjs <command> [option]\n\n`
    + `  status [--json]       只读检查 QQ、NapCat、LaunchAgent 和 OneBot HTTP\n`
    + `  install [--no-start]  校验官方 Release digest、备份/修补 QQ 并后台启动\n`
    + `  configure             原子更新 OneBot 配置并迁移旧 Mimi 命名，不启动 QQ\n`
    + `  start                 通过用户级 LaunchAgent 后台启动，不打开或操控 QQ UI\n`
    + `  stop                  只停止 MimiAgent 管理的 NapCat LaunchAgent\n`
    + `  restore               停止 NapCat 并从精确备份恢复 QQ 原始入口\n`);
}

try {
  if (command === 'install') await install();
  else if (command === 'configure') configureInstalledOneBot();
  else if (command === 'start') startLaunchAgent();
  else if (command === 'stop') {
    stopLaunchAgent();
    process.stdout.write('已停止 MimiAgent 管理的 NapCat LaunchAgent。\n');
  } else if (command === 'restore' || command === 'uninstall') restore();
  else if (command === 'status') await status();
  else if (command === 'help' || command === '--help' || command === '-h') usage();
  else fail(`未知 command: ${command}`);
} catch (error) {
  process.stderr.write(`NapCat 安装器失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
