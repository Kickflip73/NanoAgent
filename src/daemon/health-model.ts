import type { ConnectorCapability } from './connectors.js';
import type { OutboxStatus, TaskStatus } from './types.js';

export type DaemonHealthState = 'ready' | 'degraded' | 'unhealthy';
export type DaemonHealthSeverity = 'warning' | 'error';

export interface DaemonHealthRisk {
  code:
    | 'task_dead_letters'
    | 'outbox_dead_letters'
    | 'task_backlog'
    | 'outbox_backlog'
    | 'digest_backlog'
    | 'connector_offline'
    | 'connector_unavailable'
    | 'connector_stale'
    | 'connector_readiness_unknown';
  severity: DaemonHealthSeverity;
  message: string;
  nextAction: string;
}

export interface DaemonHealthSnapshot {
  state: DaemonHealthState;
  checkedAt: string;
  risks: DaemonHealthRisk[];
  backlog: {
    tasks: number;
    outbox: number;
    digest: number;
    taskDeadLetters: number;
    outboxDeadLetters: number;
  };
  connectors: {
    enabled: number;
    online: number;
    ready: number;
    offline: string[];
    unavailable: string[];
    stale: string[];
    unknown: string[];
  };
}

export interface DaemonHealthInput {
  tasks: Readonly<Record<TaskStatus, number>>;
  outbox: Readonly<Record<OutboxStatus, number>>;
  pendingDigest?: number;
  connectors?: readonly ConnectorCapability[];
  checkedAt?: string;
}

function connectorIds(
  connectors: readonly ConnectorCapability[],
  predicate: (connector: ConnectorCapability) => boolean,
): string[] {
  return connectors.filter(predicate).map((connector) => connector.id).sort();
}

export function buildDaemonHealth(input: DaemonHealthInput): DaemonHealthSnapshot {
  const connectors = input.connectors ?? [];
  const enabled = connectors.filter((connector) => connector.enabled);
  const offline = connectorIds(enabled, (connector) => !connector.online);
  const unavailable = connectorIds(enabled, (connector) => connector.online
    && connector.readiness.inbound === 'unavailable'
    && connector.readiness.outbound === 'unavailable');
  const stale = connectorIds(enabled, (connector) => connector.online && connector.readiness.stale === true);
  const unknown = connectorIds(enabled, (connector) => connector.online
    && connector.readiness.stale !== true
    && (connector.readiness.inbound === 'unknown' || connector.readiness.outbound === 'unknown'));
  const ready = enabled.filter((connector) => connector.online
    && connector.readiness.stale !== true
    && (connector.readiness.inbound === 'ready' || connector.readiness.outbound === 'ready')).length;
  const taskDeadLetters = input.tasks.dead_letter ?? 0;
  const outboxDeadLetters = input.outbox.dead_letter ?? 0;
  const taskBacklog = (input.tasks.queued ?? 0) + (input.tasks.running ?? 0)
    + (input.tasks.blocked ?? 0) + (input.tasks.paused ?? 0);
  const outboxBacklog = (input.outbox.pending ?? 0) + (input.outbox.sending ?? 0);
  const digestBacklog = input.pendingDigest ?? 0;
  const risks: DaemonHealthRisk[] = [];
  if (taskDeadLetters > 0) {
    risks.push({
      code: 'task_dead_letters',
      severity: 'warning',
      message: `${taskDeadLetters} 个任务进入 dead letter`,
      nextAction: 'mimi daemon tasks',
    });
  }
  if (outboxDeadLetters > 0) {
    risks.push({
      code: 'outbox_dead_letters',
      severity: 'warning',
      message: `${outboxDeadLetters} 个消息投递进入 dead letter`,
      nextAction: 'mimi daemon outbox',
    });
  }
  if (taskBacklog >= 100) {
    risks.push({
      code: 'task_backlog',
      severity: 'warning',
      message: `任务 backlog 已达到 ${taskBacklog}`,
      nextAction: 'mimi daemon tasks',
    });
  }
  if (outboxBacklog >= 100) {
    risks.push({
      code: 'outbox_backlog',
      severity: 'warning',
      message: `Outbox backlog 已达到 ${outboxBacklog}`,
      nextAction: 'mimi daemon outbox',
    });
  }
  if (digestBacklog >= 100) {
    risks.push({
      code: 'digest_backlog',
      severity: 'warning',
      message: `Digest backlog 已达到 ${digestBacklog}`,
      nextAction: 'mimi daemon attention',
    });
  }
  if (offline.length > 0) {
    risks.push({
      code: 'connector_offline',
      severity: 'warning',
      message: `${offline.length} 个已启用 Connector 离线：${offline.join(', ')}`,
      nextAction: 'mimi daemon connectors reload',
    });
  }
  if (unavailable.length > 0) {
    risks.push({
      code: 'connector_unavailable',
      severity: 'warning',
      message: `${unavailable.length} 个 Connector 进程在线但渠道不可用：${unavailable.join(', ')}`,
      nextAction: 'mimi daemon connectors',
    });
  }
  if (stale.length > 0) {
    risks.push({
      code: 'connector_stale',
      severity: 'warning',
      message: `${stale.length} 个 Connector 的轮询/readiness 心跳已过期：${stale.join(', ')}`,
      nextAction: 'mimi daemon connectors',
    });
  }
  if (unknown.length > 0) {
    risks.push({
      code: 'connector_readiness_unknown',
      severity: 'warning',
      message: `${unknown.length} 个 Connector 尚未报告完整渠道就绪度：${unknown.join(', ')}`,
      nextAction: 'mimi daemon connectors',
    });
  }
  return {
    state: risks.some((risk) => risk.severity === 'error')
      ? 'unhealthy'
      : risks.length > 0 ? 'degraded' : 'ready',
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    risks,
    backlog: {
      tasks: taskBacklog,
      outbox: outboxBacklog,
      digest: digestBacklog,
      taskDeadLetters,
      outboxDeadLetters,
    },
    connectors: {
      enabled: enabled.length,
      online: enabled.length - offline.length,
      ready,
      offline,
      unavailable,
      stale,
      unknown,
    },
  };
}
