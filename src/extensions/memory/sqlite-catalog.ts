import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type {
  CompilationPlan,
  CompilationReceipt,
  CompilationJob,
  CompilationReceiptV2,
  EvidenceRef,
  MemoryCandidate,
  MemoryPageRevision,
  MemoryDocument,
  MemoryDecisionEvent,
  MemoryHit,
  MemoryLink,
  MemoryRef,
  MemoryScope,
  MemorySearchOptions,
  MemoryStatusSnapshot,
  WikiLintIssue,
} from '../../core/memory.js';
import { evidenceFromSource, reciprocalRankFusion } from '../../core/memory.js';

type Row = Record<string, string | number | bigint | Uint8Array | null | undefined>;

function json<T>(value: string | number | bigint | Uint8Array | null | undefined): T {
  if (typeof value !== 'string') throw new Error('Memory catalog JSON 字段无效');
  return JSON.parse(value) as T;
}

function optionalString(value: Row[string]): string | null {
  return value === null || value === undefined ? null : String(value);
}

function refKey(ref: MemoryRef): string {
  return `${ref.scope}:${ref.profileId ?? '-'}:${ref.id}`;
}

export interface PersistedLintIssue {
  key: string;
  code: string;
  message: string;
  occurrences: number;
  resolved: boolean;
  lastSeenAt: string;
}

function hitFromRow(row: Row, score = 0): MemoryHit {
  return {
    ref: {
      scope: String(row.scope) as MemoryScope,
      id: String(row.id),
      ...(row.profile_id ? { profileId: String(row.profile_id) } : {}),
    },
    title: String(row.title),
    summary: String(row.summary),
    kind: String(row.kind) as MemoryHit['kind'],
    status: String(row.status) as MemoryHit['status'],
    confidence: String(row.confidence) as MemoryHit['confidence'],
    score,
    sourceRefs: json(row.source_refs_json),
    documentType: String(row.document_type) as MemoryHit['documentType'],
    stale: Number(row.stale) === 1 || undefined,
  };
}

function summary(body: string): string {
  return body.replace(/^#.*$/gm, '').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    aa += left[index]! ** 2;
    bb += right[index]! ** 2;
  }
  return dot / (Math.sqrt(aa) * Math.sqrt(bb) || 1);
}

function encodeVector(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer);
}

function decodeVector(value: Uint8Array): number[] {
  const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return [...new Float32Array(bytes)];
}

export class SqliteMemoryCatalog {
  private readonly database: DatabaseSync;
  private fts5 = false;

  constructor(readonly file: string, readonly scope: MemoryScope, readonly profileId?: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.backupV1IfNeeded();
    this.initialize();
  }

  close(): void {
    this.database.close();
  }

  index(
    page: MemoryDocument,
    embedding?: { model: string; vector: number[] },
    documentType: MemoryHit['documentType'] = 'wiki',
  ): void {
    const key = refKey(page.ref);
    const occurredAt = page.metadata.sourceRefs.map((source) => source.occurredAt).sort().at(-1) ?? page.metadata.updatedAt;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO documents (
          ref_key, id, scope, profile_id, title, aliases_json, tags_json, kind, status,
          confidence, body, summary, digest, source_refs_json, occurred_at, valid_from,
          valid_until, document_type, stale, path, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ref_key) DO UPDATE SET
          title=excluded.title, aliases_json=excluded.aliases_json, tags_json=excluded.tags_json,
          kind=excluded.kind, status=excluded.status, confidence=excluded.confidence,
          body=excluded.body, summary=excluded.summary, digest=excluded.digest,
          source_refs_json=excluded.source_refs_json, occurred_at=excluded.occurred_at,
          valid_from=excluded.valid_from, valid_until=excluded.valid_until, stale=excluded.stale,
          document_type=excluded.document_type, path=excluded.path, updated_at=excluded.updated_at
      `).run(
        key, page.ref.id, page.ref.scope, page.ref.profileId ?? null, page.metadata.title,
        JSON.stringify(page.metadata.aliases), JSON.stringify(page.metadata.tags), page.metadata.kind,
        page.metadata.status, page.metadata.confidence, page.body, summary(page.body), page.digest,
        JSON.stringify(page.metadata.sourceRefs), occurredAt, page.metadata.validFrom,
        page.metadata.validUntil, documentType, page.stale ? 1 : 0, page.path ?? null, page.metadata.updatedAt,
      );
      this.database.prepare('DELETE FROM links WHERE source_ref = ?').run(key);
      const links = [...page.body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g)].map((match) => match[1]!.trim());
      const insertLink = this.database.prepare('INSERT OR IGNORE INTO links (source_ref, target_title) VALUES (?, ?)');
      links.forEach((title) => insertLink.run(key, title));
      if (this.fts5) {
        this.database.prepare('DELETE FROM documents_fts WHERE ref_key = ?').run(key);
        this.database.prepare('INSERT INTO documents_fts (ref_key, title, aliases, tags, body) VALUES (?, ?, ?, ?, ?)')
          .run(key, page.metadata.title, page.metadata.aliases.join(' '), page.metadata.tags.join(' '), page.body);
      }
      this.database.prepare('DELETE FROM document_embeddings WHERE ref_key = ?').run(key);
      if (embedding) {
        this.database.prepare(`
          INSERT INTO document_embeddings (ref_key, digest, provider, model, dimensions, vector)
          VALUES (?, ?, 'openai', ?, ?, ?)
        `).run(key, page.digest, embedding.model, embedding.vector.length, encodeVector(embedding.vector));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  remove(ref: MemoryRef): void {
    const key = refKey(ref);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.fts5) this.database.prepare('DELETE FROM documents_fts WHERE ref_key = ?').run(key);
      this.database.prepare('DELETE FROM documents WHERE ref_key = ?').run(key);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  pruneEpisodes(maxUnreferenced = 10_000): number {
    const limit = Math.max(0, Math.trunc(maxUnreferenced));
    const episodeRows = this.database.prepare(`
      SELECT * FROM documents WHERE document_type = 'episode'
      ORDER BY updated_at DESC, ref_key DESC
    `).all() as Row[];
    if (episodeRows.length <= limit) return 0;
    const referencedSources = new Set<string>();
    const wikiRows = this.database.prepare(`
      SELECT source_refs_json FROM documents
      WHERE document_type = 'wiki' AND status IN ('active', 'conflicted')
    `).all() as Row[];
    for (const row of wikiRows) {
      for (const source of json<MemoryDocument['metadata']['sourceRefs']>(row.source_refs_json)) {
        referencedSources.add(`${source.type}\0${source.id}\0${source.digest}`);
      }
    }
    let removed = 0;
    for (const row of episodeRows.slice(limit)) {
      const episodeSources = json<MemoryDocument['metadata']['sourceRefs']>(row.source_refs_json);
      if (episodeSources.some((source) => referencedSources.has(`${source.type}\0${source.id}\0${source.digest}`))) {
        continue;
      }
      this.remove(hitFromRow(row).ref);
      removed += 1;
    }
    return removed;
  }

  search(query: string, options: MemorySearchOptions = {}, queryVector?: number[]): MemoryHit[] {
    const limit = Math.min(20, Math.max(1, options.limit ?? 5));
    const where = this.filters(options);
    const parameters = where.parameters;
    const structureRows = this.database.prepare(`
      SELECT * FROM documents WHERE ${where.sql}
        AND (lower(title) = lower(?) OR lower(title) LIKE lower(?) OR lower(aliases_json) LIKE lower(?))
      ORDER BY updated_at DESC LIMIT ?
    `).all(...parameters, query, `${query}%`, `%${query}%`, limit * 3) as Row[];

    let lexicalRows: Row[] = [];
    if (this.fts5 && query.trim().length >= 3) {
      const ftsQuery = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      if (ftsQuery) {
        try {
          lexicalRows = this.database.prepare(`
            SELECT d.*, bm25(documents_fts, 4.0, 2.0, 1.5, 1.0) AS lexical_score
            FROM documents_fts JOIN documents d ON d.ref_key = documents_fts.ref_key
            WHERE documents_fts MATCH ? AND ${where.sql}
            ORDER BY lexical_score LIMIT ?
          `).all(ftsQuery, ...parameters, limit * 3) as Row[];
        } catch {
          lexicalRows = [];
        }
      }
    }
    if (!lexicalRows.length) {
      lexicalRows = this.database.prepare(`
        SELECT * FROM documents WHERE ${where.sql}
          AND lower(title || ' ' || aliases_json || ' ' || tags_json || ' ' || body) LIKE lower(?)
        ORDER BY updated_at DESC LIMIT ?
      `).all(...parameters, `%${query}%`, limit * 3) as Row[];
    }

    const vectorRows = queryVector ? this.vectorRows(queryVector, where.sql, parameters, limit * 3) : [];
    const channels = [structureRows, lexicalRows, vectorRows].filter((rows) => rows.length).map((rows) => (
      rows.map((row) => ({ item: hitFromRow(row), key: String(row.ref_key) }))
    ));
    return reciprocalRankFusion(channels, limit);
  }

  list(options: MemorySearchOptions = {}): MemoryHit[] {
    const limit = Math.min(1_000, Math.max(1, options.limit ?? 100));
    const where = this.filters(options);
    return (this.database.prepare(`SELECT * FROM documents WHERE ${where.sql} ORDER BY updated_at DESC LIMIT ?`)
      .all(...where.parameters, limit) as Row[]).map((row) => hitFromRow(row));
  }

  staleDocuments(limit = 20): MemoryDocument[] {
    return (this.database.prepare(`
      SELECT ref_key FROM documents
      WHERE document_type='wiki' AND stale=1
      ORDER BY updated_at, ref_key LIMIT ?
    `).all(Math.max(1, Math.min(100, limit))) as Row[])
      .map((row) => {
        const [scope, profileId, id] = String(row.ref_key).split(':');
        return this.readDocument({
          scope: scope as MemoryScope,
          id: id!,
          ...(profileId && profileId !== '-' ? { profileId } : {}),
        });
      })
      .filter((document): document is MemoryDocument => Boolean(document));
  }

  links(ref: MemoryRef): MemoryLink[] {
    const key = refKey(ref);
    const outgoing = this.database.prepare(`
      SELECT d.* FROM links l JOIN documents d ON lower(d.title) = lower(l.target_title)
      WHERE l.source_ref = ?
    `).all(key) as Row[];
    const source = this.database.prepare('SELECT title FROM documents WHERE ref_key = ?').get(key) as Row | undefined;
    const incoming = source ? this.database.prepare(`
      SELECT d.* FROM links l JOIN documents d ON d.ref_key = l.source_ref
      WHERE lower(l.target_title) = lower(?)
    `).all(String(source.title)) as Row[] : [];
    return [
      ...outgoing.map((row) => ({ direction: 'out' as const, ref: hitFromRow(row).ref, title: String(row.title) })),
      ...incoming.map((row) => ({ direction: 'in' as const, ref: hitFromRow(row).ref, title: String(row.title) })),
    ];
  }

  readDocument(ref: MemoryRef): MemoryDocument | undefined {
    const row = this.database.prepare('SELECT * FROM documents WHERE ref_key = ?').get(refKey(ref)) as Row | undefined;
    if (!row) return undefined;
    const sourceRefs = json<MemoryDocument['metadata']['sourceRefs']>(row.source_refs_json);
    const occurredAt = String(row.occurred_at);
    return {
      ref: hitFromRow(row).ref,
      metadata: {
        schemaVersion: 1,
        id: String(row.id),
        title: String(row.title),
        kind: String(row.kind) as MemoryDocument['metadata']['kind'],
        scope: String(row.scope) as MemoryScope,
        profileId: row.profile_id ? String(row.profile_id) : null,
        status: String(row.status) as MemoryDocument['metadata']['status'],
        confidence: String(row.confidence) as MemoryDocument['metadata']['confidence'],
        aliases: json(row.aliases_json),
        tags: json(row.tags_json),
        sourceRefs,
        validFrom: optionalString(row.valid_from),
        validUntil: optionalString(row.valid_until),
        supersedes: [],
        createdAt: occurredAt,
        updatedAt: String(row.updated_at),
      },
      body: String(row.body),
      digest: String(row.digest),
      path: row.path ? String(row.path) : undefined,
      stale: Number(row.stale) === 1 || undefined,
    };
  }

  suppress(digest: string, timestamp: string): void {
    this.database.prepare('INSERT OR IGNORE INTO suppressions (digest, scope, created_at) VALUES (?, ?, ?)')
      .run(digest, this.scope, timestamp);
  }

  isSuppressed(digest: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM suppressions WHERE digest = ?').get(digest));
  }

  clearSuppression(digest: string): void {
    this.database.prepare('DELETE FROM suppressions WHERE digest = ?').run(digest);
  }

  getReceipt(digest: string, operation: string): CompilationReceipt | undefined {
    const row = this.database.prepare('SELECT * FROM source_receipts WHERE digest = ? AND operation = ?')
      .get(digest, operation) as Row | undefined;
    if (!row) return undefined;
    const plan = json<CompilationPlan>(row.plan_json);
    return {
      id: String(row.id),
      operation: String(row.operation) as CompilationReceipt['operation'],
      status: String(row.status) as CompilationReceipt['status'],
      digest: String(row.digest),
      pageRefs: plan.appliedPageRefs,
      ...(row.reason_code ? { reasonCode: String(row.reason_code) } : {}),
    };
  }

  saveReceipt(receipt: CompilationReceipt, plan: CompilationPlan): void {
    this.database.prepare(`
      INSERT INTO source_receipts (id, digest, operation, status, reason_code, compiler_version, plan_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(digest, operation) DO UPDATE SET status=excluded.status,
        reason_code=excluded.reason_code, plan_json=excluded.plan_json, updated_at=excluded.updated_at
    `).run(receipt.id, receipt.digest, receipt.operation, receipt.status, receipt.reasonCode ?? null,
      plan.compilerVersion, JSON.stringify(plan), new Date().toISOString());
  }

  saveCandidate(candidate: MemoryCandidate): void {
    this.database.prepare(`
      INSERT INTO memory_candidates (
        id, profile_id, workspace_id, scope, proposed_kind, title, content,
        evidence_refs_json, confidence, status, reason_code, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, reason_code=excluded.reason_code,
        updated_at=excluded.updated_at
    `).run(
      candidate.id, candidate.profileId, candidate.workspaceId, candidate.scope,
      candidate.proposedKind, candidate.title, candidate.content,
      JSON.stringify(candidate.evidenceRefs), candidate.confidence, candidate.status,
      candidate.reasonCode ?? null, candidate.createdBy, candidate.createdAt, candidate.updatedAt,
    );
  }

  getCandidate(id: string): MemoryCandidate | undefined {
    const row = this.database.prepare('SELECT * FROM memory_candidates WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      profileId: String(row.profile_id),
      workspaceId: String(row.workspace_id),
      scope: String(row.scope) as MemoryCandidate['scope'],
      proposedKind: String(row.proposed_kind) as MemoryCandidate['proposedKind'],
      title: String(row.title),
      content: String(row.content),
      evidenceRefs: json(row.evidence_refs_json),
      confidence: String(row.confidence) as MemoryCandidate['confidence'],
      status: String(row.status) as MemoryCandidate['status'],
      reasonCode: row.reason_code ? String(row.reason_code) : undefined,
      createdBy: String(row.created_by) as MemoryCandidate['createdBy'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  saveJob(job: CompilationJob): void {
    this.database.prepare(`
      INSERT INTO compilation_jobs (
        id, candidate_id, operation, compiler_version, expected_revisions_json,
        planned_writes_json, applied_writes_json, status, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET applied_writes_json=excluded.applied_writes_json,
        status=excluded.status, error=excluded.error, updated_at=excluded.updated_at
    `).run(
      job.id, job.candidateId, job.operation, job.compilerVersion,
      JSON.stringify(job.expectedRevisions), JSON.stringify(job.plannedWrites),
      JSON.stringify(job.appliedWrites), job.status, job.error ?? null, job.createdAt, job.updatedAt,
    );
  }

  getJob(id: string): CompilationJob | undefined {
    const row = this.database.prepare('SELECT * FROM compilation_jobs WHERE id = ?').get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      candidateId: String(row.candidate_id),
      operation: String(row.operation) as CompilationJob['operation'],
      compilerVersion: String(row.compiler_version),
      expectedRevisions: json(row.expected_revisions_json),
      plannedWrites: json(row.planned_writes_json),
      appliedWrites: json(row.applied_writes_json),
      status: String(row.status) as CompilationJob['status'],
      error: row.error ? String(row.error) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  commitRevision(
    revision: MemoryPageRevision,
    job: CompilationJob,
    receipt: CompilationReceiptV2,
  ): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.insertRevision(revision);
      this.database.prepare(`
        UPDATE compilation_jobs SET applied_writes_json=?, status=?, error=?, updated_at=? WHERE id=?
      `).run(
        JSON.stringify(job.appliedWrites), job.status, job.error ?? null, job.updatedAt, job.id,
      );
      this.database.prepare(`
        INSERT INTO compilation_receipts_v2 (
          id, candidate_id, job_id, status, page_revisions_json, reason_code, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,
          page_revisions_json=excluded.page_revisions_json,
          reason_code=excluded.reason_code, completed_at=excluded.completed_at
      `).run(
        receipt.id, receipt.candidateId, receipt.jobId, receipt.status,
        JSON.stringify(receipt.pageRevisions), receipt.reasonCode ?? null, receipt.completedAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  saveRevision(revision: MemoryPageRevision, job: CompilationJob): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.insertRevision(revision);
      this.database.prepare(`
        UPDATE compilation_jobs SET applied_writes_json=?, status=?, error=?, updated_at=? WHERE id=?
      `).run(JSON.stringify(job.appliedWrites), job.status, job.error ?? null, job.updatedAt, job.id);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  saveReceiptV2(job: CompilationJob, receipt: CompilationReceiptV2): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        UPDATE compilation_jobs SET applied_writes_json=?, status=?, error=?, updated_at=? WHERE id=?
      `).run(JSON.stringify(job.appliedWrites), job.status, job.error ?? null, job.updatedAt, job.id);
      this.database.prepare(`
        INSERT INTO compilation_receipts_v2 (
          id, candidate_id, job_id, status, page_revisions_json, reason_code, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,
          page_revisions_json=excluded.page_revisions_json,
          reason_code=excluded.reason_code, completed_at=excluded.completed_at
      `).run(
        receipt.id, receipt.candidateId, receipt.jobId, receipt.status,
        JSON.stringify(receipt.pageRevisions), receipt.reasonCode ?? null, receipt.completedAt,
      );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  applyingJobs(limit = 100): CompilationJob[] {
    return (this.database.prepare(`
      SELECT id FROM compilation_jobs WHERE status='applying'
      ORDER BY updated_at, id LIMIT ?
    `).all(Math.max(1, Math.min(1_000, limit))) as Row[])
      .map((row) => this.getJob(String(row.id))!)
      .filter(Boolean);
  }

  getReceiptV2(jobId: string): CompilationReceiptV2 | undefined {
    const row = this.database.prepare('SELECT * FROM compilation_receipts_v2 WHERE job_id = ?')
      .get(jobId) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      candidateId: String(row.candidate_id),
      jobId: String(row.job_id),
      status: String(row.status) as CompilationReceiptV2['status'],
      pageRevisions: json(row.page_revisions_json),
      reasonCode: row.reason_code ? String(row.reason_code) : undefined,
      completedAt: String(row.completed_at),
    };
  }

  currentRevision(pageId: string): MemoryPageRevision | undefined {
    const row = this.database.prepare(`
      SELECT r.* FROM memory_page_current c
      JOIN memory_page_revisions r ON r.revision_id=c.revision_id
      WHERE c.page_id=?
    `).get(pageId) as Row | undefined;
    if (!row) return undefined;
    return {
      revisionId: String(row.revision_id),
      pageId: String(row.page_id),
      revision: Number(row.revision),
      scope: String(row.scope) as MemoryPageRevision['scope'],
      profileId: row.profile_id ? String(row.profile_id) : null,
      metadata: json(row.metadata_json),
      bodyDigest: String(row.body_digest),
      evidenceRefs: json(row.evidence_refs_json),
      compilationJobId: String(row.compilation_job_id),
      createdAt: String(row.created_at),
    };
  }

  recordDecision(operation: string, reasonCode: string, refId?: string): number {
    const result = this.database.prepare(`
      INSERT INTO decision_events (operation, reason_code, ref_id, created_at) VALUES (?, ?, ?, ?)
    `).run(operation.slice(0, 80), reasonCode.slice(0, 200), refId ?? null, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  decisions(limit = 50): MemoryDecisionEvent[] {
    const bounded = Math.max(1, Math.min(200, limit));
    return (this.database.prepare(`
      SELECT id, operation, reason_code, ref_id, created_at
      FROM decision_events ORDER BY id DESC LIMIT ?
    `).all(bounded) as Row[]).map((row) => ({
      id: Number(row.id),
      operation: String(row.operation),
      reasonCode: String(row.reason_code),
      refId: row.ref_id ? String(row.ref_id) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  recordLintIssues(issues: readonly WikiLintIssue[]): PersistedLintIssue[] {
    const timestamp = new Date().toISOString();
    const keys = issues.map((issue) => `${issue.code}\0${issue.ref ? refKey(issue.ref) : '-'}\0${issue.message}`);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.database.prepare(`
        INSERT INTO lint_issues (issue_key, code, message, occurrences, resolved, last_seen_at)
        VALUES (?, ?, ?, 1, 0, ?)
        ON CONFLICT(issue_key) DO UPDATE SET occurrences=occurrences+1, resolved=0, last_seen_at=excluded.last_seen_at
      `);
      issues.forEach((issue, index) => upsert.run(keys[index]!, issue.code, issue.message.slice(0, 1_000), timestamp));
      if (keys.length) {
        this.database.prepare(`UPDATE lint_issues SET resolved=1 WHERE issue_key NOT IN (${keys.map(() => '?').join(', ')})`)
          .run(...keys);
      } else {
        this.database.prepare('UPDATE lint_issues SET resolved=1').run();
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return (this.database.prepare(`
      SELECT * FROM lint_issues WHERE occurrences >= 2
      ORDER BY resolved ASC, last_seen_at DESC LIMIT 100
    `).all() as Row[]).map((row) => ({
      key: String(row.issue_key), code: String(row.code), message: String(row.message),
      occurrences: Number(row.occurrences), resolved: Number(row.resolved) === 1,
      lastSeenAt: String(row.last_seen_at),
    }));
  }

  rebuild(pages: MemoryDocument[], embeddingModel?: string): void {
    const embeddings = new Map<string, { model: string; vector: number[] }>();
    const previous = this.database.prepare(`
      SELECT d.ref_key, d.digest, e.model, e.dimensions, e.vector
      FROM documents d JOIN document_embeddings e ON e.ref_key=d.ref_key
      WHERE d.document_type = 'wiki'
    `).all() as Row[];
    for (const row of previous) {
      if (embeddingModel && row.model !== embeddingModel) continue;
      embeddings.set(`${String(row.ref_key)}:${String(row.digest)}`, {
        model: String(row.model), vector: decodeVector(row.vector as Uint8Array),
      });
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        DELETE FROM links;
        DELETE FROM document_embeddings WHERE ref_key IN (
          SELECT ref_key FROM documents WHERE document_type = 'wiki'
        );
      `);
      if (this.fts5) this.database.exec(`
        DELETE FROM documents_fts WHERE ref_key IN (
          SELECT ref_key FROM documents WHERE document_type = 'wiki'
        );
      `);
      this.database.exec("DELETE FROM documents WHERE document_type = 'wiki';");
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    pages.forEach((page) => this.index(page, embeddings.get(`${refKey(page.ref)}:${page.digest}`)));
  }

  sync(pages: MemoryDocument[]): void {
    const existing = this.database.prepare("SELECT ref_key, digest, stale FROM documents WHERE document_type = 'wiki'").all() as Row[];
    const currentKeys = new Set(pages.map((page) => refKey(page.ref)));
    for (const row of existing) {
      if (!currentKeys.has(String(row.ref_key))) {
        const [scope, profileId, id] = String(row.ref_key).split(':');
        this.remove({ scope: scope as MemoryScope, id: id!, ...(profileId && profileId !== '-' ? { profileId } : {}) });
      }
    }
    const existingByKey = new Map(existing.map((row) => [String(row.ref_key), row]));
    for (const page of pages) {
      const stored = existingByKey.get(refKey(page.ref));
      if (stored && stored.digest === page.digest && Number(stored.stale) === (page.stale ? 1 : 0)) continue;
      this.index(page);
    }
  }

  needsEmbedding(page: MemoryDocument, model: string): boolean {
    const row = this.database.prepare(`
      SELECT 1 FROM document_embeddings WHERE ref_key=? AND digest=? AND model=?
    `).get(refKey(page.ref), page.digest, model);
    return !row;
  }

  status(): MemoryStatusSnapshot {
    const totals = this.database.prepare(`
      SELECT SUM(CASE WHEN document_type='wiki' THEN 1 ELSE 0 END) AS pages,
        SUM(CASE WHEN document_type='wiki' AND scope='private' THEN 1 ELSE 0 END) AS private_pages,
        SUM(CASE WHEN document_type='wiki' AND scope='workspace' THEN 1 ELSE 0 END) AS workspace_pages,
        SUM(CASE WHEN document_type='wiki' AND status='conflicted' THEN 1 ELSE 0 END) AS conflicted,
        SUM(CASE WHEN document_type='wiki' THEN stale ELSE 0 END) AS stale,
        SUM(CASE WHEN document_type='episode' THEN 1 ELSE 0 END) AS episodes FROM documents
    `).get() as Row;
    const embedding = this.database.prepare('SELECT model, dimensions FROM document_embeddings LIMIT 1').get() as Row | undefined;
    const controls = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM source_receipts WHERE status = 'pending') AS pending_receipts,
        (SELECT COUNT(*) FROM decision_events) AS decisions,
        (SELECT COUNT(*) FROM memory_candidates) AS candidates,
        (SELECT COUNT(*) FROM memory_page_revisions) AS revisions,
        (SELECT COUNT(*) FROM compilation_jobs WHERE status IN ('pending', 'applying')) AS pending_compilations,
        (SELECT COUNT(*) FROM compilation_jobs WHERE status='uncertain') AS uncertain_compilations
    `).get() as Row;
    return {
      pages: Number(totals.pages),
      privatePages: Number(totals.private_pages ?? 0),
      workspacePages: Number(totals.workspace_pages ?? 0),
      conflicted: Number(totals.conflicted ?? 0),
      stale: Number(totals.stale ?? 0),
      fts5: this.fts5,
      degraded: !this.fts5,
      pendingReceipts: Number(controls.pending_receipts),
      decisions: Number(controls.decisions),
      pageLimitReached: Number(totals.pages) >= 10_000,
      episodes: Number(totals.episodes ?? 0),
      candidates: Number(controls.candidates),
      revisions: Number(controls.revisions),
      pendingCompilations: Number(controls.pending_compilations),
      uncertainCompilations: Number(controls.uncertain_compilations),
      ...(embedding ? { embeddingModel: String(embedding.model), embeddingDimensions: Number(embedding.dimensions) } : {}),
    };
  }

  private filters(options: MemorySearchOptions): { sql: string; parameters: Array<string | number> } {
    const clauses = ['1=1'];
    const parameters: Array<string | number> = [];
    const documentTypes = options.documentTypes?.length ? options.documentTypes : ['wiki'];
    clauses.push(`document_type IN (${documentTypes.map(() => '?').join(', ')})`);
    parameters.push(...documentTypes);
    if (options.kind) { clauses.push('kind = ?'); parameters.push(options.kind); }
    if (options.status && options.status !== 'all') { clauses.push('status = ?'); parameters.push(options.status); }
    else if (options.status !== 'all') clauses.push("status IN ('active', 'conflicted')");
    if (options.from) { clauses.push('occurred_at >= ?'); parameters.push(options.from); }
    if (options.to) { clauses.push('occurred_at <= ?'); parameters.push(options.to); }
    return { sql: clauses.join(' AND '), parameters };
  }

  private vectorRows(vector: number[], filterSql: string, parameters: Array<string | number>, limit: number): Row[] {
    const rows = this.database.prepare(`
      SELECT d.*, e.vector, e.dimensions FROM document_embeddings e
      JOIN documents d ON d.ref_key=e.ref_key WHERE ${filterSql}
    `).all(...parameters) as Row[];
    return rows.filter((row) => Number(row.dimensions) === vector.length)
      .map((row) => ({ row, score: cosine(vector, decodeVector(row.vector as Uint8Array)) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ row }) => row);
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (
        ref_key TEXT PRIMARY KEY, id TEXT NOT NULL, scope TEXT NOT NULL, profile_id TEXT,
        title TEXT NOT NULL, aliases_json TEXT NOT NULL, tags_json TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, confidence TEXT NOT NULL, body TEXT NOT NULL, summary TEXT NOT NULL,
        digest TEXT NOT NULL, source_refs_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
        valid_from TEXT, valid_until TEXT, document_type TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
        path TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_embeddings (
        ref_key TEXT PRIMARY KEY REFERENCES documents(ref_key) ON DELETE CASCADE,
        digest TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        dimensions INTEGER NOT NULL, vector BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS links (
        source_ref TEXT NOT NULL REFERENCES documents(ref_key) ON DELETE CASCADE,
        target_title TEXT NOT NULL, UNIQUE(source_ref, target_title)
      );
      CREATE TABLE IF NOT EXISTS source_receipts (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL,
        reason_code TEXT, compiler_version TEXT NOT NULL, plan_json TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(digest, operation)
      );
      CREATE TABLE IF NOT EXISTS suppressions (
        digest TEXT PRIMARY KEY, scope TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, reason_code TEXT NOT NULL,
        ref_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lint_issues (
        issue_key TEXT PRIMARY KEY, code TEXT NOT NULL, message TEXT NOT NULL,
        occurrences INTEGER NOT NULL, resolved INTEGER NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        scope TEXT NOT NULL, proposed_kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL, confidence TEXT NOT NULL, status TEXT NOT NULL,
        reason_code TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compilation_jobs (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES memory_candidates(id),
        operation TEXT NOT NULL, compiler_version TEXT NOT NULL,
        expected_revisions_json TEXT NOT NULL, planned_writes_json TEXT NOT NULL,
        applied_writes_json TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_page_revisions (
        revision_id TEXT PRIMARY KEY, page_id TEXT NOT NULL, revision INTEGER NOT NULL,
        scope TEXT NOT NULL, profile_id TEXT, metadata_json TEXT NOT NULL, body_digest TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL, compilation_job_id TEXT NOT NULL REFERENCES compilation_jobs(id),
        created_at TEXT NOT NULL, UNIQUE(page_id, revision)
      );
      CREATE TABLE IF NOT EXISTS memory_page_current (
        page_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES memory_page_revisions(revision_id),
        revision INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS compilation_receipts_v2 (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES memory_candidates(id),
        job_id TEXT NOT NULL UNIQUE REFERENCES compilation_jobs(id), status TEXT NOT NULL,
        page_revisions_json TEXT NOT NULL, reason_code TEXT, completed_at TEXT NOT NULL
      );
    `);
    try {
      this.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        ref_key UNINDEXED, title, aliases, tags, body, tokenize='trigram'
      );`);
      this.fts5 = true;
    } catch {
      try {
        this.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
          ref_key UNINDEXED, title, aliases, tags, body
        );`);
        this.fts5 = true;
      } catch {
        this.fts5 = false;
      }
    }
    this.migrateExistingPagesToV2();
    this.database.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '2')`).run();
  }

  private backupV1IfNeeded(): void {
    const hasMetadata = this.database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_meta'
    `).get();
    if (!hasMetadata) return;
    const version = this.database.prepare(`SELECT value FROM schema_meta WHERE key='version'`).get() as Row | undefined;
    if (String(version?.value ?? '') !== '1') return;
    const backup = `${this.file}.pre-memory-v2.bak`;
    if (existsSync(backup)) return;
    const escaped = backup.replaceAll("'", "''");
    this.database.exec(`VACUUM INTO '${escaped}'`);
    chmodSync(backup, 0o600);
  }

  private migrateExistingPagesToV2(): void {
    const rows = this.database.prepare(`
      SELECT * FROM documents d WHERE document_type='wiki'
        AND NOT EXISTS (SELECT 1 FROM memory_page_current c WHERE c.page_id=d.id)
    `).all() as Row[];
    for (const row of rows) {
      const stable = createHash('sha256').update(`${this.scope}:${String(row.id)}:${String(row.digest)}`).digest('hex').slice(0, 24);
      const candidateId = `migration_candidate_${stable}`;
      const jobId = `migration_job_${stable}`;
      const revisionId = `revision_${stable}`;
      const timestamp = String(row.updated_at);
      const profileId = row.profile_id ? String(row.profile_id) : this.profileId ?? 'owner';
      const sourceRefs = json<MemoryDocument['metadata']['sourceRefs']>(row.source_refs_json);
      const evidenceRefs: EvidenceRef[] = sourceRefs.map((source) =>
        evidenceFromSource(source, profileId, 'legacy-workspace'));
      const document = this.readDocument(hitFromRow(row).ref);
      if (!document) continue;
      const candidate: MemoryCandidate = {
        id: candidateId,
        profileId,
        workspaceId: 'legacy-workspace',
        scope: String(row.scope) as MemoryCandidate['scope'],
        proposedKind: String(row.kind) as MemoryCandidate['proposedKind'],
        title: String(row.title),
        content: String(row.body),
        evidenceRefs,
        confidence: String(row.confidence) as MemoryCandidate['confidence'],
        status: 'accepted',
        reasonCode: 'legacy_page_migration',
        createdBy: 'migration',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const job: CompilationJob = {
        id: jobId,
        candidateId,
        operation: 'legacy-import',
        compilerVersion: 'memory-hub-v1-migration',
        expectedRevisions: [],
        plannedWrites: [{ pageId: String(row.id), nextRevision: 1 }],
        appliedWrites: [{ pageId: String(row.id), revisionId }],
        status: 'applied',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.saveCandidate(candidate);
      this.saveJob(job);
      this.commitRevision({
        revisionId,
        pageId: String(row.id),
        revision: 1,
        scope: document.ref.scope,
        profileId: document.metadata.profileId,
        metadata: document.metadata,
        bodyDigest: document.digest,
        evidenceRefs,
        compilationJobId: jobId,
        createdAt: timestamp,
      }, job, {
        id: `migration_receipt_${stable}`,
        candidateId,
        jobId,
        status: 'applied',
        pageRevisions: [{ pageId: String(row.id), revisionId, revision: 1 }],
        reasonCode: 'legacy_page_migration',
        completedAt: timestamp,
      });
    }
  }

  private insertRevision(revision: MemoryPageRevision): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO memory_page_revisions (
        revision_id, page_id, revision, scope, profile_id, metadata_json, body_digest,
        evidence_refs_json, compilation_job_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.revisionId, revision.pageId, revision.revision, revision.scope,
      revision.profileId, JSON.stringify(revision.metadata), revision.bodyDigest,
      JSON.stringify(revision.evidenceRefs), revision.compilationJobId, revision.createdAt,
    );
    this.database.prepare(`
      INSERT INTO memory_page_current (page_id, revision_id, revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(page_id) DO UPDATE SET revision_id=excluded.revision_id,
        revision=excluded.revision, updated_at=excluded.updated_at
      WHERE excluded.revision >= memory_page_current.revision
    `).run(revision.pageId, revision.revisionId, revision.revision, revision.createdAt);
  }
}
