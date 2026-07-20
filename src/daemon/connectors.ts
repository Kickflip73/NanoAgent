import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { derivedSessionId } from './policy.js';
import {
  PermanentDeliveryError,
  UncertainDeliveryError,
  type NotificationSink,
  type NotifierRegistry,
} from './notifier.js';
import { MimiStore } from './store.js';
import type { EventActor, EventConversation, EventKind, EventTrust, OutboxMessage } from './types.js';

const connectorSchema = z.object({
  enabled: z.boolean().default(true),
  command: z.string().min(1),
  args: z.array(z.string()).max(64).default([]),
  cwd: z.string().optional(),
  envAllowlist: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(64).default([]),
  source: z.string().min(1).optional(),
  trust: z.enum(['owner', 'trusted', 'external', 'public', 'system']).default('external'),
  profileId: z.string().min(1).default('owner'),
  restart: z.boolean().default(true),
  healthEvents: z.boolean().default(true),
  healthStabilityMs: z.number().int().min(100).max(120_000).default(5_000),
  deliveryTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  actionTimeoutMs: z.number().int().min(1_000).max(900_000).default(30_000),
  syncTemplateActions: z.boolean().default(true),
  actions: z.record(
    z.string().regex(/^[a-zA-Z0-9._-]+$/),
    z.object({ description: z.string().min(1).max(500) }).strict(),
  ).default({}),
}).strict();

const configSchema = z.object({
  connectors: z.record(z.string().regex(/^[a-zA-Z0-9._-]+$/), connectorSchema).default({}),
}).strict();

type ConnectorConfig = z.infer<typeof connectorSchema>;
export type ConnectorFileConfig = z.infer<typeof configSchema>;

export function parseConnectorConfig(value: unknown): ConnectorFileConfig {
  return configSchema.parse(value);
}

interface ConnectorEventMessage {
  type: 'event';
  externalId: string;
  kind?: EventKind;
  payload: unknown;
  occurredAt?: string;
  priority?: number;
  actor?: EventActor;
  conversation?: EventConversation;
  replyTarget?: string;
}

interface EventAckMessage {
  type: 'event_ack';
  externalId: string;
  ok: boolean;
  eventId?: string;
  error?: string;
}

interface DeliveryAckMessage {
  type: 'delivery_ack';
  id: string;
  ok: boolean;
  uncertain?: boolean;
  error?: string;
}

interface ActionResultMessage {
  type: 'action_result';
  id: string;
  ok: boolean;
  uncertain?: boolean;
  result?: unknown;
  error?: string;
}

type ConnectorReadiness = 'ready' | 'unavailable' | 'unknown';

interface ConnectorStatusMessage {
  type: 'status';
  inbound: ConnectorReadiness;
  outbound: ConnectorReadiness;
  deliveryConfirmed?: boolean;
  eventAcknowledgement?: boolean;
}

interface PendingDelivery {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingAction {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ConnectorCapability {
  id: string;
  enabled: boolean;
  online: boolean;
  readiness: {
    inbound: ConnectorReadiness;
    outbound: ConnectorReadiness;
    deliveryConfirmed?: boolean;
  };
  source: string;
  trust: EventTrust;
  actions: Array<{ name: string; description: string }>;
}

export interface ConnectorActionRequest {
  connector: string;
  action: string;
  target: string;
  payload: unknown;
}

export interface ConnectorEnabledResult {
  connector: ConnectorCapability;
  changed: boolean;
}

function safeEnvironment(allowlist: readonly string[]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', ...allowlist]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function validDate(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;
}

function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && ['command', 'alert', 'ambient', 'schedule', 'webhook'].includes(value);
}

export function connectorEventPriority(trust: EventTrust, kind: EventKind, priority: unknown): number {
  const requested = Math.max(0, Math.min(100, Number.isFinite(priority) ? Number(priority) : 50));
  return trust === 'owner' && kind === 'command' ? 100 : requested;
}

class ConnectorProcess implements NotificationSink {
  private child?: ChildProcessWithoutNullStreams;
  private stopping = false;
  private restartTimer?: NodeJS.Timeout;
  private stableTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private restartAttempt = 0;
  private healthState: 'initial' | 'outage' | 'healthy' = 'initial';
  private draining = false;
  private stdoutBuffer = '';
  private readonly pending = new Map<string, PendingDelivery>();
  private readonly pendingActions = new Map<string, PendingAction>();
  private readiness: ConnectorCapability['readiness'] = { inbound: 'unknown', outbound: 'unknown' };
  private supportsEventAcknowledgement = false;

  constructor(
    readonly id: string,
    private readonly config: ConnectorConfig,
    private readonly store: MimiStore,
  ) {}

  start(): void {
    if (this.child || this.stopping || this.draining || !this.config.enabled) return;
    if (this.config.cwd && !path.isAbsolute(this.config.cwd)) {
      this.onStartFailure(new Error(`Connector ${this.id} 的 cwd 必须是绝对路径`));
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.config.command, this.config.args, {
        cwd: this.config.cwd,
        env: safeEnvironment(this.config.envAllowlist),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.onStartFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(`[MimiAgent connector:${this.id}] ${chunk.slice(0, 8_000)}`);
    });
    child.once('spawn', () => {
      this.stableTimer = setTimeout(() => { this.restartAttempt = 0; }, 60_000);
      this.stableTimer.unref();
      this.healthTimer = setTimeout(() => this.markHealthy(), this.config.healthStabilityMs);
      this.healthTimer.unref();
    });
    child.once('error', (error) => this.onExit(error));
    child.once('exit', (code, signal) => this.onExit(new Error(`退出 code=${code ?? 'null'} signal=${signal ?? 'none'}`)));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.rejectPending(new Error(`Connector ${this.id} 已停止`));
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async deliver(message: OutboxMessage): Promise<void> {
    if (this.draining) throw new Error(`Connector ${this.id} 正在重载`);
    const child = this.child;
    if (!child || child.exitCode !== null || child.stdin.destroyed) {
      throw new Error(`Connector ${this.id} 当前不在线`);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        this.terminateTimedOutChild();
        reject(new UncertainDeliveryError(`Connector ${this.id} 投递确认超时`));
      }, this.config.deliveryTimeoutMs);
      this.pending.set(message.id, { resolve, reject, timer });
      const line = `${JSON.stringify({
        type: 'deliver', id: message.id, target: message.target, payload: message.payload,
        deadlineAt: Date.now() + this.config.deliveryTimeoutMs,
      })}\n`;
      child.stdin.write(line, (error) => {
        if (!error) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        reject(new UncertainDeliveryError(`Connector ${this.id} 写入投递请求失败：${error.message}`));
      });
    });
  }

  capability(): ConnectorCapability {
    return {
      id: this.id,
      enabled: this.config.enabled,
      online: this.isOnline,
      readiness: this.isOnline
        ? this.readiness
        : { inbound: 'unavailable', outbound: 'unavailable' },
      source: this.config.source ?? `connector:${this.id}`,
      trust: this.config.trust as EventTrust,
      actions: Object.entries(this.config.actions).map(([name, value]) => ({
        name,
        description: value.description,
      })),
    };
  }

  async executeAction(action: string, target: string, payload: unknown): Promise<unknown> {
    if (!Object.hasOwn(this.config.actions, action)) {
      throw new Error(`Connector ${this.id} 未声明 action ${action}`);
    }
    if (!target.trim()) throw new Error('Connector action target 不能为空');
    if (this.draining) throw new Error(`Connector ${this.id} 正在重载`);
    const child = this.child;
    if (!child || child.exitCode !== null || child.stdin.destroyed) {
      throw new Error(`Connector ${this.id} 当前不在线`);
    }
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(id);
        this.terminateTimedOutChild();
        reject(new UncertainDeliveryError(
          `Connector ${this.id} action ${action} 执行超时；为避免重复副作用不会自动重放`,
        ));
      }, this.config.actionTimeoutMs);
      this.pendingActions.set(id, { resolve, reject, timer });
      const line = `${JSON.stringify({
        type: 'action', id, action, target, payload,
        deadlineAt: Date.now() + this.config.actionTimeoutMs,
      })}\n`;
      child.stdin.write(line, (error) => {
        if (!error) return;
        const pending = this.pendingActions.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingActions.delete(id);
        reject(new UncertainDeliveryError(
          `Connector ${this.id} action ${action} 写入失败，结果不确定：${error.message}`,
        ));
      });
    });
  }

  private get isOnline(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.stdin.destroyed);
  }

  get environmentKeys(): readonly string[] {
    return this.config.envAllowlist;
  }

  private terminateTimedOutChild(): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.stdin.destroy();
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 1_000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }

  beginDrain(): boolean {
    if (this.pending.size > 0 || this.pendingActions.size > 0) return false;
    this.draining = true;
    return true;
  }

  cancelDrain(): void {
    if (!this.stopping) this.draining = false;
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > 1024 * 1024) {
      this.child?.kill('SIGTERM');
      this.stdoutBuffer = '';
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.handle(JSON.parse(line) as unknown);
      } catch (error) {
        process.stderr.write(`[MimiAgent connector:${this.id}] 无效消息：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  private handle(raw: unknown): void {
    if (!raw || typeof raw !== 'object') throw new Error('消息必须是 JSON 对象');
    const message = raw as Record<string, unknown>;
    if (message.type === 'delivery_ack') {
      this.handleAck(message as unknown as DeliveryAckMessage);
      return;
    }
    if (message.type === 'action_result') {
      this.handleActionResult(message as unknown as ActionResultMessage);
      return;
    }
    if (message.type === 'status') {
      this.handleStatus(message as unknown as ConnectorStatusMessage);
      return;
    }
    if (message.type !== 'event') throw new Error(`未知消息类型：${String(message.type)}`);
    const event = message as unknown as ConnectorEventMessage;
    if (typeof event.externalId !== 'string' || !event.externalId.trim()) throw new Error('event.externalId 不能为空');
    try {
      const now = new Date().toISOString();
      const source = this.config.source ?? `connector:${this.id}`;
      const kind = isEventKind(event.kind) ? event.kind : 'webhook';
      const trust = this.config.trust as EventTrust;
      const stored = this.store.enqueueEvent({
        id: randomUUID(),
        externalId: event.externalId,
        source,
        kind,
        trust,
        actor: event.actor,
        conversation: event.conversation,
        payload: event.payload,
        occurredAt: validDate(event.occurredAt) ?? now,
        receivedAt: now,
        priority: connectorEventPriority(trust, kind, event.priority),
        profileId: this.config.profileId,
        replyRoute: event.replyTarget
          ? { channel: `connector:${this.id}`, target: event.replyTarget }
          : undefined,
      });
      this.writeEventAck({
        type: 'event_ack', externalId: event.externalId, ok: true, eventId: stored.event.id,
      });
    } catch (error) {
      this.writeEventAck({
        type: 'event_ack', externalId: event.externalId, ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
      throw error;
    }
  }

  private writeEventAck(message: EventAckMessage): void {
    if (!this.supportsEventAcknowledgement) return;
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) process.stderr.write(`[MimiAgent connector:${this.id}] event ACK 写入失败：${error.message}\n`);
    });
  }

  private handleStatus(message: ConnectorStatusMessage): void {
    const valid = new Set<ConnectorReadiness>(['ready', 'unavailable', 'unknown']);
    if (!valid.has(message.inbound) || !valid.has(message.outbound)) {
      throw new Error('status.inbound/outbound 必须是 ready、unavailable 或 unknown');
    }
    if (message.deliveryConfirmed !== undefined && typeof message.deliveryConfirmed !== 'boolean') {
      throw new Error('status.deliveryConfirmed 必须是 boolean');
    }
    if (message.eventAcknowledgement !== undefined && typeof message.eventAcknowledgement !== 'boolean') {
      throw new Error('status.eventAcknowledgement 必须是 boolean');
    }
    this.supportsEventAcknowledgement = message.eventAcknowledgement === true;
    this.readiness = {
      inbound: message.inbound,
      outbound: message.outbound,
      ...(message.deliveryConfirmed === undefined ? {} : { deliveryConfirmed: message.deliveryConfirmed }),
    };
  }

  private handleAck(message: DeliveryAckMessage): void {
    if (typeof message.id !== 'string' || typeof message.ok !== 'boolean') {
      throw new Error('delivery_ack 需要 id 和 ok');
    }
    if (message.uncertain !== undefined && typeof message.uncertain !== 'boolean') {
      throw new Error('delivery_ack.uncertain 必须是 boolean');
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve();
    else if (message.uncertain) {
      pending.reject(new UncertainDeliveryError(message.error ?? `Connector ${this.id} 投递结果不确定`));
    } else pending.reject(new PermanentDeliveryError(message.error ?? `Connector ${this.id} 拒绝投递`));
  }

  private handleActionResult(message: ActionResultMessage): void {
    if (typeof message.id !== 'string' || typeof message.ok !== 'boolean') {
      throw new Error('action_result 需要 id 和 ok');
    }
    if (message.uncertain !== undefined && typeof message.uncertain !== 'boolean') {
      throw new Error('action_result.uncertain 必须是 boolean');
    }
    const pending = this.pendingActions.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingActions.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else if (message.uncertain) {
      pending.reject(new UncertainDeliveryError(message.error ?? `Connector ${this.id} action 结果不确定`));
    }
    else pending.reject(new Error(message.error ?? `Connector ${this.id} action 执行失败`));
  }

  private onExit(error: Error): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.readiness = { inbound: 'unknown', outbound: 'unknown' };
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = undefined;
    this.rejectPending(error);
    this.recordFailure(error);
  }

  private onStartFailure(error: Error): void {
    if (this.stopping) return;
    this.rejectPending(error);
    this.recordFailure(error);
  }

  private recordFailure(error: Error): void {
    if (this.stopping) return;
    if (this.healthState !== 'outage') {
      this.healthState = 'outage';
      this.enqueueHealthEvent('offline', error);
    }
    if (!this.config.restart) {
      process.stderr.write(`[MimiAgent connector:${this.id}] ${error.message}，不会自动重启\n`);
      return;
    }
    const delay = Math.min(60_000, 500 * 2 ** this.restartAttempt++);
    process.stderr.write(`[MimiAgent connector:${this.id}] ${error.message}，${delay}ms 后重启\n`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.start();
    }, delay);
    this.restartTimer.unref();
  }

  private markHealthy(): void {
    this.healthTimer = undefined;
    if (!this.isOnline || this.stopping) return;
    const recovered = this.healthState === 'outage';
    this.healthState = 'healthy';
    if (recovered) this.enqueueHealthEvent('recovered');
  }

  private enqueueHealthEvent(status: 'offline' | 'recovered', error?: Error): void {
    if (!this.config.healthEvents) return;
    const now = new Date().toISOString();
    const source = this.config.source ?? `connector:${this.id}`;
    const automaticRestart = this.config.restart;
    const prompt = status === 'offline'
      ? `Connector “${this.id}” 已离线。${automaticRestart ? 'Daemon 正在自动重启；请核对实时状态并跟踪到恢复，只在无法自愈或影响事务时通知所有者。' : '该 Connector 未启用自动重启；请诊断并执行一次安全恢复，无法恢复时给出精确修复信息。'}`
      : `Connector “${this.id}” 已稳定恢复在线。请清理恢复跟踪并处理仍可安全继续的工作，不要重放中断期间结果不确定的外部动作。`;
    try {
      this.store.enqueueEvent({
        id: randomUUID(),
        externalId: `${this.id}:${status}:${randomUUID()}`,
        source: 'system:connector-health',
        kind: 'alert',
        trust: 'system',
        payload: {
          prompt,
          connectorHealth: {
            connectorId: this.id,
            connectorSource: source,
            status,
            automaticRestart,
            ...(error ? { error: this.healthErrorSummary(error) } : {}),
          },
        },
        occurredAt: now,
        receivedAt: now,
        priority: status === 'offline' ? 90 : 75,
        profileId: this.config.profileId,
        sessionKey: derivedSessionId('connector-health', this.id),
        replyRoute: { channel: 'system' },
      });
    } catch (enqueueError) {
      process.stderr.write(`[MimiAgent connector:${this.id}] 无法记录健康事件：${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}\n`);
    }
  }

  private healthErrorSummary(error: Error): string {
    if (error.message.startsWith('退出 code=')) return error.message.slice(0, 200);
    if (error.message.includes('cwd 必须是绝对路径')) return '配置错误：cwd 必须是绝对路径';
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `进程错误 ${code}` : `进程错误 ${error.name}`;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new UncertainDeliveryError(`Connector ${this.id} 中断，投递结果不确定：${error.message}`));
    }
    this.pending.clear();
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${error.message}；为避免重复副作用 action 不会自动重放`));
    }
    this.pendingActions.clear();
  }
}

export class ConnectorManager {
  private connectors: Map<string, ConnectorProcess>;
  private reloading = false;

  private constructor(
    private readonly configFile: string,
    private readonly store: MimiStore,
    private readonly notifier: NotifierRegistry,
    connectors: ConnectorProcess[],
  ) {
    this.connectors = new Map(connectors.map((connector) => [connector.id, connector]));
    this.register(connectors);
  }

  static async load(configFile: string, store: MimiStore, notifier: NotifierRegistry): Promise<ConnectorManager> {
    const parsed = await this.readConfig(configFile);
    const connectors = this.createProcesses(parsed, store);
    return new ConnectorManager(configFile, store, notifier, connectors);
  }

  private static async readConfig(configFile: string): Promise<ConnectorFileConfig> {
    let raw: string;
    try {
      raw = await readFile(configFile, 'utf8');
      await chmod(configFile, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { connectors: {} };
      throw error;
    }
    return parseConnectorConfig(JSON.parse(raw) as unknown);
  }

  private static createProcesses(config: ConnectorFileConfig, store: MimiStore): ConnectorProcess[] {
    return Object.entries(config.connectors).map(([id, connector]) => (
      new ConnectorProcess(id, connector, store)
    ));
  }

  private async writeConfig(config: ConnectorFileConfig): Promise<void> {
    const temporary = `${this.configFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.configFile);
      await chmod(this.configFile, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private register(connectors: Iterable<ConnectorProcess>): void {
    for (const connector of connectors) this.notifier.register(`connector:${connector.id}`, connector);
  }

  private unregister(connectors: Iterable<ConnectorProcess>): void {
    for (const connector of connectors) this.notifier.unregister(`connector:${connector.id}`, connector);
  }

  start(): void {
    for (const connector of this.connectors.values()) connector.start();
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.connectors.values()].map((connector) => connector.stop()));
  }

  async reload(): Promise<ConnectorCapability[]> {
    if (this.reloading) throw new Error('Connector 正在执行另一次重载');
    this.reloading = true;
    let current: ConnectorProcess[] = [];
    let draining = false;
    try {
      const parsed = await ConnectorManager.readConfig(this.configFile);
      const replacements = ConnectorManager.createProcesses(parsed, this.store);
      current = [...this.connectors.values()];
      const drained: ConnectorProcess[] = [];
      for (const connector of current) {
        if (!connector.beginDrain()) {
          for (const item of drained) item.cancelDrain();
          throw new Error('Connector 存在进行中的投递或 action，请稍后重试');
        }
        drained.push(connector);
      }
      draining = true;
      await Promise.allSettled(current.map((connector) => connector.stop()));
      this.unregister(current);
      this.connectors = new Map(replacements.map((connector) => [connector.id, connector]));
      this.register(replacements);
      this.start();
      return this.listCapabilities();
    } catch (error) {
      if (!draining) for (const connector of current) connector.cancelDrain();
      throw error;
    } finally {
      this.reloading = false;
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<ConnectorEnabledResult> {
    if (this.reloading) throw new Error('Connector 正在执行另一次重载');
    this.reloading = true;
    let current: ConnectorProcess[] = [];
    let draining = false;
    try {
      const config = await ConnectorManager.readConfig(this.configFile);
      const connector = config.connectors[id];
      if (!connector) throw new Error(`未找到 Connector ${id}`);
      const live = this.connectors.get(id)?.capability();
      if (connector.enabled === enabled && live?.enabled === enabled) {
        return { connector: live, changed: false };
      }
      const updated = parseConnectorConfig({
        connectors: { ...config.connectors, [id]: { ...connector, enabled } },
      });
      const replacements = ConnectorManager.createProcesses(updated, this.store);
      current = [...this.connectors.values()];
      const drained: ConnectorProcess[] = [];
      for (const item of current) {
        if (!item.beginDrain()) {
          for (const candidate of drained) candidate.cancelDrain();
          throw new Error('Connector 存在进行中的投递或 action，请稍后重试');
        }
        drained.push(item);
      }
      await this.writeConfig(updated);
      draining = true;
      await Promise.allSettled(current.map((item) => item.stop()));
      this.unregister(current);
      this.connectors = new Map(replacements.map((item) => [item.id, item]));
      this.register(replacements);
      this.start();
      const capability = this.connectors.get(id)?.capability();
      if (!capability) throw new Error(`Connector ${id} 启停后丢失`);
      return { connector: capability, changed: true };
    } catch (error) {
      if (!draining) for (const connector of current) connector.cancelDrain();
      throw error;
    } finally {
      this.reloading = false;
    }
  }

  listCapabilities(): ConnectorCapability[] {
    return [...this.connectors.values()].map((connector) => connector.capability());
  }

  async executeAction(request: ConnectorActionRequest): Promise<unknown> {
    const connector = this.connectors.get(request.connector);
    if (!connector) throw new Error(`未找到 Connector ${request.connector}`);
    return connector.executeAction(request.action, request.target, request.payload);
  }

  get size(): number {
    return this.connectors.size;
  }

  get configPath(): string {
    return this.configFile;
  }

  /** Environment names reserved for isolated Connector processes; values are never exposed. */
  get environmentKeys(): string[] {
    return [...new Set(
      [...this.connectors.values()].flatMap((connector) => connector.environmentKeys),
    )].sort();
  }
}
