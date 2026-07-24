import type { AgentInputItem } from '@openai/agents';
import type { AgentPermissionMode, SecurityProfileSummary } from '../config.js';
import type { DaemonHealthSnapshot } from './health-model.js';
import type { MemoryHit, SourceRef } from '../core/memory.js';
import type { PlanStep } from '../core/plan.js';
import type { RunCheckpoint } from '../core/session.js';

export type EventTrust = 'owner' | 'trusted' | 'external' | 'public' | 'system';
export type EventKind = 'command' | 'alert' | 'ambient' | 'schedule' | 'webhook';
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
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSelector {
  types?: TaskType[];
  executor?: TaskExecutor;
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

export interface MemoryObservationCard extends MemoryObservation {
  sourceRef: SourceRef;
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

export interface HostRunRecord {
  id: string;
  taskId: string;
  attemptNo: number;
  workerId: string;
  sessionKey: string;
  status: HostRunStatus;
  startedAt: string;
  completedAt?: string;
  answer?: unknown;
  error?: string;
}

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

// Protocol 9 completes the MemoryHub control surface and maintenance status.
export const DAEMON_PROTOCOL_VERSION = 9;

export interface DaemonTaskWorkerStatus {
  taskId: string;
  pid?: number;
  workerId?: string;
  heartbeatAt?: string;
}

export interface DaemonStatus {
  protocolVersion: number;
  buildVersion?: string;
  permissionMode?: AgentPermissionMode;
  securityProfile?: SecurityProfileSummary;
  pid: number;
  startedAt: string;
  workerId: string;
  workspaceRoot: string;
  activeEventId?: string;
  activeEventIds?: string[];
  activeEventCount?: number;
  activeTaskCount?: number;
  taskWorkers?: DaemonTaskWorkerStatus[];
  activeHostMutations: number;
  webhookAddress?: string;
  connectorCount?: number;
  attention?: Record<string, unknown>;
  events: { total: number };
  tasks: Record<TaskStatus, number>;
  outbox: Record<OutboxStatus, number>;
  enabledSchedules: number;
  health?: DaemonHealthSnapshot;
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
}

export interface MimiActivityRun {
  id: string;
  taskId: string;
  status: HostRunStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
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
  contextUsed: number;
  contextWindow: number;
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
