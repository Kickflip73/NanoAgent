import process from 'node:process';
import { MimiAgent } from '../runtime/mimi-agent.js';
import { configureAgentRuntime } from '../runtime/bootstrap.js';
import { MimiHost } from '../runtime/mimi-host.js';
import { AttentionEngine } from './attention.js';
import { KernelConnectorRuntime } from './connector-worker-rpc.js';
import { MimiDispatcher } from './dispatcher.js';
import {
  mimiRuntimeStreamEvent,
  mimiStreamEvent,
} from './live-events.js';
import { MimiStore } from './store.js';
import {
  taskWorkerControlSchema,
  taskWorkerInitSchema,
  restrictedTaskShellEnvironment,
  withTaskProviderCredential,
  type TaskWorkerControl,
  type TaskWorkerInit,
  type TaskWorkerOutput,
  taskProviderEnvironmentName,
} from './worker-protocol.js';
import { CodexCliTaskExecutor } from './codex-task-executor.js';

let dispatcher: MimiDispatcher | undefined;
let initialized = false;
let pendingCancel: Extract<TaskWorkerControl, { type: 'cancel' }> | undefined;
let pendingPause: Extract<TaskWorkerControl, { type: 'pause' }> | undefined;
let shutdownRequested = false;
let codexController: AbortController | undefined;

function send(message: TaskWorkerOutput): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send || !process.connected) {
      resolve();
      return;
    }
    process.send(message, () => resolve());
  });
}

async function run(raw: unknown): Promise<void> {
  if (initialized) return;
  const init = taskWorkerInitSchema.parse(raw);
  const secretValues = [
    init.providerCredential?.apiKey,
    init.embeddingCredential?.apiKey,
    ...Object.values(init.mcpEnvironment),
  ].filter((value): value is string => Boolean(value));
  const safeError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    return secretValues.reduce(
      (redacted, secret) => redacted.split(secret).join('[REDACTED]'),
      message,
    );
  };
  initialized = true;
  const store = new MimiStore(init.database);
  let host: MimiHost | undefined;
  const heartbeat = setInterval(() => {
    void send({ type: 'heartbeat', taskId: init.taskId, at: new Date().toISOString() });
  }, 10_000);
  heartbeat.unref();
  try {
    const task = store.getEvent(init.taskId);
    if (!task || task.executionLane !== 'task' || !task.sessionKey) {
      throw new Error(`后台任务不存在或缺少 Task Session：${init.taskId}`);
    }
    if (init.executor === 'codex') {
      await runCodexTask(init, store);
      return;
    }
    if (!init.providerCredential) throw new Error('Mimi Task worker 缺少 provider credential');
    const attention = await AttentionEngine.load(init.assistantConfig, store);
    let agent;
    const mcpEnvironment: Record<string, string> = init.enableMcp ? {
      ...init.mcpEnvironment,
      [taskProviderEnvironmentName(init.providerCredential.provider)]: init.providerCredential.apiKey,
      ...(init.embeddingCredential ? { OPENAI_API_KEY: init.embeddingCredential.apiKey } : {}),
    } : {};
    try {
      agent = await withTaskProviderCredential(init.providerCredential, async () => {
        const create = async () => {
          configureAgentRuntime(init.config);
          return MimiAgent.create(init.config, task.sessionKey, {
            protectRuntimePathsFromShell: true,
            shellEnvironment: restrictedTaskShellEnvironment(process.env),
            shellDetachedProcessGroup: false,
            restrictReadsToWorkspace: init.workspaceAccess === 'read',
            mcpEnvironment,
            enableMcp: init.enableMcp,
            releaseMcpEnvironmentAfterConnect: true,
          });
        };
        return init.embeddingCredential
          ? withTaskProviderCredential(init.embeddingCredential, create)
          : create();
      });
    } finally {
      if (init.providerCredential) init.providerCredential.apiKey = '';
      if (init.embeddingCredential) init.embeddingCredential.apiKey = '';
      for (const name of Object.keys(init.mcpEnvironment)) init.mcpEnvironment[name] = '';
      for (const name of Object.keys(mcpEnvironment)) mcpEnvironment[name] = '';
    }
    const payload = task.payload && typeof task.payload === 'object'
      ? task.payload as Record<string, unknown>
      : {};
    if (payload.strategy === 'team') await agent.switchMode('ultra');
    host = new MimiHost(agent, undefined, { maxConcurrentSessions: 1 });
    dispatcher = new MimiDispatcher(store, host, attention, undefined, undefined, {
      maxConcurrentEvents: 1,
      claimExecutionLane: 'task',
      connectorRuntime: new KernelConnectorRuntime(init.socket, init.taskId, init.workerToken),
      onStreamEvent: (eventId, event) => {
        const streamed = mimiStreamEvent(event);
        if (streamed) void send({ type: 'stream', taskId: eventId, event: streamed });
      },
      onRuntimeEvent: (eventId, event) => {
        const streamed = mimiRuntimeStreamEvent(event);
        if (streamed) void send({ type: 'stream', taskId: eventId, event: streamed });
      },
    });
    if (pendingCancel) dispatcher.cancel(pendingCancel.taskId, pendingCancel.reason);
    else if (pendingPause) dispatcher.pause(pendingPause.taskId, pendingPause.reason);
    if (shutdownRequested) {
      await dispatcher.stop();
      return;
    }
    await send({
      type: 'started',
      taskId: init.taskId,
      workerId: dispatcher.workerId,
      pid: process.pid,
    });
    const processed = await dispatcher.processEventById(init.taskId);
    await send({
      type: 'done',
      taskId: init.taskId,
      processed,
      status: store.getEvent(init.taskId)?.status,
    });
  } catch (error) {
    try {
      const task = store.getEvent(init.taskId);
      if (task?.executionLane === 'task' && task.status === 'queued') {
        const bootstrapOwner = `task-bootstrap-${process.pid}`;
        const claimed = store.claimEventById(init.taskId, bootstrapOwner);
        if (claimed) {
          store.failEvent(
            init.taskId,
            bootstrapOwner,
            new Error(`Task worker 初始化失败：${safeError(error)}`),
          );
        }
      }
    } catch (failureError) {
      process.stderr.write(`[MimiAgent] 无法持久化 Task worker 初始化失败：${safeError(failureError)}\n`);
    }
    await send({
      type: 'error',
      taskId: init.taskId,
      error: safeError(error).slice(0, 4_000),
    });
    process.exitCode = 1;
  } finally {
    if (init.providerCredential) init.providerCredential.apiKey = '';
    if (init.embeddingCredential) init.embeddingCredential.apiKey = '';
    for (const name of Object.keys(init.mcpEnvironment)) init.mcpEnvironment[name] = '';
    clearInterval(heartbeat);
    await host?.close().catch(() => undefined);
    store.close();
    process.removeAllListeners('message');
    process.disconnect?.();
  }
}

async function runCodexTask(
  init: TaskWorkerInit,
  store: MimiStore,
): Promise<void> {
  const workerId = `codex-${process.pid}-${init.taskId.slice(0, 8)}`;
  const claimed = store.claimEventById(init.taskId, workerId, 60_000);
  if (!claimed) {
    throw new Error(`Codex Task ${init.taskId} 无法取得执行租约`);
  }
  await send({ type: 'started', taskId: init.taskId, workerId, pid: process.pid });
  const lease = setInterval(() => {
    try {
      const control = store.taskControl(init.taskId);
      if (control) {
        codexController?.abort(new Error(control.reason));
      } else if (!store.renewEventLease(init.taskId, workerId, 60_000)) {
        codexController?.abort(new Error('Codex Task 租约已失效'));
      }
    } catch (error) {
      codexController?.abort(error);
    }
  }, 10_000);
  lease.unref();
  codexController = new AbortController();
  const payload = claimed.payload && typeof claimed.payload === 'object'
    ? claimed.payload as Record<string, unknown>
    : {};
  const codexState = payload.codex && typeof payload.codex === 'object' && !Array.isArray(payload.codex)
    ? payload.codex as Record<string, unknown>
    : {};
  const pendingControl = pendingCancel ?? pendingPause;
  if (pendingControl) codexController.abort(new Error(pendingControl.reason));
  try {
    const result = await new CodexCliTaskExecutor().execute({
      objective: typeof payload.objective === 'string' ? payload.objective : String(payload.prompt ?? ''),
      successCriteria: typeof payload.successCriteria === 'string' ? payload.successCriteria : undefined,
      context: typeof payload.context === 'string' ? payload.context : undefined,
      workspaceRoot: init.config.workspaceRoot,
      workspaceAccess: init.workspaceAccess,
      threadId: typeof codexState.threadId === 'string' ? codexState.threadId : undefined,
      signal: codexController.signal,
      onProgress: (event) => {
        const type = typeof event.type === 'string' ? event.type : 'progress';
        if (type === 'thread.started' && typeof event.thread_id === 'string') {
          store.checkpointCodexTask(init.taskId, workerId, event.thread_id);
        }
        void send({
          type: 'stream', taskId: init.taskId,
          event: {
            kind: 'status',
            tone: type === 'turn.failed' ? 'failure' : 'agent',
            title: `Codex · ${type}`,
            detail: JSON.stringify(event).slice(0, 1_000),
            next: 'Codex 后台执行中，完成后交回 MimiAgent 验收',
          },
        });
      },
    });
    store.handoffCodexTaskToMimi(init.taskId, workerId, result);
  } catch (error) {
    const current = store.getEvent(init.taskId);
    if (current?.taskControl) {
      store.failEvent(init.taskId, workerId, error);
    } else if (shutdownRequested) {
      store.preemptEvent(init.taskId, workerId, 'Codex worker 正在停止，任务已安全重排队');
    } else {
      store.handoffCodexTaskToMimi(init.taskId, workerId, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    clearInterval(lease);
    codexController = undefined;
  }
  await send({
    type: 'done', taskId: init.taskId, processed: true,
    status: store.getEvent(init.taskId)?.status,
  });
}

process.on('message', (raw: unknown) => {
  if (!initialized) {
    void run(raw);
    return;
  }
  const parsed = taskWorkerControlSchema.safeParse(raw);
  if (!parsed.success) return;
  if (parsed.data.type === 'cancel') {
    if (dispatcher) dispatcher.cancel(parsed.data.taskId, parsed.data.reason);
    else if (codexController) codexController.abort(new Error(parsed.data.reason));
    else pendingCancel = parsed.data;
    return;
  }
  if (parsed.data.type === 'pause') {
    if (dispatcher) dispatcher.pause(parsed.data.taskId, parsed.data.reason);
    else if (codexController) codexController.abort(new Error(parsed.data.reason));
    else pendingPause = parsed.data;
    return;
  }
  shutdownRequested = true;
  codexController?.abort(new Error('Codex Task worker 正在关闭'));
  void dispatcher?.stop();
});

process.on('disconnect', () => {
  shutdownRequested = true;
  codexController?.abort(new Error('Codex Task worker 与 Kernel 的 IPC 连接已断开'));
  dispatcher?.forceStop('Task worker 与 Kernel 的 IPC 连接已断开');
});

function forceStopForSignal(signal: NodeJS.Signals): void {
  shutdownRequested = true;
  codexController?.abort(new Error(`Codex Task worker 收到 ${signal}`));
  dispatcher?.forceStop(`Task worker 收到 ${signal}`);
}

process.on('SIGTERM', () => forceStopForSignal('SIGTERM'));
process.on('SIGINT', () => forceStopForSignal('SIGINT'));
