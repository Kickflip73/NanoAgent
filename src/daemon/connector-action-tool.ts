import { tool, type Tool } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ConnectorActionRequest, ConnectorManager } from './connectors.js';

const identifier = z.string().regex(/^[a-zA-Z0-9._-]+$/);
const MAX_CONNECTORS = 50;
const MAX_ACTIONS = 100;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_ACTION_RESULT_BYTES = 32_000;

export interface ConnectorCapabilitySnapshot {
  configFile: string;
  total: number;
  enabled: number;
  online: number;
  inboundReady: number;
  outboundReady: number;
  stale: number;
  actions: number;
  truncated: boolean;
  connectors: Array<{
    id: string;
    enabled: boolean;
    online: boolean;
    readiness: {
      inbound: 'ready' | 'unavailable' | 'unknown';
      outbound: 'ready' | 'unavailable' | 'unknown';
      deliveryConfirmed?: boolean;
      reportedAt?: string;
      freshUntil?: string;
      stale?: boolean;
    };
    source: string;
    actions: Array<{ name: string; description: string }>;
  }>;
}

export interface ConnectorCapabilityFilter {
  connector?: string;
  query?: string;
}

/** Minimum Connector control-plane surface available inside a Task worker. */
export interface ConnectorTaskRuntime {
  inspectCapabilities(
    filter: ConnectorCapabilityFilter,
    signal?: AbortSignal,
  ): ConnectorCapabilitySnapshot | Promise<ConnectorCapabilitySnapshot>;
  executeAction(request: ConnectorActionRequest, signal?: AbortSignal): Promise<unknown>;
}

type InspectCapabilities = ConnectorTaskRuntime['inspectCapabilities'];
type ExecuteConnectorAction = ConnectorTaskRuntime['executeAction'];
type ConnectorActionReceipt = Record<string, unknown> & {
  tool: 'connector_action';
  connector: string;
  action: string;
  target: string;
  outcome: 'confirmed' | 'accepted';
};
type OnConnectorAction = (request: ConnectorActionRequest, receipt: ConnectorActionReceipt) => void;

function boundedActionResult(result: unknown): unknown {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) return result;
  const bytes = Buffer.from(serialized);
  if (bytes.byteLength <= MAX_ACTION_RESULT_BYTES) return result;
  return {
    truncated: true,
    originalBytes: bytes.byteLength,
    preview: bytes.subarray(0, MAX_ACTION_RESULT_BYTES).toString('utf8'),
  };
}

export function connectorCapabilitySnapshot(
  connectors: ConnectorManager,
  filter: ConnectorCapabilityFilter = {},
): ConnectorCapabilitySnapshot {
  const exact = filter.connector
    ? connectors.listCapabilities().filter((connector) => connector.id === filter.connector)
    : connectors.listCapabilities();
  const query = filter.query?.trim().toLowerCase();
  const all = query
    ? exact.flatMap((connector) => {
      const connectorMatches = `${connector.id}\n${connector.source}`.toLowerCase().includes(query);
      if (connectorMatches) return [connector];
      const actions = connector.actions.filter((action) => (
        `${action.name}\n${action.description}`.toLowerCase().includes(query)
      ));
      return actions.length ? [{ ...connector, actions }] : [];
    })
    : exact;
  const actionCount = all.reduce((total, connector) => total + connector.actions.length, 0);
  let remainingActions = MAX_ACTIONS;
  let truncatedDescription = false;
  const visible = all.slice(0, MAX_CONNECTORS).map((connector) => {
    const actions = connector.actions.slice(0, remainingActions).map((action) => {
      if (action.description.length > MAX_DESCRIPTION_CHARS) truncatedDescription = true;
      return { name: action.name, description: action.description.slice(0, MAX_DESCRIPTION_CHARS) };
    });
    remainingActions -= actions.length;
    return {
      id: connector.id,
      enabled: connector.enabled,
      online: connector.online,
      readiness: connector.readiness,
      source: connector.source.slice(0, 300),
      actions,
    };
  });
  const visibleActions = visible.reduce((total, connector) => total + connector.actions.length, 0);
  return {
    configFile: connectors.configPath,
    total: all.length,
    enabled: all.filter((connector) => connector.enabled).length,
    online: all.filter((connector) => connector.online).length,
    inboundReady: all.filter((connector) => connector.online
      && connector.readiness.stale !== true && connector.readiness.inbound === 'ready').length,
    outboundReady: all.filter((connector) => connector.online
      && connector.readiness.stale !== true && connector.readiness.outbound === 'ready').length,
    stale: all.filter((connector) => connector.online && connector.readiness.stale === true).length,
    actions: actionCount,
    truncated: all.length > visible.length || actionCount > visibleActions || truncatedDescription,
    connectors: visible,
  };
}

export function createConnectorCapabilityTool(connectors: ConnectorManager): Tool {
  return createConnectorCapabilityRuntimeTool((filter) => connectorCapabilitySnapshot(connectors, filter));
}

function createConnectorCapabilityRuntimeTool(inspect: InspectCapabilities): Tool {
  return tool({
    name: 'inspect_mimi_capabilities',
    description: '动态读取 MimiAgent 当前 Connector 的进程状态、真实 inbound/outbound 就绪度和有界 action 目录。已知渠道时用 connector 精确过滤；只知道关键词时用 query 搜索 connector/source/action，避免读取完整目录。online 只表示 Connector 进程存活；执行外部事务前应优先检查 readiness。',
    parameters: z.object({
      connector: identifier.optional().describe('可选 Connector ID 精确过滤，例如 openclaw-weixin 或 qq'),
      query: z.string().trim().min(1).max(100).optional().describe('可选关键词，匹配 Connector ID、source、action 名或描述'),
    }).strict(),
    execute: async (filter, _context, details) => inspect(filter, details?.signal),
  });
}

export function createConnectorReloadTool(connectors: ConnectorManager): Tool {
  return tool({
    name: 'reload_mimi_connectors',
    description: '重新读取并热切换 MimiAgent Connector 配置。用于应用 owner 在配置文件中完成的命令、凭证白名单或 action 目录修改；无效配置或存在进行中的 delivery/action 时旧 Connector 保持在线并返回错误。单纯启停已有渠道请使用 set_mimi_connector_enabled。',
    parameters: z.object({}),
    execute: async () => {
      await connectors.reload();
      return connectorCapabilitySnapshot(connectors);
    },
  });
}

export function createConnectorEnabledTool(connectors: ConnectorManager): Tool {
  return tool({
    name: 'set_mimi_connector_enabled',
    description: '原子启用或停用一个已经配置的 MimiAgent Connector，并立即热切换进程。不会读取或修改凭证、命令、环境白名单和 action 目录；存在进行中的 delivery/action 时保持原状态并返回错误。',
    parameters: z.object({
      connector: identifier.describe('已配置的 Connector ID'),
      enabled: z.boolean().describe('true 启用，false 停用'),
    }).strict(),
    execute: async ({ connector, enabled }) => connectors.setEnabled(connector, enabled),
  });
}

export function createConnectorHostTools(
  connectors: ConnectorManager,
  onAction?: OnConnectorAction,
): Tool[] {
  return [
    createConnectorCapabilityTool(connectors),
    createConnectorEnabledTool(connectors),
    createConnectorReloadTool(connectors),
    createConnectorActionTool(connectors, onAction),
  ];
}

/** Task workers can inspect and invoke Connectors, but cannot mutate the kernel Connector registry. */
export function createConnectorTaskHostTools(runtime: ConnectorTaskRuntime): Tool[] {
  return [
    createConnectorCapabilityRuntimeTool(runtime.inspectCapabilities.bind(runtime)),
    createConnectorActionRuntimeTool(runtime.executeAction.bind(runtime)),
  ];
}

export function createConnectorActionTool(
  connectors: ConnectorManager,
  onAction?: OnConnectorAction,
): Tool {
  return createConnectorActionRuntimeTool((request) => connectors.executeAction(request), onAction);
}

function createConnectorActionRuntimeTool(
  executeAction: ExecuteConnectorAction,
  onAction?: OnConnectorAction,
): Tool {
  return tool({
    name: 'connector_action',
    description: '通过隔离的 Connector 执行外部副作用，如发送 IM、创建日程或发送邮件。调用前先用 inspect_mimi_capabilities 获取当前 connector/action、target 格式和 readiness：已知 ID 时传 connector 精确过滤，不确定微信等渠道 ID 时传 query 关键词搜索，避免加载完整目录。不要猜测能力名。只能使用目录中已声明的能力；payloadJson 必须是严格 JSON。结果超时或不确定时不要自动重试，避免重复事务。',
    parameters: z.object({
      connector: identifier.describe('Connector ID，例如 daxiang'),
      action: identifier.describe('Connector 声明的 action 名称，例如 send_message'),
      target: z.string().min(1).max(2_000).describe('主要操作对象，例如 single:zhangsan 或 group:123'),
      payloadJson: z.string().min(1).max(50_000).describe('要传给 Connector 的 JSON 载荷'),
    }).strict(),
    execute: async ({ connector, action, target, payloadJson }, _context, details) => {
      let payload: unknown;
      try {
        payload = JSON.parse(payloadJson) as unknown;
      } catch {
        throw new Error('payloadJson 不是有效 JSON');
      }
      const result = await executeAction({ connector, action, target, payload }, details?.signal);
      const boundedResult = boundedActionResult(result);
      const value = boundedResult !== null && typeof boundedResult === 'object' && !Array.isArray(boundedResult)
        ? boundedResult as Record<string, unknown>
        : undefined;
      const declaredOutcome = value?.outcome;
      const outcome = declaredOutcome === 'confirmed' || declaredOutcome === 'accepted'
        ? declaredOutcome
        : value?.deliveryConfirmed === true
          || typeof value?.messageId === 'string'
          || typeof value?.requestId === 'string'
          ? 'confirmed'
          : 'accepted';
      const receipt: ConnectorActionReceipt = {
        ...(value ?? {}),
        operationId: typeof value?.operationId === 'string'
          ? value.operationId
          : typeof value?.messageId === 'string' ? value.messageId
            : typeof value?.requestId === 'string' ? value.requestId : randomUUID(),
        tool: 'connector_action',
        connector,
        action,
        target,
        outcome,
        ...(value ? {} : { evidence: boundedResult }),
        occurredAt: new Date().toISOString(),
      };
      onAction?.({ connector, action, target, payload }, receipt);
      return receipt;
    },
  });
}
