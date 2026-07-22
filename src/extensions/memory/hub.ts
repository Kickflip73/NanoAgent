import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type OpenAI from 'openai';
import type {
  CaptureInput,
  ForgetReceipt,
  EpisodeInput,
  MemoryCard,
  MemoryDocument,
  MemoryHit,
  MemoryHub,
  MemoryLink,
  MemoryPage,
  MemoryPageMetadata,
  MemoryRef,
  MemorySearchOptions,
  MemoryStatusSnapshot,
  RememberInput,
  RunMemoryContext,
  SourceRef,
  WikiLintReport,
} from '../../core/memory.js';
import {
  assertRefVisible,
  assertRememberAllowed,
  contentDigest,
  reciprocalRankFusion,
  stableDirectoryId,
  validateRunMemoryContext,
} from '../../core/memory.js';
import { DefaultWikiCompiler } from './wiki-compiler.js';
import { DocumentSource } from './document-source.js';
import { SqliteMemoryCatalog } from './sqlite-catalog.js';
import { WikiVault } from './wiki-vault.js';
import { cutoverLegacyMemory } from './cutover.js';

const AUTOMATIC_EMBEDDING_TIMEOUT_MS = 1_500;

export interface MemoryHubOptions {
  workspaceRoot: string;
  dataRoot: string;
  profileId: string;
  embeddingClient?: OpenAI;
  embeddingModel?: string;
  retrievalMode?: 'auto' | 'lexical';
  cutover?: boolean;
  userSoulFile?: string;
  packagedSoulFile?: string;
}

function pageId(scope: string, title: string): string {
  return `mem_${createHash('sha256').update(`${scope}\0${title.trim().toLowerCase()}`).digest('hex').slice(0, 24)}`;
}

function sourceFor(input: RememberInput, context: RunMemoryContext): SourceRef {
  const trust = context.cause?.trust ?? 'owner';
  const explicit = !input.autonomous && trust === 'owner';
  return {
    type: explicit ? 'user-explicit' : 'session',
    id: explicit ? `${context.sessionId}/${context.runId}` : `${context.sessionId}@${context.runId}`,
    digest: `sha256:${contentDigest(input.content)}`,
    occurredAt: new Date().toISOString(),
    trust,
  };
}

function mergeStatus(privateStatus: MemoryStatusSnapshot, workspaceStatus: MemoryStatusSnapshot): MemoryStatusSnapshot {
  return {
    pages: privateStatus.pages + workspaceStatus.pages,
    privatePages: privateStatus.privatePages,
    workspacePages: workspaceStatus.workspacePages,
    conflicted: privateStatus.conflicted + workspaceStatus.conflicted,
    stale: privateStatus.stale + workspaceStatus.stale,
    fts5: privateStatus.fts5 && workspaceStatus.fts5,
    degraded: privateStatus.degraded || workspaceStatus.degraded,
    embeddingModel: privateStatus.embeddingModel ?? workspaceStatus.embeddingModel,
    embeddingDimensions: privateStatus.embeddingDimensions ?? workspaceStatus.embeddingDimensions,
    pendingReceipts: (privateStatus.pendingReceipts ?? 0) + (workspaceStatus.pendingReceipts ?? 0),
    decisions: (privateStatus.decisions ?? 0) + (workspaceStatus.decisions ?? 0),
    pageLimitReached: Boolean(privateStatus.pageLimitReached || workspaceStatus.pageLimitReached),
    episodes: (privateStatus.episodes ?? 0) + (workspaceStatus.episodes ?? 0),
  };
}

function estimatedTokens(value: string): number {
  const ascii = (value.match(/[\x00-\x7f]/g) ?? []).length;
  return Math.ceil(ascii / 4 + (value.length - ascii) / 1.5);
}

function boundCards(cards: MemoryHit[], tokenBudget: number, maxCards: number): MemoryHit[] {
  const bounded: MemoryHit[] = [];
  let remaining = tokenBudget;
  for (const card of cards.slice(0, maxCards)) {
    const fixed = `${card.title}\n${card.kind}/${card.status}\n`;
    const fixedTokens = estimatedTokens(fixed);
    if (fixedTokens >= remaining) break;
    let summary = card.summary;
    while (summary && estimatedTokens(summary) > remaining - fixedTokens) {
      summary = summary.slice(0, Math.max(0, Math.floor(summary.length * 0.8)));
    }
    if (!summary) break;
    bounded.push({ ...card, summary });
    remaining -= fixedTokens + estimatedTokens(summary);
  }
  return bounded;
}

class DefaultMemoryHub implements MemoryHub {
  private readonly workspaceRoot: string;
  private readonly dataRoot: string;
  private readonly profileId: string;
  private readonly privateVault: WikiVault;
  private readonly workspaceVault: WikiVault;
  private readonly privateCatalog: SqliteMemoryCatalog;
  private readonly workspaceCatalog: SqliteMemoryCatalog;
  private readonly documents: DocumentSource;
  private readonly compiler: DefaultWikiCompiler;
  private readonly embeddingModel: string;
  private readonly evidence = new Map<string, Awaited<ReturnType<DocumentSource['read']>>>();

  constructor(private readonly options: MemoryHubOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.dataRoot = path.resolve(options.dataRoot);
    this.profileId = options.profileId;
    const memoryRoot = path.join(this.dataRoot, 'memory');
    const profileRoot = path.join(memoryRoot, 'profiles', stableDirectoryId(options.profileId));
    const workspaceCatalogRoot = path.join(memoryRoot, 'workspaces', stableDirectoryId(this.workspaceRoot));
    this.privateVault = new WikiVault(path.join(profileRoot, 'wiki'), 'private', options.profileId);
    this.workspaceVault = new WikiVault(
      path.join(this.workspaceRoot, 'knowledge', 'wiki'),
      'workspace',
      undefined,
      path.join(this.workspaceRoot, 'knowledge', 'WIKI.md'),
    );
    this.privateCatalog = new SqliteMemoryCatalog(path.join(profileRoot, 'memory.db'), 'private', options.profileId);
    this.workspaceCatalog = new SqliteMemoryCatalog(path.join(workspaceCatalogRoot, 'memory.db'), 'workspace');
    this.documents = new DocumentSource(this.workspaceRoot, this.dataRoot);
    this.compiler = new DefaultWikiCompiler(
      this.privateVault, this.workspaceVault, this.privateCatalog, this.workspaceCatalog, this.documents,
    );
    this.embeddingModel = options.embeddingModel ?? process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
  }

  async initialize(): Promise<void> {
    await Promise.all([this.privateVault.initialize(), this.workspaceVault.initialize()]);
    await this.syncIndexes();
  }

  async hotProfile(context: RunMemoryContext): Promise<MemoryCard[]> {
    this.validate(context);
    const cards = this.privateCatalog.list({ kind: 'profile', status: 'active', limit: 8 })
      .filter((hit) => hit.confidence !== 'inferred')
      .slice(0, 8);
    return boundCards(cards, 600, 8);
  }

  async search(query: string, context: RunMemoryContext, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    this.validate(context);
    const normalized = query.trim();
    if (!normalized) throw new Error('Memory query 不能为空');
    const limit = Math.min(20, Math.max(1, options.limit ?? 5));
    const automatic = Object.keys(options).length === 0;
    const finish = (hits: MemoryHit[]) => automatic ? boundCards(hits, 1_200, 5) : hits;
    const queryVector = await this.embed(normalized, automatic);
    const channels: Array<Array<{ item: MemoryHit; key: string }>> = [];
    if (!options.scope || options.scope === 'all' || options.scope === 'private') {
      const hits = this.privateCatalog.search(normalized, { ...options, limit }, queryVector);
      channels.push(hits.map((item) => ({ item, key: `private:${item.ref.id}` })));
    }
    if (!options.scope || options.scope === 'all' || options.scope === 'workspace') {
      const hits = this.workspaceCatalog.search(normalized, { ...options, limit }, queryVector);
      channels.push(hits.map((item) => ({ item, key: `workspace:${item.ref.id}` })));
    }
    const wikiHits = reciprocalRankFusion(channels.filter((channel) => channel.length), limit);
    const needsEvidence = options.includeEvidence
      || wikiHits.length < limit
      || wikiHits.some((hit) => hit.stale || hit.status === 'conflicted');
    if (!needsEvidence) return finish(wikiHits);
    const missing = limit - wikiHits.length;
    const evidenceLimit = missing > 0 ? missing : Math.max(1, Math.floor(limit / 3));
    const sourceEvidence = (!options.scope || options.scope === 'all' || options.scope === 'workspace')
      ? await this.documents.search(normalized, evidenceLimit)
      : [];
    const sourceHits = sourceEvidence.map((document, index): MemoryHit => {
      const id = `source_${createHash('sha256').update(document.path).digest('hex').slice(0, 24)}`;
      this.evidence.set(id, document);
      return {
        ref: { scope: 'workspace', id }, title: document.title,
        summary: document.content.replace(/\s+/g, ' ').trim().slice(0, 600),
        kind: 'source-summary', status: 'active', confidence: 'source-grounded',
        score: 1 / (60 + index + 1), sourceRefs: [document.sourceRef], documentType: 'source',
      };
    });
    const episodeHits = options.includeEvidence
      && context.allowEpisodeEvidence
      && (context.cause?.trust ?? 'owner') === 'owner'
      && (!options.scope || options.scope === 'all' || options.scope === 'private')
      ? this.privateCatalog.search(normalized, {
          ...options, scope: 'private', documentTypes: ['episode'], limit: evidenceLimit,
        }, queryVector)
      : [];
    const evidenceHits = reciprocalRankFusion([
      episodeHits.map((item) => ({ item, key: `episode:${item.ref.id}` })),
      sourceHits.map((item) => ({ item, key: `source:${item.ref.id}` })),
    ].filter((channel) => channel.length), evidenceLimit);
    if (evidenceHits.length === 0) return finish(wikiHits);
    return finish([...wikiHits.slice(0, Math.max(0, limit - evidenceHits.length)), ...evidenceHits]);
  }

  async read(ref: MemoryRef, context: RunMemoryContext): Promise<MemoryDocument> {
    this.validate(context);
    assertRefVisible(ref.scope, ref.profileId, context);
    const evidence = this.evidence.get(ref.id);
    if (ref.scope === 'workspace' && evidence) {
      const timestamp = evidence.sourceRef.occurredAt;
      return {
        ref, metadata: {
          schemaVersion: 1, id: ref.id, title: evidence.title, kind: 'source-summary', scope: 'workspace',
          profileId: null, status: 'active', confidence: 'source-grounded', aliases: [], tags: ['evidence'],
          sourceRefs: [evidence.sourceRef], validFrom: null, validUntil: null, supersedes: [],
          createdAt: timestamp, updatedAt: timestamp,
        }, body: evidence.content, digest: evidence.sourceRef.digest, path: evidence.path,
      };
    }
    if (ref.scope === 'private' && ref.id.startsWith('episode_')) {
      const episode = this.privateCatalog.readDocument(ref);
      if (!episode || episode.metadata.profileId !== context.profileId) throw new Error(`Episode 不存在：${ref.id}`);
      return episode;
    }
    return ref.scope === 'private' ? this.privateVault.read(ref) : this.workspaceVault.read(ref);
  }

  async links(ref: MemoryRef, context: RunMemoryContext): Promise<MemoryLink[]> {
    this.validate(context);
    assertRefVisible(ref.scope, ref.profileId, context);
    return ref.scope === 'private' ? this.privateCatalog.links(ref) : this.workspaceCatalog.links(ref);
  }

  async remember(input: RememberInput, context: RunMemoryContext): Promise<MemoryPage> {
    this.validate(context);
    const normalized: RememberInput = {
      ...input,
      title: input.title.trim(),
      content: input.content.trim(),
      scope: input.scope ?? 'private',
    };
    if (!normalized.title || !normalized.content) throw new Error('Memory 标题和正文不能为空');
    if (normalized.content.length > 120_000) throw new Error('Memory 正文过长');
    if (normalized.scope === 'workspace' && normalized.sourcePaths?.length) {
      normalized.sourceRefs = await Promise.all(normalized.sourcePaths.map(async (sourcePath) => (
        await this.documents.read(sourcePath)
      ).sourceRef));
    }
    assertRememberAllowed(normalized, context);
    if (normalized.supersedes?.length && normalized.autonomous) {
      throw new Error('只有 owner 明确纠正时，remember 才能 supersede 旧事实');
    }
    const scope = normalized.scope!;
    const vault = scope === 'private' ? this.privateVault : this.workspaceVault;
    const catalog = scope === 'private' ? this.privateCatalog : this.workspaceCatalog;
    const digest = contentDigest(`${normalized.title}\0${normalized.content}`);
    if (catalog.isSuppressed(digest)) {
      if (normalized.autonomous) throw new Error('该内容已被 owner 遗忘，自动维护不得恢复');
      catalog.clearSuppression(digest);
    }
    const id = pageId(scope, normalized.title);
    const ref: MemoryRef = { scope, id, ...(scope === 'private' ? { profileId: context.profileId } : {}) };
    let existing: MemoryDocument | undefined;
    try { existing = await vault.read(ref); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('不存在')) throw error;
    }
    const timestamp = new Date().toISOString();
    const supersededPages = new Map<string, MemoryDocument>();
    for (const supersededId of new Set(normalized.supersedes ?? [])) {
      if (supersededId === ref.id) continue;
      const supersededRef: MemoryRef = {
        scope, id: supersededId, ...(scope === 'private' ? { profileId: context.profileId } : {}),
      };
      supersededPages.set(supersededId, await vault.read(supersededRef));
    }
    const sources = normalized.sourceRefs?.length ? normalized.sourceRefs : [sourceFor(normalized, context)];
    if (scope === 'workspace') {
      for (const source of sources) {
        const current = await this.documents.read(source.id);
        if (current.sourceRef.digest !== source.digest) throw new Error(`Workspace SourceRef digest 已变化：${source.id}`);
      }
    }
    const metadata: MemoryPageMetadata = {
      schemaVersion: 1,
      id,
      title: normalized.title,
      kind: normalized.kind,
      scope,
      profileId: scope === 'private' ? context.profileId : null,
      status: 'active',
      confidence: normalized.confidence ?? (normalized.autonomous ? 'inferred' : 'user-confirmed'),
      aliases: [...new Set(normalized.aliases ?? [])],
      tags: [...new Set(normalized.tags ?? [])],
      sourceRefs: sources,
      validFrom: normalized.supersedes?.length ? timestamp : null,
      validUntil: null,
      supersedes: [...new Set(normalized.supersedes ?? [])],
      createdAt: existing?.metadata.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    const page = await vault.write(metadata, normalized.content, existing?.digest);
    const embedding = await this.embedDocument(`${metadata.title}\n${normalized.content}`);
    catalog.index(page, embedding);
    for (const [supersededId, previous] of supersededPages) {
      const updated = await vault.write({
        ...previous.metadata, status: 'superseded', validUntil: timestamp, updatedAt: timestamp,
      }, previous.body, previous.digest);
      catalog.index(updated);
      catalog.recordDecision('correct', 'owner_superseded', supersededId);
    }
    catalog.recordDecision('remember', normalized.autonomous ? 'autonomous_future_value' : 'owner_explicit', ref.id);
    await vault.refreshNavigation('capture', digest, [ref]);
    return page;
  }

  async forget(ref: MemoryRef, context: RunMemoryContext): Promise<ForgetReceipt> {
    this.validate(context);
    assertRefVisible(ref.scope, ref.profileId, context);
    if (ref.scope === 'workspace' && (context.cause?.trust ?? 'owner') !== 'owner') {
      throw new Error('只有 owner 能删除 workspace Memory');
    }
    const vault = ref.scope === 'private' ? this.privateVault : this.workspaceVault;
    const catalog = ref.scope === 'private' ? this.privateCatalog : this.workspaceCatalog;
    let digest: string | undefined;
    try {
      const page = await vault.read(ref);
      digest = contentDigest(`${page.metadata.title}\0${page.body}`);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('不存在')) throw error;
    }
    const forgotten = await vault.remove(ref);
    catalog.remove(ref);
    const timestamp = new Date().toISOString();
    if (digest) catalog.suppress(digest, timestamp);
    catalog.recordDecision('forget', forgotten ? 'owner_forget' : 'already_absent', ref.id);
    if (forgotten) await vault.refreshNavigation('lint', digest ?? 'forgotten', []);
    return { ref, forgotten, ...(digest ? { suppressedDigest: digest } : {}), timestamp };
  }

  async ingest(sourcePath: string, context: RunMemoryContext) {
    this.validate(context);
    if ((context.cause?.trust ?? 'owner') !== 'owner' && context.cause?.trust !== 'system') {
      throw new Error('只有 owner/system 能 ingest workspace 来源');
    }
    const document = await this.documents.read(sourcePath);
    const receipt = await this.compiler.ingest(document.sourceRef, context);
    for (const ref of receipt.pageRefs) {
      const page = await this.workspaceVault.read(ref);
      const embedding = await this.embedDocument(`${page.metadata.title}\n${page.body}`);
      this.workspaceCatalog.index(page, embedding);
    }
    return receipt;
  }

  async capture(input: CaptureInput, context: RunMemoryContext) {
    this.validate(context);
    assertRememberAllowed({
      title: input.title, content: input.content, kind: input.kind ?? 'synthesis',
      scope: input.scope, confidence: input.confidence, sourceRefs: input.sourceRefs,
      supersedes: input.supersedes, autonomous: true,
    }, context);
    if ((context.cause?.trust ?? 'owner') === 'external' || context.cause?.trust === 'public') {
      throw new Error('外部来源不能直接 capture active Memory');
    }
    if (input.sourceRefs.length === 0 || input.sourceRefs.length > 20) {
      throw new Error('Capture 必须包含 1-20 个 SourceRef');
    }
    if ((input.scope ?? 'private') === 'workspace'
      && input.sourceRefs.some((source) => source.type !== 'file')) {
      throw new Error('Workspace capture 只接受明确文件来源');
    }
    return this.compiler.capture(input, context);
  }

  async reject(sourceRefs: SourceRef[], reasonCode: string, context: RunMemoryContext) {
    this.validate(context);
    return this.compiler.reject(sourceRefs, reasonCode, context);
  }

  async recordEpisode(input: EpisodeInput, context: RunMemoryContext): Promise<MemoryRef> {
    this.validate(context);
    if (input.sessionId !== context.sessionId || input.runId !== context.runId) {
      throw new Error('Episode 必须属于当前 immutable Session/Run');
    }
    const content = `用户：${input.input.trim().slice(0, 8_000)}\n\n助手：${input.answer.trim().slice(0, 8_000)}`;
    const digest = contentDigest(content);
    const id = `episode_${createHash('sha256').update(`${input.sessionId}\0${input.runId}`).digest('hex').slice(0, 24)}`;
    const sourceRef = input.sourceRef ?? {
      type: 'session' as const,
      id: `${input.sessionId}@${input.runId}`,
      digest: `sha256:${digest}`,
      occurredAt: input.occurredAt,
      trust: context.cause?.trust ?? 'owner',
    };
    const ref: MemoryRef = { scope: 'private', profileId: context.profileId, id };
    const document: MemoryDocument = {
      ref,
      metadata: {
        schemaVersion: 1, id, title: input.input.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Session episode',
        kind: 'source-summary', scope: 'private', profileId: context.profileId, status: 'active',
        confidence: 'source-grounded', aliases: [], tags: ['episode'], sourceRefs: [sourceRef],
        validFrom: null, validUntil: null, supersedes: [], createdAt: input.occurredAt, updatedAt: input.occurredAt,
      },
      body: content,
      digest,
    };
    this.privateCatalog.index(document, undefined, 'episode');
    this.privateCatalog.pruneEpisodes();
    return ref;
  }

  async conflicts(context: RunMemoryContext, limit = 50): Promise<MemoryHit[]> {
    return this.list(context, { status: 'conflicted', limit });
  }

  async audit(context: RunMemoryContext, limit = 50) {
    this.validate(context);
    return [...this.privateCatalog.decisions(limit), ...this.workspaceCatalog.decisions(limit)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.max(1, Math.min(200, limit)));
  }

  async list(context: RunMemoryContext, options: MemorySearchOptions = {}): Promise<MemoryHit[]> {
    this.validate(context);
    const hits = [
      ...(!options.scope || options.scope === 'all' || options.scope === 'private' ? this.privateCatalog.list(options) : []),
      ...(!options.scope || options.scope === 'all' || options.scope === 'workspace' ? this.workspaceCatalog.list(options) : []),
    ];
    return hits.sort((left, right) => right.summary.localeCompare(left.summary)).slice(0, options.limit ?? 100);
  }

  async lint(context: RunMemoryContext): Promise<WikiLintReport> {
    this.validate(context);
    return this.compiler.lint(context);
  }

  async reindex(context: RunMemoryContext): Promise<MemoryStatusSnapshot> {
    this.validate(context);
    await this.rebuildIndexes();
    return this.status(context);
  }

  async status(context: RunMemoryContext): Promise<MemoryStatusSnapshot> {
    this.validate(context);
    return mergeStatus(this.privateCatalog.status(), this.workspaceCatalog.status());
  }

  private async rebuildIndexes(): Promise<void> {
    const [privatePages, workspacePages] = await this.loadPages();
    this.privateCatalog.rebuild(privatePages, this.embeddingModel);
    this.workspaceCatalog.rebuild(workspacePages, this.embeddingModel);
    await this.ensureEmbeddings(privatePages, workspacePages);
  }

  private async syncIndexes(): Promise<void> {
    const [privatePages, workspacePages] = await this.loadPages();
    this.privateCatalog.sync(privatePages);
    this.workspaceCatalog.sync(workspacePages);
    await this.ensureEmbeddings(privatePages, workspacePages);
  }

  private async loadPages(): Promise<[MemoryDocument[], MemoryDocument[]]> {
    const [privatePages, workspacePages] = await Promise.all([this.privateVault.list(), this.workspaceVault.list()]);
    await Promise.all(workspacePages.map(async (page) => {
      const sources = page.metadata.sourceRefs.filter((source) => source.type === 'file');
      for (const source of sources) {
        try {
          if ((await this.documents.read(source.id)).sourceRef.digest !== source.digest) page.stale = true;
        } catch {
          page.stale = true;
        }
      }
    }));
    return [privatePages, workspacePages];
  }

  private async ensureEmbeddings(privatePages: MemoryDocument[], workspacePages: MemoryDocument[]): Promise<void> {
    if (this.options.retrievalMode !== 'lexical' && this.options.embeddingClient) {
      for (const page of privatePages) {
        if (!this.privateCatalog.needsEmbedding(page, this.embeddingModel)) continue;
        this.privateCatalog.index(page, await this.embedDocument(`${page.metadata.title}\n${page.body}`));
      }
      for (const page of workspacePages) {
        if (!this.workspaceCatalog.needsEmbedding(page, this.embeddingModel)) continue;
        this.workspaceCatalog.index(page, await this.embedDocument(`${page.metadata.title}\n${page.body}`));
      }
    }
  }

  private validate(context: RunMemoryContext): void {
    validateRunMemoryContext(context, this.workspaceRoot, this.profileId);
  }

  private async embed(query: string, automatic = false): Promise<number[] | undefined> {
    if (this.options.retrievalMode === 'lexical' || !this.options.embeddingClient) return undefined;
    try {
      const response = await this.options.embeddingClient.embeddings.create(
        { model: this.embeddingModel, input: query },
        automatic ? { maxRetries: 0, timeout: AUTOMATIC_EMBEDDING_TIMEOUT_MS } : undefined,
      );
      return response.data[0]?.embedding;
    } catch {
      return undefined;
    }
  }

  private async embedDocument(content: string): Promise<{ model: string; vector: number[] } | undefined> {
    const vector = await this.embed(content);
    return vector ? { model: this.embeddingModel, vector } : undefined;
  }
}

export async function createMemoryHub(options: MemoryHubOptions): Promise<MemoryHub> {
  const hub = new DefaultMemoryHub(options);
  await hub.initialize();
  if (options.cutover !== false) {
    await cutoverLegacyMemory(hub, options.workspaceRoot, options.dataRoot, {
      profileId: options.profileId,
      workspaceRoot: options.workspaceRoot,
      sessionId: 'memory-cutover',
      runId: 'memory-cutover-v1',
      cause: { trust: 'owner', source: 'local-cutover' },
    }, { userSoulFile: options.userSoulFile, packagedSoulFile: options.packagedSoulFile });
  }
  return hub;
}

class RoutedMemoryHub implements MemoryHub {
  private readonly hubs = new Map<string, Promise<MemoryHub>>();

  constructor(private readonly options: Omit<MemoryHubOptions, 'profileId' | 'cutover'>) {}

  hotProfile(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.hotProfile(context)); }
  search(query: string, context: RunMemoryContext, options?: MemorySearchOptions) { return this.forContext(context).then((hub) => hub.search(query, context, options)); }
  read(ref: MemoryRef, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.read(ref, context)); }
  links(ref: MemoryRef, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.links(ref, context)); }
  remember(input: RememberInput, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.remember(input, context)); }
  forget(ref: MemoryRef, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.forget(ref, context)); }
  ingest(sourcePath: string, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.ingest(sourcePath, context)); }
  capture(input: CaptureInput, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.capture(input, context)); }
  reject(sourceRefs: SourceRef[], reasonCode: string, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.reject(sourceRefs, reasonCode, context)); }
  recordEpisode(input: EpisodeInput, context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.recordEpisode(input, context)); }
  conflicts(context: RunMemoryContext, limit?: number) { return this.forContext(context).then((hub) => hub.conflicts(context, limit)); }
  audit(context: RunMemoryContext, limit?: number) { return this.forContext(context).then((hub) => hub.audit(context, limit)); }
  list(context: RunMemoryContext, options?: MemorySearchOptions) { return this.forContext(context).then((hub) => hub.list(context, options)); }
  lint(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.lint(context)); }
  reindex(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.reindex(context)); }
  status(context: RunMemoryContext) { return this.forContext(context).then((hub) => hub.status(context)); }

  private forContext(context: RunMemoryContext): Promise<MemoryHub> {
    let hub = this.hubs.get(context.profileId);
    if (!hub) {
      hub = createMemoryHub({ ...this.options, profileId: context.profileId, cutover: context.profileId === 'owner' });
      this.hubs.set(context.profileId, hub);
    }
    return hub;
  }
}

export function createRoutedMemoryHub(options: Omit<MemoryHubOptions, 'profileId' | 'cutover'>): MemoryHub {
  return new RoutedMemoryHub(options);
}
