import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readFile, rm, writeFile,
  type FileHandle,
} from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';

interface RpcRequest {
  id: string;
  method: string;
  params?: unknown;
  auth?: string;
}

interface RpcResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type RpcHandler = (
  method: string,
  params: unknown,
  signal: AbortSignal,
  auth: string | undefined,
) => unknown | Promise<unknown>;

export interface MimiRpcOptions {
  controlAuth?: boolean;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

interface LockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockSnapshot {
  identity: FileIdentity;
  raw: string;
  record?: LockRecord;
}

interface OwnedLock {
  identity: FileIdentity;
  record: LockRecord;
}

type SocketProbe =
  | { state: 'occupied' }
  | { state: 'no_listener' }
  | { state: 'unknown'; error: Error };

const MAX_IPC_REQUEST_BYTES = 1024 * 1024;
const MAX_IPC_RESPONSE_BYTES = 8 * 1024 * 1024;
const CONTROL_TOKEN_FILE = 'control.token';
const CONTROL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function controlTokenPathForSocket(socketPath: string): string {
  return path.join(path.dirname(socketPath), CONTROL_TOKEN_FILE);
}

async function readProtectedControlToken(socketPath: string): Promise<string | undefined> {
  const file = controlTokenPathForSocket(socketPath);
  let handle: FileHandle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const metadata = await handle.stat();
    const currentUid = process.getuid?.();
    if (!metadata.isFile() || metadata.nlink !== 1
      || (currentUid !== undefined && metadata.uid !== currentUid)) {
      throw new Error('MimiAgent IPC 控制令牌文件身份无效');
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error('MimiAgent IPC 控制令牌文件权限必须是 0600');
    }
    const token = (await handle.readFile('utf8')).trim();
    if (!CONTROL_TOKEN_PATTERN.test(token)) throw new Error('MimiAgent IPC 控制令牌文件内容无效');
    return token;
  } finally {
    await handle.close();
  }
}

export async function ensureControlToken(socketPath: string): Promise<void> {
  const directory = path.dirname(socketPath);
  const file = controlTokenPathForSocket(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const token = randomBytes(32).toString('base64url');
  await writeFile(temporary, `${token}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await link(temporary, file);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  if (!await readProtectedControlToken(socketPath)) {
    throw new Error('MimiAgent IPC 控制令牌未创建');
  }
}

export async function readControlToken(socketPath: string): Promise<string | undefined> {
  return readProtectedControlToken(socketPath);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs;
}

function parseLockRecord(raw: string): LockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LockRecord>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.token !== 'string' || !value.token
      || typeof value.createdAt !== 'string') return undefined;
    return { pid: Number(value.pid), token: value.token, createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(socket: Socket, value: RpcResponse): void {
  if (socket.destroyed || socket.writableEnded || !socket.writable) return;
  let response = JSON.stringify(value);
  if (Buffer.byteLength(response) + 1 > MAX_IPC_RESPONSE_BYTES) {
    response = JSON.stringify({
      id: value.id,
      ok: false,
      error: 'IPC 响应超过 8MB，请缩小查询范围或使用详情接口',
    } satisfies RpcResponse);
  }
  socket.end(`${response}\n`);
}

function parseLine<T>(buffer: string, maximumBytes: number, label: string): T {
  if (Buffer.byteLength(buffer) > maximumBytes) throw new Error(`${label}超过 ${maximumBytes / (1024 * 1024)}MB`);
  return JSON.parse(buffer) as T;
}

export class MimiIpcServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private socketIdentity?: FileIdentity;
  private lock?: OwnedLock;
  private readonly lockPath: string;
  private readonly recoveryLockPath: string;

  constructor(readonly socketPath: string, private readonly handler: RpcHandler) {
    this.lockPath = `${socketPath}.lock`;
    this.recoveryLockPath = `${this.lockPath}.recovery`;
  }

  async start(): Promise<void> {
    if (this.server || this.lock) throw new Error(`MimiAgent IPC 已在启动：${this.socketPath}`);
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    this.lock = await this.acquireStartupLock();
    try {
      await this.removeStaleSocket();
      const server = net.createServer((socket) => this.accept(socket));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.socketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      await chmod(this.socketPath, 0o600);
      const identity = await this.fileIdentity(this.socketPath);
      if (!identity) throw new Error(`MimiAgent IPC Socket 未创建：${this.socketPath}`);
      this.socketIdentity = identity;
    } catch (error) {
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    try {
      if (server) {
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        if (server.listening) {
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
      }
    } finally {
      await this.removeOwnedSocket();
      await this.releaseStartupLock();
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const controller = new AbortController();
    const abort = (reason: Error) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    socket.once('close', () => {
      this.sockets.delete(socket);
      abort(new Error('IPC 客户端已断开'));
    });
    socket.setTimeout(30_000, () => {
      const error = new Error('IPC 连接超时');
      abort(error);
      socket.destroy(error);
    });
    socket.setEncoding('utf8');
    let input = '';
    let inputBytes = 0;
    socket.on('data', (chunk: string) => {
      input += chunk;
      inputBytes += Buffer.byteLength(chunk);
      if (!input.includes('\n') && inputBytes <= MAX_IPC_REQUEST_BYTES) return;
      socket.pause();
      socket.setTimeout(0);
      void (async () => {
        let request: RpcRequest | undefined;
        try {
          request = parseLine<RpcRequest>(input.split('\n', 1)[0]!, MAX_IPC_REQUEST_BYTES, 'IPC 请求');
          if (!request.id || !request.method) throw new Error('IPC 请求缺少 id 或 method');
          const auth = typeof request.auth === 'string' && request.auth.length <= 128
            ? request.auth
            : undefined;
          const result = await this.handler(request.method, request.params, controller.signal, auth);
          write(socket, { id: request.id, ok: true, result });
        } catch (error) {
          write(socket, {
            id: request?.id ?? 'invalid',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });
    socket.on('error', () => undefined);
  }

  private async removeStaleSocket(): Promise<void> {
    const candidate = await this.fileIdentity(this.socketPath);
    if (!candidate) return;
    const probe = await this.probeSocket();
    if (probe.state === 'occupied') throw new Error(`MimiAgent 已在运行：${this.socketPath}`);
    if (probe.state === 'unknown') throw this.unsafeSocketProbeError(probe.error);
    const current = await this.fileIdentity(this.socketPath);
    if (!current) return;
    if (!sameIdentity(current, candidate)) {
      throw new Error(`MimiAgent IPC Socket 在存活探测期间发生变化，拒绝清理：${this.socketPath}`);
    }
    await rm(this.socketPath, { force: true });
  }

  private async acquireStartupLock(): Promise<OwnedLock> {
    const record: LockRecord = {
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const recovery = await this.lockSnapshot(this.recoveryLockPath);
      if (recovery) {
        if (!recovery.record || !processIsLive(recovery.record.pid)) {
          await this.removeSnapshot(this.recoveryLockPath, recovery);
        }
        await delay(10);
        continue;
      }

      const acquired = await this.tryCreateLock(this.lockPath, record);
      if (acquired) return acquired;
      const existing = await this.lockSnapshot(this.lockPath);
      if (!existing) continue;
      if (existing.record && processIsLive(existing.record.pid)) {
        throw new Error(`MimiAgent 已在运行或启动中：${this.socketPath}`);
      }
      if (await this.socketIsOccupied()) throw new Error(`MimiAgent 已在运行：${this.socketPath}`);

      const recoveryRecord: LockRecord = {
        pid: process.pid,
        token: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      const recoveryLock = await this.tryCreateLock(this.recoveryLockPath, recoveryRecord);
      if (!recoveryLock) {
        await delay(10);
        continue;
      }
      try {
        const stale = await this.lockSnapshot(this.lockPath);
        if (stale?.record && processIsLive(stale.record.pid)) {
          throw new Error(`MimiAgent 已在运行或启动中：${this.socketPath}`);
        }
        if (await this.socketIsOccupied()) throw new Error(`MimiAgent 已在运行：${this.socketPath}`);
        if (stale) await this.removeSnapshot(this.lockPath, stale);
        const recovered = await this.tryCreateLock(this.lockPath, record);
        if (recovered) return recovered;
      } finally {
        await this.releaseLock(this.recoveryLockPath, recoveryLock);
      }
      await delay(10);
    }
    throw new Error(`MimiAgent 启动锁竞争超时：${this.lockPath}`);
  }

  private async tryCreateLock(file: string, record: LockRecord): Promise<OwnedLock | undefined> {
    const candidate = `${file}.${process.pid}.${record.token}.tmp`;
    await writeFile(candidate, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    try {
      await link(candidate, file);
    } catch (error) {
      await rm(candidate, { force: true });
      if (errorCode(error) === 'EEXIST') return undefined;
      throw error;
    }
    await rm(candidate, { force: true });
    const identity = await this.fileIdentity(file);
    if (!identity) throw new Error(`MimiAgent 启动锁未创建：${file}`);
    return { identity, record };
  }

  private async lockSnapshot(file: string): Promise<LockSnapshot | undefined> {
    try {
      const [raw, identity] = await Promise.all([readFile(file, 'utf8'), this.fileIdentity(file)]);
      if (!identity) return undefined;
      return { identity, raw, record: parseLockRecord(raw) };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async socketIsOccupied(): Promise<boolean> {
    const probe = await this.probeSocket();
    if (probe.state === 'unknown') throw this.unsafeSocketProbeError(probe.error);
    return probe.state === 'occupied';
  }

  private probeSocket(): Promise<SocketProbe> {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      const finish = (result: SocketProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => {
        const error = new Error(`MimiAgent IPC Socket 存活探测超时：${this.socketPath}`) as NodeJS.ErrnoException;
        error.code = 'ETIMEDOUT';
        finish({ state: 'unknown', error });
      }, 300);
      socket.once('connect', () => finish({ state: 'occupied' }));
      socket.once('error', (error) => {
        const code = errorCode(error);
        finish(code === 'ENOENT' || code === 'ECONNREFUSED'
          ? { state: 'no_listener' }
          : { state: 'unknown', error });
      });
    });
  }

  private unsafeSocketProbeError(cause: Error): Error {
    return new Error(
      `无法安全确认 MimiAgent IPC Socket 已失效，拒绝清理：${this.socketPath}（${cause.message}）`,
      { cause },
    );
  }

  private async removeSnapshot(file: string, expected: LockSnapshot): Promise<void> {
    const current = await this.lockSnapshot(file);
    if (!current || !sameIdentity(current.identity, expected.identity) || current.raw !== expected.raw) return;
    await rm(file, { force: true });
  }

  private async releaseLock(file: string, owned: OwnedLock): Promise<void> {
    const current = await this.lockSnapshot(file);
    if (!current || !sameIdentity(current.identity, owned.identity)
      || current.record?.token !== owned.record.token) return;
    await rm(file, { force: true });
  }

  private async releaseStartupLock(): Promise<void> {
    const lock = this.lock;
    this.lock = undefined;
    if (lock) await this.releaseLock(this.lockPath, lock);
  }

  private async removeOwnedSocket(): Promise<void> {
    const owned = this.socketIdentity;
    this.socketIdentity = undefined;
    if (!owned) return;
    const current = await this.fileIdentity(this.socketPath);
    if (current && sameIdentity(current, owned)) await rm(this.socketPath, { force: true });
  }

  private async fileIdentity(file: string): Promise<FileIdentity | undefined> {
    try {
      const stats = await lstat(file, { bigint: true });
      return { dev: stats.dev, ino: stats.ino, ctimeNs: stats.ctimeNs };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }
}

export async function mimiRpc<T = unknown>(
  socketPath: string,
  method: string,
  params?: unknown,
  timeoutMs = 5_000,
  signal?: AbortSignal,
  options: MimiRpcOptions = {},
): Promise<T> {
  signal?.throwIfAborted();
  const auth = options.controlAuth === false ? undefined : await readControlToken(socketPath);
  return await new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let requestWritten = false;
    const timer = setTimeout(() => socket.destroy(new MimiRpcError(
      method,
      'ETIMEDOUT',
      requestWritten ? 'response' : 'connect',
      requestWritten ? 'may_have_run' : 'not_sent',
      `MimiAgent IPC 超时：${method}`,
    )), timeoutMs);
    const onAbort = () => {
      const reason = signal?.reason;
      socket.destroy(reason instanceof Error ? reason : new Error(String(reason ?? 'MimiAgent IPC 已取消')));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    let output = '';
    let outputBytes = 0;
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      requestWritten = true;
      socket.write(`${JSON.stringify({
        id: randomId(), method, params, ...(auth ? { auth } : {}),
      } satisfies RpcRequest)}\n`);
    });
    socket.on('data', (chunk: string) => {
      output += chunk;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_IPC_RESPONSE_BYTES) {
        socket.destroy(new Error('MimiAgent IPC 响应超过 8MB'));
      }
    });
    socket.once('error', (error) => {
      cleanup();
      reject(error);
    });
    socket.once('end', () => {
      cleanup();
      try {
        if (!output.trim()) {
          const error = new Error(`MimiAgent IPC 连接在响应前关闭：${method}`) as NodeJS.ErrnoException;
          error.code = 'ECONNRESET';
          throw error;
        }
        const response = parseLine<RpcResponse>(
          output.split('\n', 1)[0]!,
          MAX_IPC_RESPONSE_BYTES,
          'IPC 响应',
        );
        if (!response.ok) reject(new Error(response.error ?? 'MimiAgent IPC 调用失败'));
        else resolve(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export type MimiRpcDelivery = 'not_sent' | 'may_have_run';
export type MimiRpcPhase = 'connect' | 'response';

export class MimiRpcError extends Error {
  readonly name = 'MimiRpcError';

  constructor(
    readonly method: string,
    readonly code: string,
    readonly phase: MimiRpcPhase,
    readonly delivery: MimiRpcDelivery,
    message: string,
  ) {
    super(message);
  }
}

function randomId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
