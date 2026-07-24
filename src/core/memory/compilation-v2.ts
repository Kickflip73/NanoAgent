import type {
  MemoryConfidence,
  MemoryKind,
  MemoryPageMetadata,
  MemoryScope,
  MemoryTrust,
  SourceRef,
} from './types.js';

export type EvidenceKind =
  | 'session-round'
  | 'mimi-event'
  | 'task-run'
  | 'workspace-file'
  | 'owner-explicit'
  | 'memory-revision';

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  profileId: string;
  workspaceId: string;
  digest: string;
  occurredAt: string;
  trust: MemoryTrust;
  locator: {
    sessionId?: string;
    runId?: string;
    eventId?: string;
    taskId?: string;
    relativePath?: string;
    revisionId?: string;
  };
}

export type MemoryCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'conflicted' | 'superseded';

export interface MemoryCandidate {
  id: string;
  profileId: string;
  workspaceId: string;
  scope: MemoryScope;
  proposedKind: MemoryKind;
  title: string;
  content: string;
  evidenceRefs: EvidenceRef[];
  confidence: MemoryConfidence;
  status: MemoryCandidateStatus;
  reasonCode?: string;
  createdBy: 'owner' | 'runtime' | 'maintenance' | 'migration';
  createdAt: string;
  updatedAt: string;
}

export type CompilationJobStatus = 'pending' | 'applying' | 'applied' | 'rejected' | 'failed' | 'uncertain';
export type CompilationJobOperation = 'remember' | 'ingest' | 'capture' | 'refresh' | 'lint-repair' | 'legacy-import';

export interface CompilationJob {
  id: string;
  candidateId: string;
  operation: CompilationJobOperation;
  compilerVersion: string;
  expectedRevisions: Array<{ pageId: string; revision: number; digest: string }>;
  plannedWrites: Array<{ pageId: string; nextRevision: number; bodyDigest?: string }>;
  appliedWrites: Array<{ pageId: string; revisionId: string }>;
  status: CompilationJobStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPageRevision {
  revisionId: string;
  pageId: string;
  revision: number;
  scope: MemoryScope;
  profileId: string | null;
  metadata: MemoryPageMetadata;
  bodyDigest: string;
  evidenceRefs: EvidenceRef[];
  compilationJobId: string;
  createdAt: string;
}

export interface CompilationReceiptV2 {
  id: string;
  candidateId: string;
  jobId: string;
  status: 'applied' | 'rejected' | 'failed' | 'uncertain';
  pageRevisions: Array<{ pageId: string; revisionId: string; revision: number }>;
  reasonCode?: string;
  completedAt: string;
}

export function evidenceFromSource(
  source: SourceRef,
  profileId: string,
  workspaceId: string,
): EvidenceRef {
  const [sessionId, runId] = source.type === 'session'
    ? source.id.split('@', 2)
    : source.type === 'user-explicit' ? source.id.split('/', 2) : [];
  return {
    id: `${source.type}:${source.id}:${source.digest}`,
    kind: source.type === 'file'
      ? 'workspace-file'
      : source.type === 'mimi-event'
        ? 'mimi-event'
        : source.type === 'memory'
          ? 'memory-revision'
          : source.type === 'user-explicit' ? 'owner-explicit' : 'session-round',
    profileId,
    workspaceId,
    digest: source.digest,
    occurredAt: source.occurredAt,
    trust: source.trust,
    locator: {
      ...(sessionId ? { sessionId } : {}),
      ...(runId ? { runId } : {}),
      ...(source.type === 'mimi-event' ? { eventId: source.id } : {}),
      ...(source.type === 'file' ? { relativePath: source.id } : {}),
      ...(source.type === 'memory' ? { revisionId: source.id } : {}),
    },
  };
}
