import { z } from 'zod';

export const toolCapabilitySchema = z.enum([
  'read',
  'write',
  'execute',
  'network-read',
  'network-write',
  'memory-read',
  'memory-write',
  'state-read',
  'state-write',
  'delivery-control',
  'computer-read',
  'computer-write',
  'control',
]);

export type ToolCapability = z.infer<typeof toolCapabilitySchema>;
export type WorkUnitKind = 'subagent' | 'team-worker' | 'background' | 'codex';
export type WorkUnitStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

export interface WorkUnitDescriptor {
  id: string;
  kind: WorkUnitKind;
  parentRunId: string;
  parentWorkUnitId?: string;
  objective: string;
  role?: string;
  dependencies: string[];
  capabilities: ToolCapability[];
  workspaceAccess: 'none' | 'read' | 'write';
  paths: string[];
}

export interface WorkUnitArtifact {
  path: string;
  digest?: string;
}

export interface WorkUnitEvidence {
  type: string;
  ref: string;
}

export interface WorkUnitResult {
  id: string;
  status: WorkUnitStatus;
  summary: string;
  artifacts: WorkUnitArtifact[];
  evidence: WorkUnitEvidence[];
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export interface WorkUnitObservation {
  descriptor: WorkUnitDescriptor;
  status: WorkUnitStatus;
  observedAt: string;
  result?: WorkUnitResult;
}

export function isWorkUnitResult(value: unknown): value is WorkUnitResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && typeof item.status === 'string'
    && typeof item.summary === 'string'
    && Array.isArray(item.artifacts)
    && Array.isArray(item.evidence)
    && typeof item.startedAt === 'string';
}
