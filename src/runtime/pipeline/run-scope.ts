import { randomUUID } from 'node:crypto';
import type {
  AgentPermissionMode,
  AppConfig,
  SecurityProfile,
} from '../../config.js';
import type { AgentMode } from '../instructions.js';

export interface RunScopeCause {
  eventId: string;
  taskId?: string;
  profileId?: string;
  source: string;
  actor?: string;
  conversation?: string;
  trust: 'owner' | 'trusted' | 'external' | 'public' | 'system';
  personId?: string;
  personName?: string;
}

export interface RunScope {
  readonly runId: string;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly profileId: string;
  readonly workspaceRoot: string;
  readonly provider: AppConfig['provider'];
  readonly model: string;
  readonly mode: AgentMode;
  readonly permissionMode: AgentPermissionMode;
  readonly securityProfile: SecurityProfile;
  readonly input: string;
  readonly cause?: Readonly<RunScopeCause>;
  readonly executionKey?: string;
}

export interface RunScopeInput {
  sessionId: string;
  workspaceRoot: string;
  provider: AppConfig['provider'];
  model: string;
  mode: AgentMode;
  permissionMode: AgentPermissionMode;
  securityProfile: SecurityProfile;
  input: string;
  options?: {
    cause?: RunScopeCause;
    executionKey?: string;
  };
}

export function captureRunScope(input: RunScopeInput): RunScope {
  const cause = input.options?.cause
    ? Object.freeze({ ...input.options.cause })
    : undefined;
  return Object.freeze({
    runId: randomUUID(),
    ownerId: randomUUID(),
    sessionId: input.sessionId,
    profileId: cause?.profileId ?? 'owner',
    workspaceRoot: input.workspaceRoot,
    provider: input.provider,
    model: input.model,
    mode: input.mode,
    permissionMode: input.permissionMode,
    securityProfile: input.securityProfile,
    input: input.input,
    cause,
    executionKey: input.options?.executionKey,
  });
}
