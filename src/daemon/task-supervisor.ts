import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import type { AppConfig } from '../config.js';
import {
  collectTrustedMcpEnvironment,
  isMcpConfigurationTrusted,
} from '../extensions/mcp.js';
import type { PendingMimiStreamEvent } from './live-events.js';
import { MimiStore } from './store.js';
import type { EventCancelResult } from './dispatcher.js';
import type { BackgroundTaskPauseResult } from './task-tools.js';
import {
  restrictedTaskShellEnvironment,
  taskProviderEnvironmentName,
  taskWorkerOutputSchema,
  type TaskEmbeddingCredential,
  type TaskProviderCredential,
  type TaskWorkerControl,
  type TaskWorkerInit,
} from './worker-protocol.js';

interface WorkerRecord {
  taskId: string;
  workerToken: string;
  child: ChildProcess;
  workspaceAccess: 'read' | 'write';
  spawnedAt: number;
  workerId?: string;
  heartbeatAt?: string;
  terminating?: boolean;
  failureReason?: string;
  gracefulExit?: boolean;
  killTimer?: NodeJS.Timeout;
  exit: Promise<void>;
}

export interface TaskProcessSupervisorOptions {
  maxWorkers?: number;
  pollMs?: number;
  workerEntry?: string;
  redactEnvironmentKeys?: readonly string[] | (() => readonly string[]);
  workerStartTimeoutMs?: number;
  workerHeartbeatTimeoutMs?: number;
  workerKillGraceMs?: number;
  workerShutdownTimeoutMs?: number;
  onStreamEvent?: (eventId: string, event: PendingMimiStreamEvent) => void;
}

export interface TaskWorkerSnapshot {
  taskId: string;
  pid?: number;
  spawnedAt: string;
  workerId?: string;
  heartbeatAt?: string;
  workspaceAccess: 'read' | 'write';
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'dead_letter']);
const TASK_SAFE_BASE_ENVIRONMENT = new Set((process.platform === 'win32'
  ? ['PATH', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE']
  : ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL'])
  .map((name) => name.toUpperCase()));

export function taskWorkerEnvironment(
  source: NodeJS.ProcessEnv,
  redactEnvironmentKeys: readonly string[] = [],
): NodeJS.ProcessEnv {
  const redacted = new Set(redactEnvironmentKeys.map((key) => key.toUpperCase()));
  const bounded = {
    ...restrictedTaskShellEnvironment(source),
    ...Object.fromEntries(Object.entries(source).filter(([name]) => name.startsWith('TASK_WORKER_'))),
  };
  return Object.fromEntries(Object.entries(bounded)
    .filter(([name]) => !redacted.has(name.toUpperCase())));
}

function taskProviderCredential(config: AppConfig, source = process.env): TaskProviderCredential {
  const provider = config.provider;
  const name = taskProviderEnvironmentName(provider);
  const apiKey = source[name]?.trim();
  if (!apiKey) throw new Error(`Task worker 缺少 ${name}`);
  return { provider, apiKey };
}

function taskEmbeddingCredential(
  config: AppConfig,
  source = process.env,
): TaskEmbeddingCredential | undefined {
  if (config.provider !== 'deepseek') return undefined;
  const apiKey = source.OPENAI_API_KEY?.trim();
  return apiKey ? { provider: 'openai', apiKey } : undefined;
}

function hasOwnerConversationRoot(store: MimiStore, taskId: string): boolean {
  const task = store.getTask(taskId);
  return task !== undefined
    && store.getImmutableEvent(task.authorityEventId)?.trust === 'owner';
}

function equalWorkerToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function defaultTaskWorkerEntry(moduleUrl = import.meta.url): string {
  const extension = moduleUrl.endsWith('.ts') ? '.ts' : '.js';
  return fileURLToPath(new URL(`./task-worker-entry${extension}`, moduleUrl));
}

function loadsDotenv(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized === 'dotenv/config'
    || normalized === 'dotenv/config.js'
    || normalized.includes('/node_modules/dotenv/config');
}

export function taskWorkerExecArgv(source: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const argument = source[index]!;
    if (argument === '--env-file' || argument === '--env-file-if-exists') {
      index += 1;
      continue;
    }
    if (argument.startsWith('--env-file=') || argument.startsWith('--env-file-if-exists=')) continue;
    if (argument === '--require' || argument === '-r' || argument === '--import') {
      const value = source[index + 1];
      if (value !== undefined && loadsDotenv(value)) {
        index += 1;
        continue;
      }
      result.push(argument);
      if (value !== undefined) {
        result.push(value);
        index += 1;
      }
      continue;
    }
    const inlinePreload = /^(?:--require=|-r=|--import=)(.*)$/.exec(argument)
      ?? /^-r(.+)$/.exec(argument);
    if (inlinePreload && loadsDotenv(inlinePreload[1]!)) continue;
    result.push(argument);
  }
  return result;
}

export class TaskProcessSupervisor {
  private readonly workers = new Map<string, WorkerRecord>();
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private stopping = false;
  private pumpFaulted = false;
  private lastPumpErrorLogAt = 0;

  constructor(
    private readonly store: MimiStore,
    private readonly config: AppConfig,
    private readonly paths: { database: string; assistantConfig: string; socket: string },
    private readonly options: TaskProcessSupervisorOptions = {},
  ) {}

  start(): void {
    if (this.timer || this.stopping) return;
    const pollMs = Math.max(25, this.options.pollMs ?? 250);
    this.timer = setInterval(() => { void this.safePump(); }, pollMs);
    this.timer.unref();
    void this.safePump();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const shutdown = { type: 'shutdown' } satisfies TaskWorkerControl;
    for (const worker of this.workers.values()) this.sendControl(worker, shutdown);
    const workers = [...this.workers.values()];
    const shutdownTimers = workers.map((worker) => {
      const timer = setTimeout(
        () => this.terminateWorker(worker, '关闭超时'),
        Math.max(100, this.options.workerShutdownTimeoutMs ?? 5_000),
      );
      timer.unref();
      return timer;
    });
    try {
      await Promise.all(workers.map((worker) => worker.exit));
    } finally {
      for (const timer of shutdownTimers) clearTimeout(timer);
    }
  }

  status(): TaskWorkerSnapshot[] {
    return [...this.workers.values()].map((worker) => ({
      taskId: worker.taskId,
      pid: worker.child.pid,
      spawnedAt: new Date(worker.spawnedAt).toISOString(),
      workerId: worker.workerId,
      heartbeatAt: worker.heartbeatAt,
      workspaceAccess: worker.workspaceAccess,
    }));
  }

  authorizeWorker(taskId: string, workerToken: string): boolean {
    const worker = this.workers.get(taskId);
    if (!worker || !worker.workerId || !equalWorkerToken(worker.workerToken, workerToken)) return false;
    const task = this.store.getTask(taskId);
    const leaseUntil = Date.parse(task?.leaseUntil ?? '');
    return task?.status === 'running'
      && task.leaseOwner === worker.workerId
      && Number.isFinite(leaseUntil)
      && leaseUntil > Date.now();
  }

  authorizeWorkerAction(taskId: string, workerToken: string): boolean {
    const worker = this.workers.get(taskId);
    return worker?.workspaceAccess === 'write'
      && this.authorizeWorker(taskId, workerToken)
      && hasOwnerConversationRoot(this.store, taskId);
  }

  cancel(taskId: string, reason = 'owner 取消了后台任务'): EventCancelResult {
    const task = this.store.getTask(taskId);
    if (!task) return { state: 'not_found' };
    if (TERMINAL.has(task.status)) return { state: 'already_terminal' };
    this.store.cancelTask(taskId, reason);
    const worker = this.workers.get(taskId);
    if (worker) this.sendControl(worker, { type: 'cancel', taskId, reason });
    return { state: 'cancelled' };
  }

  pause(taskId: string, reason = 'owner 暂停了后台任务'): BackgroundTaskPauseResult {
    const task = this.store.getTask(taskId);
    if (!task) return { state: 'not_found' };
    if (task.status === 'paused') return { state: 'already_paused' };
    if (TERMINAL.has(task.status) || task.status === 'blocked') return { state: 'already_terminal' };
    const requested = this.store.pauseTask(taskId, reason);
    if (requested.controlIntent === 'cancel') return { state: 'not_pauseable' };
    const worker = this.workers.get(taskId);
    if (worker) this.sendControl(worker, { type: 'pause', taskId, reason });
    return { state: requested.status === 'paused' ? 'paused' : 'pause_requested' };
  }

  private async safePump(): Promise<void> {
    if (this.pumping || this.stopping) return;
    try {
      await this.pump();
      if (this.pumpFaulted) {
        process.stderr.write('[MimiAgent] Task supervisor 调度已恢复\n');
      }
      this.pumpFaulted = false;
      this.lastPumpErrorLogAt = 0;
    } catch (error) {
      const now = Date.now();
      if (!this.pumpFaulted || now - this.lastPumpErrorLogAt >= 5_000) {
        const summary = (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, ' ')
          .slice(0, 1_000);
        process.stderr.write(`[MimiAgent] Task supervisor 调度失败，将自动重试：${summary}\n`);
        this.lastPumpErrorLogAt = now;
      }
      this.pumpFaulted = true;
    }
  }

  private sendControl(worker: WorkerRecord, control: TaskWorkerControl): void {
    try {
      if (!worker.child.connected || !worker.child.send) return;
      worker.child.send(control, () => {
        // Running Task controls are durable before IPC. A closed channel is
        // recovered by the worker exit/lease path and must not fail the RPC.
      });
    } catch {
      // Best effort only; durable task_control is the source of truth.
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping) return;
    this.pumping = true;
    try {
      this.terminateStaleWorkers();
      const limit = Math.max(1, Math.min(8, this.options.maxWorkers ?? 2));
      const activeWorkers = [...this.workers.values()];
      if (activeWorkers.some((worker) => worker.workspaceAccess === 'write')) return;
      const available = limit - activeWorkers.length;
      if (available <= 0) return;
      const ready = this.store.readyTasks({
        types: ['background', 'scheduled', 'briefing', 'memory_maintenance'],
        executor: 'isolated_worker',
      }, 50)
        .filter((task) => !this.workers.has(task.id));
      if (ready.length === 0) return;
      const workspaceAccess = (task: (typeof ready)[number]): 'read' | 'write' => {
        return task.workspaceAccess === 'read' ? 'read' : 'write';
      };
      if (activeWorkers.length > 0) {
        if (ready.some((task) => workspaceAccess(task) === 'write')) return;
        for (const task of ready.slice(0, available)) await this.launch(task.id, 'read');
        return;
      }
      const firstAccess = workspaceAccess(ready[0]!);
      if (firstAccess === 'write') {
        await this.launch(ready[0]!.id, 'write');
        return;
      }
      const firstWriter = ready.findIndex((task) => workspaceAccess(task) === 'write');
      const readablePrefix = ready.slice(0, firstWriter < 0 ? ready.length : firstWriter);
      for (const task of readablePrefix.slice(0, available)) await this.launch(task.id, 'read');
    } finally {
      this.pumping = false;
    }
  }

  private async launch(taskId: string, workspaceAccess: 'read' | 'write'): Promise<void> {
    const entry = this.options.workerEntry ?? defaultTaskWorkerEntry();
    const redactEnvironmentKeys = typeof this.options.redactEnvironmentKeys === 'function'
      ? this.options.redactEnvironmentKeys()
      : this.options.redactEnvironmentKeys;
    let child: ChildProcess;
    let providerCredential: TaskProviderCredential | undefined;
    let embeddingCredential: TaskEmbeddingCredential | undefined;
    let mcpEnvironment: Record<string, string>;
    let enableMcp: boolean;
    let mcpEnvironmentKeys: string[];
    const task = this.store.getTask(taskId);
    const executor = task?.executor === 'codex' ? 'codex' as const : 'mimi' as const;
    try {
      providerCredential = executor === 'mimi' ? taskProviderCredential(this.config) : undefined;
      embeddingCredential = executor === 'mimi' ? taskEmbeddingCredential(this.config) : undefined;
      const mcpConfigurationTrusted = await isMcpConfigurationTrusted(
        this.config.mcpConfig,
        this.config.workspaceRoot,
        this.config.trustedWorkspaceMcp,
      );
      const declaredMcpEnvironment = mcpConfigurationTrusted
        ? await collectTrustedMcpEnvironment(
            this.config.mcpConfig,
            this.config.workspaceRoot,
            this.config.trustedWorkspaceMcp,
          )
        : {};
      mcpEnvironmentKeys = Object.keys(declaredMcpEnvironment)
        .filter((name) => !TASK_SAFE_BASE_ENVIRONMENT.has(name.toUpperCase()));
      enableMcp = executor === 'mimi' && mcpConfigurationTrusted
        && workspaceAccess === 'write'
        && hasOwnerConversationRoot(this.store, taskId);
      mcpEnvironment = enableMcp ? declaredMcpEnvironment : {};
      if (providerCredential) delete mcpEnvironment[taskProviderEnvironmentName(providerCredential.provider)];
      if (embeddingCredential) delete mcpEnvironment.OPENAI_API_KEY;
      if (this.stopping || this.store.getTask(taskId)?.status !== 'queued') return;
      child = fork(entry, [], {
        execArgv: taskWorkerExecArgv(process.execArgv),
        env: taskWorkerEnvironment(process.env, [
          ...(redactEnvironmentKeys ?? []),
          ...mcpEnvironmentKeys,
        ]),
        detached: process.platform !== 'win32',
        serialization: 'json',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    } catch (error) {
      this.persistLaunchFailure(taskId, error);
      return;
    }
    let resolveExit!: () => void;
    const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
    const workerToken = randomBytes(32).toString('base64url');
    const record: WorkerRecord = {
      taskId,
      workerToken,
      child,
      workspaceAccess,
      spawnedAt: Date.now(),
      exit,
    };
    this.workers.set(taskId, record);
    const secretValues = [
      providerCredential?.apiKey,
      embeddingCredential?.apiKey,
      ...Object.values(mcpEnvironment),
    ].filter((value): value is string => Boolean(value));
    const redact = (value: string) => secretValues.reduce(
      (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
      value,
    );
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      process.stderr.write(`[MimiAgent task ${taskId.slice(0, 8)}] ${redact(chunk)}`);
    });
    child.on('message', (raw: unknown) => {
      const parsed = taskWorkerOutputSchema.safeParse(raw);
      if (!parsed.success || parsed.data.taskId !== taskId) return;
      const message = parsed.data;
      if (message.type === 'started') {
        record.workerId = message.workerId;
        record.heartbeatAt = new Date().toISOString();
      } else if (message.type === 'heartbeat') {
        record.heartbeatAt = message.at;
      } else if (message.type === 'stream') {
        this.options.onStreamEvent?.(taskId, message.event as PendingMimiStreamEvent);
      } else if (message.type === 'error') {
        process.stderr.write(`[MimiAgent] background task ${taskId} failed: ${redact(message.error)}\n`);
      } else if (message.type === 'done') {
        record.gracefulExit = true;
      }
    });
    child.once('error', (error) => {
      record.failureReason = `进程启动失败：${error.message}`;
      process.stderr.write(`[MimiAgent] cannot start task worker ${taskId}: ${error.message}\n`);
    });
    child.once('close', (code, signal) => {
      if (!this.stopping) this.persistWorkerExit(record, code, signal);
      void this.cleanupWorkerProcessGroup(record).finally(() => {
        if (this.workers.get(taskId) === record) this.workers.delete(taskId);
        resolveExit();
        if (!this.stopping) void this.safePump();
      });
    });
    const init = {
      type: 'init',
      executor,
      taskId,
      database: this.paths.database,
      assistantConfig: this.paths.assistantConfig,
      socket: this.paths.socket,
      workerToken,
      workspaceAccess,
      enableMcp,
      providerCredential,
      embeddingCredential,
      mcpEnvironment,
      config: this.config,
    } satisfies TaskWorkerInit;
    child.send(init, (error) => {
      if (!error) return;
      record.failureReason = `初始化消息发送失败：${error.message}`;
      process.stderr.write(`[MimiAgent] task worker init failed ${taskId}: ${error.message}\n`);
    });
  }

  private persistWorkerExit(record: WorkerRecord, code: number | null, signal: NodeJS.Signals | null): void {
    if (record.gracefulExit) return;
    const task = this.store.getTask(record.taskId);
    if (!task || TERMINAL.has(task.status) || task.status === 'paused' || task.status === 'blocked') return;
    const reason = record.failureReason
      ?? (record.terminating ? 'Task worker 被运行时回收' : `Task worker 意外退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`);
    try {
      if (task.status === 'queued') {
        const bootstrapOwner = `task-supervisor-${process.pid}-${randomBytes(6).toString('hex')}`;
        const claimed = this.store.claimTaskById(record.taskId, bootstrapOwner);
        if (claimed) this.store.failTask(record.taskId, bootstrapOwner, new Error(reason));
        return;
      }
      if (task.status === 'running' && record.workerId && task.leaseOwner === record.workerId) {
        this.store.failTask(record.taskId, record.workerId, new Error(reason));
      }
    } catch (error) {
      process.stderr.write(`[MimiAgent] cannot persist task worker exit ${record.taskId}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private persistLaunchFailure(taskId: string, error: unknown): void {
    const owner = `task-supervisor-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      const claimed = this.store.claimTaskById(taskId, owner);
      if (claimed) this.store.failTask(taskId, owner, error);
    } catch (failure) {
      process.stderr.write(`[MimiAgent] cannot persist task worker launch failure ${taskId}: ${failure instanceof Error ? failure.message : String(failure)}\n`);
    }
  }

  private terminateStaleWorkers(now = Date.now()): void {
    const startTimeoutMs = Math.max(100, this.options.workerStartTimeoutMs ?? 45_000);
    const heartbeatTimeoutMs = Math.max(100, this.options.workerHeartbeatTimeoutMs ?? 45_000);
    for (const worker of this.workers.values()) {
      const heartbeatAt = worker.heartbeatAt ? Date.parse(worker.heartbeatAt) : worker.spawnedAt;
      const startExpired = !worker.workerId && now - worker.spawnedAt > startTimeoutMs;
      const heartbeatExpired = worker.workerId !== undefined && now - heartbeatAt > heartbeatTimeoutMs;
      if (startExpired || heartbeatExpired) {
        this.terminateWorker(
          worker,
          startExpired ? '启动超时' : '心跳超时',
        );
      }
    }
  }

  private terminateWorker(worker: WorkerRecord, reason: string): void {
    if (worker.terminating) return;
    worker.terminating = true;
    process.stderr.write(`[MimiAgent] task worker ${worker.taskId} ${reason}，正在回收进程\n`);
    this.signalWorkerProcessGroup(worker, 'SIGTERM');
    worker.killTimer = setTimeout(() => {
      this.signalWorkerProcessGroup(worker, 'SIGKILL');
    }, Math.max(100, this.options.workerKillGraceMs ?? 1_000));
    worker.killTimer.unref();
  }

  private signalWorkerProcessGroup(worker: WorkerRecord, signal: NodeJS.Signals): boolean {
    const pid = worker.child.pid;
    if (process.platform !== 'win32' && pid) {
      try {
        process.kill(-pid, signal);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        process.stderr.write(
          `[MimiAgent] cannot signal task worker group ${worker.taskId}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    return worker.child.kill(signal);
  }

  private workerProcessGroupExists(worker: WorkerRecord): boolean {
    const pid = worker.child.pid;
    if (process.platform === 'win32' || !pid) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async cleanupWorkerProcessGroup(worker: WorkerRecord): Promise<void> {
    if (worker.killTimer) clearTimeout(worker.killTimer);
    worker.killTimer = undefined;
    if (process.platform === 'win32' || !this.workerProcessGroupExists(worker)) return;
    this.signalWorkerProcessGroup(worker, 'SIGTERM');
    const graceMs = Math.max(100, this.options.workerKillGraceMs ?? 1_000);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && this.workerProcessGroupExists(worker)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
    }
    if (this.workerProcessGroupExists(worker)) this.signalWorkerProcessGroup(worker, 'SIGKILL');
  }
}
