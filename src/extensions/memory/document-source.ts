import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SourceRef } from '../../core/memory.js';

export interface WorkspaceDocument {
  path: string;
  title: string;
  content: string;
  sourceRef: SourceRef;
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export class DocumentSource {
  private readonly root: string;
  private readonly protectedRoot: string;
  private readonly protectedRootIsWithinWorkspace: boolean;

  constructor(workspaceRoot: string, dataRoot: string) {
    this.root = path.resolve(workspaceRoot);
    this.protectedRoot = path.resolve(dataRoot);
    this.protectedRootIsWithinWorkspace = contained(this.root, this.protectedRoot);
  }

  async read(relativePath: string): Promise<WorkspaceDocument> {
    const lexical = path.resolve(this.root, relativePath);
    if (!contained(this.root, lexical)) throw new Error('Document Source 不能超出 workspace');
    if (this.protectedRootIsWithinWorkspace && contained(this.protectedRoot, lexical)) {
      throw new Error('不能把 MimiAgent 私有运行数据作为 Document Source');
    }
    const [canonicalRoot, canonical, info] = await Promise.all([realpath(this.root), realpath(lexical), stat(lexical)]);
    if (!contained(canonicalRoot, canonical)) throw new Error('Document Source 不能通过符号链接越界');
    if (!info.isFile()) throw new Error('Document Source 必须是常规文件');
    if (!/\.(?:md|txt)$/i.test(canonical)) throw new Error('Document Source 只支持 Markdown 或文本文件');
    if (info.size > 2_000_000) throw new Error('Document Source 单文件不能超过 2MB');
    const content = await readFile(canonical, 'utf8');
    const normalizedPath = path.relative(canonicalRoot, canonical).split(path.sep).join('/');
    const digest = createHash('sha256').update(content).digest('hex');
    const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    return {
      path: normalizedPath,
      title: heading || path.basename(canonical, path.extname(canonical)),
      content,
      sourceRef: {
        type: 'file',
        id: normalizedPath,
        digest: `sha256:${digest}`,
        occurredAt: info.mtime.toISOString(),
        trust: 'owner',
      },
    };
  }

  async search(query: string, limit: number): Promise<WorkspaceDocument[]> {
    const knowledge = path.join(this.root, 'knowledge');
    const candidates: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || entry.name === 'wiki' || entry.name === 'WIKI.md') continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(candidate);
        else if (entry.isFile() && /\.(?:md|txt)$/i.test(entry.name)) candidates.push(candidate);
        if (candidates.length >= 2_000) return;
      }
    };
    await visit(knowledge);
    const terms = query.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]/g) ?? [];
    const documents: WorkspaceDocument[] = [];
    let totalBytes = 0;
    for (const file of candidates) {
      const document = await this.read(path.relative(this.root, file));
      const bytes = Buffer.byteLength(document.content, 'utf8');
      if (totalBytes + bytes > 10_000_000) break;
      totalBytes += bytes;
      documents.push(document);
    }
    return documents.map((document) => {
      const text = `${document.title}\n${document.content}`.toLowerCase();
      const score = terms.length ? terms.filter((term) => text.includes(term)).length / terms.length : 0;
      return { document, score };
    }).filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ document }) => document);
  }
}
