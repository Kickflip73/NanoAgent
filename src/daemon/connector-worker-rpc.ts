import { z } from 'zod';
import type {
  ConnectorCapabilityFilter,
  ConnectorCapabilitySnapshot,
  ConnectorTaskRuntime,
} from './connector-action-tool.js';
import type { ConnectorActionRequest } from './connectors.js';
import { mimiRpc } from './ipc.js';
import { taskWorkerTokenSchema } from './worker-protocol.js';

export const WORKER_CONNECTOR_INSPECT_METHOD = 'worker.connector.inspect';
export const WORKER_CONNECTOR_ACTION_METHOD = 'worker.connector.action';

const identifier = z.string().regex(/^[a-zA-Z0-9._-]+$/);
const taskIdSchema = z.string().uuid();

export const workerConnectorFilterSchema = z.object({
  connector: identifier.optional(),
  query: z.string().trim().min(1).max(100).optional(),
}).strict();

const workerAuthorizationSchema = {
  taskId: taskIdSchema,
  workerToken: taskWorkerTokenSchema,
};

export const workerConnectorInspectParamsSchema = z.object({
  ...workerAuthorizationSchema,
  filter: workerConnectorFilterSchema,
}).strict();

const connectorActionRequestSchema = z.object({
  connector: identifier,
  action: identifier,
  target: z.string().trim().min(1).max(2_000),
  payload: z.unknown(),
}).strict();

export const workerConnectorActionParamsSchema = z.object({
  ...workerAuthorizationSchema,
  request: connectorActionRequestSchema,
}).strict();

const readinessSchema = z.object({
  inbound: z.enum(['ready', 'unavailable', 'unknown']),
  outbound: z.enum(['ready', 'unavailable', 'unknown']),
  deliveryConfirmed: z.boolean().optional(),
  reportedAt: z.string().datetime().optional(),
  freshUntil: z.string().datetime().optional(),
  stale: z.boolean().optional(),
}).strict();

export const connectorCapabilitySnapshotSchema = z.object({
  configFile: z.string().min(1).max(16_384),
  total: z.number().int().nonnegative(),
  enabled: z.number().int().nonnegative(),
  online: z.number().int().nonnegative(),
  inboundReady: z.number().int().nonnegative(),
  outboundReady: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  actions: z.number().int().nonnegative(),
  truncated: z.boolean(),
  connectors: z.array(z.object({
    id: identifier,
    enabled: z.boolean(),
    online: z.boolean(),
    readiness: readinessSchema,
    source: z.string().max(300),
    actions: z.array(z.object({
      name: identifier,
      description: z.string().max(300),
    }).strict()).max(100),
  }).strict()).max(50),
}).strict().superRefine((snapshot, context) => {
  const visibleActions = snapshot.connectors.reduce((total, connector) => total + connector.actions.length, 0);
  if (visibleActions > 100) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Connector capability snapshot action 目录超过 100 条',
      path: ['connectors'],
    });
  }
});

export const WORKER_CONNECTOR_INSPECT_TIMEOUT_MS = 5_000;
export const WORKER_CONNECTOR_ACTION_TIMEOUT_MS = 905_000;

/** Task-side proxy; Connector credentials and channel processes remain owned by the kernel daemon. */
export class KernelConnectorRuntime implements ConnectorTaskRuntime {
  constructor(
    private readonly socket: string,
    private readonly taskId: string,
    private readonly workerToken: string,
  ) {
    taskIdSchema.parse(taskId);
    taskWorkerTokenSchema.parse(workerToken);
    if (!socket.trim()) throw new Error('MimiAgent Connector Broker socket 不能为空');
  }

  async inspectCapabilities(
    filter: ConnectorCapabilityFilter,
    signal?: AbortSignal,
  ): Promise<ConnectorCapabilitySnapshot> {
    const params = workerConnectorInspectParamsSchema.parse({
      taskId: this.taskId,
      workerToken: this.workerToken,
      filter,
    });
    const response = await mimiRpc<unknown>(
      this.socket,
      WORKER_CONNECTOR_INSPECT_METHOD,
      params,
      WORKER_CONNECTOR_INSPECT_TIMEOUT_MS,
      signal,
      { controlAuth: false },
    );
    return connectorCapabilitySnapshotSchema.parse(response) as ConnectorCapabilitySnapshot;
  }

  async executeAction(request: ConnectorActionRequest, signal?: AbortSignal): Promise<unknown> {
    const params = workerConnectorActionParamsSchema.parse({
      taskId: this.taskId,
      workerToken: this.workerToken,
      request,
    });
    return await mimiRpc(
      this.socket,
      WORKER_CONNECTOR_ACTION_METHOD,
      params,
      WORKER_CONNECTOR_ACTION_TIMEOUT_MS,
      signal,
      { controlAuth: false },
    );
  }
}
