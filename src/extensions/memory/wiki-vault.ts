import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { MemoryDocument, MemoryPage, MemoryPageMetadata, MemoryRef, MemoryScope, WikiLintIssue } from '../../core/memory.js';
import { contentDigest } from '../../core/memory.js';
import { withExclusiveFileLock } from '../../core/state-file.js';
import { DEFAULT_WIKI_SCHEMA, memoryPageMetadataSchema } from './wiki-schema.js';
import type { PersistedLintIssue } from './sqlite-catalog.js';

const MAX_PAGE_BYTES = 200_000;

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pageFileName(page: Pick<MemoryPageMetadata, 'id' | 'kind'>): string {
  return path.join(page.kind, `${page.id}.md`);
}

export function serializePage(metadata: MemoryPageMetadata, body: string): string {
  return `---\n${stringifyYaml(metadata, { lineWidth: 0 }).trimEnd()}\n---\n\n${body.trim()}\n`;
}

export function parsePage(source: string, file?: string): MemoryPage {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) throw new Error(`Wiki 页面缺少 YAML frontmatter${file ? `：${file}` : ''}`);
  const metadata = memoryPageMetadataSchema.parse(parseYaml(match[1]!));
  const body = match[2]!.trim();
  if (!body) throw new Error(`Wiki 页面正文为空${file ? `：${file}` : ''}`);
  return {
    ref: { scope: metadata.scope, id: metadata.id, ...(metadata.profileId ? { profileId: metadata.profileId } : {}) },
    metadata,
    body,
    digest: `sha256:${contentDigest(source)}`,
  };
}

export class WikiVault {
  readonly root: string;
  readonly wikiFile: string;

  constructor(root: string, readonly scope: MemoryScope, readonly profileId?: string, wikiFile?: string) {
    this.root = path.resolve(root);
    this.wikiFile = wikiFile ? path.resolve(wikiFile) : path.join(this.root, 'WIKI.md');
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: this.scope === 'private' ? 0o700 : 0o755 });
    await mkdir(path.dirname(this.wikiFile), { recursive: true, mode: this.scope === 'private' ? 0o700 : 0o755 });
    if (this.scope === 'private') await chmod(this.root, 0o700);
    try {
      await stat(this.wikiFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(this.wikiFile, DEFAULT_WIKI_SCHEMA, { mode: this.scope === 'private' ? 0o600 : 0o644, flag: 'wx' });
    }
  }

  async loadSchema(): Promise<string> {
    const info = await stat(this.wikiFile);
    if (!info.isFile() || info.size > 100_000) throw new Error('WIKI.md 必须是小于 100KB 的常规文件');
    return readFile(this.wikiFile, 'utf8');
  }

  async read(ref: MemoryRef): Promise<MemoryDocument> {
    this.assertRef(ref);
    const files = await this.pageFiles();
    const file = files.find((candidate) => path.basename(candidate) === `${ref.id}.md`);
    if (!file) throw new Error(`Memory 页面不存在：${ref.id}`);
    const page = parsePage(await readFile(file, 'utf8'), file);
    this.assertPage(page);
    return { ...page, path: file };
  }

  async list(): Promise<MemoryDocument[]> {
    return (await this.inspect()).pages;
  }

  async inspect(): Promise<{ pages: MemoryDocument[]; issues: WikiLintIssue[] }> {
    const pages: MemoryDocument[] = [];
    const issues: WikiLintIssue[] = [];
    for (const file of await this.pageFiles()) {
      const info = await stat(file);
      if (info.size > MAX_PAGE_BYTES) {
        issues.push({ code: 'page-too-large', severity: 'error', message: `${file} 超过页面上限` });
        continue;
      }
      try {
        const page = parsePage(await readFile(file, 'utf8'), file);
        this.assertPage(page);
        pages.push({ ...page, path: file });
      } catch (error) {
        issues.push({ code: 'invalid-page', severity: 'error', message: `${file}: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return { pages, issues };
  }

  async write(metadata: MemoryPageMetadata, body: string, expectedDigest?: string): Promise<MemoryPage> {
    const parsedMetadata = memoryPageMetadataSchema.parse(metadata);
    const page: MemoryPage = {
      ref: { scope: parsedMetadata.scope, id: parsedMetadata.id, ...(parsedMetadata.profileId ? { profileId: parsedMetadata.profileId } : {}) },
      metadata: parsedMetadata,
      body: body.trim(),
      digest: '',
    };
    this.assertPage(page);
    const file = path.resolve(this.root, pageFileName(parsedMetadata));
    if (!contained(this.root, file)) throw new Error('Wiki 页面路径越界');
    const source = serializePage(parsedMetadata, page.body);
    if (Buffer.byteLength(source) > MAX_PAGE_BYTES) throw new Error(`Wiki 页面不能超过 ${MAX_PAGE_BYTES} 字节`);
    await withExclusiveFileLock(this.root, async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: this.scope === 'private' ? 0o700 : 0o755 });
      if (expectedDigest) {
        try {
          const current = parsePage(await readFile(file, 'utf8'), file);
          if (current.digest !== expectedDigest) throw new Error(`Wiki 页面已被并发修改：${parsedMetadata.id}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          throw new Error(`Wiki 页面已被删除：${parsedMetadata.id}`);
        }
      }
      const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', this.scope === 'private' ? 0o600 : 0o644);
      try {
        await handle.writeFile(source, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
    });
    return { ...page, digest: `sha256:${contentDigest(source)}` };
  }

  async remove(ref: MemoryRef): Promise<boolean> {
    this.assertRef(ref);
    return withExclusiveFileLock(this.root, async () => {
      const files = await this.pageFiles();
      const file = files.find((candidate) => path.basename(candidate) === `${ref.id}.md`);
      if (!file) return false;
      await unlink(file);
      return true;
    });
  }

  async refreshNavigation(operation: 'ingest' | 'capture' | 'lint', digest: string, refs: readonly MemoryRef[]): Promise<void> {
    const pages = await this.list();
    const index = [
      '# Wiki Index',
      '',
      ...pages.sort((left, right) => left.metadata.title.localeCompare(right.metadata.title)).map((page) =>
        `- [[${page.metadata.title}]] · ${page.metadata.kind} · ${page.metadata.updatedAt.slice(0, 10)} · ${page.metadata.sourceRefs.length} source(s) — ${page.body.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 140)}`
      ),
      '',
    ].join('\n');
    await withExclusiveFileLock(this.root, async () => {
      const indexFile = path.join(this.root, '_index.md');
      const temporary = `${indexFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, index, { flag: 'wx', mode: this.scope === 'private' ? 0o600 : 0o644 });
      await rename(temporary, indexFile);
      const timestamp = new Date().toISOString();
      const year = timestamp.slice(0, 4);
      const logFile = path.join(this.root, '_log.md');
      let log = '';
      try { log = await readFile(logFile, 'utf8'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!log.includes(`## ${year}`)) await appendFile(logFile, `${log ? '\n' : '# Wiki Maintenance Log\n\n'}## ${year}\n`, { mode: this.scope === 'private' ? 0o600 : 0o644 });
      const entries = (refs.length ? refs.map((ref) => ref.id) : operation === 'lint' ? ['-'] : [])
        .map((id) => `${operation} ${id} ${digest} memory-hub-v1 ${timestamp}`).join('\n');
      if (entries) await appendFile(logFile, `${entries}\n`, { mode: this.scope === 'private' ? 0o600 : 0o644 });
    });
  }

  async refreshErrorBook(issues: readonly PersistedLintIssue[]): Promise<void> {
    const lines = [
      '# Wiki Error Book',
      '',
      'Only recurring deterministic issues are recorded here; resolved entries remain auditable.',
      '',
      ...issues.map((issue) => [
        `## ${issue.resolved ? 'resolved' : 'open'} · ${issue.code}`,
        '',
        `- occurrences: ${issue.occurrences}`,
        `- lastSeenAt: ${issue.lastSeenAt}`,
        `- message: ${issue.message.replace(/\s+/g, ' ').trim()}`,
        '',
      ].join('\n')),
    ];
    const file = path.join(this.root, '_error-book.md');
    await withExclusiveFileLock(this.root, async () => {
      const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${lines.join('\n').trimEnd()}\n`, {
        flag: 'wx', mode: this.scope === 'private' ? 0o600 : 0o644,
      });
      await rename(temporary, file);
    });
  }

  private assertRef(ref: MemoryRef): void {
    if (ref.scope !== this.scope) throw new Error('Memory scope 不匹配');
    if (this.scope === 'private' && ref.profileId !== this.profileId) throw new Error('Memory profile 不匹配');
  }

  private assertPage(page: MemoryPage): void {
    if (page.metadata.scope !== this.scope) throw new Error('Wiki 页面 scope 与 Vault 不匹配');
    if (this.scope === 'private' && page.metadata.profileId !== this.profileId) throw new Error('Wiki 页面 profile 与 Vault 不匹配');
    if (this.scope === 'workspace' && page.metadata.sourceRefs.some((source) => source.type !== 'file')) {
      throw new Error('Workspace Wiki 只能引用明确的 workspace 文件来源');
    }
  }

  private async pageFiles(): Promise<string[]> {
    const files: string[] = [];
    const canonicalRoot = await realpath(this.root);
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('_') || entry.name === 'WIKI.md') continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(candidate);
        else if (entry.isFile() && entry.name.endsWith('.md')) {
          const canonical = await realpath(candidate);
          if (!contained(canonicalRoot, canonical)) throw new Error('Wiki 页面通过符号链接越界');
          files.push(canonical);
        }
      }
    };
    await visit(this.root);
    return files.sort();
  }
}
