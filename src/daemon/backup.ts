import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { backup as backupSqlite, DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import { mimiPaths } from './client-runtime.js';

const BACKUP_SCHEMA_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const DATA_FILES = [
  'MIMI.md',
  'plans.json',
  'teams.json',
  'execution-ledger.json',
] as const;
const DATA_DIRECTORIES = [
  'sessions',
  'isolated-sessions',
  'memory',
  'traces',
] as const;
const DAEMON_FILES = ['connectors.json', 'assistant.json'] as const;

interface BackupManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MimiBackupManifest {
  schemaVersion: number;
  createdAt: string;
  files: BackupManifestFile[];
}

export interface MimiBackupResult {
  directory: string;
  manifest: MimiBackupManifest;
  databaseIntegrity: 'ok';
}

export interface MimiRestoreResult {
  backupDirectory: string;
  dataRoot: string;
  daemonDataRoot: string;
  filesRestored: number;
  databaseIntegrity: 'ok';
}

function containedBy(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRelative(value: string): string {
  const normalized = value.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../') || normalized === '..') {
    throw new Error(`备份清单包含不安全路径：${value}`);
  }
  return normalized;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function copyProtectedFile(source: string, destination: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`备份源必须是普通文件且不能是符号链接：${source}`);
  }
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  return true;
}

async function copyProtectedTree(source: string, destination: string): Promise<boolean> {
  let info;
  try {
    info = await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`备份源必须是目录且不能是符号链接：${source}`);
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`备份源不能包含符号链接：${sourceEntry}`);
    if (entry.isDirectory()) await copyProtectedTree(sourceEntry, destinationEntry);
    else if (entry.isFile()) await copyProtectedFile(sourceEntry, destinationEntry);
    else throw new Error(`备份源包含不支持的文件类型：${sourceEntry}`);
  }
  return true;
}

async function manifestFiles(root: string): Promise<BackupManifestFile[]> {
  const files: BackupManifestFile[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`备份不能包含符号链接：${target}`);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) throw new Error(`备份包含不支持的文件类型：${target}`);
      const relative = safeRelative(path.relative(root, target));
      if (relative === MANIFEST_FILE) continue;
      const info = await stat(target);
      files.push({ path: relative, bytes: info.size, sha256: await sha256(target) });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertDatabaseIntegrity(databaseFile: string): void {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const rows = database.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>;
    if (rows.length !== 1 || String(Object.values(rows[0] ?? {})[0]) !== 'ok') {
      throw new Error('SQLite integrity_check 未通过');
    }
  } finally {
    database.close();
  }
}

async function backupDatabase(source: string, destination: string): Promise<void> {
  if (!await exists(source)) throw new Error('MimiAgent 数据库不存在，无法创建恢复备份');
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  try {
    await backupSqlite(database, destination);
  } finally {
    database.close();
  }
  await chmod(destination, 0o600);
  assertDatabaseIntegrity(destination);
}

export async function createMimiBackup(
  config: AppConfig,
  outputDirectory: string,
): Promise<MimiBackupResult> {
  const paths = mimiPaths(config);
  const target = path.resolve(outputDirectory);
  if (containedBy(target, config.dataRoot) || containedBy(target, paths.root)) {
    throw new Error('备份目录不能位于 MimiAgent 数据目录内部');
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  try {
    await backupDatabase(paths.database, path.join(target, 'daemon', 'mimi.db'));
    for (const file of DATA_FILES) {
      await copyProtectedFile(path.join(config.dataRoot, file), path.join(target, 'data', file));
    }
    for (const directory of DATA_DIRECTORIES) {
      await copyProtectedTree(path.join(config.dataRoot, directory), path.join(target, 'data', directory));
    }
    for (const file of DAEMON_FILES) {
      const source = file === 'connectors.json' ? paths.connectorsConfig : paths.assistantConfig;
      await copyProtectedFile(source, path.join(target, 'daemon', file));
    }
    const manifest: MimiBackupManifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      files: await manifestFiles(target),
    };
    await writeFile(path.join(target, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return { directory: target, manifest, databaseIntegrity: 'ok' };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): MimiBackupManifest {
  if (!value || typeof value !== 'object') throw new Error('备份清单格式无效');
  const candidate = value as Partial<MimiBackupManifest>;
  if (candidate.schemaVersion !== BACKUP_SCHEMA_VERSION || typeof candidate.createdAt !== 'string'
    || !Array.isArray(candidate.files)) {
    throw new Error('备份清单版本或字段无效');
  }
  const files = candidate.files.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('备份文件清单无效');
    const file = entry as Partial<BackupManifestFile>;
    if (typeof file.path !== 'string' || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('备份文件清单字段无效');
    }
    return { path: safeRelative(file.path), bytes: Number(file.bytes), sha256: file.sha256 };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error('备份清单包含重复路径');
  }
  return { schemaVersion: candidate.schemaVersion, createdAt: candidate.createdAt, files };
}

export async function verifyMimiBackup(directory: string): Promise<MimiBackupResult> {
  const root = path.resolve(directory);
  const manifest = parseManifest(JSON.parse(await readFile(path.join(root, MANIFEST_FILE), 'utf8')) as unknown);
  const actual = await manifestFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('备份文件集合、大小或摘要与清单不一致');
  }
  const database = path.join(root, 'daemon', 'mimi.db');
  if (!manifest.files.some((file) => file.path === 'daemon/mimi.db')) {
    throw new Error('备份缺少 MimiAgent 数据库');
  }
  assertDatabaseIntegrity(database);
  return { directory: root, manifest, databaseIntegrity: 'ok' };
}

async function copyManifestFiles(
  backupRoot: string,
  stagingDataRoot: string,
  stagingDaemonRoot: string,
  manifest: MimiBackupManifest,
): Promise<void> {
  for (const file of manifest.files) {
    const segments = file.path.split('/');
    const area = segments.shift();
    const relative = segments.join(path.sep);
    if (!relative || (area !== 'data' && area !== 'daemon')) {
      throw new Error(`备份包含未知目标：${file.path}`);
    }
    const destination = path.join(area === 'data' ? stagingDataRoot : stagingDaemonRoot, relative);
    await copyProtectedFile(path.join(backupRoot, ...file.path.split('/')), destination);
  }
}

export async function restoreMimiBackup(
  config: AppConfig,
  backupDirectory: string,
): Promise<MimiRestoreResult> {
  const verified = await verifyMimiBackup(backupDirectory);
  const paths = mimiPaths(config);
  const dataRoot = path.resolve(config.dataRoot);
  const daemonRoot = path.resolve(paths.root);
  if (path.resolve(paths.connectorsConfig) !== path.join(daemonRoot, 'connectors.json')
    || path.resolve(paths.assistantConfig) !== path.join(daemonRoot, 'assistant.json')) {
    throw new Error('恢复目标必须使用 Daemon 数据目录内的标准配置路径');
  }
  const daemonInsideData = daemonRoot !== dataRoot && containedBy(daemonRoot, dataRoot);
  const dataInsideDaemon = containedBy(dataRoot, daemonRoot);
  if (dataInsideDaemon) {
    throw new Error('恢复目标不能把工作数据目录放在 Daemon 数据目录内部');
  }
  if (await exists(dataRoot) || (!daemonInsideData && await exists(daemonRoot))) {
    throw new Error('恢复只允许写入不存在的空白数据目录');
  }
  await mkdir(path.dirname(dataRoot), { recursive: true, mode: 0o700 });
  if (!daemonInsideData) await mkdir(path.dirname(daemonRoot), { recursive: true, mode: 0o700 });
  const stagingDataRoot = path.join(path.dirname(dataRoot), `.${path.basename(dataRoot)}.restore-${randomUUID()}`);
  const stagingDaemonRoot = daemonInsideData
    ? path.join(stagingDataRoot, path.relative(dataRoot, daemonRoot))
    : path.join(path.dirname(daemonRoot), `.${path.basename(daemonRoot)}.restore-${randomUUID()}`);
  let dataCommitted = false;
  try {
    await mkdir(stagingDataRoot, { mode: 0o700 });
    await mkdir(stagingDaemonRoot, { recursive: daemonInsideData, mode: 0o700 });
    await copyManifestFiles(
      verified.directory,
      stagingDataRoot,
      stagingDaemonRoot,
      verified.manifest,
    );
    assertDatabaseIntegrity(path.join(stagingDaemonRoot, 'mimi.db'));
    await rename(stagingDataRoot, dataRoot);
    dataCommitted = true;
    if (!daemonInsideData) {
      try {
        await rename(stagingDaemonRoot, daemonRoot);
      } catch (error) {
        await rename(dataRoot, stagingDataRoot);
        dataCommitted = false;
        throw error;
      }
    }
    return {
      backupDirectory: verified.directory,
      dataRoot,
      daemonDataRoot: daemonRoot,
      filesRestored: verified.manifest.files.length,
      databaseIntegrity: 'ok',
    };
  } finally {
    if (!dataCommitted) await rm(stagingDataRoot, { recursive: true, force: true });
    await rm(stagingDaemonRoot, { recursive: true, force: true });
  }
}
