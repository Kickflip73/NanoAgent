import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 12;
const queues = new Map<string, Promise<void>>();

class InvalidStateFileError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export class StateFileCorruptError extends Error {
  constructor(
    readonly file: string,
    readonly backup: string,
    options: { cause: unknown },
  ) {
    super(`状态文件损坏，已隔离到 ${backup}`, options);
    this.name = 'StateFileCorruptError';
  }
}

export interface AtomicJsonStoreOptions<T> {
  defaultValue: () => T;
  decode?: (value: unknown) => T;
  pretty?: boolean;
  recoverCorrupt?: boolean;
}

function isCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException).code === code;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('状态文件操作已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  queues.set(key, tail);
  void tail.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, 'ESRCH');
  }
}

export async function withExclusiveFileLock<R>(
  file: string,
  operation: () => Promise<R>,
  signal?: AbortSignal,
): Promise<R> {
  const digest = createHash('sha256').update(path.resolve(file)).digest('hex');
  const lockTarget = path.join(os.tmpdir(), 'nano-agent-file-locks', digest);
  return enqueue(`external:${lockTarget}`, async () => {
    const release = await acquireLock(lockTarget, signal);
    let failed = false;
    try {
      return await operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await release();
      } catch (error) {
        if (!failed) throw error;
      }
    }
  });
}

interface LockMetadata {
  token: string;
  pid: number;
}

function parseLockMetadata(source: string): LockMetadata | undefined {
  try {
    const value = JSON.parse(source) as { token?: unknown; pid?: unknown };
    if (typeof value.token !== 'string' || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) return undefined;
    return { token: value.token, pid: Number(value.pid) };
  } catch {
    return undefined;
  }
}

async function removeObservedLock(
  lockFile: string,
  observed: { dev: number; ino: number; mtimeMs: number; size: number },
  token?: string,
  source?: string,
): Promise<boolean> {
  try {
    const [current, currentSource] = await Promise.all([stat(lockFile), readFile(lockFile, 'utf8')]);
    if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
    if (token) {
      if (parseLockMetadata(currentSource)?.token !== token) return false;
    } else if (currentSource !== source || current.mtimeMs !== observed.mtimeMs || current.size !== observed.size) {
      return false;
    }
    await rm(lockFile);
    return true;
  } catch (error) {
    return isCode(error, 'ENOENT');
  }
}

async function acquireLock(file: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const lockFile = `${file}.lock`;
  const reapFile = `${lockFile}.reap`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(file), 0o700).catch(() => undefined);

  while (true) {
    signal?.throwIfAborted();
    try {
      try {
        await stat(reapFile);
        throw Object.assign(new Error('状态锁正在回收'), { code: 'EEXIST' });
      } catch (gateError) {
        if (!isCode(gateError, 'ENOENT')) throw gateError;
      }
      const handle = await open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: Date.now() })}\n`, 'utf8');
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockFile, { force: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        let closeError: unknown;
        try {
          await handle.close();
        } catch (error) {
          closeError = error;
        }
        try {
          const current = JSON.parse(await readFile(lockFile, 'utf8')) as { token?: string };
          if (current.token === token) await rm(lockFile, { force: true });
        } catch (error) {
          if (!isCode(error, 'ENOENT')) throw error;
        }
        if (closeError) throw closeError;
      };
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      signal?.throwIfAborted();
      try {
        const reaper = await open(reapFile, 'wx', 0o600);
        let removed = false;
        try {
          await reaper.writeFile(`${JSON.stringify({ token, pid: process.pid })}\n`, 'utf8');
          const [source, info] = await Promise.all([readFile(lockFile, 'utf8'), stat(lockFile)]);
          const metadata = parseLockMetadata(source);
          const invalidAndOld = !metadata && Date.now() - info.mtimeMs > 5_000;
          const deadOwner = metadata && !processIsAlive(metadata.pid);
          if (deadOwner || invalidAndOld) {
            await rm(lockFile);
            removed = true;
          }
        } finally {
          await reaper.close().catch(() => undefined);
          await rm(reapFile, { force: true }).catch(() => undefined);
        }
        if (removed) continue;
      } catch (inspectionError) {
        if (isCode(inspectionError, 'ENOENT')) continue;
        if (!isCode(inspectionError, 'EEXIST')) throw inspectionError;
      }
      if (Date.now() >= deadline) throw new Error(`等待状态文件锁超时：${file}`, { cause: error });
      await wait(LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS), signal);
    }
  }
}

export class AtomicJsonStore<T> {
  readonly file: string;
  private readonly decode: (value: unknown) => T;
  private permissionsHardened = false;

  constructor(file: string, private readonly options: AtomicJsonStoreOptions<T>) {
    this.file = path.resolve(file);
    this.decode = options.decode ?? ((value) => value as T);
  }

  async read(): Promise<T> {
    await queues.get(this.file);
    try {
      return await this.readFromDisk();
    } catch (error) {
      if (!(error instanceof InvalidStateFileError)) throw error;
      return enqueue(this.file, async () => this.withLock(async () => {
        try {
          return await this.readFromDisk();
        } catch (latestError) {
          if (!(latestError instanceof InvalidStateFileError)) throw latestError;
          return this.recoverInvalidState(latestError);
        }
      }));
    }
  }

  update<R>(mutation: (value: T) => R | Promise<R>): Promise<R> {
    return this.updateWhen(async (value) => ({ result: await mutation(value), changed: true }));
  }

  updateWhen<R>(
    mutation: (value: T) => { result: R; changed: boolean } | Promise<{ result: R; changed: boolean }>,
  ): Promise<R> {
    return enqueue(this.file, async () => this.withLock(async () => {
      let value: T;
      try {
        value = await this.readFromDisk();
      } catch (error) {
        if (!(error instanceof InvalidStateFileError)) throw error;
        value = await this.recoverInvalidState(error);
      }
      const { result, changed } = await mutation(value);
      if (changed) await this.writeToDisk(value);
      return result;
    }));
  }

  replace(value: T, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return enqueue(this.file, async () => this.withLock(async () => {
      signal?.throwIfAborted();
      await this.assertNotBlocked();
      await this.writeToDisk(value, signal);
    }, signal));
  }

  private async withLock<R>(operation: () => Promise<R>, signal?: AbortSignal): Promise<R> {
    const release = await acquireLock(this.file, signal);
    let operationFailed = false;
    try {
      return await operation();
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await release();
      } catch (error) {
        if (!operationFailed) throw error;
      }
    }
  }

  private async readFromDisk(): Promise<T> {
    await this.assertNotBlocked();
    await this.hardenPermissions();
    let source: string;
    try {
      source = await readFile(this.file, 'utf8');
    } catch (error) {
      if (isCode(error, 'ENOENT')) return this.options.defaultValue();
      throw error;
    }
    try {
      return this.decode(JSON.parse(source));
    } catch (error) {
      throw new InvalidStateFileError(error);
    }
  }

  private async writeToDisk(value: T, signal?: AbortSignal): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const spacing = this.options.pretty === false ? undefined : 2;
      await writeFile(temporary, `${JSON.stringify(value, null, spacing)}\n`, { encoding: 'utf8', mode: 0o600 });
      signal?.throwIfAborted();
      await rename(temporary, this.file);
      this.permissionsHardened = true;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async quarantine(): Promise<string> {
    const backup = `${this.file}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await rename(this.file, backup);
    return backup;
  }

  private async recoverInvalidState(error: InvalidStateFileError): Promise<T> {
    if (this.options.recoverCorrupt) {
      await this.quarantine();
      return this.options.defaultValue();
    }
    const marker = this.corruptionMarker();
    let markerHandle;
    try {
      markerHandle = await open(
        marker,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await markerHandle.writeFile(`${JSON.stringify({ state: 'blocking', file: this.file })}\n`, 'utf8');
      await markerHandle.sync();
    } catch (markerError) {
      await markerHandle?.close().catch(() => undefined);
      throw new StateFileCorruptError(this.file, marker, { cause: markerError });
    }
    let backup = marker;
    try {
      backup = await this.quarantine();
      await markerHandle.truncate(0);
      await markerHandle.writeFile(`${JSON.stringify({ state: 'quarantined', backup })}\n`, 'utf8');
      await markerHandle.sync();
    } finally {
      await markerHandle.close().catch(() => undefined);
    }
    throw new StateFileCorruptError(this.file, backup, { cause: error.cause });
  }

  private corruptionMarker(): string {
    return `${this.file}.corrupt-state`;
  }

  private async assertNotBlocked(): Promise<void> {
    if (this.options.recoverCorrupt) return;
    const marker = this.corruptionMarker();
    try {
      await lstat(marker);
      const parsed = JSON.parse(await readFile(marker, 'utf8')) as { backup?: unknown };
      const backup = typeof parsed.backup === 'string' ? parsed.backup : marker;
      throw new StateFileCorruptError(this.file, backup, {
        cause: new Error('状态文件已标记为损坏，需要显式检查后再恢复'),
      });
    } catch (error) {
      if (isCode(error, 'ENOENT')) return;
      if (error instanceof StateFileCorruptError) throw error;
      throw new StateFileCorruptError(this.file, marker, { cause: error });
    }
  }

  private async hardenPermissions(): Promise<void> {
    if (this.permissionsHardened) return;
    await chmod(path.dirname(this.file), 0o700).catch(() => undefined);
    await chmod(this.file, 0o600).catch((error) => {
      if (!isCode(error, 'ENOENT')) throw error;
    });
    this.permissionsHardened = true;
  }
}
