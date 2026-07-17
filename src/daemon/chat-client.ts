import process from 'node:process';
import { randomUUID } from 'node:crypto';
import type { AgentInputItem } from '@openai/agents';
import { adoptWorkspaceConfig, preferredEnvironmentValue, type AppConfig } from '../config.js';
import { InteractiveTerminal, type CompletionItem } from '../interactive.js';
import {
  COMMANDS,
  CommandHandler,
  commandHelp,
  type BackgroundTaskCancelResult,
  type BackgroundTaskPauseResult,
  type BackgroundTaskResumeResult,
  type BackgroundTaskSummary,
  type CommandTarget,
} from '../commands.js';
import { runtimeEffectSchema, type RuntimeEffect } from '../runtime/control.js';
import {
  normalizeOutputLevel,
  OUTPUT_LEVELS,
  renderRecoveryCheckpoint,
  renderSessionTranscript,
  TerminalRenderer,
} from '../terminal.js';
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
  MimiMemoryContentChunk,
  MimiMemoryPage,
  MimiStreamEvent,
  MimiStreamEventState,
  MimiStreamSnapshot,
  StoredEvent,
} from './types.js';

const CHAT_COMMANDS: CompletionItem[] = [...COMMANDS];
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

type DaemonReconciler = (config: AppConfig, status: DaemonStatus) => Promise<DaemonStatus>;

export interface MimiChatClientOptions {
  submitTimeoutMs?: number;
  submitRetryDeadlineMs?: number;
}

async function defaultReconcileDaemon(config: AppConfig, status: DaemonStatus): Promise<DaemonStatus> {
  const { reconcileMimiDaemon } = await import('./service.js');
  return reconcileMimiDaemon(config, status);
}

async function defaultStartDaemon(config: AppConfig): Promise<DaemonStatus> {
  const { startMimiDaemon } = await import('./service.js');
  return startMimiDaemon(config);
}

const CHAT_HELP = `${commandHelp()}

这些命令作用于后台唯一 MimiAgent。/exit 只关闭当前终端。`;

interface SubmitResponse {
  event: StoredEvent;
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

function eventAnswer(event: MimiStreamEventState): string {
  const result = event.result;
  if (result && typeof result === 'object') {
    const answer = (result as Record<string, unknown>).answer;
    if (typeof answer === 'string' && answer.trim()) return answer.trim();
  }
  if (typeof result === 'string' && result.trim()) return result.trim();
  if (event.error) throw new Error(event.error);
  return event.status === 'digested'
    ? '该信息已进入 MimiAgent 摘要队列。'
    : `任务已结束，状态：${event.status}`;
}

export function eventEffects(event: MimiStreamEventState): RuntimeEffect[] {
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
  private readonly workspaceExplicitlyConfigured: boolean;
  private expectedWorkspaceRoot?: string;

  constructor(
    private readonly config: AppConfig,
    private readonly reconcileDaemon: DaemonReconciler = defaultReconcileDaemon,
    private readonly options: MimiChatClientOptions = {},
  ) {
    this.socket = mimiPaths(config).socket;
    this.workspaceExplicitlyConfigured = Boolean(
      preferredEnvironmentValue('MIMI_WORKSPACE', 'AGENT_WORKSPACE'),
    );
    if (this.workspaceExplicitlyConfigured) {
      this.expectedWorkspaceRoot = config.workspaceRoot;
    }
  }

  async connect(): Promise<DaemonStatus> {
    let status: DaemonStatus;
    try {
      status = await mimiRpc<DaemonStatus>(this.socket, 'status', undefined, 750);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      status = await defaultStartDaemon(this.config);
    }
    return this.ensureCurrentDaemon(status);
  }

  async status(): Promise<DaemonStatus> {
    const status = await mimiRpc<DaemonStatus>(this.socket, 'status');
    return this.ensureCurrentDaemon(status);
  }

  async snapshot(limit = 30, sessionKey?: string): Promise<MimiChatSnapshot> {
    const snapshot = await mimiRpc<MimiChatSnapshot>(this.socket, 'chat.snapshot', {
      profileId: 'owner', limit, sessionKey,
    });
    this.assertWorkspace(snapshot.workspaceRoot);
    return snapshot;
  }

  async history(sessionKey?: string): Promise<AgentInputItem[]> {
    const chunks: string[] = [];
    let offset = 0;
    let revision: string | undefined;
    for (let page = 0; page < 10_000; page += 1) {
      const result = await mimiRpc<MimiHistoryChunk>(this.socket, 'chat.history', {
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
    return await mimiRpc<T>(this.socket, 'chat.invoke', {
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
        return { eventId: submitted.event.id, inserted: submitted.inserted };
      } catch (error) {
        if (!isTransientIpcDisconnect(error)) throw error;
        const accepted = await mimiRpc<StoredEvent | undefined>(
          this.socket,
          'event.get',
          { id: eventId },
          requestTimeoutMs,
        ).catch(() => undefined);
        if (accepted) return { eventId: accepted.id, inserted: true };
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
  ): Promise<MimiStreamEventState> {
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
      const event = snapshot.event;
      if (!event) throw new Error(`MimiAgent 事件不存在：${eventId}`);
      const terminal = [
        'paused', 'blocked', 'completed', 'ignored', 'digested', 'dead_letter', 'archived',
      ].includes(event.status);
      if (snapshot.hasMore && sequence > previousSequence) continue;
      if (terminal) return event;
      await delay(200, signal);
    }
    throw new Error(`等待 MimiAgent 任务超时：${eventId}`);
  }

  async cancel(eventId: string, reason?: string): Promise<EventCancelResult> {
    return await mimiRpc<EventCancelResult>(this.socket, 'event.cancel', { id: eventId, reason });
  }

  async listBackgroundTasks(limit = 20): Promise<BackgroundTaskSummary[]> {
    return await mimiRpc<BackgroundTaskSummary[]>(this.socket, 'tasks.list', { limit });
  }

  async inspectBackgroundTask(taskId: string): Promise<BackgroundTaskSummary> {
    return await mimiRpc<BackgroundTaskSummary>(this.socket, 'tasks.get', { id: taskId });
  }

  async cancelBackgroundTask(taskId: string, reason?: string): Promise<BackgroundTaskCancelResult> {
    return await mimiRpc<BackgroundTaskCancelResult>(this.socket, 'tasks.cancel', { id: taskId, reason });
  }

  async pauseBackgroundTask(taskId: string, reason?: string): Promise<BackgroundTaskPauseResult> {
    return await mimiRpc<BackgroundTaskPauseResult>(this.socket, 'tasks.pause', { id: taskId, reason });
  }

  async resumeBackgroundTask(taskId: string, context?: string): Promise<BackgroundTaskResumeResult> {
    return await mimiRpc<BackgroundTaskResumeResult>(this.socket, 'tasks.resume', { id: taskId, context });
  }

  private assertWorkspace(workspaceRoot: unknown): void {
    if (this.expectedWorkspaceRoot) {
      assertDaemonWorkspace(workspaceRoot, this.expectedWorkspaceRoot);
      return;
    }
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      assertDaemonWorkspace(workspaceRoot, this.config.workspaceRoot);
    }
    this.expectedWorkspaceRoot = workspaceRoot;
  }

  private async ensureCurrentDaemon(status: DaemonStatus): Promise<DaemonStatus> {
    this.assertWorkspace(status.workspaceRoot);
    const expectedPermissionMode = this.config.permissionMode ?? 'trusted';
    const daemonConfig = !this.workspaceExplicitlyConfigured && this.expectedWorkspaceRoot
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
  constructor(
    private readonly client: MimiChatClient,
    private sessionId: string,
  ) {}

  get currentSessionId(): string {
    return this.sessionId;
  }

  applyRuntimeEffects(effects: readonly RuntimeEffect[]): void {
    for (const effect of effects) {
      if (effect.type === 'session_changed') this.sessionId = effect.sessionId;
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
    await this.client.invoke('runtime', undefined, sessionId);
    this.sessionId = sessionId;
  }

  listSessionSummaries(): Promise<CommandMethodResult<'listSessionSummaries'>> {
    return this.client.invoke('sessions');
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

  async listMemories(): Promise<CommandMethodResult<'listMemories'>> {
    const memories: MimiMemoryPage['items'] = [];
    let offset = 0;
    let revision: string | undefined;
    let total: number | undefined;
    while (true) {
      const page = await this.client.invoke<MimiMemoryPage>(
        'memories.page',
        { offset, revision },
        this.sessionId,
      );
      if (!Number.isSafeInteger(page.total) || page.total < 0 || (total !== undefined && page.total !== total)) {
        throw new Error('MimiAgent 返回了无效的长期记忆总数');
      }
      if (revision && page.revision !== revision) throw new Error('长期记忆在读取期间发生变化，请重试 /memories');
      revision = page.revision;
      total = page.total;
      for (let index = 0; index < page.items.length; index += 1) {
        if (page.items[index]?.index !== offset + index) {
          throw new Error('MimiAgent 返回了无效的长期记忆分页索引');
        }
      }
      memories.push(...page.items);
      const expectedOffset = offset + page.items.length;
      if (page.nextOffset === undefined) {
        if (expectedOffset !== page.total) throw new Error('MimiAgent 长期记忆分页提前结束');
        break;
      }
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset !== expectedOffset || page.nextOffset > page.total) {
        throw new Error('MimiAgent 返回了无效的长期记忆分页游标');
      }
      offset = page.nextOffset;
    }
    for (const memory of memories) {
      if (!memory.contentTruncated) continue;
      const chunks: string[] = [];
      let contentOffset = 0;
      while (true) {
        const result: MimiMemoryContentChunk = await this.client.invoke<MimiMemoryContentChunk>(
          'memory.content',
          { index: memory.index, id: memory.id, offset: contentOffset, revision },
          this.sessionId,
        );
        if (result.revision !== revision) throw new Error('长期记忆在读取期间发生变化，请重试 /memories');
        chunks.push(result.chunk);
        const expectedOffset = contentOffset + result.chunk.length;
        if (result.nextOffset === undefined) {
          if (expectedOffset !== result.totalCharacters) throw new Error('MimiAgent 长期记忆正文分页提前结束');
          break;
        }
        if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset !== expectedOffset) {
          throw new Error('MimiAgent 返回了无效的长期记忆正文游标');
        }
        contentOffset = result.nextOffset;
      }
      memory.content = chunks.join('');
      if (Buffer.byteLength(memory.content) !== memory.contentBytes) {
        throw new Error('MimiAgent 长期记忆正文长度校验失败');
      }
      memory.contentTruncated = false;
    }
    return memories;
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

  indexKnowledge(target = 'knowledge', signal?: AbortSignal): Promise<CommandMethodResult<'indexKnowledge'>> {
    return this.client.invoke('index', target, this.sessionId, 20 * 60_000, signal);
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

export function renderChatHistory(snapshot: MimiChatSnapshot, tty: boolean): string {
  return [
    renderSessionTranscript(snapshot.items, tty),
    renderRecoveryCheckpoint(snapshot.recovery, tty),
  ].filter(Boolean).join('\n\n');
}

function renderBanner(version: string, snapshot: MimiChatSnapshot): string {
  return [
    `MimiAgent v${version}`,
    '全天候个人 Agent · CLI 已连接统一后台',
    `模型    ${snapshot.provider} · ${snapshot.model}`,
    `对话    ${snapshot.sessionId}`,
    `工作区  ${snapshot.workspaceRoot}`,
  ].join('\n');
}

export async function runMimiCli(
  config: AppConfig,
  args: string[],
  version: string,
  reconcileDaemon: DaemonReconciler = defaultReconcileDaemon,
): Promise<void> {
  const client = new MimiChatClient(config, reconcileDaemon);
  await client.connect();
  const configuredSession = preferredEnvironmentValue('MIMI_SESSION', 'AGENT_SESSION');
  const oneShotInput = args.join(' ').trim();
  if (oneShotInput) {
    const current = await client.snapshot(30, configuredSession);
    const renderer = new TerminalRenderer(process.stderr, process.stdout, normalizeOutputLevel(current.outputLevel));
    renderer.start('模型思考中', oneShotInput);
    let streamedAnswer = '';
    try {
      const accepted = await client.submit(oneShotInput, current.sessionId);
      const event = await client.wait(accepted.eventId, undefined, (streamed) => {
        if (streamed.kind === 'plan') return;
        if (streamed.kind === 'answer') streamedAnswer += streamed.text;
        renderer.handleDisplay(streamed);
      });
      const answer = eventAnswer(event);
      if (!streamedAnswer) renderer.handleDisplay({ kind: 'answer', text: answer });
      else if (answer.startsWith(streamedAnswer)) {
        const tail = answer.slice(streamedAnswer.length);
        if (tail) renderer.handleDisplay({ kind: 'answer', text: tail });
      }
      renderer.finish();
    } catch (error) {
      renderer.stop();
      throw error;
    }
    return;
  }

  let snapshot = await client.snapshot(30, configuredSession);
  const target = new RemoteCommandTarget(client, snapshot.sessionId);
  const terminal = new InteractiveTerminal(CHAT_COMMANDS);
  const queue: string[] = [];
  let activeAbort: AbortController | undefined;
  let activeEventId: string | undefined;
  let activeCancelRequested = false;
  let activeCancelSent = false;
  let cyclingMode = false;
  let draining = false;
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const tty = Boolean(process.stdout.isTTY);

  const refresh = async () => {
    snapshot = await client.snapshot(30, target.currentSessionId);
    terminal.useSession(snapshot.sessionId);
    terminal.setRuntimeStatus({
      mode: snapshot.mode,
      model: snapshot.model,
      contextUsed: snapshot.contextUsed,
      contextWindow: snapshot.contextWindow,
    });
    terminal.setTasks(snapshot.plan);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    activeAbort?.abort(new Error('终端已退出；MimiAgent 任务继续在后台执行'));
    terminal.setQueue(queue);
    terminal.close();
    resolveClosed();
  };
  const cancelActiveEvent = () => {
    const eventId = activeEventId;
    if (!eventId || activeCancelSent) return;
    activeCancelSent = true;
    void client.cancel(eventId, '用户按下 Esc 取消任务').then((result) => {
      if (result.state === 'not_found') terminal.notify(`未找到可取消的任务：${eventId}`);
    }).catch((error) => {
      terminal.notify(`取消任务失败：${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const submitAndDisplay = async (input: string, signal = activeAbort?.signal) => {
    const renderer = new TerminalRenderer(
      terminal.createWriter(process.stderr),
      terminal.createWriter(process.stdout),
      normalizeOutputLevel(snapshot.outputLevel),
    );
    renderer.start('模型思考中', input);
    let streamedAnswer = '';
    try {
      const accepted = await client.submit(input, target.currentSessionId);
      activeEventId = accepted.eventId;
      if (activeCancelRequested) cancelActiveEvent();
      const event = await client.wait(accepted.eventId, signal, (streamed) => {
        if (streamed.kind === 'plan') {
          terminal.setTasks(streamed.steps);
          return;
        }
        if (streamed.kind === 'answer') streamedAnswer += streamed.text;
        renderer.handleDisplay(streamed);
      });
      const effects = eventEffects(event);
      const answer = eventAnswer(event);
      if (!streamedAnswer) renderer.handleDisplay({ kind: 'answer', text: answer });
      else if (answer.startsWith(streamedAnswer)) {
        const tail = answer.slice(streamedAnswer.length);
        if (tail) renderer.handleDisplay({ kind: 'answer', text: tail });
      }
      renderer.finish();
      await synchronizeRemoteRuntimeEffects(target, effects, { restoreSession, resetSession, close });
    } catch (error) {
      renderer.stop();
      throw error;
    }
  };
  const restoreSession = async () => {
    await refresh();
    terminal.clearScreen([renderBanner(version, snapshot), renderChatHistory(snapshot, tty)]
      .filter(Boolean).join('\n\n'));
  };
  const resetSession = async () => {
    await refresh();
    terminal.clearScreen(renderBanner(version, snapshot));
  };
  const commands = new CommandHandler(target, submitAndDisplay, {
    write: (text) => terminal.notify(text),
    resetScreen: async () => {
      await resetSession();
    },
    restoreSession,
    selectSession: async (sessions) => terminal.select(sessions.map((session) => ({
      value: session.id,
      label: `${session.id === target.currentSessionId ? '● ' : ''}${session.title}`,
      detail: `${session.recoverable ? '↻ 可恢复 · ' : ''}${session.turns} 轮 · ${session.preview}`,
    })), '选择 MimiAgent 对话'),
    selectModel: async (models, current) => terminal.select(models.map((model) => ({
      value: model,
      label: `${model === current ? '● ' : ''}${model}`,
    })), '选择模型'),
    selectMode: async (modes, current) => terminal.select(modes.map((mode) => ({
      value: mode.id,
      label: `${mode.id === current ? '● ' : ''}${mode.label}`,
      detail: mode.description,
    })), '选择模式'),
    getOutputLevel: () => normalizeOutputLevel(snapshot.outputLevel),
    setOutputLevel: async (level) => {
      await target.setOutputLevel(level);
      snapshot.outputLevel = level;
    },
    selectOutputLevel: async (current) => terminal.select(OUTPUT_LEVELS.map((level) => ({
      value: level.id,
      label: `${level.id === current ? '● ' : ''}${level.label}`,
      detail: level.description,
    })), '选择输出等级'),
  });
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !closed) {
        const input = queue.shift()!;
        terminal.setQueue(queue);
        terminal.recordInput(input);
        activeAbort = new AbortController();
        activeEventId = undefined;
        activeCancelRequested = false;
        activeCancelSent = false;
        try {
          terminal.setBusy(true);
          const result = await commands.execute(input, activeAbort.signal);
          if (result === 'exit') {
            close();
            break;
          }
          if (result === 'handled') continue;
          commands.remember(input);
          await submitAndDisplay(input);
        } catch (error) {
          const message = activeCancelRequested
            ? '已请求取消当前任务。'
            : activeAbort.signal.aborted
              ? '已停止等待；任务仍由 MimiAgent 在后台可靠执行，可稍后用 /history 查看结果。'
              : `运行失败：${error instanceof Error ? error.message : String(error)}`;
          terminal.notify(message);
        } finally {
          activeAbort = undefined;
          activeEventId = undefined;
          activeCancelRequested = false;
          activeCancelSent = false;
          terminal.setBusy(false);
          if (!closed) await refresh().catch(() => undefined);
        }
      }
    } finally {
      draining = false;
      if (queue.length && !closed) void drain();
    }
  };

  await refresh();
  process.stdout.write(`${renderBanner(version, snapshot)}\n`);
  const history = renderChatHistory(snapshot, tty);
  if (history) process.stdout.write(`\n${history}\n`);
  terminal.start({
    onLine: (input) => {
      if (input.trim() === '/exit') {
        close();
        return;
      }
      queue.push(input);
      terminal.setQueue(queue);
      void drain();
    },
    onEscape: () => {
      if (!activeAbort || activeAbort.signal.aborted) return;
      activeCancelRequested = true;
      cancelActiveEvent();
      activeAbort.abort(new Error('用户按下 Esc 取消任务'));
    },
    onModeCycle: () => {
      if (cyclingMode) return;
      cyclingMode = true;
      void (async () => {
        try {
          const modes = await target.availableModes();
          const current = modes.findIndex((mode) => mode.label === snapshot.mode);
          const next = modes[(current + 1) % modes.length];
          if (!next) return;
          await target.switchMode(next.id);
          await refresh();
          terminal.notify(`已切换到 ${next.label} 模式。`);
        } catch (error) {
          terminal.notify(`切换模式失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          cyclingMode = false;
        }
      })();
    },
    onExit: close,
  });
  await closedPromise;
}

export { CHAT_HELP, eventAnswer };
