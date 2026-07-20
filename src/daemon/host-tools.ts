import type { Tool } from '@openai/agents';
import { createMimiActivityTools } from './activity-tools.js';
import { AttentionEngine } from './attention.js';
import { createMimiAttentionRuleTools } from './attention-rule-tools.js';
import { createMimiBriefingTools } from './briefing-tools.js';
import {
  createConnectorHostTools,
  createConnectorTaskHostTools,
  type ConnectorTaskRuntime,
} from './connector-action-tool.js';
import type { ConnectorManager } from './connectors.js';
import { createMimiDeliveryTools, type MimiDeliveryControl } from './delivery-tools.js';
import { createMimiPeopleTools } from './people-tools.js';
import { createMemoryMaintenanceTools, type MemoryMaintenanceRuntime } from './memory-maintenance-tools.js';
import { createMimiRoutineTools } from './routine-tools.js';
import { createMimiScheduleTools } from './schedule-tools.js';
import { createMimiSessionActivityTools } from './session-activity-tools.js';
import { createMimiSettingsTools } from './settings-tools.js';
import { createMimiSourcePolicyTools } from './source-policy-tools.js';
import { createMimiStandingOrderTools } from './standing-order-tools.js';
import {
  createBackgroundTaskTools,
  type BackgroundTaskBlockRequest,
  type BackgroundTaskPauseResult,
} from './task-tools.js';
import { MimiStore } from './store.js';
import type { ImmutableEvent, ReplyRoute, TaskRecord } from './types.js';
import type { EventCancelResult } from './dispatcher.js';

export interface MimiHostToolContext {
  store: MimiStore;
  attention: AttentionEngine;
  task: TaskRecord;
  event: ImmutableEvent;
  deliveryControl: MimiDeliveryControl;
  sessionId: string;
  connectors?: ConnectorManager;
  connectorRuntime?: ConnectorTaskRuntime;
  replyRoute?: ReplyRoute;
  cancelEvent?: (eventId: string, reason?: string) => EventCancelResult | Promise<EventCancelResult>;
  pauseEvent?: (
    eventId: string,
    reason?: string,
  ) => BackgroundTaskPauseResult | Promise<BackgroundTaskPauseResult>;
  blockTask?: (request: BackgroundTaskBlockRequest) => unknown | Promise<unknown>;
  memoryMaintenance?: MemoryMaintenanceRuntime;
}

/** One composition root for the Host Tools exposed to every Daemon run. */
export function createMimiHostTools(context: MimiHostToolContext): Tool[] {
  return [
    ...createMimiActivityTools(context.store),
    ...createMemoryMaintenanceTools(context.store, context.task, context.memoryMaintenance),
    ...createMimiAttentionRuleTools(context.attention),
    ...createMimiBriefingTools(context.attention),
    ...createMimiDeliveryTools(context.task, context.event, context.deliveryControl),
    ...createMimiPeopleTools(context.attention),
    ...createMimiRoutineTools(context.attention),
    ...createMimiScheduleTools(context.store, context.task, context.event, context.replyRoute, context.sessionId),
    ...createMimiSessionActivityTools(context.store, context.sessionId),
    ...createMimiSettingsTools(context.attention),
    ...createMimiSourcePolicyTools(context.attention),
    ...createMimiStandingOrderTools(context.attention),
    ...createBackgroundTaskTools({
      store: context.store,
      task: context.task,
      event: context.event,
      sessionId: context.sessionId,
      replyRoute: context.replyRoute,
      cancel: context.cancelEvent,
      pause: context.pauseEvent,
      block: context.blockTask,
    }),
    ...(context.connectors
      ? createConnectorHostTools(context.connectors, (request, receipt) => {
          const route = context.replyRoute;
          if (request.action !== 'send_message'
            || receipt.outcome !== 'confirmed'
            || route?.channel !== `connector:${request.connector}`
            || route.target !== request.target) return;
          context.deliveryControl.suppressed = true;
          context.deliveryControl.reason = '已通过同一 Connector 会话显式发送回复，抑制重复最终投递';
        })
      : context.connectorRuntime
        ? createConnectorTaskHostTools(context.connectorRuntime)
        : []),
  ];
}

/**
 * Builds the exact catalog a normal owner CLI command receives. The returned
 * tools are used only for discovery; execution always uses the real Event.
 */
export function createMimiCommandHostTools(
  store: MimiStore,
  attention: AttentionEngine,
  connectors: ConnectorManager | undefined,
  sessionId: string,
): Tool[] {
  const timestamp = new Date().toISOString();
  const event: ImmutableEvent = {
    id: 'mimi-cli-tool-catalog',
    externalId: 'mimi-cli-tool-catalog',
    source: 'local-cli',
    type: 'command.received',
    trust: 'owner',
    payload: {},
    occurredAt: timestamp,
    receivedAt: timestamp,
    profileId: 'owner',
    createdAt: timestamp,
  };
  const task: TaskRecord = {
    id: 'mimi-cli-tool-catalog-task',
    type: 'conversation',
    idempotencyKey: 'mimi-cli-tool-catalog-task',
    authorityEventId: event.id,
    profileId: 'owner',
    sessionKey: sessionId,
    objective: {},
    executor: 'session_actor',
    workspaceAccess: 'write',
    priority: 100,
    status: 'running',
    notBefore: timestamp,
    attemptCount: 1,
    maxAttempts: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return createMimiHostTools({
    store,
    attention,
    connectors,
    task,
    event,
    deliveryControl: { suppressed: false },
    sessionId,
  });
}
