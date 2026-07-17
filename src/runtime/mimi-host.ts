import { randomUUID } from 'node:crypto';
import type { SessionSummary } from '../core/session.js';
import type { AgentSessionSnapshot, MimiAgent } from './mimi-agent.js';
import {
  AgentRunService,
  type AgentRunObserver,
  type AgentRunRequest,
  type AgentRunResult,
} from './run-service.js';

export interface HostedAgentRunRequest extends AgentRunRequest {
  sessionId: string;
  executionId?: string;
}

export type HostCancelResult =
  | { state: 'cancelled' }
  | { state: 'not_found' };

export interface HostedRunExecutor {
  execute(request: AgentRunRequest, observer?: AgentRunObserver): Promise<AgentRunResult>;
}

interface PendingExecution {
  controller: AbortController;
}

interface SessionActor {
  sessionId: string;
  agent: MimiAgent;
  runs: HostedRunExecutor;
  lane: Promise<void>;
  pending: number;
  lastUsed: number;
}

export interface MimiSessionRuntime {
  agent: MimiAgent;
  runs?: HostedRunExecutor;
}

export interface MimiHostOptions {
  maxConcurrentSessions?: number;
  maxCachedSessions?: number;
  sessionIdleMs?: number;
  createSessionRuntime?: (sessionId: string) => Promise<MimiSessionRuntime>;
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class Semaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Session 并发上限必须是正安全整数');
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) return Promise.resolve(this.take());
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new Error('等待 Session 执行槽时已取消'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private take(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit && this.waiters.length) {
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason ?? new Error('等待 Session 执行槽时已取消'));
        continue;
      }
      waiter.resolve(this.take());
    }
  }
}

/**
 * Owns keyed Session actors. Each mutable MimiAgent instance remains strictly
 * single-run, while different Session actors can use independent execution
 * slots. Durable event reliability remains in the daemon Dispatcher.
 */
export class MimiHost {
  private readonly primary: SessionActor;
  private readonly actors = new Map<string, Promise<SessionActor>>();
  private readonly resolvedActors = new Map<string, SessionActor>();
  private readonly actorReservations = new Map<string, number>();
  private readonly actorClosures = new Set<Promise<void>>();
  private readonly slots: Semaphore;
  private readonly pending = new Map<string, PendingExecution>();
  private closing = false;

  constructor(
    private readonly agent: MimiAgent,
    private readonly runs: HostedRunExecutor = new AgentRunService(agent),
    private readonly options: MimiHostOptions = {},
  ) {
    if (options.createSessionRuntime) agent.bindSessionActor(agent.currentSessionId);
    this.primary = {
      sessionId: agent.currentSessionId,
      agent,
      runs,
      lane: Promise.resolve(),
      pending: 0,
      lastUsed: Date.now(),
    };
    this.actors.set(agent.currentSessionId, Promise.resolve(this.primary));
    this.resolvedActors.set(agent.currentSessionId, this.primary);
    this.slots = new Semaphore(options.maxConcurrentSessions ?? 4);
  }

  get currentSessionId(): string {
    return this.agent.currentSessionId;
  }

  execute(
    request: HostedAgentRunRequest,
    observer: AgentRunObserver = {},
  ): Promise<AgentRunResult> {
    this.assertOpen();
    const executionId = request.executionId ?? randomUUID();
    if (this.pending.has(executionId)) throw new Error(`Execution ${executionId} 已存在`);
    const controller = new AbortController();
    this.pending.set(executionId, { controller });
    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;

    return this.actorFor(request.sessionId).then((actor) => this.enqueue(actor, async () => {
      const release = await this.slots.acquire(signal);
      try {
        if (signal.aborted) throw signal.reason ?? new Error(`Execution ${executionId} 已取消`);
        await this.selectSession(actor.agent, request.sessionId);
        signal.throwIfAborted();
        const receipt = request.options?.executionKey
          ? await actor.agent.completedExecution?.(request.sessionId, request.options.executionKey)
          : undefined;
        signal.throwIfAborted();
        if (receipt) {
          const recovered = {
            answer: receipt.answer,
            effects: receipt.effects ?? [],
            usage: receipt.usage,
          } satisfies AgentRunResult;
          await this.observe(observer.onStart, request.input);
          signal.throwIfAborted();
          await this.observe(observer.onComplete, recovered);
          signal.throwIfAborted();
          return recovered;
        }
        const result = await actor.runs.execute({
          input: request.input,
          signal,
          options: request.options,
        }, observer);
        signal.throwIfAborted();
        return result;
      } finally {
        release();
      }
    }, request.sessionId)).finally(() => this.pending.delete(executionId));
  }

  mutate<T>(
    sessionId: string,
    operation: (agent: MimiAgent) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.assertOpen();
    return this.actorFor(sessionId).then((actor) => this.enqueue(actor, async () => {
      signal?.throwIfAborted();
      await this.selectSession(actor.agent, sessionId);
      signal?.throwIfAborted();
      return operation(actor.agent);
    }, sessionId));
  }

  finalizeExecutionLedger(sessionId: string, executionKey: string): Promise<void> {
    this.assertOpen();
    // A completed run may have switched the user-facing Session. Ledger
    // acknowledgement is host bookkeeping and must not switch it back.
    return this.actorFor(sessionId).then((actor) => this.enqueue(
      actor,
      () => actor.agent.finalizeExecutionLedger(sessionId, executionKey),
      sessionId,
    ));
  }

  reopenExecutionLedger(sessionId: string, executionKey: string): Promise<void> {
    this.assertOpen();
    return this.actorFor(sessionId).then((actor) => this.enqueue(
      actor,
      () => actor.agent.reopenExecutionLedger(sessionId, executionKey),
      sessionId,
    ));
  }

  snapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    this.assertOpen();
    return this.agent.sessionSnapshot(sessionId);
  }

  listSessionSummaries(): Promise<SessionSummary[]> {
    this.assertOpen();
    return this.agent.listSessionSummaries();
  }

  cancel(executionId: string, reason = new Error(`Execution ${executionId} 已取消`)): HostCancelResult {
    const execution = this.pending.get(executionId);
    if (!execution) return { state: 'not_found' };
    if (!execution.controller.signal.aborted) execution.controller.abort(reason);
    return { state: 'cancelled' };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const [executionId, execution] of this.pending) {
      execution.controller.abort(new Error(`MimiHost 正在关闭，已取消 ${executionId}`));
    }
    const actors = await Promise.all([...new Set(this.actors.values())]);
    await Promise.all(actors.map((actor) => actor.lane));
    const agents = [...new Set(actors.map((actor) => actor.agent))];
    await Promise.all(agents.map((runtime) => runtime.close()));
    await Promise.all([...this.actorClosures]);
  }

  private actorFor(sessionId: string): Promise<SessionActor> {
    this.reserveActor(sessionId);
    this.evictIdleActors(sessionId);
    const existing = this.actors.get(sessionId);
    if (existing) return existing.catch((error) => {
      this.releaseActorReservation(sessionId);
      throw error;
    });
    if (!this.options.createSessionRuntime) return Promise.resolve(this.primary);
    const created = this.options.createSessionRuntime(sessionId).then((runtime) => {
      runtime.agent.bindSessionActor(sessionId);
      return {
        sessionId,
        agent: runtime.agent,
        runs: runtime.runs ?? new AgentRunService(runtime.agent),
        lane: Promise.resolve(),
        pending: 0,
        lastUsed: Date.now(),
      } satisfies SessionActor;
    }).then((actor) => {
      this.resolvedActors.set(sessionId, actor);
      this.evictIdleActors(sessionId);
      return actor;
    });
    this.actors.set(sessionId, created);
    return created.catch((error) => {
      if (this.actors.get(sessionId) === created) this.actors.delete(sessionId);
      this.releaseActorReservation(sessionId);
      throw error;
    });
  }

  private async selectSession(agent: MimiAgent, sessionId: string): Promise<void> {
    if (agent.currentSessionId !== sessionId) await agent.switchSession(sessionId);
  }

  private enqueue<T>(
    actor: SessionActor,
    operation: () => Promise<T>,
    reservationSessionId = actor.sessionId,
  ): Promise<T> {
    actor.pending += 1;
    this.releaseActorReservation(reservationSessionId);
    const task = actor.lane.then(operation, operation);
    actor.lane = task.then(() => undefined, () => undefined);
    return task.finally(() => {
      actor.pending = Math.max(0, actor.pending - 1);
      actor.lastUsed = Date.now();
      this.evictIdleActors();
    });
  }

  private evictIdleActors(preserveSessionId?: string): void {
    if (this.closing) return;
    const maxCached = Math.max(
      2,
      this.options.maxCachedSessions ?? Math.max(32, (this.options.maxConcurrentSessions ?? 4) * 8),
    );
    const idleMs = Math.max(0, this.options.sessionIdleMs ?? 30 * 60_000);
    const now = Date.now();
    const candidates = [...this.resolvedActors.values()]
      .filter((actor) => actor !== this.primary
        && actor.pending === 0
        && (this.actorReservations.get(actor.sessionId) ?? 0) === 0
        && actor.sessionId !== preserveSessionId)
      .sort((left, right) => left.lastUsed - right.lastUsed);
    for (const actor of candidates) {
      const overLimit = this.resolvedActors.size > maxCached;
      if (!overLimit && now - actor.lastUsed < idleMs) break;
      this.actors.delete(actor.sessionId);
      this.resolvedActors.delete(actor.sessionId);
      const closing = actor.agent.close().catch(() => undefined);
      this.actorClosures.add(closing);
      void closing.finally(() => this.actorClosures.delete(closing));
    }
  }

  private assertOpen(): void {
    if (this.closing) throw new Error('MimiHost 正在关闭');
  }

  private reserveActor(sessionId: string): void {
    this.actorReservations.set(sessionId, (this.actorReservations.get(sessionId) ?? 0) + 1);
  }

  private releaseActorReservation(sessionId: string): void {
    const remaining = (this.actorReservations.get(sessionId) ?? 1) - 1;
    if (remaining > 0) this.actorReservations.set(sessionId, remaining);
    else this.actorReservations.delete(sessionId);
  }

  private async observe<T>(callback: ((value: T) => void | Promise<void>) | undefined, value: T): Promise<void> {
    if (!callback) return;
    try {
      await callback(value);
    } catch {
      // A recovered durable result must not be invalidated by presentation code.
    }
  }
}
