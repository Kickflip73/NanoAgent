import type { AgentInputItem } from '@openai/agents';
import type { AgentPermissionMode } from '../config.js';
import type { Memory } from '../core/memory.js';
import type { PlanStep } from '../core/plan.js';
import type { RunCheckpoint } from '../core/session.js';

export type EventTrust = 'owner' | 'trusted' | 'external' | 'public' | 'system';
export type EventKind = 'command' | 'alert' | 'ambient' | 'schedule' | 'webhook';
export type EventExecutionLane = 'conversation' | 'task';
export type TaskControlIntent = 'pause' | 'cancel';
export type EventStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'ignored'
  | 'digested'
  | 'dead_letter'
  | 'archived';

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
  executionLane?: EventExecutionLane;
  originSessionKey?: string;
  parentEventId?: string;
  rootEventId?: string;
  taskDepth?: number;
}

export interface StoredEvent extends EventEnvelope {
  taskControl?: TaskControlIntent;
  taskControlReason?: string;
  status: EventStatus;
  attempts: number;
  maxAttempts?: number;
  completionDeferrals?: number;
  completionNoProgressDeferrals?: number;
  completionProgressFingerprint?: string;
  notBefore: string;
  leaseOwner?: string;
  leaseUntil?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'dead_letter' | 'archived';

export interface OutboxMessage {
  id: string;
  eventId: string;
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
  eventId: string;
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
  kind: EventKind;
  trust: EventTrust;
  status: EventStatus;
  priority: number;
  attempts: number;
  profileId: string;
  sessionKey?: string;
  occurredAt: string;
  receivedAt: string;
  updatedAt: string;
  error?: string;
}

export interface MimiRunSummary {
  id: string;
  eventId: string;
  sessionKey: string;
  status: HostRunStatus;
  startedAt: string;
  completedAt?: string;
  answerAvailable: boolean;
  error?: string;
}

export interface MimiOutboxSummary {
  id: string;
  eventId: string;
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

export const DAEMON_PROTOCOL_VERSION = 6;

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
  events: Record<EventStatus, number>;
  outbox: Record<OutboxStatus, number>;
  enabledSchedules: number;
}

export type DaemonWorkerStatus = Omit<
  DaemonStatus,
  'protocolVersion' | 'permissionMode' | 'workspaceRoot' | 'activeHostMutations'
>;

export interface MimiActivityEvent {
  id: string;
  source: string;
  kind: EventKind;
  status: EventStatus;
  priority: number;
  attempts: number;
  occurredAt: string;
  updatedAt: string;
  error?: string;
}

export interface MimiActivityRun {
  id: string;
  eventId: string;
  status: HostRunStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface MimiActivityDelivery {
  id: string;
  eventId: string;
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
  events: Record<EventStatus, number>;
  outbox: Record<OutboxStatus, number>;
  recentEvents: MimiActivityEvent[];
  recentRuns: MimiActivityRun[];
  recentDeliveries: MimiActivityDelivery[];
  recentTransitions: MimiActivityTransition[];
}

export interface MimiSessionActivity {
  eventId: string;
  source: string;
  kind: EventKind;
  eventStatus: EventStatus;
  runStatus: HostRunStatus;
  occurredAt: string;
  startedAt: string;
  completedAt?: string;
  answer?: string;
  error?: string;
}

export interface MimiChatSnapshot {
  sessionId: string;
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

export interface MimiMemoryItem extends Memory {
  index: number;
  contentBytes: number;
  contentTruncated: boolean;
}

export interface MimiMemoryPage {
  items: MimiMemoryItem[];
  nextOffset?: number;
  revision: string;
  total: number;
}

export interface MimiMemoryContentChunk {
  chunk: string;
  nextOffset?: number;
  revision: string;
  totalCharacters: number;
}

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
  event?: MimiStreamEventState;
  nextSequence?: number;
  hasMore?: boolean;
}

export interface MimiStreamEventState {
  id: string;
  status: EventStatus;
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
