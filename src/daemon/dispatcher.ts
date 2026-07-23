import { randomUUID } from 'node:crypto';
import type { RunStreamEvent } from '@openai/agents';
import type { MimiAgent } from '../runtime/mimi-agent.js';
import { MimiHost } from '../runtime/mimi-host.js';
import type { RuntimeEvent } from '../runtime/hooks.js';
import { isTerminalRunInterruption, TerminalRunInterruptedError } from '../runtime/run-outcome.js';
import { CompletionGateError } from '../core/completion.js';
import { capabilityDisclosureForInput } from '../core/user-intent.js';
import {
  isPermanentDeliveryError,
  isUncertainDeliveryError,
  NotifierRegistry,
} from './notifier.js';
import type { ConnectorTaskRuntime } from './connector-action-tool.js';
import type { ConnectorManager } from './connectors.js';
import type { MimiDeliveryControl } from './delivery-tools.js';
import { AttentionEngine } from './attention.js';
import { createMimiHostTools } from './host-tools.js';
import { buildOwnerStatusAnswer } from './status-context.js';
import type { MemoryMaintenanceRuntime } from './memory-maintenance-tools.js';
import { MimiStore } from './store.js';
import type { BackgroundTaskBlockRequest, BackgroundTaskPauseResult } from './task-tools.js';
import type {
  DaemonWorkerStatus,
  ImmutableEvent,
  OutboxMessage,
  ReplyRoute,
  TaskRecord,
  TaskType,
} from './types.js';

type MaybePromise<T> = T | Promise<T>;

export interface DispatcherOptions {
  pollMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  maxConcurrentTasks?: number;
  claimTaskTypes?: TaskType[];
  preemptPollMs?: number;
  runIdleTimeoutMs?: number;
  onStreamEvent?: (eventId: string, event: RunStreamEvent) => void;
  onRuntimeEvent?: (eventId: string, event: RuntimeEvent) => void;
  cancelEvent?: (eventId: string, reason?: string) => MaybePromise<EventCancelResult>;
  pauseEvent?: (eventId: string, reason?: string) => MaybePromise<BackgroundTaskPauseResult>;
  connectorRuntime?: ConnectorTaskRuntime;
  memoryMaintenance?: MemoryMaintenanceRuntime;
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

export function eventFailureAttemptLimit(
  error: unknown,
  claimedAttempts: number,
  configuredMaxAttempts: number,
): number {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : String(error);
  const messageStatus = /^(\d{3})(?:\s|$)/.exec(message)?.[1];
  const status = typeof value.status === 'number'
    ? value.status
    : messageStatus ? Number(messageStatus) : undefined;
  if (isTerminalRunInterruption(error)
    || value.name === 'ContextProtocolBudgetError'
    || value.name === 'MaxTurnsExceededError'
    || /^Max turns \(\d+\) exceeded$/i.test(message)) {
    return Math.max(1, claimedAttempts);
  }
  // Background conversation retries happen within seconds. Retrying a rejected
  // request, exhausted quota, or rate limit only burns attempts/credits and can
  // produce a stale IM reply later; dead-letter once and require an explicit retry.
  if (status !== undefined && status >= 400 && status < 500
    && status !== 408 && status !== 409 && status !== 425) {
    return Math.max(1, claimedAttempts);
  }
  return configuredMaxAttempts;
}

const TERMINAL_TASK_STATUSES = new Set<TaskRecord['status']>([
  'completed', 'failed', 'cancelled', 'dead_letter',
]);

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
  readonly workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
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
  private readonly deliveryPromises = new Map<string, { route: ReplyRoute; promise: Promise<void> }>();
  private nextMaintenanceAt = 0;

  constructor(
    private readonly store: MimiStore,
    agentOrHost: MimiAgent | MimiHost,
    private readonly attention: AttentionEngine,
    private readonly notifier = new NotifierRegistry(),
    private readonly connectors?: ConnectorManager,
    private readonly options: DispatcherOptions = {},
  ) {
    this.host = agentOrHost instanceof MimiHost ? agentOrHost : new MimiHost(agentOrHost);
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
    await Promise.all([...this.deliveryPromises.values()].map((delivery) => delivery.promise));
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
    this.store.emitDueSchedules();
    if (this.preferOutbox && await this.deliverOne()) {
      this.preferOutbox = false;
      return true;
    }
    const task = this.store.claimTask(
      this.workerId,
      { types: this.options.claimTaskTypes, executor: 'session_actor' },
      this.options.leaseMs ?? 60_000,
      new Date(),
    );
    if (task) {
      await this.runTask(task);
      this.preferOutbox = true;
      return true;
    }
    if (!this.preferOutbox && await this.deliverOne()) {
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

  private async deliverOne(): Promise<boolean> {
    const delivery = this.startDelivery();
    if (delivery) {
      await delivery;
      return true;
    }
    const inFlight = this.deliveryPromises.values().next().value as
      | { route: ReplyRoute; promise: Promise<void> }
      | undefined;
    if (!inFlight) return false;
    await inFlight.promise;
    return true;
  }

  private startDelivery(): Promise<void> | undefined {
    if (this.deliveryPromises.size >= 4) return undefined;
    const outgoing = this.store.claimOutbox(
      this.workerId,
      undefined,
      undefined,
      [...this.deliveryPromises.values()].map((delivery) => delivery.route),
    );
    if (!outgoing) return undefined;
    let tracked!: Promise<void>;
    tracked = this.deliverClaimed(outgoing)
      .catch((error) => {
        process.stderr.write(
          `[MimiAgent] outbox ${outgoing.id} error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      })
      .finally(() => {
        const routeKey = JSON.stringify([outgoing.channel, outgoing.target ?? '']);
        if (this.deliveryPromises.get(routeKey)?.promise === tracked) {
          this.deliveryPromises.delete(routeKey);
        }
      });
    const route = { channel: outgoing.channel, ...(outgoing.target ? { target: outgoing.target } : {}) };
    this.deliveryPromises.set(JSON.stringify([outgoing.channel, outgoing.target ?? '']), { route, promise: tracked });
    return tracked;
  }

  private async deliverClaimed(outgoing: OutboxMessage): Promise<void> {
    try {
      await this.notifier.deliver(outgoing);
    } catch (error) {
      this.store.failOutbox(
        outgoing.id,
        this.workerId,
        error,
        isUncertainDeliveryError(error) || isPermanentDeliveryError(error) ? 1 : 8,
      );
      return;
    }
    try {
      this.store.completeOutbox(outgoing.id, this.workerId);
    } catch (error) {
      // The external sink already confirmed success. Leaving the message in its
      // sending lease makes recovery dead-letter it instead of redelivering it.
      process.stderr.write(
        `[MimiAgent] outbox ${outgoing.id} 已送达但本地确认失败，将停止自动重发：${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private async loop(): Promise<void> {
    const signal = this.loopController.signal;
    while (!signal.aborted) {
      try {
        const worked = await this.scheduleAvailable();
        if (!worked) await delay(this.options.pollMs ?? 250, signal);
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
    this.store.emitDueSchedules();
    let worked = false;
    if (this.preferOutbox && this.startDelivery()) {
      this.preferOutbox = false;
      worked = true;
    }
    const limit = Math.max(1, Math.min(16, this.options.maxConcurrentTasks ?? 4));
    while (!this.stopRequested && this.active.size < limit) {
      const task = this.store.claimTask(
        this.workerId,
        {
          types: this.options.claimTaskTypes,
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
    if (!worked && !this.preferOutbox && this.startDelivery()) {
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
      this.store.failTask(task.id, this.workerId, new Error(`Task authority Event 不存在：${task.authorityEventId}`), undefined, new Date(), false);
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
    let execution: { sessionId: string; key: string } | undefined;
    let leaseFailure: Error | undefined;
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
      const runIdleTimeoutMs = this.options.runIdleTimeoutMs ?? this.attention.runIdleTimeoutMs;
      const pauseRunIdleWatchdog = () => {
        if (runIdleTimer) clearTimeout(runIdleTimer);
        runIdleTimer = undefined;
      };
      const refreshRunIdleWatchdog = () => {
        pauseRunIdleWatchdog();
        if (runSignal.aborted || active.tools > 0) return;
        runIdleTimer = setTimeout(() => {
          runController.abort(new Error(`Agent 连续 ${runIdleTimeoutMs}ms 无进展，已中止并等待重试`));
        }, runIdleTimeoutMs);
      };
      if (task.type !== 'scheduled') this.store.wakeWatches(decision.sessionId!, task.id);
      const attempt = this.store.beginTaskAttempt(task.id, this.workerId, decision.sessionId!);
      attemptId = attempt.id;
      const executionKey = task.idempotencyKey.startsWith('migration:event:')
        ? `event:${task.id}`
        : `task:${task.id}`;
      execution = { sessionId: decision.sessionId!, key: executionKey };
      const deliveryControl: MimiDeliveryControl = { suppressed: false };
      let completionDelivery: { suppressed: true; reason?: string } | undefined;
      const checkPreemption = () => {
        if (!this.options.claimTaskTypes?.includes('conversation')) return;
        if (preemptedBy || active.tools > 0 || runSignal.aborted) return;
        try {
          for (const reservedId of this.reservedPreemptions) {
            if (this.store.getTask(reservedId)?.status !== 'queued') {
              this.reservedPreemptions.delete(reservedId);
            }
          }
          for (const candidate of this.store.readyTasks({ types: this.options.claimTaskTypes }, 50)) {
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
      const focusedStatus = event.trust === 'owner'
        && task.type === 'conversation'
        && capabilityDisclosureForInput(decision.input!) === 'status';
      const focusedStatusAnswer = focusedStatus
        ? await this.host.mutate(decision.sessionId!, async (agent) => {
            const [plan, goal] = await Promise.all([agent.currentPlan(), agent.currentGoal()]);
            return buildOwnerStatusAnswer(this.store, decision.sessionId!, task.id, { plan, goal });
          }, runSignal)
        : undefined;
      const hostedRun = this.host.execute({
        executionId: task.id,
        sessionId: decision.sessionId!,
        input: decision.input!,
        signal: runSignal,
        ...(focusedStatusAnswer !== undefined ? { trustedHostAnswer: focusedStatusAnswer } : {}),
        options: {
          ...decision.options,
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
            connectorRuntime: this.options.connectorRuntime,
            task,
            event,
            deliveryControl,
            replyRoute,
            sessionId: decision.sessionId!,
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
          refreshRunIdleWatchdog();
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
            { answer: result.answer, question: blocked.question, reason, usage: result.usage },
            reason,
            attempt.id,
            new Date(),
            {
              route: replyRoute ?? { channel: 'system' },
              payload: {
                type: 'background_task_blocked',
                taskId: task.id,
                question: blocked.question,
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
              ...(task.type !== 'conversation' ? {
                type: 'background_task_completed',
              } : {}),
            },
          }
        : undefined;
      const sessionEffect = [...result.effects].reverse()
        .find((effect) => effect.type === 'session_changed');
      this.store.completeTask(task.id, this.workerId, {
        answer: result.answer,
        sessionId: sessionEffect?.type === 'session_changed' ? sessionEffect.sessionId : decision.sessionId,
        effects: result.effects,
        usage: result.usage,
        ...(deliveryControl.suppressed ? {
          delivery: { suppressed: true, reason: deliveryControl.reason },
        } : {}),
      }, attempt.id, new Date(), delivery);
      await this.host.finalizeExecutionLedger(decision.sessionId!, executionKey).catch(() => undefined);
    } catch (error) {
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
      } else if (active.blockRequested) {
        if (execution) {
          await this.host.reopenExecutionLedger(execution.sessionId, execution.key).catch(() => undefined);
        }
        const blocked = active.blockRequested;
        const reason = blocked.reason ?? '后台任务需要用户输入';
        this.store.blockTask(
          task.id,
          this.workerId,
          { question: blocked.question, reason },
          reason,
          attemptId,
          new Date(),
          {
            route: event.replyRoute ?? { channel: 'system' },
            payload: {
              type: 'background_task_blocked',
              taskId: task.id,
              question: blocked.question,
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
        this.store.failTask(task.id, this.workerId, error, attemptId, new Date(), false);
      } else if (this.stopRequested && active.runController?.signal.aborted) {
        this.store.requeueTask(task.id, this.workerId, 'MimiAgent Dispatcher 正在停止，任务已安全重排队', attemptId);
      } else {
        const configuredMaxAttempts = this.options.maxAttempts ?? 5;
        const attemptLimit = eventFailureAttemptLimit(error, task.attemptCount, configuredMaxAttempts);
        this.store.failTask(
          task.id,
          this.workerId,
          error,
          attemptId,
          new Date(),
          task.attemptCount < attemptLimit,
          'dead_letter',
        );
      }
    } finally {
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
    if (!cancellation || active.tools > 0) return;
    active.runController?.abort(new TerminalRunInterruptedError(cancellation.reason));
    this.host.cancel(active.task.id, new TerminalRunInterruptedError(cancellation.reason));
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
