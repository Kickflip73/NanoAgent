import { randomUUID } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import { adoptWorkspaceConfig, type AppConfig } from '../config.js';
import {
  type BackgroundTaskCancelResult,
  type BackgroundTaskPauseResult,
  type BackgroundTaskResumeResult,
  type BackgroundTaskSummary,
  type CommandTarget,
} from '../commands.js';
import { runtimeEffectSchema, type RuntimeEffect } from '../runtime/control.js';
import { mimiRpc } from './ipc.js';
import {
  assertDaemonWorkspace,
  daemonProtocolAction,
  mimiPaths,
} from './client-runtime.js';
import type {
  DaemonStatus,
  MimiChatSnapshot,
  MimiHistoryChunk,
  MimiStreamEvent,
  MimiStreamTaskState,
  MimiStreamSnapshot,
  ImmutableEvent,
  TaskRecord,
} from './types.js';
import type { SessionSummary } from '../core/session.js';
import type { MemoryRef, MemoryScope } from '../core/memory.js';

const CHAT_RECONNECT_INITIAL_DELAY_MS = 50;
const CHAT_RECONNECT_MAX_DELAY_MS = 1_000;
const TRANSIENT_IPC_DISCONNECT_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOENT',
  'ENOTCONN',
  'EPIPE',
  'ETIMEDOUT',
]);

export type DaemonReconciler = (config: AppConfig, status: DaemonStatus) => Promise<DaemonStatus>;

export interface MimiChatClientOptions {
  submitTimeoutMs?: number;
  submitRetryDeadlineMs?: number;
  startDaemon?: (config: AppConfig) => Promise<DaemonStatus>;
}

async function defaultReconcileDaemon(config: AppConfig, status: DaemonStatus): Promise<DaemonStatus> {
  const expectedPermissionMode = config.permissionMode ?? 'trusted';
  if (daemonProtocolAction(status, expectedPermissionMode) === 'reuse') return status;
  const { reconcileMimiDaemon } = await import('./service.js');
  return reconcileMimiDaemon(config, status);
}

async function defaultStartDaemon(config: AppConfig): Promise<DaemonStatus> {
  const { startMimiDaemon } = await import('./service.js');
  return startMimiDaemon(config);
}

interface SubmitResponse {
  event: ImmutableEvent;
  task?: TaskRecord;
  inserted: boolean;
}

export interface AcceptedMimiEvent {
  eventId: string;
  inserted: boolean;
}

export type EventCancelResult =
  | { state: 'cancelled' }
  | { state: 'already_terminal' }
  | { state: 'not_found' };

export function eventAnswer(event: MimiStreamTaskState): string {
  const result = event.result;
  if (result && typeof result === 'object') {
    const answer = (result as Record<string, unknown>).answer;
    if (typeof answer === 'string' && answer.trim()) return answer.trim();
  }
  if (typeof result === 'string' && result.trim()) return result.trim();
  if (event.error) throw new Error(event.error);
  return `任务已结束，状态：${event.status}`;
}

export function eventEffects(event: MimiStreamTaskState): RuntimeEffect[] {
  const result = event.result;
  if (!result || typeof result !== 'object') return [];
  const effects = (result as Record<string, unknown>).effects;
  if (effects === undefined) return [];
  if (!Array.isArray(effects)) throw new Error(`MimiAgent 事件 ${event.id} 的 RuntimeEffect 格式无效`);
  return effects.map((effect) => runtimeEffectSchema.parse(effect));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('已停止等待'));
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('已停止等待'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('已停止等待'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('已停止等待'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function isTransientIpcDisconnect(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && TRANSIENT_IPC_DISCONNECT_CODES.has(code);
}

export class MimiChatClient {
  private readonly socket: string;
  private expectedWorkspaceRoot?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly reconcileDaemon: DaemonReconciler = defaultReconcileDaemon,
    private readonly options: MimiChatClientOptions = {},
  ) {
    this.socket = mimiPaths(config).socket;
  }

  async connect(): Promise<DaemonStatus> {
    let status: DaemonStatus;
    try {
      status = await mimiRpc<DaemonStatus>(this.socket, 'status', undefined, 2_000);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      status = await (this.options.startDaemon ?? defaultStartDaemon)(this.config);
    }
    return this.ensureCurrentDaemon(status);
  }

  async status(): Promise<DaemonStatus> {
    const status = await this.rpc<DaemonStatus>('status');
    return this.ensureCurrentDaemon(status);
  }

  async snapshot(limit = 30, sessionKey?: string): Promise<MimiChatSnapshot> {
    const snapshot = await this.rpc<MimiChatSnapshot>('chat.snapshot', {
      profileId: 'owner', limit, sessionKey,
    });
    this.assertWorkspace(snapshot.workspaceRoot);
    return snapshot;
  }

  async bootstrap(draftSessionId = `mimi-chat-${randomUUID()}`): Promise<MimiChatSnapshot> {
    const snapshot = await this.rpc<MimiChatSnapshot>('chat.bootstrap', { draftSessionId });
    this.assertWorkspace(snapshot.workspaceRoot);
    return snapshot;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return await this.rpc<SessionSummary[]>('chat.sessions');
  }

  async history(sessionKey?: string): Promise<AgentInputItem[]> {
    const chunks: string[] = [];
    let offset = 0;
    let revision: string | undefined;
    for (let page = 0; page < 10_000; page += 1) {
      const result = await this.rpc<MimiHistoryChunk>('chat.history', {
        profileId: 'owner', sessionKey, offset, revision,
      });
      if (revision && result.revision !== revision) throw new Error('Session 历史在读取期间发生变化，请重试 /history');
      revision = result.revision;
      chunks.push(result.chunk);
      if (result.nextOffset === undefined) {
        const parsed = JSON.parse(chunks.join('')) as unknown;
        if (!Array.isArray(parsed)) throw new Error('MimiAgent Session 历史格式无效');
        return parsed as AgentInputItem[];
      }
      if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset <= offset) {
        throw new Error('MimiAgent Session 历史游标无效');
      }
      offset = result.nextOffset;
    }
    throw new Error('MimiAgent Session 历史分页超过安全上限');
  }

  async invoke<T>(
    operation: string,
    value?: unknown,
    sessionKey?: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<T> {
    return await this.rpc<T>('chat.invoke', {
      operation, value, profileId: 'owner', sessionKey,
    }, timeoutMs, signal);
  }

  async submit(
    input: string,
    sessionKey?: string,
  ): Promise<AcceptedMimiEvent> {
    const eventId = randomUUID();
    const params = {
      text: input,
      source: 'local-cli',
      trust: 'owner',
      profileId: 'owner',
      sessionKey,
      eventId,
      externalId: `local-cli:${eventId}`,
    };
    const requestTimeoutMs = this.options.submitTimeoutMs ?? 5_000;
    const deadline = Date.now() + (this.options.submitRetryDeadlineMs ?? 24 * 60 * 60_000);
    let retryDelayMs = CHAT_RECONNECT_INITIAL_DELAY_MS;
    while (true) {
      try {
        const submitted = await mimiRpc<SubmitResponse>(
          this.socket,
          'submit',
          params,
          requestTimeoutMs,
        );
        if (!submitted.task) throw new Error('MimiAgent 没有为命令创建 Task');
        return { eventId: submitted.task.id, inserted: submitted.inserted };
      } catch (error) {
        if (!isTransientIpcDisconnect(error)) throw error;
        const acceptedEvent = await mimiRpc<ImmutableEvent | undefined>(
          this.socket,
          'event.get',
          { id: eventId },
          requestTimeoutMs,
        ).catch(() => undefined);
        if (acceptedEvent) {
          const receipt = await mimiRpc<{ taskIds: string[] } | undefined>(
            this.socket, 'event.route', { id: acceptedEvent.id }, requestTimeoutMs,
          ).catch(() => undefined);
          if (receipt?.taskIds[0]) return { eventId: receipt.taskIds[0], inserted: true };
        }
        if (Date.now() >= deadline) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ECONNREFUSED') {
          await this.connect().catch((connectError) => {
            if (!isTransientIpcDisconnect(connectError)) throw connectError;
          });
        }
        await delay(retryDelayMs);
        retryDelayMs = Math.min(CHAT_RECONNECT_MAX_DELAY_MS, retryDelayMs * 2);
      }
    }
  }

  async wait(
    eventId: string,
    signal?: AbortSignal,
    onStreamEvent?: (event: MimiStreamEvent) => void,
  ): Promise<MimiStreamTaskState> {
    const deadline = Date.now() + 24 * 60 * 60_000;
    let sequence = 0;
    let reconnectDelayMs = CHAT_RECONNECT_INITIAL_DELAY_MS;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const previousSequence = sequence;
      let snapshot: MimiStreamSnapshot;
      try {
        snapshot = await abortable(mimiRpc<MimiStreamSnapshot>(this.socket, 'event.stream', {
          id: eventId, after: sequence,
        }, 2_000), signal);
        reconnectDelayMs = CHAT_RECONNECT_INITIAL_DELAY_MS;
      } catch (error) {
        if (!isTransientIpcDisconnect(error)) throw error;
        let lastError: unknown = error;
        while (true) {
          signal?.throwIfAborted();
          if (Date.now() >= deadline) throw lastError;
          await delay(reconnectDelayMs, signal);
          reconnectDelayMs = Math.min(
            CHAT_RECONNECT_MAX_DELAY_MS,
            reconnectDelayMs * 2,
          );
          try {
            await abortable(this.connect(), signal);
            break;
          } catch (connectError) {
            if (!isTransientIpcDisconnect(connectError)) throw connectError;
            lastError = connectError;
          }
        }
        continue;
      }
      for (const streamed of snapshot.events) {
        sequence = Math.max(sequence, streamed.sequence);
        onStreamEvent?.(streamed);
      }
      if (snapshot.nextSequence !== undefined && Number.isSafeInteger(snapshot.nextSequence)) {
        sequence = Math.max(sequence, snapshot.nextSequence);
      }
      const event = snapshot.task;
      if (!event) throw new Error(`MimiAgent Task 不存在：${eventId}`);
      const terminal = [
        'paused', 'blocked', 'completed', 'failed', 'cancelled', 'dead_letter',
      ].includes(event.status);
      if (snapshot.hasMore && sequence > previousSequence) continue;
      if (terminal) return event;
      await delay(200, signal);
    }
    throw new Error(`等待 MimiAgent 任务超时：${eventId}`);
  }

  async cancel(eventId: string, reason?: string): Promise<EventCancelResult> {
    return await this.rpc<EventCancelResult>('task.cancel', { id: eventId, reason });
  }

  async listBackgroundTasks(limit = 20): Promise<BackgroundTaskSummary[]> {
    return await this.rpc<BackgroundTaskSummary[]>('tasks.list', { limit });
  }

  async inspectBackgroundTask(taskId: string): Promise<BackgroundTaskSummary> {
    return await this.rpc<BackgroundTaskSummary>('tasks.get', { id: taskId });
  }

  async cancelBackgroundTask(taskId: string, reason?: string): Promise<BackgroundTaskCancelResult> {
    return await this.rpc<BackgroundTaskCancelResult>('tasks.cancel', { id: taskId, reason });
  }

  async pauseBackgroundTask(taskId: string, reason?: string): Promise<BackgroundTaskPauseResult> {
    return await this.rpc<BackgroundTaskPauseResult>('tasks.pause', { id: taskId, reason });
  }

  async resumeBackgroundTask(taskId: string, context?: string): Promise<BackgroundTaskResumeResult> {
    return await this.rpc<BackgroundTaskResumeResult>('tasks.resume', { id: taskId, context });
  }

  private assertWorkspace(workspaceRoot: unknown): void {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      assertDaemonWorkspace(workspaceRoot, this.config.workspaceRoot);
    }
    this.expectedWorkspaceRoot = workspaceRoot;
  }

  private async rpc<T>(
    method: string,
    params?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await mimiRpc<T>(this.socket, method, params, timeoutMs, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      await this.connect();
      return await mimiRpc<T>(this.socket, method, params, timeoutMs, signal);
    }
  }

  private async ensureCurrentDaemon(status: DaemonStatus): Promise<DaemonStatus> {
    this.assertWorkspace(status.workspaceRoot);
    const expectedPermissionMode = this.config.permissionMode ?? 'trusted';
    const daemonConfig = this.expectedWorkspaceRoot
      ? adoptWorkspaceConfig(this.config, this.expectedWorkspaceRoot)
      : this.config;
    const upgraded = await this.reconcileDaemon(daemonConfig, status);
    this.assertWorkspace(upgraded.workspaceRoot);
    if (daemonProtocolAction(upgraded, expectedPermissionMode) !== 'reuse') {
      throw new Error('MimiAgent 后台升级后仍未使用当前协议版本。');
    }
    return upgraded;
  }
}

type CommandMethodResult<Key extends keyof CommandTarget> = CommandTarget[Key] extends (...args: infer _Arguments) => infer Result
  ? Awaited<Result>
  : never;

export class RemoteCommandTarget implements CommandTarget {
  private materialized: boolean;

  constructor(
    private readonly client: MimiChatClient,
    private sessionId: string,
    materialized = true,
  ) {
    this.materialized = materialized;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  get sessionReady(): boolean {
    return this.materialized;
  }

  markSessionReady(): void {
    this.materialized = true;
  }

  applyRuntimeEffects(effects: readonly RuntimeEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'session_changed') {
        this.sessionId = effect.sessionId;
        this.materialized = true;
      }
    }
  }

  get toolNames(): Promise<string[]> {
    return this.client.invoke<string[]>('tools', undefined, this.sessionId);
  }

  runtimeInfo(): Promise<CommandMethodResult<'runtimeInfo'>> {
    return this.client.invoke('runtime', undefined, this.sessionId);
  }

  availableModels(): Promise<CommandMethodResult<'availableModels'>> {
    return this.client.invoke('models', undefined, this.sessionId);
  }

  async switchModel(model: string): Promise<void> {
    await this.client.invoke('model.set', model, this.sessionId);
  }

  availableModes(): Promise<CommandMethodResult<'availableModes'>> {
    return this.client.invoke('modes', undefined, this.sessionId);
  }

  async switchMode(mode: string): Promise<void> {
    await this.client.invoke('mode.set', mode, this.sessionId);
  }

  async switchSession(sessionId: string): Promise<void> {
    const exists = (await this.client.listSessions()).some((session) => session.id === sessionId);
    if (!exists) throw new Error(`Session ${sessionId} 不存在`);
    await this.client.invoke('runtime', undefined, sessionId);
    this.sessionId = sessionId;
    this.materialized = true;
  }

  prepareNewSession(sessionId = `mimi-chat-${randomUUID()}`): void {
    this.sessionId = sessionId;
    this.materialized = false;
  }

  listSessionSummaries(): Promise<CommandMethodResult<'listSessionSummaries'>> {
    return this.client.listSessions();
  }

  async history(): Promise<CommandMethodResult<'history'>> {
    return this.client.history(this.sessionId);
  }

  async clearSession(): Promise<void> {
    await this.client.invoke('clear', undefined, this.sessionId);
  }

  listSkills(): Promise<CommandMethodResult<'listSkills'>> {
    return this.client.invoke('skills', undefined, this.sessionId);
  }

  reloadSkills(): Promise<CommandMethodResult<'reloadSkills'>> {
    return this.client.invoke('skills.reload', undefined, this.sessionId);
  }

  mcpStatuses(): Promise<CommandMethodResult<'mcpStatuses'>> {
    return this.client.invoke('mcp', undefined, this.sessionId);
  }

  reloadMcp(): Promise<CommandMethodResult<'reloadMcp'>> {
    return this.client.invoke('mcp.reload', undefined, this.sessionId);
  }

  contextInfo(): Promise<CommandMethodResult<'contextInfo'>> {
    return this.client.invoke('context', undefined, this.sessionId);
  }

  compactContext(): Promise<CommandMethodResult<'compactContext'>> {
    return this.client.invoke('compact', undefined, this.sessionId);
  }

  guidanceInfo(): Promise<CommandMethodResult<'guidanceInfo'>> {
    return this.client.invoke('instructions', undefined, this.sessionId);
  }

  memoryList(scope: MemoryScope | 'all' = 'all'): Promise<CommandMethodResult<'memoryList'>> {
    return this.client.invoke('memory.list', scope, this.sessionId);
  }

  memorySearch(query: string, scope: MemoryScope | 'all' = 'all'): Promise<CommandMethodResult<'memorySearch'>> {
    return this.client.invoke('memory.search', { query, scope }, this.sessionId);
  }

  memoryRead(ref: MemoryRef): Promise<CommandMethodResult<'memoryRead'>> {
    return this.client.invoke('memory.read', ref, this.sessionId);
  }

  memoryForget(ref: MemoryRef): Promise<CommandMethodResult<'memoryForget'>> {
    return this.client.invoke('memory.forget', ref, this.sessionId);
  }

  memoryIngest(target: string, signal?: AbortSignal): Promise<CommandMethodResult<'memoryIngest'>> {
    return this.client.invoke('memory.ingest', target, this.sessionId, 20 * 60_000, signal);
  }

  memoryCaptureRound(roundRef?: string): Promise<CommandMethodResult<'memoryCaptureRound'>> {
    return this.client.invoke('memory.capture', roundRef, this.sessionId);
  }

  memoryLint(): Promise<CommandMethodResult<'memoryLint'>> {
    return this.client.invoke('memory.lint', undefined, this.sessionId);
  }

  memoryConflicts(limit = 20): Promise<CommandMethodResult<'memoryConflicts'>> {
    return this.client.invoke('memory.conflicts', limit, this.sessionId);
  }

  memoryAudit(limit = 20): Promise<CommandMethodResult<'memoryAudit'>> {
    return this.client.invoke('memory.audit', limit, this.sessionId);
  }

  memoryMaintain(): Promise<unknown> {
    return this.client.invoke('memory.maintain', undefined, this.sessionId);
  }

  memoryReindex(): Promise<CommandMethodResult<'memoryReindex'>> {
    return this.client.invoke('memory.reindex', undefined, this.sessionId);
  }

  memoryStatus(): Promise<CommandMethodResult<'memoryStatus'>> {
    return this.client.invoke('memory.status', undefined, this.sessionId);
  }

  currentPlan(): Promise<CommandMethodResult<'currentPlan'>> {
    return this.client.invoke('plan', undefined, this.sessionId);
  }

  currentTeam(): Promise<CommandMethodResult<'currentTeam'>> {
    return this.client.invoke('team', undefined, this.sessionId);
  }

  currentGoal(): Promise<CommandMethodResult<'currentGoal'>> {
    return this.client.invoke('goal', undefined, this.sessionId);
  }

  setGoal(objective: string): Promise<CommandMethodResult<'setGoal'>> {
    return this.client.invoke('goal.set', objective, this.sessionId);
  }

  async resumePrompt(): Promise<string> {
    return (await this.client.invoke<{ prompt: string }>('resume', undefined, this.sessionId)).prompt;
  }

  listBackgroundTasks(limit = 20): Promise<BackgroundTaskSummary[]> {
    return this.client.listBackgroundTasks(limit);
  }

  inspectBackgroundTask(taskId: string): Promise<BackgroundTaskSummary> {
    return this.client.inspectBackgroundTask(taskId);
  }

  cancelBackgroundTask(taskId: string, reason?: string): Promise<BackgroundTaskCancelResult> {
    return this.client.cancelBackgroundTask(taskId, reason);
  }

  pauseBackgroundTask(taskId: string, reason?: string): Promise<BackgroundTaskPauseResult> {
    return this.client.pauseBackgroundTask(taskId, reason);
  }

  resumeBackgroundTask(taskId: string, context?: string): Promise<BackgroundTaskResumeResult> {
    return this.client.resumeBackgroundTask(taskId, context);
  }

  async setOutputLevel(level: string): Promise<void> {
    await this.client.invoke('output.set', level, this.sessionId);
  }
}

export interface RemoteRuntimeEffectHandlers {
  restoreSession: () => Promise<void>;
  resetSession: () => Promise<void>;
  close: () => void;
}

export async function synchronizeRemoteRuntimeEffects(
  target: RemoteCommandTarget,
  effects: readonly RuntimeEffect[],
  handlers: RemoteRuntimeEffectHandlers,
): Promise<void> {
  target.applyRuntimeEffects(effects);
  const latestSessionEffect = [...effects].reverse().find((effect) => (
    effect.type === 'session_changed' || effect.type === 'session_cleared'
  ));
  if (latestSessionEffect?.type === 'session_changed') await handlers.restoreSession();
  if (latestSessionEffect?.type === 'session_cleared') await handlers.resetSession();
  if (effects.some((effect) => effect.type === 'exit_requested')) handlers.close();
}
