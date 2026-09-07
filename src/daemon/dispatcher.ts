import { randomUUID } from 'node:crypto';
import type { RunStreamEvent } from '@openai/agents';
import type { MimiAgent } from '../runtime/mimi-agent.js';
import { MimiHost } from '../runtime/mimi-host.js';
import { attachmentPayload, inputWithAttachments } from '../runtime/attachments.js';
import type { RuntimeEvent } from '../runtime/hooks.js';
import { TerminalRunInterruptedError } from '../runtime/run-outcome.js';
import { projectRunStreamEvent } from '../runtime/stream-projection.js';
import { CompletionGateError } from '../core/completion.js';
import { RunFailureError } from '../core/run-failure.js';
import { runFinalizationFromError } from '../core/run-finalization.js';
import { NotifierRegistry } from './notifier.js';
import type { ConnectorTaskRuntime } from './connector-action-tool.js';
import type { ConnectorManager } from './connectors.js';
import type { MimiDeliveryControl } from './delivery-tools.js';
import { OutboxDeliveryCoordinator } from './dispatcher-delivery.js';
import { AttentionEngine } from './attention.js';
import { createMimiHostTools } from './host-tools.js';
import { BrowserRunManager } from '../extensions/browser/manager.js';
import {
  connectorEffectiveCapabilityItems,
} from './connector-action-tool.js';
import {
  ephemeralSecretReferences,
  EphemeralSensitiveRunFailedError,
  EphemeralSecretsExpiredError,
  type EphemeralSecretReference,
} from './ephemeral-secrets.js';
import type { EphemeralOwnerInputLease } from '../runtime/ephemeral-owner-input.js';
import type { MemoryMaintenanceRuntime } from './memory-maintenance-tools.js';
import { MimiStore } from './store.js';
import { classifyRunFailureRecord } from './dispatcher-retry-policy.js';
import type { BackgroundTaskBlockRequest, BackgroundTaskPauseResult } from './task-tools.js';
import type {
  DaemonWorkerStatus,
  ImmutableEvent,
  TaskRecord,
} from './types.js';
import {
  personalMessageContextSchema,
  personalMessageResultSchema,
  type PersonalMessageAuthorization,
} from './personal-message.js';
import type { PersonalMessageScope } from '../runtime/personal-message-hub.js';
import type { ComputerAccess } from '../extensions/computer/types.js';

type MaybePromise<T> = T | Promise<T>;

export interface DispatcherOptions {
  workerId?: string;
  pollMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  maxConcurrentTasks?: number;
  preemptPollMs?: number;
  runIdleTimeoutMs?: number;
  onStreamEvent?: (eventId: string, event: RunStreamEvent) => void;
  onRuntimeEvent?: (eventId: string, event: RuntimeEvent) => void;
  cancelEvent?: (eventId: string, reason?: string) => MaybePromise<EventCancelResult>;
  pauseEvent?: (eventId: string, reason?: string) => MaybePromise<BackgroundTaskPauseResult>;
  connectorRuntime?: ConnectorTaskRuntime;
  memoryMaintenance?: MemoryMaintenanceRuntime;
  takeEphemeralSecrets?: (
    eventId: string,
    sessionId: string,
    references: readonly EphemeralSecretReference[],
  ) => EphemeralOwnerInputLease | undefined;
  resolveWorkspace?: (
    event: ImmutableEvent,
    sessionId: string,
    task: TaskRecord,
  ) => MaybePromise<string | undefined>;
}

export function runStreamMakesObservableProgress(event: RunStreamEvent): boolean {
  // Liveness must not depend on whether an SDK event deserves UI output.
  if (event.type === 'run_item_stream_event' && event.name === 'reasoning_item_created') return true;
  const projection = projectRunStreamEvent(event);
  if (!projection) return false;
  return projection.kind === 'status' || projection.text.trim().length > 0;
}

interface ActiveExecution {
  task: TaskRecord;
  event: ImmutableEvent;
  authority: ImmutableEvent;
  tools: number;
  cancelRequested?: { reason: string };
  pauseRequested?: { reason: string };
  blockRequested?: BackgroundTaskBlockRequest;
  sessionId?: string;
  runController?: AbortController;
  promise?: Promise<void>;
  pendingToolCalls: Map<string, { name: string; argumentsJson: string }>;
}

export type EventCancelResult =
  | { state: 'cancelled' }
  | { state: 'already_terminal' }
  | { state: 'not_found' };

export { eventFailureAttemptLimit } from './dispatcher-retry-policy.js';

const TERMINAL_TASK_STATUSES = new Set<TaskRecord['status']>([
  'completed', 'failed', 'cancelled', 'dead_letter',
]);
// run_shell owns its process group and turns AbortSignal into TERM/KILL cleanup.
// Keep other tools behind the safe boundary until they provide equivalent guarantees.
const INTERRUPTIBLE_ACTIVE_TOOLS = new Set(['run_shell']);

function activeToolsAreInterruptible(active: ActiveExecution): boolean {
  if (active.tools === 0) return true;
  const pending = [...active.pendingToolCalls.values()];
  return pending.length === active.tools
    && pending.every((call) => INTERRUPTIBLE_ACTIVE_TOOLS.has(call.name));
}

function personalConnectorId(channel: PersonalMessageAuthorization['channel']): string {
  return `personal-${channel}`;
}

function personalConversationTarget(authorization: PersonalMessageAuthorization): string | undefined {
  if (authorization.channel !== 'daxiang') return undefined;
  const match = /^daxiang:[a-f0-9]{16,64}:(\d+)$/.exec(authorization.conversationId);
  return match?.[1];
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class MimiDispatcher {
  readonly workerId: string;
  readonly startedAt = new Date().toISOString();
  private readonly host: MimiHost;
  private readonly loopController = new AbortController();
  private loopPromise?: Promise<void>;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly activeSessions = new Set<string>();
  private readonly reservedPreemptions = new Set<string>();
  private stopRequested = false;
  private forceStopReason?: Error;
  private preferOutbox = true;
  private readonly delivery: OutboxDeliveryCoordinator;
  private nextMaintenanceAt = 0;

  constructor(
    private readonly store: MimiStore,
    agentOrHost: MimiAgent | MimiHost,
    private readonly attention: AttentionEngine,
    private readonly notifier = new NotifierRegistry(),
    private readonly connectors?: ConnectorManager,
    private readonly options: DispatcherOptions = {},
  ) {
    this.workerId = options.workerId ?? `${process.pid}-${randomUUID().slice(0, 8)}`;
    this.host = agentOrHost instanceof MimiHost ? agentOrHost : new MimiHost(agentOrHost);
    this.delivery = new OutboxDeliveryCoordinator(this.store, this.notifier, this.workerId);
  }

  start(): void {
    if (this.loopPromise) return;
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (!this.loopController.signal.aborted) this.loopController.abort();
    for (const execution of this.active.values()) this.abortForStopWhenSafe(execution);
    await this.loopPromise;
    await Promise.all([...this.active.values()].map((execution) => execution.promise).filter(Boolean));
    await this.delivery.waitForAll();
  }

  forceStop(reason = 'MimiAgent Dispatcher 被强制停止'): void {
    this.stopRequested = true;
    this.forceStopReason ??= new Error(reason);
    if (!this.loopController.signal.aborted) this.loopController.abort(this.forceStopReason);
    for (const execution of this.active.values()) {
      if (execution.runController && !execution.runController.signal.aborted) {
        execution.runController.abort(this.forceStopReason);
      }
      this.host.cancel(execution.task.id, this.forceStopReason);
    }
  }

  status(): DaemonWorkerStatus {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      workerId: this.workerId,
      activeEventId: this.active.values().next().value?.task.id,
      activeEventIds: [...this.active.keys()],
      activeEventCount: this.active.size,
      activeToolCount: [...this.active.values()]
        .reduce((total, execution) => total + execution.tools, 0),
      ...this.store.counts(),
    };
  }

  cancel(eventId: string, reason = 'owner 取消了任务'): EventCancelResult {
    const task = this.store.getTask(eventId);
    if (!task) return { state: 'not_found' };
    if (TERMINAL_TASK_STATUSES.has(task.status)) return { state: 'already_terminal' };
    const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || 'owner 取消了任务';
    if (task.status !== 'running') {
      this.store.cancelTask(eventId, summary);
      return { state: 'cancelled' };
    }
    const active = this.active.get(eventId);
    if (active) {
      this.store.cancelTask(eventId, summary);
      if (!active.cancelRequested) active.cancelRequested = { reason: summary };
      active.pauseRequested = undefined;
      this.abortForCancellationWhenSafe(active);
      return { state: 'cancelled' };
    }
    return { state: 'not_found' };
  }

  pause(eventId: string, reason = 'owner 暂停了后台任务'): BackgroundTaskPauseResult {
    const task = this.store.getTask(eventId);
    if (!task || task.type === 'conversation') return { state: 'not_found' };
    if (task.status === 'paused') return { state: 'already_paused' };
    if (TERMINAL_TASK_STATUSES.has(task.status)) return { state: 'already_terminal' };
    const summary = reason.replace(/\s+/g, ' ').trim().slice(0, 4_000) || 'owner 暂停了后台任务';
    if (task.status === 'queued') {
      this.store.pauseTask(eventId, summary);
      return { state: 'paused' };
    }
    const active = this.active.get(eventId);
    if (task.status === 'running' && active) {
      const requested = this.store.pauseTask(eventId, summary);
      if (requested.controlIntent === 'cancel') return { state: 'not_pauseable' };
      if (!active.pauseRequested) active.pauseRequested = { reason: summary };
      this.abortForPauseWhenSafe(active);
      return { state: 'paused' };
    }
    return { state: 'not_pauseable' };
  }

  async processOnce(): Promise<boolean> {
    this.runMaintenanceIfDue();
    this.attention.emitDueRoutines();
    this.attention.emitDueBriefings();
    this.store.schedules.emitDue();
    if (this.preferOutbox && await this.delivery.deliverOne()) {
      this.preferOutbox = false;
      return true;
    }
    const task = this.store.claimTask(
      this.workerId,
      { executor: 'session_actor' },
      this.options.leaseMs ?? 60_000,
      new Date(),
    );
    if (task) {
      await this.runTask(task);
      this.preferOutbox = true;
      return true;
    }
    if (!this.preferOutbox && await this.delivery.deliverOne()) {
      this.preferOutbox = false;
      return true;
    }
    return false;
  }

  async processTaskById(eventId: string): Promise<boolean> {
    const task = this.store.claimTaskById(
      eventId,
      this.workerId,
      this.options.leaseMs ?? 60_000,
      new Date(),
    );
    if (!task) return false;
    await this.runTask(task);
    return true;
  }

  private async loop(): Promise<void> {
    const signal = this.loopController.signal;
    while (!signal.aborted) {
      try {
        const worked = await this.scheduleAvailable();
    if (!worked) await delay(this.options.pollMs ?? 1_000, signal);
      } catch (error) {
        process.stderr.write(`[MimiAgent] dispatcher error: ${error instanceof Error ? error.message : String(error)}\n`);
        await delay(1_000, signal);
      }
    }
  }

  private async scheduleAvailable(): Promise<boolean> {
    this.runMaintenanceIfDue();
    this.attention.emitDueRoutines();
    this.attention.emitDueBriefings();
    this.store.schedules.emitDue();
    let worked = false;
    if (this.preferOutbox && this.delivery.start()) {
      this.preferOutbox = false;
      worked = true;
    }
    const limit = Math.max(1, Math.min(16, this.options.maxConcurrentTasks ?? 4));
    while (!this.stopRequested && this.active.size < limit) {
      const task = this.store.claimTask(
        this.workerId,
        {
          executor: 'session_actor',
          excludedSessionKeys: [...this.activeSessions],
        },
        this.options.leaseMs ?? 60_000,
        new Date(),
      );
      if (!task) break;
      this.reservedPreemptions.delete(task.id);
      worked = true;
      this.preferOutbox = true;
      void this.runTask(task).catch((error) => {
        process.stderr.write(`[MimiAgent] task ${task.id} error: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
    if (!worked && !this.preferOutbox && this.delivery.start()) {
      this.preferOutbox = false;
      worked = true;
    }
    return worked;
  }

  private runTask(task: TaskRecord): Promise<void> {
    if (this.active.has(task.id)) throw new Error(`Task ${task.id} 已在执行`);
    const authority = this.store.getImmutableEvent(task.authorityEventId);
    const event = this.store.getImmutableEvent(task.triggerEventId ?? task.authorityEventId);
    if (!event || !authority) {
      this.store.failTask(
        task.id,
        this.workerId,
        new Error(`Task authority Event 不存在：${task.authorityEventId}`),
        {
          code: 'task.authority_missing',
          disposition: {
            phase: 'pre_dispatch',
            kind: 'state_conflict',
            retryable: false,
            dispatchStarted: false,
          },
        },
      );
      return Promise.resolve();
    }
    const active: ActiveExecution = {
      task,
      event,
      authority,
      tools: 0,
      pendingToolCalls: new Map(),
    };
    this.active.set(task.id, active);
    const promise = this.processTask(active);
    active.promise = promise;
    return promise;
  }

  private async processTask(active: ActiveExecution): Promise<void> {
    const task = active.task;
    const event = active.event;
    let attemptId: string | undefined;
    let preemptTimer: NodeJS.Timeout | undefined;
    let preemptedBy: { id: string; priority: number; ownerCorrection: boolean } | undefined;
    let runIdleTimer: NodeJS.Timeout | undefined;
    let runIdleFailure: RunFailureError | undefined;
    let execution: { sessionId: string; key: string } | undefined;
    let leaseFailure: Error | undefined;
    let ephemeralSensitiveValues: readonly string[] = [];
    let browserRun: BrowserRunManager | undefined;
    const closeBrowserRun = async (): Promise<void> => {
      if (!browserRun) return;
      const owned = browserRun;
      browserRun = undefined;
      try {
        await owned.endRun();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = new Error(`Browser session cleanup failed for ${task.id}: ${message}`, {
          cause: error,
        });
        failure.name = 'BrowserSessionCleanupError';
        throw failure;
      }
    };
    const leaseMs = this.options.leaseMs ?? 60_000;
    const renew = setInterval(() => {
      if (leaseFailure) return;
      try {
        const renewed = this.store.renewTaskLease(task.id, this.workerId, leaseMs);
        if (renewed) {
          this.synchronizeDurableTaskControl(active);
          return;
        }
        leaseFailure = new Error(`Task ${task.id} 租约已失效，旧 Run 已安全中止`);
      } catch (error) {
        leaseFailure = new Error(
          `Task ${task.id} 续租失败，旧 Run 已安全中止：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (active.runController && !active.runController.signal.aborted) {
        active.runController.abort(leaseFailure);
      }
      this.host.cancel(task.id, leaseFailure);
    }, Math.max(25, Math.floor(leaseMs / 3)));
    renew.unref();
    try {
      this.attention.observeOwnerRoute({
        trust: event.trust,
        kind: event.type === 'command.received' ? 'command' : 'ambient',
        profileId: event.profileId,
        replyRoute: event.replyRoute,
      });
      const replyRoute = this.attention.replyRouteFor(event);
      const decision = this.attention.decideTask(task, event, active.authority);
      if (decision.action === 'ignore') {
        this.store.completeTask(task.id, this.workerId, { reason: decision.reason });
        return;
      }
      const sessionId = decision.sessionId!;
      const workspaceRoot = await this.options.resolveWorkspace?.(event, sessionId, task);
      this.store.bindRunningTaskSession(task.id, this.workerId, sessionId);
      if (this.activeSessions.has(sessionId)) {
        this.store.requeueTask(task.id, this.workerId, `同 Session ${sessionId} 已有活动 Run，保持 FIFO 等待`);
        return;
      }
      active.sessionId = sessionId;
      this.activeSessions.add(sessionId);
      const runController = new AbortController();
      active.runController = runController;
      this.synchronizeDurableTaskControl(active);
      if (leaseFailure) runController.abort(leaseFailure);
      else if (this.forceStopReason) runController.abort(this.forceStopReason);
      const runSignal = runController.signal;
      browserRun = this.connectors
        ? new BrowserRunManager(task.id, async (request, signal) => {
            signal?.throwIfAborted();
            const result = await this.connectors!.executeCapability(request);
            signal?.throwIfAborted();
            return result;
          })
        : undefined;
      const runIdleTimeoutMs = this.options.runIdleTimeoutMs ?? this.attention.runIdleTimeoutMs;
      const pauseRunIdleWatchdog = () => {
        if (runIdleTimer) clearTimeout(runIdleTimer);
        runIdleTimer = undefined;
      };
      const refreshRunIdleWatchdog = () => {
        pauseRunIdleWatchdog();
        if (runSignal.aborted || active.tools > 0) return;
        runIdleTimer = setTimeout(() => {
          runIdleFailure = new RunFailureError(
            'runtime.idle_timeout',
            `Agent 连续 ${runIdleTimeoutMs}ms 无进展，已中止并等待重试`,
            {
              phase: 'runtime',
              kind: 'transient',
              retryable: true,
              dispatchStarted: false,
            },
          );
          runController.abort(runIdleFailure);
        }, runIdleTimeoutMs);
      };
      if (task.type !== 'scheduled') this.store.schedules.wake(decision.sessionId!, task.id);
      const attempt = this.store.beginTaskAttempt(task.id, this.workerId, decision.sessionId!);
      attemptId = attempt.id;
      const executionKey = task.idempotencyKey.startsWith('migration:event:')
        ? `event:${task.id}`
        : `task:${task.id}`;
      execution = { sessionId: decision.sessionId!, key: executionKey };
      const deliveryControl: MimiDeliveryControl = { suppressed: false };
      const personalMessage = decision.personalMessage
        ? await this.personalMessageScope(
            decision.personalMessage,
            sessionId,
            workspaceRoot,
            decision.options?.computerAccess,
            decision.options?.computerApps,
            runSignal,
          )
        : undefined;
      let completionDelivery: { suppressed: true; reason?: string } | undefined;
      const checkPreemption = () => {
        if (task.executor !== 'session_actor') return;
        if (preemptedBy || active.tools > 0 || runSignal.aborted) return;
        try {
          for (const reservedId of this.reservedPreemptions) {
            if (this.store.getTask(reservedId)?.status !== 'queued') {
              this.reservedPreemptions.delete(reservedId);
            }
          }
          for (const candidate of this.store.readyTasks({ executor: 'session_actor' }, 50)) {
            if (candidate.id === task.id || this.active.has(candidate.id)
              || this.reservedPreemptions.has(candidate.id)) continue;
            const candidateEvent = this.store.getImmutableEvent(candidate.triggerEventId ?? candidate.authorityEventId);
            const candidateAuthority = this.store.getImmutableEvent(candidate.authorityEventId);
            if (!candidateEvent || !candidateAuthority) continue;
            const candidateDecision = this.attention.decideTask(candidate, candidateEvent, candidateAuthority);
            if (candidateDecision.action !== 'run') continue;
            const ownerCorrection = candidateEvent.trust === 'owner'
              && candidateEvent.type === 'command.received'
              && candidate.priority === task.priority
              && candidateDecision.sessionId === decision.sessionId;
            const urgent = candidate.priority > task.priority
              && candidate.priority >= this.attention.urgentPriority;
            if (!ownerCorrection && !urgent) continue;
            this.reservedPreemptions.add(candidate.id);
            preemptedBy = { id: candidate.id, priority: candidate.priority, ownerCorrection };
            const reason = ownerCorrection
              ? `当前任务被同 Session 的新 owner 命令 ${candidate.id} 打断`
              : `当前任务被更高优先级 Task ${candidate.id}（priority ${candidate.priority}）抢占`;
            runController.abort(ownerCorrection ? new TerminalRunInterruptedError(reason) : new Error(reason));
            break;
          }
        } catch (error) {
          process.stderr.write(`[MimiAgent] preemption check error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      };
      checkPreemption();
      preemptTimer = setInterval(checkPreemption, this.options.preemptPollMs ?? 250);
      preemptTimer.unref();
      refreshRunIdleWatchdog();
      const modelInput = await inputWithAttachments(decision.input!, attachmentPayload(event.payload));
      const secretReferences = ephemeralSecretReferences(task.objective);
      const directOwnerConversation = task.type === 'conversation'
        && event.id === active.authority.id
        && event.type === 'command.received'
        && event.trust === 'owner'
        && (event.source === 'local-cli' || event.source === 'runtime-http');
      const ephemeralOwnerInput = secretReferences.length && directOwnerConversation
        ? this.options.takeEphemeralSecrets?.(event.id, sessionId, secretReferences)
        : undefined;
      if (secretReferences.length && !ephemeralOwnerInput) {
        throw new EphemeralSecretsExpiredError();
      }
      ephemeralSensitiveValues = ephemeralOwnerInput?.values ?? [];
      const hostedRun = this.host.execute({
        executionId: task.id,
        sessionId: decision.sessionId!,
        workspaceRoot,
        input: decision.input!,
        ...(typeof modelInput === 'string' ? {} : { modelInput }),
        signal: runSignal,
        options: {
          ...decision.options,
          ...(ephemeralOwnerInput ? { ephemeralOwnerInput } : {}),
          capabilityItems: this.connectors
            ? connectorEffectiveCapabilityItems(this.connectors)
            : [],
          capabilityCatalog: this.connectors
              ? {
                inspectConnector: (filter) => this.connectors!.inspectCapabilities(filter),
                revision: () => this.connectors!.capabilityRevision(),
              }
            : this.options.connectorRuntime
              ? {
                  inspectConnector: (filter, signal) =>
                    this.options.connectorRuntime!.inspectCapabilities(filter, signal),
                }
              : undefined,
          ...(personalMessage ? { personalMessage } : {}),
          executionKey,
          retainExecutionLedger: true,
          completionDelivery: (calls) => {
            if (completionDelivery) return completionDelivery;
            if (deliveryControl.suppressed) {
              completionDelivery = { suppressed: true, reason: deliveryControl.reason };
              return completionDelivery;
            }
            const matchingReceipt = calls?.find((call) => {
              if (call.toolName !== 'connector_action' || call.status !== 'succeeded') return false;
              const receipt = call.output && typeof call.output === 'object' && !Array.isArray(call.output)
                ? call.output as Record<string, unknown>
                : undefined;
              return receipt?.outcome === 'confirmed'
                && receipt.action === 'send_message'
                && replyRoute?.channel === `connector:${String(receipt.connector)}`
                && replyRoute.target === receipt.target;
            });
            if (!matchingReceipt) return undefined;
            completionDelivery = {
              suppressed: true,
              reason: '执行账本确认已通过同一 Connector 会话发送，抑制重复最终投递',
            };
            return completionDelivery;
          },
          hostTools: createMimiHostTools({
            store: this.store,
            attention: this.attention,
            connectors: this.connectors,
            browserRun,
            connectorRuntime: this.options.connectorRuntime,
            task,
            event,
            deliveryControl,
            replyRoute,
            sessionId: decision.sessionId!,
            workspaceRoot,
            memoryMaintenance: this.options.memoryMaintenance,
            cancelEvent: this.options.cancelEvent
              ?? ((eventId, reason) => this.cancel(eventId, reason)),
            pauseEvent: this.options.pauseEvent
              ?? ((eventId, reason) => this.pause(eventId, reason)),
            blockTask: (request) => {
              if (!active.blockRequested) active.blockRequested = request;
            },
          }),
        },
      }, {
        onStreamEvent: (streamEvent) => {
          this.options.onStreamEvent?.(task.id, streamEvent);
          if (streamEvent.type === 'run_item_stream_event' && streamEvent.name === 'tool_called') {
            active.tools += 1;
            const item = streamEvent.item as unknown as Record<string, unknown>;
            const raw = item.rawItem && typeof item.rawItem === 'object'
              ? item.rawItem as Record<string, unknown>
              : {};
            const callId = typeof raw.callId === 'string'
              ? raw.callId
              : `legacy:${active.pendingToolCalls.size}:${typeof raw.name === 'string' ? raw.name : 'unknown'}`;
            active.pendingToolCalls.set(callId, {
              name: typeof raw.name === 'string' ? raw.name : 'unknown',
              argumentsJson: typeof raw.arguments === 'string'
                ? raw.arguments
                : JSON.stringify(raw.arguments ?? null),
            });
            pauseRunIdleWatchdog();
            return;
          }
          if (streamEvent.type === 'run_item_stream_event' && streamEvent.name === 'tool_output') {
            active.tools = Math.max(0, active.tools - 1);
            const item = streamEvent.item as unknown as Record<string, unknown>;
            const raw = item.rawItem && typeof item.rawItem === 'object'
              ? item.rawItem as Record<string, unknown>
              : {};
            const callId = typeof raw.callId === 'string' ? raw.callId : undefined;
            const fallback = callId ? undefined : [...active.pendingToolCalls.entries()]
              .find(([, pending]) => pending.name === raw.name);
            const resolvedCallId = callId ?? fallback?.[0];
            if (resolvedCallId) active.pendingToolCalls.delete(resolvedCallId);
            this.synchronizeDurableTaskControl(active);
            if (active.cancelRequested && active.tools === 0) {
              pauseRunIdleWatchdog();
              this.abortForCancellationWhenSafe(active);
              return;
            }
            if (active.blockRequested && active.tools === 0) {
              pauseRunIdleWatchdog();
              this.abortForBlockWhenSafe(active);
              return;
            }
            if (active.pauseRequested && active.tools === 0) {
              pauseRunIdleWatchdog();
              this.abortForPauseWhenSafe(active);
              return;
            }
            if (this.stopRequested && active.tools === 0) {
              pauseRunIdleWatchdog();
              this.abortForStopWhenSafe(active);
              return;
            }
          }
          if (runStreamMakesObservableProgress(streamEvent)) refreshRunIdleWatchdog();
        },
        onRuntimeEvent: (runtimeEvent) => {
          refreshRunIdleWatchdog();
          this.options.onRuntimeEvent?.(task.id, runtimeEvent);
        },
      });
      this.abortForCancellationWhenSafe(active);
      this.abortForBlockWhenSafe(active);
      this.abortForPauseWhenSafe(active);
      const result = await hostedRun;
      await closeBrowserRun();
      if (result.delivery?.suppressed) {
        deliveryControl.suppressed = true;
        deliveryControl.reason = result.delivery.reason;
      }
      if (leaseFailure) throw leaseFailure;
      this.synchronizeDurableTaskControl(active);
      const pendingCancellation = active.cancelRequested;
      if (pendingCancellation) throw new Error(pendingCancellation.reason);
      if (active.blockRequested || active.pauseRequested) {
        await this.host.reopenExecutionLedger(sessionId, executionKey);
        if (active.blockRequested) {
          const blocked = active.blockRequested;
          const reason = blocked.reason ?? '后台任务需要用户输入';
          this.store.blockTask(
            task.id,
            this.workerId,
            {
              answer: result.answer,
              question: blocked.question,
              reason,
              finalization: result.finalization,
              usage: result.usage,
            },
            reason,
            attempt.id,
            new Date(),
            {
              route: replyRoute ?? { channel: 'system' },
              payload: {
                type: 'background_task_blocked',
                taskId: task.id,
                question: blocked.question,
                finalization: result.finalization,
                text: `MimiAgent 后台任务需要你的输入（${task.id}）：${blocked.question}`.slice(0, 4_000),
              },
            },
          );
          return;
        }
        this.store.settleTaskControl(task.id, this.workerId, attempt.id);
        return;
      }
      pauseRunIdleWatchdog();
      const delivery = replyRoute && !deliveryControl.suppressed
        ? {
            route: replyRoute,
            payload: {
              text: task.type !== 'conversation'
                ? `MimiAgent 后台任务已完成（${task.id}）：${result.answer}`.slice(0, 4_000)
                : result.answer,
              taskId: task.id,
              finalization: result.finalization,
              ...(task.type !== 'conversation' ? {
                type: 'background_task_completed',
              } : {}),
            },
          }
        : undefined;
      const sessionEffect = [...result.effects].reverse()
        .find((effect) => effect.type === 'session_changed');
      // Do not publish a terminal Task before the host has finished its
      // bookkeeping. Clients use the terminal state as the safe boundary for
      // follow-up runtime actions such as a Provider restart. Publishing first
      // briefly made the just-completed conversation still appear in
      // activeEventIds, so the restart rejected its own completed Run.
      await this.host.finalizeExecutionLedger(decision.sessionId!, executionKey).catch(() => undefined);
      this.store.completeTask(task.id, this.workerId, {
        answer: result.answer,
        sessionId: sessionEffect?.type === 'session_changed' ? sessionEffect.sessionId : decision.sessionId,
        effects: result.effects,
        finalization: result.finalization,
        usage: result.usage,
        ...(deliveryControl.suppressed ? {
          delivery: { suppressed: true, reason: deliveryControl.reason },
        } : {}),
      }, attempt.id, new Date(), delivery);
    } catch (error) {
      let failureFinalization = runFinalizationFromError(error);
      let browserCleanupFailed = error instanceof Error && error.name === 'BrowserSessionCleanupError';
      try {
        await closeBrowserRun();
      } catch (cleanupError) {
        browserCleanupFailed = true;
        error = cleanupError;
        failureFinalization = undefined;
      }
      if (browserCleanupFailed) process.stderr.write(
        `[MimiAgent] ${error instanceof Error ? error.message : String(error)}\n`,
      );
      this.synchronizeDurableTaskControl(active);
      const pendingCancellation = active.cancelRequested;
      if (leaseFailure) {
        // Another worker may already own or recover this Event. Never mutate
        // durable state after losing the fencing lease.
      } else if (pendingCancellation) {
        this.store.settleTaskControl(task.id, this.workerId, attemptId);
        if (execution) {
          const cancelledExecution = execution;
          await this.host.finalizeExecutionLedger(
            cancelledExecution.sessionId,
            cancelledExecution.key,
          ).catch(() => undefined);
        }
      } else if (browserCleanupFailed) {
        this.store.failTask(
          task.id,
          this.workerId,
          error,
          {
            code: 'browser.cleanup_uncertain',
            disposition: {
              phase: 'dispatch',
              kind: 'uncertain',
              retryable: false,
              dispatchStarted: true,
            },
          },
          attemptId,
          new Date(),
          undefined,
          failureFinalization,
        );
      } else if (active.blockRequested) {
        if (execution) {
          await this.host.reopenExecutionLedger(execution.sessionId, execution.key).catch(() => undefined);
        }
        const blocked = active.blockRequested;
        const reason = blocked.reason ?? '后台任务需要用户输入';
        this.store.blockTask(
          task.id,
          this.workerId,
          { question: blocked.question, reason, finalization: failureFinalization },
          reason,
          attemptId,
          new Date(),
          {
            route: event.replyRoute ?? { channel: 'system' },
            payload: {
              type: 'background_task_blocked',
              taskId: task.id,
              question: blocked.question,
              finalization: failureFinalization,
              text: `MimiAgent 后台任务需要你的输入（${task.id}）：${blocked.question}`.slice(0, 4_000),
            },
          },
        );
      } else if (active.pauseRequested) {
        if (execution) {
          await this.host.reopenExecutionLedger(execution.sessionId, execution.key).catch(() => undefined);
        }
        this.store.settleTaskControl(task.id, this.workerId, attemptId);
      } else if (preemptedBy) {
        const reason = preemptedBy.ownerCorrection
          ? `被当前 Session 的新 owner 命令 ${preemptedBy.id} 取代`
          : `被紧急 Task ${preemptedBy.id}（priority ${preemptedBy.priority}）抢占`;
        if (preemptedBy.ownerCorrection) {
          this.store.cancelTask(task.id, reason);
          this.store.settleTaskControl(task.id, this.workerId, attemptId);
          if (execution) {
            await this.host.finalizeExecutionLedger(execution.sessionId, execution.key).catch(() => undefined);
          }
        } else {
          this.store.preemptTask(task.id, this.workerId, reason, attemptId);
        }
      } else if (error instanceof CompletionGateError) {
        this.store.failTask(
          task.id,
          this.workerId,
          error,
          classifyRunFailureRecord(error),
          attemptId,
          new Date(),
          undefined,
          failureFinalization,
        );
      } else if (this.stopRequested && active.runController?.signal.aborted) {
        this.store.requeueTask(task.id, this.workerId, 'MimiAgent Dispatcher 正在停止，任务已安全重排队', attemptId);
      } else {
        const configuredMaxAttempts = this.options.maxAttempts ?? 5;
        const taskError = ephemeralSecretReferences(task.objective).length
          ? new EphemeralSensitiveRunFailedError(error, ephemeralSensitiveValues)
          : runIdleFailure ?? error;
        const failure = classifyRunFailureRecord(taskError);
        this.store.failTask(
          task.id,
          this.workerId,
          taskError,
          failure,
          attemptId,
          new Date(),
          configuredMaxAttempts,
          failureFinalization,
        );
      }
    } finally {
      if (browserRun) {
        await closeBrowserRun().catch((error) => {
          process.stderr.write(
            `[MimiAgent] Browser session cleanup failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      }
      if (preemptTimer) clearInterval(preemptTimer);
      if (runIdleTimer) clearTimeout(runIdleTimer);
      clearInterval(renew);
      active.tools = 0;
      this.active.delete(task.id);
      if (active.sessionId) {
        this.activeSessions.delete(active.sessionId);
      }
    }
  }

  private async personalMessageScope(
    authorization: PersonalMessageAuthorization,
    sessionId: string,
    workspaceRoot: string | undefined,
    computerAccess: ComputerAccess | undefined,
    computerApps: readonly string[] | undefined,
    signal: AbortSignal,
  ): Promise<PersonalMessageScope | undefined> {
    if (authorization.channel === 'qq') {
      return this.host.prepareQqPersonalMessageScope(
        sessionId,
        workspaceRoot,
        authorization,
        computerAccess,
        computerApps,
        signal,
      );
    }
    const connectors = this.connectors;
    const target = personalConversationTarget(authorization);
    if (!connectors || !target) return undefined;
    const connectorId = personalConnectorId(authorization.channel);
    const connector = connectors.listCapabilities().find((candidate) => candidate.id === connectorId);
    const readiness = connector?.readiness;
    const fresh = connector?.online === true && readiness?.stale !== true;
    const capability = {
      accountVerified: fresh && readiness?.accountVerified === true,
      inboundCoverage: fresh
        ? readiness?.coverage ?? 'unavailable'
        : 'unavailable' as const,
      contextRead: fresh
        ? readiness?.contextRead ?? 'unavailable'
        : 'unavailable' as const,
      sendRoute: fresh && readiness?.outbound === 'ready'
        ? 'connector' as const
        : 'none' as const,
      deliveryConfirmed: readiness?.deliveryConfirmed === true,
      backgroundSafe: fresh && readiness?.backgroundSafe === true,
      changesReadState: readiness?.changesReadState ?? 'unknown' as const,
      stableConversationId: readiness?.stableConversationId === true,
      stableMessageId: readiness?.stableMessageId === true,
      probedAt: readiness?.reportedAt ?? new Date(0).toISOString(),
    };
    return {
      eventId: authorization.eventId,
      channel: authorization.channel,
      accountFingerprint: authorization.accountFingerprint,
      conversationId: authorization.conversationId,
      actorId: authorization.actorId,
      messageMode: authorization.mode,
      approvedText: authorization.approvedText,
      capability,
      getContext: async (limit) => personalMessageContextSchema.parse(
        await connectors.executePersonalMessageAction({
          connector: connectorId,
          action: 'get_context',
          target,
          payload: {
            accountFingerprint: authorization.accountFingerprint,
            conversationId: authorization.conversationId,
            limit,
          },
        }),
      ),
      send: async ({ text, latestFingerprint }) => personalMessageResultSchema.parse(
        await connectors.executePersonalMessageAction({
          connector: connectorId,
          action: 'send_message',
          target,
          payload: {
            accountFingerprint: authorization.accountFingerprint,
            conversationId: authorization.conversationId,
            latestFingerprint,
            text,
          },
        }),
      ),
    };
  }

  private abortForStopWhenSafe(active: ActiveExecution): void {
    if (this.stopRequested && active.tools === 0 && active.runController
      && !active.runController.signal.aborted) {
      active.runController.abort(new Error('MimiAgent dispatcher 正在停止'));
    }
  }

  private synchronizeDurableTaskControl(active: ActiveExecution): void {
    try {
      const control = this.store.taskControl(active.task.id);
      if (!control) return;
      if (control.intent === 'cancel') {
        active.cancelRequested = { reason: control.reason };
        active.pauseRequested = undefined;
        this.abortForCancellationWhenSafe(active);
        return;
      }
      if (!active.cancelRequested) {
        active.pauseRequested = { reason: control.reason };
        this.abortForPauseWhenSafe(active);
      }
    } catch (error) {
      process.stderr.write(
        `[MimiAgent] task control sync error ${active.task.id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private abortForCancellationWhenSafe(active: ActiveExecution): void {
    const cancellation = active.cancelRequested;
    if (!cancellation || !activeToolsAreInterruptible(active)) return;
    const reason = new TerminalRunInterruptedError(cancellation.reason);
    active.runController?.abort(reason);
    this.host.cancel(active.task.id, reason);
  }

  private abortForPauseWhenSafe(active: ActiveExecution): void {
    const pause = active.pauseRequested;
    if (!pause || active.tools > 0) return;
    const reason = new Error(pause.reason);
    active.runController?.abort(reason);
    this.host.cancel(active.task.id, reason);
  }

  private abortForBlockWhenSafe(active: ActiveExecution): void {
    const blocked = active.blockRequested;
    if (!blocked || active.tools > 0) return;
    const reason = new Error(blocked.reason ?? '后台任务正在等待用户输入');
    active.runController?.abort(reason);
    this.host.cancel(active.task.id, reason);
  }

  private runMaintenanceIfDue(now = new Date()): void {
    const maintenance = this.attention.maintenance;
    if (!maintenance.enabled) {
      this.nextMaintenanceAt = 0;
      return;
    }
    if (now.getTime() < this.nextMaintenanceAt) return;
    this.nextMaintenanceAt = now.getTime() + maintenance.intervalHours * 60 * 60_000;
    try {
      const cutoff = new Date(now.getTime() - maintenance.historyRetentionDays * 24 * 60 * 60_000);
      this.store.pruneHistory(cutoff);
    } catch (error) {
      process.stderr.write(`[MimiAgent] history maintenance error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
