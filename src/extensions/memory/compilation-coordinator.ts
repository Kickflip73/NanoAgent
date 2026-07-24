import { createHash } from 'node:crypto';
import type {
  CompilationJob,
  CompilationJobOperation,
  CompilationReceiptV2,
  MemoryCandidate,
  MemoryConfidence,
  MemoryDocument,
  MemoryKind,
  MemoryPageMetadata,
  MemoryPageRevision,
  MemoryScope,
  RunMemoryContext,
  SourceRef,
} from '../../core/memory.js';
import { evidenceFromSource } from '../../core/memory.js';
import { SqliteMemoryCatalog } from './sqlite-catalog.js';
import { WikiVault } from './wiki-vault.js';

const COMPILER_VERSION = 'memory-hub-v2';

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

export interface CompilationCandidateInput {
  operation: Exclude<CompilationJobOperation, 'legacy-import'>;
  scope: MemoryScope;
  title: string;
  content: string;
  kind: MemoryKind;
  confidence: MemoryConfidence;
  sourceRefs: SourceRef[];
  metadata: MemoryPageMetadata;
  targetDigest: string;
  createdBy: MemoryCandidate['createdBy'];
  reasonCode?: string;
  context: RunMemoryContext;
}

export interface PreparedCompilation {
  candidate: MemoryCandidate;
  job: CompilationJob;
  receipt?: CompilationReceiptV2;
}

export class MemoryCompilationCoordinator {
  constructor(
    private readonly catalog: SqliteMemoryCatalog,
    private readonly vault: WikiVault,
    private readonly workspaceId: string,
  ) {}

  prepare(input: CompilationCandidateInput): PreparedCompilation {
    const timestamp = new Date().toISOString();
    const evidenceRefs = input.sourceRefs.map((source) =>
      evidenceFromSource(source, input.context.profileId, this.workspaceId));
    const candidateSeed = [
      input.operation,
      input.scope,
      input.metadata.id,
      input.title,
      input.content,
      ...evidenceRefs.map((evidence) => evidence.id),
    ].join('\0');
    const candidateId = stableId('candidate', candidateSeed);
    const jobId = stableId('job', `${candidateId}\0${input.targetDigest}`);
    const existingReceipt = this.catalog.getReceiptV2(jobId);
    const existingCandidate = this.catalog.getCandidate(candidateId);
    const candidate: MemoryCandidate = existingCandidate ?? {
      id: candidateId,
      profileId: input.context.profileId,
      workspaceId: this.workspaceId,
      scope: input.scope,
      proposedKind: input.kind,
      title: input.title,
      content: input.content,
      evidenceRefs,
      confidence: input.confidence,
      status: 'accepted',
      reasonCode: input.reasonCode,
      createdBy: input.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.catalog.saveCandidate(candidate);
    const current = this.catalog.currentRevision(input.metadata.id);
    const existingJob = this.catalog.getJob(jobId);
    const job: CompilationJob = existingJob ?? {
      id: jobId,
      candidateId,
      operation: input.operation,
      compilerVersion: COMPILER_VERSION,
      expectedRevisions: current ? [{
        pageId: current.pageId,
        revision: current.revision,
        digest: current.bodyDigest,
      }] : [],
      plannedWrites: [{
        pageId: input.metadata.id,
        nextRevision: (current?.revision ?? 0) + 1,
        bodyDigest: input.targetDigest,
      }],
      appliedWrites: [],
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (job.status === 'failed' || job.status === 'uncertain') {
      throw new Error(`Memory compilation ${job.id} 已进入 ${job.status}，不能自动重放`);
    }
    if (!existingReceipt) {
      job.status = 'applying';
      job.updatedAt = timestamp;
      this.catalog.saveJob(job);
    }
    return { candidate, job, receipt: existingReceipt };
  }

  commit(
    prepared: PreparedCompilation,
    page: MemoryDocument,
    embedding?: { model: string; vector: number[] },
  ): CompilationReceiptV2 {
    if (prepared.receipt) return prepared.receipt;
    const planned = prepared.job.plannedWrites[0];
    if (!planned || planned.pageId !== page.ref.id || planned.bodyDigest !== page.digest) {
      return this.uncertain(prepared, 'written_page_digest_mismatch');
    }
    const timestamp = new Date().toISOString();
    const revisionId = stableId(
      'revision',
      `${prepared.job.id}\0${page.ref.id}\0${planned.nextRevision}\0${page.digest}`,
    );
    const revision: MemoryPageRevision = {
      revisionId,
      pageId: page.ref.id,
      revision: planned.nextRevision,
      scope: page.ref.scope,
      profileId: page.metadata.profileId,
      metadata: page.metadata,
      bodyDigest: page.digest,
      evidenceRefs: prepared.candidate.evidenceRefs,
      compilationJobId: prepared.job.id,
      createdAt: timestamp,
    };
    this.catalog.index(page, embedding);
    if (!prepared.job.appliedWrites.some((write) => write.revisionId === revisionId)) {
      prepared.job.appliedWrites.push({ pageId: page.ref.id, revisionId });
    }
    prepared.job.updatedAt = timestamp;
    this.catalog.saveRevision(revision, prepared.job);
    prepared.job.status = 'applied';
    prepared.job.updatedAt = timestamp;
    const receipt: CompilationReceiptV2 = {
      id: stableId('receipt_v2', prepared.job.id),
      candidateId: prepared.candidate.id,
      jobId: prepared.job.id,
      status: 'applied',
      pageRevisions: [{ pageId: page.ref.id, revisionId, revision: planned.nextRevision }],
      reasonCode: prepared.candidate.reasonCode,
      completedAt: timestamp,
    };
    this.catalog.saveReceiptV2(prepared.job, receipt);
    return receipt;
  }

  fail(prepared: PreparedCompilation, error: unknown, uncertain = false): CompilationReceiptV2 {
    const timestamp = new Date().toISOString();
    prepared.job.status = uncertain ? 'uncertain' : 'failed';
    prepared.job.error = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    prepared.job.updatedAt = timestamp;
    const receipt: CompilationReceiptV2 = {
      id: stableId('receipt_v2', prepared.job.id),
      candidateId: prepared.candidate.id,
      jobId: prepared.job.id,
      status: uncertain ? 'uncertain' : 'failed',
      pageRevisions: [],
      reasonCode: uncertain ? 'uncertain_write_result' : 'known_compilation_failure',
      completedAt: timestamp,
    };
    this.catalog.saveReceiptV2(prepared.job, receipt);
    return receipt;
  }

  reject(
    sourceRefs: SourceRef[],
    reasonCode: string,
    context: RunMemoryContext,
  ): CompilationReceiptV2 {
    const timestamp = new Date().toISOString();
    const evidenceRefs = sourceRefs.map((source) =>
      evidenceFromSource(source, context.profileId, this.workspaceId));
    const candidateId = stableId(
      'candidate',
      `reject\0${reasonCode}\0${evidenceRefs.map((evidence) => evidence.id).join('\0')}`,
    );
    const jobId = stableId('job', `${candidateId}\0rejected`);
    const existing = this.catalog.getReceiptV2(jobId);
    if (existing) return existing;
    const candidate: MemoryCandidate = {
      id: candidateId,
      profileId: context.profileId,
      workspaceId: this.workspaceId,
      scope: this.catalog.scope,
      proposedKind: 'synthesis',
      title: 'Rejected memory candidate',
      content: '',
      evidenceRefs,
      confidence: 'inferred',
      status: 'rejected',
      reasonCode,
      createdBy: context.cause?.source === 'memory-maintenance' ? 'maintenance' : 'runtime',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const job: CompilationJob = {
      id: jobId,
      candidateId,
      operation: 'capture',
      compilerVersion: COMPILER_VERSION,
      expectedRevisions: [],
      plannedWrites: [],
      appliedWrites: [],
      status: 'rejected',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const receipt: CompilationReceiptV2 = {
      id: stableId('receipt_v2', jobId),
      candidateId,
      jobId,
      status: 'rejected',
      pageRevisions: [],
      reasonCode,
      completedAt: timestamp,
    };
    this.catalog.saveCandidate(candidate);
    this.catalog.saveJob(job);
    this.catalog.saveReceiptV2(job, receipt);
    return receipt;
  }

  async recover(jobId?: string): Promise<Array<CompilationReceiptV2 | CompilationJob>> {
    const jobs = jobId
      ? [this.catalog.getJob(jobId)].filter((job): job is CompilationJob => Boolean(job))
      : this.catalog.applyingJobs();
    const results: Array<CompilationReceiptV2 | CompilationJob> = [];
    for (const job of jobs) {
      const candidate = this.catalog.getCandidate(job.candidateId);
      const planned = job.plannedWrites[0];
      if (!candidate || !planned) {
        job.status = 'uncertain';
        job.error = 'missing_candidate_or_planned_write';
        job.updatedAt = new Date().toISOString();
        this.catalog.saveJob(job);
        results.push(job);
        continue;
      }
      let page: MemoryDocument | undefined;
      try {
        page = await this.vault.read({
          scope: candidate.scope,
          id: planned.pageId,
          ...(candidate.scope === 'private' ? { profileId: candidate.profileId } : {}),
        });
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('不存在')) throw error;
      }
      if (!page) {
        job.status = job.appliedWrites.length ? 'uncertain' : 'pending';
        job.updatedAt = new Date().toISOString();
        this.catalog.saveJob(job);
        results.push(job);
        continue;
      }
      if (page.digest === planned.bodyDigest) {
        results.push(this.commit({ candidate, job }, page));
        continue;
      }
      const expected = job.expectedRevisions[0];
      if (!job.appliedWrites.length && expected?.digest === page.digest) {
        job.status = 'pending';
        job.updatedAt = new Date().toISOString();
        this.catalog.saveJob(job);
        results.push(job);
        continue;
      }
      results.push(this.uncertain({ candidate, job }, 'partial_or_conflicting_page_write'));
    }
    return results;
  }

  private uncertain(prepared: PreparedCompilation, reasonCode: string): CompilationReceiptV2 {
    const timestamp = new Date().toISOString();
    prepared.job.status = 'uncertain';
    prepared.job.error = reasonCode;
    prepared.job.updatedAt = timestamp;
    const receipt: CompilationReceiptV2 = {
      id: stableId('receipt_v2', prepared.job.id),
      candidateId: prepared.candidate.id,
      jobId: prepared.job.id,
      status: 'uncertain',
      pageRevisions: [],
      reasonCode,
      completedAt: timestamp,
    };
    this.catalog.saveReceiptV2(prepared.job, receipt);
    return receipt;
  }
}
