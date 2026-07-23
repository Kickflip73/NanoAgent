import { createHash, randomUUID } from 'node:crypto';
import type {
  CaptureInput,
  CompilationPlan,
  CompilationReceipt,
  MemoryKind,
  MemoryPageMetadata,
  RunMemoryContext,
  SourceRef,
  WikiCompiler,
  WikiLintReport,
} from '../../core/memory.js';
import { contentDigest, sourceDigest } from '../../core/memory.js';
import { DocumentSource } from './document-source.js';
import { SqliteMemoryCatalog } from './sqlite-catalog.js';
import { lintWiki } from './wiki-lint.js';
import { WikiVault } from './wiki-vault.js';

const COMPILER_VERSION = 'memory-hub-v1';

function pageId(seed: string): string {
  return `mem_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function pageBody(title: string, content: string, sources: readonly SourceRef[], links: readonly string[] = []): string {
  const bounded = content.trim().slice(0, 120_000);
  const relations = links.length ? `\n\n## 关系\n\n${links.map((link) => `- [[${link}]]`).join('\n')}` : '';
  return `# ${title}\n\n## 摘要\n\n${bounded}${relations}\n\n## 来源\n\n${sources.map((source) => `- [source:${source.type}:${source.id}]`).join('\n')}`;
}

function sectionKind(title: string): MemoryKind {
  if (/(?:decision|决定|决策|adr)/i.test(title)) return 'decision';
  if (/(?:lesson|gotcha|经验|教训|陷阱)/i.test(title)) return 'lesson';
  if (/(?:people|person|team|组织|人物|实体)/i.test(title)) return 'entity';
  return 'concept';
}

function ingestUnits(title: string, content: string, source: SourceRef): Array<{
  ref: { scope: 'workspace'; id: string };
  title: string;
  content: string;
  kind: MemoryKind;
  links: string[];
}> {
  const headings = [...content.matchAll(/^#{2,3}\s+(.+)$/gm)].slice(0, 14);
  const seenHeadings = new Set<string>();
  const sections = headings.map((heading, index) => {
    const sectionTitle = heading[1]!.trim().slice(0, 160);
    const start = heading.index! + heading[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    return { title: `${title}: ${sectionTitle}`, content: content.slice(start, end).trim(), heading: sectionTitle };
  }).filter((section) => {
    const key = section.heading.toLowerCase();
    if (section.content.length < 40 || seenHeadings.has(key)) return false;
    seenHeadings.add(key);
    return true;
  });
  const summaryContent = sections.length
    ? `${content.slice(0, 8_000).trim()}\n\n本来源另编译为 ${sections.length} 个主题页面。`
    : content;
  const summary = {
    ref: { scope: 'workspace' as const, id: pageId(`file:${source.id}`) },
    title, content: summaryContent, kind: 'source-summary' as const,
    links: sections.map((section) => section.title),
  };
  return [summary, ...sections.map((section) => ({
    ref: { scope: 'workspace' as const, id: pageId(`file:${source.id}#${section.heading.toLowerCase()}`) },
    title: section.title, content: section.content, kind: sectionKind(section.heading), links: [title],
  }))].slice(0, 15);
}

export class DefaultWikiCompiler implements WikiCompiler {
  constructor(
    private readonly privateVault: WikiVault,
    private readonly workspaceVault: WikiVault,
    private readonly privateCatalog: SqliteMemoryCatalog,
    private readonly workspaceCatalog: SqliteMemoryCatalog,
    private readonly documents: DocumentSource,
  ) {}

  async ingest(source: SourceRef, context: RunMemoryContext): Promise<CompilationReceipt> {
    if (source.type !== 'file') throw new Error('Ingest 只接受明确的 workspace 文件 SourceRef');
    await this.workspaceVault.loadSchema();
    const document = await this.documents.read(source.id);
    if (document.sourceRef.digest !== source.digest) throw new Error('Document Source digest 已变化，请重新发起 ingest');
    const digest = sourceDigest(source);
    const previous = this.workspaceCatalog.getReceipt(digest, 'ingest');
    if (previous?.status === 'applied') return previous;
    const units = ingestUnits(document.title, document.content, source);
    const refs = units.map((unit) => unit.ref);
    const plan: CompilationPlan = {
      operation: 'ingest', digest, compilerVersion: COMPILER_VERSION,
      plannedPageRefs: refs, appliedPageRefs: previous?.pageRefs ?? [],
    };
    const pending: CompilationReceipt = {
      id: previous?.id ?? `receipt_${randomUUID()}`, operation: 'ingest', status: 'pending', digest,
      pageRefs: [...plan.appliedPageRefs],
    };
    this.workspaceCatalog.saveReceipt(pending, plan);
    const timestamp = new Date().toISOString();
    const existingPages = new Map((await this.workspaceVault.list()).map((page) => [page.ref.id, page]));
    for (const unit of units) {
      const existing = existingPages.get(unit.ref.id);
      const alreadyApplied = plan.appliedPageRefs.some((ref) => ref.id === unit.ref.id)
        && existing?.metadata.sourceRefs.some((candidate) => sourceDigest(candidate) === sourceDigest(source));
      if (alreadyApplied) continue;
      const metadata: MemoryPageMetadata = {
        schemaVersion: 1, id: unit.ref.id, title: unit.title, kind: unit.kind, scope: 'workspace', profileId: null,
        status: 'active', confidence: 'source-grounded', aliases: [], tags: ['source'], sourceRefs: [source],
        validFrom: null, validUntil: null, supersedes: existing?.metadata.supersedes ?? [],
        createdAt: existing?.metadata.createdAt ?? timestamp, updatedAt: timestamp,
      };
      const page = await this.workspaceVault.write(
        metadata, pageBody(unit.title, unit.content, [source], unit.links), existing?.digest,
      );
      this.workspaceCatalog.index({ ...page, path: existing?.path });
      if (!plan.appliedPageRefs.some((ref) => ref.id === unit.ref.id)) plan.appliedPageRefs.push(unit.ref);
      this.workspaceCatalog.saveReceipt({ ...pending, pageRefs: [...plan.appliedPageRefs] }, plan);
    }
    const inspection = await this.workspaceVault.inspect();
    const deterministic = lintWiki(inspection.pages);
    const errors = [...inspection.issues, ...deterministic.issues].filter((issue) => issue.severity === 'error');
    if (errors.length) throw new Error(`Ingest 后确定性 Lint 失败：${errors[0]!.message}`);
    await this.workspaceVault.refreshNavigation('ingest', digest, refs);
    const applied: CompilationReceipt = { ...pending, status: 'applied', pageRefs: refs };
    this.workspaceCatalog.saveReceipt(applied, plan);
    return applied;
  }

  async capture(input: CaptureInput, context: RunMemoryContext): Promise<CompilationReceipt> {
    const scope = input.scope ?? 'private';
    const vault = scope === 'private' ? this.privateVault : this.workspaceVault;
    const catalog = scope === 'private' ? this.privateCatalog : this.workspaceCatalog;
    await vault.loadSchema();
    if (!input.title.trim() || !input.content.trim()) throw new Error('Capture 标题和内容不能为空');
    if (input.content.length > 120_000) throw new Error('Capture 内容过长');
    const digest = contentDigest(`${input.title}\0${input.content}\0${input.sourceRefs.map(sourceDigest).join(':')}`);
    const previous = catalog.getReceipt(digest, 'capture');
    if (previous?.status === 'applied') return previous;
    const ref = { scope, id: pageId(`capture:${scope}:${input.title.trim().toLowerCase()}`), ...(scope === 'private' ? { profileId: context.profileId } : {}) };
    const timestamp = new Date().toISOString();
    let existing;
    try { existing = await vault.read(ref); } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('不存在')) throw error;
    }
    if (!existing && context.cause?.source === 'memory-maintenance' && catalog.status().pageLimitReached) {
      throw new Error('Vault 已达到 10,000 页上限；maintenance 只能合并或更新现有页面');
    }
    const plan: CompilationPlan = {
      operation: 'capture', digest, compilerVersion: COMPILER_VERSION,
      plannedPageRefs: [ref], appliedPageRefs: [],
    };
    const pending: CompilationReceipt = {
      id: previous?.id ?? `receipt_${randomUUID()}`, operation: 'capture', status: 'pending', digest, pageRefs: [],
    };
    catalog.saveReceipt(pending, plan);
    const metadata: MemoryPageMetadata = {
      schemaVersion: 1, id: ref.id, title: input.title.trim(), kind: input.kind ?? 'synthesis', scope,
      profileId: scope === 'private' ? context.profileId : null,
      status: input.status ?? 'active', confidence: input.confidence ?? 'inferred', aliases: [], tags: [], sourceRefs: input.sourceRefs,
      validFrom: null, validUntil: null, supersedes: input.supersedes ?? existing?.metadata.supersedes ?? [],
      createdAt: existing?.metadata.createdAt ?? timestamp, updatedAt: timestamp,
    };
    const page = await vault.write(metadata, pageBody(input.title, input.content, input.sourceRefs), existing?.digest);
    catalog.index(page);
    plan.appliedPageRefs.push(ref);
    catalog.saveReceipt({ ...pending, pageRefs: [ref] }, plan);
    const inspection = await vault.inspect();
    const deterministic = lintWiki(inspection.pages);
    const errors = [...inspection.issues, ...deterministic.issues].filter((issue) => issue.severity === 'error');
    if (errors.length) throw new Error(`Capture 后确定性 Lint 失败：${errors[0]!.message}`);
    await vault.refreshNavigation('capture', digest, [ref]);
    const receipt: CompilationReceipt = { ...pending, status: 'applied', pageRefs: [ref] };
    catalog.saveReceipt(receipt, plan);
    catalog.recordDecision('capture', input.reasonCode ?? 'captured_for_future_value', ref.id);
    return receipt;
  }

  async reject(sourceRefs: SourceRef[], reasonCode: string, _context: RunMemoryContext): Promise<CompilationReceipt> {
    if (sourceRefs.length === 0 || sourceRefs.length > 20) throw new Error('Rejected receipt 必须引用 1-20 个来源');
    const normalizedReason = reasonCode.trim().slice(0, 200);
    if (!normalizedReason) throw new Error('Rejected receipt 缺少 reasonCode');
    const digest = contentDigest(sourceRefs.map(sourceDigest).join(':'));
    const previous = this.privateCatalog.getReceipt(digest, 'capture');
    if (previous?.status === 'rejected') return previous;
    const plan: CompilationPlan = {
      operation: 'capture', digest, compilerVersion: COMPILER_VERSION,
      plannedPageRefs: [], appliedPageRefs: [],
    };
    const receipt: CompilationReceipt = {
      id: previous?.id ?? `receipt_${randomUUID()}`, operation: 'capture', status: 'rejected',
      digest, pageRefs: [], reasonCode: normalizedReason,
    };
    this.privateCatalog.saveReceipt(receipt, plan);
    this.privateCatalog.recordDecision('capture', normalizedReason);
    return receipt;
  }

  async lint(_context: RunMemoryContext): Promise<WikiLintReport> {
    await Promise.all([this.privateVault.loadSchema(), this.workspaceVault.loadSchema()]);
    const [privateInspection, workspaceInspection] = await Promise.all([
      this.privateVault.inspect(), this.workspaceVault.inspect(),
    ]);
    const privateLint = lintWiki(privateInspection.pages);
    const workspaceLint = lintWiki(workspaceInspection.pages);
    const privateIssues = [...privateInspection.issues, ...privateLint.issues];
    const workspaceIssues = [...workspaceInspection.issues, ...workspaceLint.issues];
    const [privateRules, workspaceRules] = [
      this.privateCatalog.recordLintIssues(privateIssues),
      this.workspaceCatalog.recordLintIssues(workspaceIssues),
    ];
    await Promise.all([
      this.privateVault.refreshErrorBook(privateRules),
      this.workspaceVault.refreshErrorBook(workspaceRules),
      this.privateVault.refreshNavigation('lint', contentDigest(JSON.stringify(privateIssues)), []),
      this.workspaceVault.refreshNavigation('lint', contentDigest(JSON.stringify(workspaceIssues)), []),
    ]);
    const issues = [...privateIssues, ...workspaceIssues];
    return {
      valid: !issues.some((issue) => issue.severity === 'error'),
      checked: privateLint.checked + workspaceLint.checked,
      issues,
    };
  }
}
