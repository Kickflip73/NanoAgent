import type { AgentInputItem } from '@openai/agents';
import { z } from 'zod';
import type { AgentPermissionMode, SecurityProfileSummary } from '../config.js';
import type { CuaDriverLifecycleStatus } from '../extensions/computer/cua-driver-lifecycle.js';
import type { DaemonLifecycleEpoch } from './lifecycle.js';
import type { DaemonHealthSnapshot } from './health-model.js';
import type { MemoryHit, SourceRef } from '../core/memory.js';
import type { PlanStep } from '../core/plan.js';
import type { RunCheckpoint } from '../core/session.js';
import type { RunFailureRecord } from '../core/run-failure.js';
import type { MimiContextStatus } from '../core/context.js';
import type { DailyResourceTrend } from './resource-slo.js';
import type {
  AutonomousBudgetExhaustion,
  RunSourceCategory,
  RunSourceUsage,
} from './run-source.js';
import type {
  DeadLetterClassification,
  DigestClassification,
  ReadinessUnknownClassification,
} from './operational-classification.js';

export const eventTrustSchema = z.enum(['owner', 'trusted', 'external', 'public', 'system']);
export const eventKindSchema = z.enum(['command', 'alert', 'ambient', 'schedule', 'webhook']);
export type EventTrust = z.infer<typeof eventTrustSchema>;
export type EventKind = z.infer<typeof eventKindSchema>;
export type TaskControlIntent = 'pause' | 'cancel';

export interface EventActor {
  id: string;
  displayName?: string;
}

export interface EventConversation {
  id: string;
  threadId?: string;
}

export interface ReplyRoute {
  channel: string;
  target?: string;
}

export interface EventEnvelope {
  id: string;
  externalId: string;
  source: string;
  kind: EventKind;
  trust: EventTrust;
  actor?: EventActor;
  conversation?: EventConversation;
  payload: unknown;
  occurredAt: string;
  receivedAt: string;
  priority: number;
  profileId: string;
  sessionKey?: string;
  replyRoute?: ReplyRoute;
}

export type EventSubjectType = 'task' | 'schedule' | 'connector';

export interface ImmutableEventInput {
  id: string;
  externalId: string;
  source: string;
  type: string;
  trust: EventTrust;
  actor?: EventActor;
  conversation?: EventConversation;
  payload: unknown;
  subjectType?: EventSubjectType;
  subjectId?: string;
  correlationId?: string;
  causationEventId?: string;
  profileId: string;
  replyRoute?: ReplyRoute;
  occurredAt: string;
  receivedAt: string;
}

export interface ImmutableEvent extends ImmutableEventInput {
  createdAt: string;
}

export type EventRouteDecision = 'observe_only' | 'digest' | 'task_created' | 'rejected';

export interface EventRouteReceipt {
  eventId: string;
  routerVersion: string;
  decision: EventRouteDecision;
  taskIds: string[];
  reasonCode: string;
  routedAt: string;
}

export type TaskType = 'conversation' | 'background' | 'scheduled' | 'briefing' | 'memory_maintenance';
export type TaskExecutor = 'session_actor' | 'isolated_worker' | 'codex';
export type TaskWorkspaceAccess = 'none' | 'read' | 'write';
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'dead_letter';

export interface TaskInput {
  id: string;
  type: TaskType;
  idempotencyKey: string;
  triggerEventId?: string;
  authorityEventId: string;
  parentTaskId?: string;
  profileId: string;
  sessionKey?: string;
  objective: unknown;
  executor: TaskExecutor;
  workspaceAccess: TaskWorkspaceAccess;
  priority: number;
  notBefore?: string;
  maxAttempts?: number;
}

export interface TaskRecord extends TaskInput {
  status: TaskStatus;
  notBefore: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseUntil?: string;
  controlIntent?: TaskControlIntent;
  controlReason?: string;
  result?: unknown;
  failure?: RunFailureRecord;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSelector {
  executor?: TaskExecutor;
  executors?: TaskExecutor[];
  excludedSessionKeys?: string[];
}

export interface TaskRouteInput {
  routerVersion: string;
  decision: EventRouteDecision;
  reasonCode: string;
  tasks?: TaskInput[];
}

export interface IngressTaskRoute {
  type?: TaskType;
  authorityEventId?: string;
  parentTaskId?: string;
  sessionKey?: string;
  executor?: TaskExecutor;
  workspaceAccess?: TaskWorkspaceAccess;
}

export interface TaskAttemptRecord {
  id: string;
  taskId: string;
  attemptNo: number;
  sessionKey: string;
  workerId: string;
  status: HostRunStatus;
  startedAt: string;
  completedAt?: string;
  answer?: unknown;
  error?: string;
}

export interface MemoryObservation {
  sourceKey: string;
  eventId: string;
  taskId: string;
  runId: string;
  sessionId: string;
  profileId: string;
  outcome: 'completed' | 'dead_letter';
  trust: EventTrust;
  contentDigest: string;
  observedAt: string;
  compiledAt?: string;
  receiptId?: string;
}

export interface MemoryEvidenceSnapshot {
  objective: unknown;
  result?: unknown;
  error?: string;
}

export interface MemoryObservationCard extends MemoryObservation {
  sourceRef: SourceRef;
  evidenceSnapshot: MemoryEvidenceSnapshot;
  objective: unknown;
  result?: unknown;
  error?: string;
}

export interface MemoryObservationStatus {
  pending: number;
  oldestPendingAt?: string;
  queuedMaintenance: number;
  runsLast24Hours: number;
  changesSinceSemanticLint: number;
  semanticLintDue: boolean;
  lastSemanticLintAt?: string;
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'dead_letter' | 'archived';

export interface OutboxMessage {
  id: string;
  taskId: string;
  channel: string;
  target?: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  notBefore: string;
  leaseOwner?: string;
  leaseUntil?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type HostRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export type HostRunRecord = TaskAttemptRecord;

export interface MimiEventSummary {
  id: string;
  externalId: string;
  source: string;
  type: string;
  trust: EventTrust;
  subjectType?: EventSubjectType;
  subjectId?: string;
  profileId: string;
  occurredAt: string;
  receivedAt: string;
  createdAt: string;
}

export interface MimiRunSummary {
  id: string;
  taskId: string;
  attemptNo: number;
  sessionKey: string;
  status: HostRunStatus;
  startedAt: string;
  completedAt?: string;
  answerAvailable: boolean;
  error?: string;
  source: string;
  sourceCategory: RunSourceCategory;
}

export interface MimiOutboxSummary {
  id: string;
  taskId: string;
  channel: string;
  target?: string;
  status: OutboxStatus;
  attempts: number;
  notBefore: string;
  updatedAt: string;
  error?: string;
}

export type ScheduleType = 'at' | 'interval' | 'watch';

export interface ScheduleRecord {
  id: string;
  name: string;
  type: ScheduleType;
  value: string;
  prompt: string;
  profileId: string;
  sessionKey?: string;
  authorityEventId?: string;
  context?: { workspaceRoot?: string; summary?: string; lastResult?: string; lastCheckedAt?: string };
  replyRoute?: ReplyRoute;
  trust: EventTrust;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MimiScheduleSummary {
  id: string;
  name: string;
  type: ScheduleType;
  value: string;
  profileId: string;
  sessionKey?: string;
  trust: EventTrust;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  promptPreview: string;
  promptLength: number;
  promptTruncated: boolean;
  updatedAt: string;
}

export interface MimiSchedulePage {
  items: MimiScheduleSummary[];
  nextOffset?: number;
  revision: string;
  total: number;
}

// Protocol 11 adds Session-scoped security profiles and live chat switching.
export const DAEMON_PROTOCOL_VERSION = 11;

export interface DaemonTaskWorkerStatus {
  taskId: string;
  pid?: number;
  workerId?: string;
  heartbeatAt?: string;
}

export interface DaemonTaskWorkerRuntime {
  ready: boolean;
  reason?: string;
}

export interface DaemonProviderHealth {
  provider: string;
  state: 'closed' | 'open' | 'half_open';
  failures: number;
  openedAt?: string;
  retryAt?: string;
  lastFailure?: 'rate_limit' | 'insufficient_balance' | 'network' | 'server' | 'other';
  lastSuccessAt?: string;
}

export interface DaemonStatus {
  protocolVersion: number;
  buildVersion?: string;
  permissionMode?: AgentPermissionMode;
  securityProfile?: SecurityProfileSummary;
  pid: number;
  startedAt: string;
  workerId: string;
  lifecycle?: DaemonLifecycleEpoch;
  workspaceRoot: string;
  activeEventId?: string;
  activeEventIds?: string[];
  activeEventCount?: number;
  activeToolCount?: number;
  activeTaskCount?: number;
  taskWorkers?: DaemonTaskWorkerStatus[];
  taskWorkerRuntime?: DaemonTaskWorkerRuntime;
  activeHostMutations: number;
  webhookAddress?: string;
  runtimeHttpAddress?: string;
  connectorCount?: number;
  attention?: Record<string, unknown>;
  events: { total: number };
  tasks: Record<TaskStatus, number>;
  outbox: Record<OutboxStatus, number>;
  enabledSchedules: number;
  health?: DaemonHealthSnapshot;
  effectiveCapability?: {
    schemaVersion: number;
    snapshotDigest: string;
    observedAt: string;
  };
  providerHealth?: DaemonProviderHealth;
  providerHealthRoutes?: DaemonProviderHealth[];
  computer?: CuaDriverLifecycleStatus;
}

export type DaemonWorkerStatus = Omit<
  DaemonStatus,
  'protocolVersion' | 'permissionMode' | 'workspaceRoot' | 'activeHostMutations'
>;

export interface MimiActivityEvent {
  id: string;
  source: string;
  type: string;
  subjectType?: EventSubjectType;
  subjectId?: string;
  occurredAt: string;
  receivedAt: string;
}

export interface MimiActivityTask {
  id: string;
  type: TaskType;
  status: TaskStatus;
  triggerEventId?: string;
  source?: string;
  eventType?: string;
  priority: number;
  attemptCount: number;
  updatedAt: string;
  error?: string;
  failure?: RunFailureRecord;
}

export interface MimiActivityRun {
  id: string;
  taskId: string;
  status: HostRunStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
  source: string;
  sourceCategory: RunSourceCategory;
}

export interface MimiActivityDelivery {
  id: string;
  taskId: string;
  channel: string;
  status: OutboxStatus;
  attempts: number;
  updatedAt: string;
  error?: string;
}

export interface MimiActivityTransition {
  sequence: number;
  type: string;
  entityId: string;
  createdAt: string;
}

export interface MimiActivitySnapshot {
  generatedAt: string;
  needsAttention: boolean;
  workPending: number;
  pendingDigest: number;
  enabledSchedules: number;
  events: { total: number };
  tasks: Record<TaskStatus, number>;
  tasksByType: Record<TaskType, Record<TaskStatus, number>>;
  outbox: Record<OutboxStatus, number>;
  recentEvents: MimiActivityEvent[];
  recentTasks: MimiActivityTask[];
  recentRuns: MimiActivityRun[];
  recentDeliveries: MimiActivityDelivery[];
  recentTransitions: MimiActivityTransition[];
  resourceTrends: DailyResourceTrend[];
  runUsageBySource: RunSourceUsage[];
  unknownRunSources: number;
  autonomousBudgetExhaustions: AutonomousBudgetExhaustion[];
  failureClassification: {
    deadLetters: DeadLetterClassification[];
    digest: DigestClassification[];
    readinessUnknown?: ReadinessUnknownClassification[];
    unclassifiedDeadLetters: number;
  };
}

export interface MimiSessionActivity {
  taskId: string;
  eventId?: string;
  source: string;
  type: string;
  taskStatus: TaskStatus;
  runStatus: HostRunStatus;
  occurredAt: string;
  startedAt: string;
  completedAt?: string;
  answer?: string;
  error?: string;
}

export interface MimiChatSnapshot {
  sessionId: string;
  draft?: boolean;
  workspaceRoot: string;
  provider: string;
  model: string;
  mode: string;
  outputLevel: 'answer' | 'thinking' | 'tools' | 'trace';
  permissionMode: AgentPermissionMode;
  contextUsed: number;
  contextWindow: number;
  contextStatus?: MimiContextStatus;
  items: AgentInputItem[];
  plan: PlanStep[];
  recovery?: RunCheckpoint;
}

export interface MimiHistoryChunk {
  chunk: string;
  nextOffset?: number;
  revision: string;
  totalCharacters: number;
}

export type MimiMemoryItem = MemoryHit;

export type MimiStreamEvent = {
  sequence: number;
  eventId: string;
} & (
  | { kind: 'answer'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'plan'; steps: PlanStep[] }
  | {
      kind: 'status';
      tone: 'agent' | 'thinking' | 'tool' | 'success' | 'failure';
      title: string;
      detail?: string;
      fullDetail?: string;
      next: string;
    }
);

export interface MimiStreamSnapshot {
  events: MimiStreamEvent[];
  task?: MimiStreamTaskState;
  nextSequence?: number;
  hasMore?: boolean;
}

export interface MimiStreamTaskState {
  id: string;
  status: TaskStatus;
  result?: unknown;
  error?: string;
}

export interface DigestItem {
  id: string;
  eventId: string;
  source: string;
  kind: EventKind;
  priority: number;
  payload: unknown;
  reason: string;
  occurredAt: string;
  createdAt: string;
  digestedAt?: string;
  briefingEventId?: string;
}
