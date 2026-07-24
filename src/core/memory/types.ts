export type MemoryScope = 'private' | 'workspace';
export type MemoryKind = 'profile' | 'fact' | 'concept' | 'entity' | 'decision'
  | 'lesson' | 'source-summary' | 'synthesis' | 'procedure-ref';
export type MemoryStatus = 'active' | 'conflicted' | 'superseded';
export type MemoryConfidence = 'user-confirmed' | 'source-grounded' | 'inferred';
export type MemoryTrust = 'owner' | 'trusted' | 'external' | 'public' | 'system';

export interface RunMemoryContext {
  profileId: string;
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  allowEpisodeEvidence?: boolean;
  cause?: {
    eventId?: string;
    taskId?: string;
    trust: MemoryTrust;
    source: string;
  };
}

export interface SourceRef {
  type: 'file' | 'session' | 'mimi-event' | 'user-explicit' | 'memory';
  id: string;
  digest: string;
  occurredAt: string;
  trust: MemoryTrust;
}

export interface MemoryRef {
  scope: MemoryScope;
  id: string;
  profileId?: string;
}

export interface MemoryPageMetadata {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: MemoryKind;
  scope: MemoryScope;
  profileId: string | null;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  aliases: string[];
  tags: string[];
  sourceRefs: SourceRef[];
  validFrom: string | null;
  validUntil: string | null;
  supersedes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPage {
  ref: MemoryRef;
  metadata: MemoryPageMetadata;
  body: string;
  digest: string;
}

export interface MemoryDocument extends MemoryPage {
  path?: string;
  stale?: boolean;
}

export interface MemoryHit {
  ref: MemoryRef;
  title: string;
  summary: string;
  kind: MemoryKind;
  status: MemoryStatus;
  confidence: MemoryConfidence;
  score: number;
  sourceRefs: SourceRef[];
  documentType: 'wiki' | 'source' | 'episode';
  stale?: boolean;
}

export interface MemoryCard extends MemoryHit {}

export interface MemoryLink {
  direction: 'in' | 'out';
  ref: MemoryRef;
  title: string;
}

export interface MemorySearchOptions {
  scope?: MemoryScope | 'all';
  kind?: MemoryKind;
  status?: MemoryStatus | 'all';
  from?: string;
  to?: string;
  includeEvidence?: boolean;
  limit?: number;
  documentTypes?: Array<'wiki' | 'source' | 'episode'>;
}

export interface RememberInput {
  title: string;
  content: string;
  kind: MemoryKind;
  scope?: MemoryScope;
  confidence?: MemoryConfidence;
  aliases?: string[];
  tags?: string[];
  sourceRefs?: SourceRef[];
  sourcePaths?: string[];
  supersedes?: string[];
  autonomous?: boolean;
}

export interface ForgetReceipt {
  ref: MemoryRef;
  forgotten: boolean;
  suppressedDigest?: string;
  timestamp: string;
}

export interface MemoryStatusSnapshot {
  pages: number;
  privatePages: number;
  workspacePages: number;
  conflicted: number;
  stale: number;
  fts5: boolean;
  degraded: boolean;
  embeddingModel?: string;
  embeddingDimensions?: number;
  pendingReceipts?: number;
  decisions?: number;
  pageLimitReached?: boolean;
  episodes?: number;
  candidates?: number;
  revisions?: number;
  pendingCompilations?: number;
  uncertainCompilations?: number;
}

export interface EpisodeInput {
  sessionId: string;
  runId: string;
  input: string;
  answer: string;
  occurredAt: string;
  sourceRef?: SourceRef;
}

export interface MemoryDecisionEvent {
  id: number;
  operation: string;
  reasonCode: string;
  refId?: string;
  createdAt: string;
}

export interface WikiLintIssue {
  code: string;
  severity: 'error' | 'warning';
  ref?: MemoryRef;
  message: string;
}

export interface WikiLintReport {
  valid: boolean;
  checked: number;
  issues: WikiLintIssue[];
}
