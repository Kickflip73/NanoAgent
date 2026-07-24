import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { restrictedShellEnvironment } from '../runtime/shell-environment.js';

export function restrictedTaskShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return restrictedShellEnvironment(source);
}

const openAiProviderCredentialSchema = z.object({
  provider: z.literal('openai'),
  apiKey: z.string().trim().min(1).max(16_384),
}).strict();

const providerCredentialSchema = z.discriminatedUnion('provider', [
  openAiProviderCredentialSchema,
  z.object({
    provider: z.literal('deepseek'),
    apiKey: z.string().trim().min(1).max(16_384),
  }).strict(),
]);

export type TaskProviderCredential = z.infer<typeof providerCredentialSchema>;
export type TaskEmbeddingCredential = z.infer<typeof openAiProviderCredentialSchema>;

const taskMcpEnvironmentSchema = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/i),
  z.string().max(16_384),
).superRefine((environment, context) => {
  const entries = Object.entries(environment);
  if (entries.length > 50) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP environment 不能超过 50 项' });
  }
  const totalBytes = entries.reduce((total, [, value]) => total + Buffer.byteLength(value, 'utf8'), 0);
  if (totalBytes > 65_536) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'MCP environment 合计不能超过 65536 字节' });
  }
});

export function taskProviderEnvironmentName(
  provider: TaskProviderCredential['provider'],
): 'OPENAI_API_KEY' | 'DEEPSEEK_API_KEY' {
  return provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY';
}

export async function withTaskProviderCredential<T>(
  credential: TaskProviderCredential,
  operation: () => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const name = taskProviderEnvironmentName(credential.provider);
  const previous = environment[name];
  environment[name] = credential.apiKey;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete environment[name];
    else environment[name] = previous;
  }
}

const appConfigSchema = z.object({
  provider: z.enum(['openai', 'deepseek']),
  workspaceRoot: z.string().min(1),
  dataRoot: z.string().min(1),
  daemonDataRoot: z.string().min(1).optional(),
  skillsRoot: z.string().min(1),
  mcpConfig: z.string().min(1),
  historyLimit: z.number().int().positive(),
  contextWindow: z.number().int().positive().optional(),
  outputReserve: z.number().int().positive().optional(),
  maxTurns: z.number().int().positive().nullable(),
  teamMaxConcurrency: z.number().int().positive().optional(),
  sessionMaxConcurrency: z.number().int().positive().optional(),
  permissionMode: z.enum(['workspace', 'read-only', 'trusted']).optional(),
  securityProfile: z.enum(['safe', 'workstation', 'full-owner']).optional(),
  trustedWorkspaceMcp: z.string().min(1).optional(),
}).strict();

export function taskWorkerConfig(config: AppConfig): z.infer<typeof appConfigSchema> {
  const workerConfig = { ...config };
  delete workerConfig.computer;
  return appConfigSchema.parse(workerConfig);
}

export const taskWorkerTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const taskWorkerInitSchema = z.object({
  type: z.literal('init'),
  executor: z.enum(['mimi', 'codex']).default('mimi'),
  taskId: z.string().uuid(),
  database: z.string().min(1),
  assistantConfig: z.string().min(1),
  socket: z.string().min(1),
  workerToken: taskWorkerTokenSchema,
  workspaceAccess: z.enum(['read', 'write']),
  enableMcp: z.boolean(),
  providerCredential: providerCredentialSchema.optional(),
  embeddingCredential: openAiProviderCredentialSchema.optional(),
  mcpEnvironment: taskMcpEnvironmentSchema,
  config: appConfigSchema,
}).strict().superRefine((init, context) => {
  if (init.executor === 'mimi' && !init.providerCredential) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Mimi Task worker 必须携带 provider credential',
      path: ['providerCredential'],
    });
  }
  if (init.providerCredential && init.providerCredential.provider !== init.config.provider) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Task worker provider credential 与运行配置不匹配',
      path: ['providerCredential', 'provider'],
    });
  }
  if (init.embeddingCredential && init.config.provider !== 'deepseek') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Embedding credential 仅用于 DeepSeek Task 的 OpenAI MemoryHub 检索',
      path: ['embeddingCredential'],
    });
  }
  if (init.enableMcp && init.workspaceAccess !== 'write') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'MCP 仅能在 write Task 中启用',
      path: ['enableMcp'],
    });
  }
  if (init.executor === 'codex' && (init.providerCredential || init.embeddingCredential || init.enableMcp)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Codex Task worker 不接收 Mimi provider/MCP credential',
      path: ['executor'],
    });
  }
  if (!init.enableMcp && Object.keys(init.mcpEnvironment).length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: '禁用 MCP 时不得携带 MCP environment',
      path: ['mcpEnvironment'],
    });
  }
});

export const taskWorkerControlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cancel'),
    taskId: z.string().uuid(),
    reason: z.string().min(1).max(4_000),
  }).strict(),
  z.object({
    type: z.literal('pause'),
    taskId: z.string().uuid(),
    reason: z.string().min(1).max(4_000),
  }).strict(),
  z.object({ type: z.literal('shutdown') }).strict(),
]);

const pendingStreamEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), text: z.string() }).passthrough(),
  z.object({ kind: z.literal('reasoning'), text: z.string() }).passthrough(),
  z.object({ kind: z.literal('plan'), steps: z.array(z.unknown()) }).passthrough(),
  z.object({
    kind: z.literal('status'),
    tone: z.enum(['agent', 'thinking', 'tool', 'success', 'failure']),
    title: z.string(),
    detail: z.string().optional(),
    fullDetail: z.string().optional(),
    next: z.string(),
  }).passthrough(),
]);

export const taskWorkerOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    taskId: z.string().uuid(),
    workerId: z.string().min(1).max(200),
    pid: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('stream'),
    taskId: z.string().uuid(),
    event: pendingStreamEventSchema,
  }).strict(),
  z.object({
    type: z.literal('heartbeat'),
    taskId: z.string().uuid(),
    at: z.string().datetime(),
  }).strict(),
  z.object({
    type: z.literal('detached'),
    taskId: z.string().uuid(),
    runnerPid: z.number().int().positive(),
    codexPid: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal('done'),
    taskId: z.string().uuid(),
    processed: z.boolean(),
    status: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal('error'),
    taskId: z.string().uuid(),
    error: z.string().min(1).max(4_000),
  }).strict(),
]);

export type TaskWorkerInit = z.infer<typeof taskWorkerInitSchema>;
export type TaskWorkerControl = z.infer<typeof taskWorkerControlSchema>;
export type TaskWorkerOutput = z.infer<typeof taskWorkerOutputSchema>;
