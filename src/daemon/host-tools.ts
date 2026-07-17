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
import type { ReplyRoute, StoredEvent } from './types.js';
import type { EventCancelResult } from './dispatcher.js';

export interface MimiHostToolContext {
  store: MimiStore;
  attention: AttentionEngine;
  event: StoredEvent;
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
}

/** One composition root for the Host Tools exposed to every Daemon run. */
export function createMimiHostTools(context: MimiHostToolContext): Tool[] {
  return [
    ...createMimiActivityTools(context.store),
    ...createMimiAttentionRuleTools(context.attention),
    ...createMimiBriefingTools(context.attention),
    ...createMimiDeliveryTools(context.event, context.deliveryControl),
    ...createMimiPeopleTools(context.attention),
    ...createMimiRoutineTools(context.attention),
    ...createMimiScheduleTools(context.store, context.event, context.replyRoute, context.sessionId),
    ...createMimiSessionActivityTools(context.store, context.sessionId),
    ...createMimiSettingsTools(context.attention),
    ...createMimiSourcePolicyTools(context.attention),
    ...createMimiStandingOrderTools(context.attention),
    ...createBackgroundTaskTools({
      store: context.store,
      event: context.event,
      sessionId: context.sessionId,
      replyRoute: context.replyRoute,
      cancel: context.cancelEvent,
      pause: context.pauseEvent,
      block: context.blockTask,
    }),
    ...(context.connectors
      ? createConnectorHostTools(context.connectors)
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
  const event: StoredEvent = {
    id: 'mimi-cli-tool-catalog',
    externalId: 'mimi-cli-tool-catalog',
    source: 'local-cli',
    kind: 'command',
    trust: 'owner',
    payload: {},
    occurredAt: timestamp,
    receivedAt: timestamp,
    priority: 100,
    profileId: 'owner',
    sessionKey: sessionId,
    status: 'running',
    attempts: 1,
    notBefore: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return createMimiHostTools({
    store,
    attention,
    connectors,
    event,
    deliveryControl: { suppressed: false },
    sessionId,
  });
}
