import type { MemoryDocument, MemoryRef, WikiLintIssue, WikiLintReport } from '../../core/memory.js';

function key(ref: MemoryRef): string {
  return `${ref.scope}:${ref.profileId ?? '-'}:${ref.id}`;
}

export function lintWiki(pages: readonly MemoryDocument[]): WikiLintReport {
  const issues: WikiLintIssue[] = [];
  const titles = new Map<string, MemoryDocument[]>();
  const titleSet = new Set(pages.map((page) => page.metadata.title.toLowerCase()));
  const linked = new Set<string>();
  for (const page of pages) {
    const candidates = [page.metadata.title, ...page.metadata.aliases];
    for (const candidate of candidates) {
      const normalized = candidate.toLowerCase();
      titles.set(normalized, [...titles.get(normalized) ?? [], page]);
    }
    for (const match of page.body.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g)) {
      const title = match[1]!.trim().toLowerCase();
      if (!titleSet.has(title)) issues.push({ code: 'broken-link', severity: 'warning', ref: page.ref, message: `断链：${match[1]}` });
      else linked.add(title);
    }
    if (!page.metadata.sourceRefs.length) issues.push({ code: 'missing-source', severity: 'error', ref: page.ref, message: '页面缺少 SourceRef' });
    if (page.stale && page.metadata.kind === 'source-summary') {
      issues.push({ code: 'stale-summary', severity: 'warning', ref: page.ref, message: '来源摘要已陈旧，需要重新编译' });
    }
    if (/(?:\bTODO\b|\bunknown\b|待确认|未知|未解决)/i.test(page.body)) {
      issues.push({ code: 'knowledge-gap', severity: 'warning', ref: page.ref, message: '页面包含明确的知识空洞或待确认结论' });
    }
  }
  for (const [title, matches] of titles) {
    const distinct = new Set(matches.map((page) => key(page.ref)));
    if (distinct.size > 1) {
      issues.push({ code: 'duplicate-title', severity: 'warning', message: `重复标题或别名：${title}` });
      const conclusions = new Set(matches.map((page) => page.body.replace(/\s+/g, ' ').trim().toLowerCase()));
      if (conclusions.size > 1) {
        issues.push({ code: 'cross-page-conflict', severity: 'warning', message: `同名主题存在不同结论：${title}` });
      }
    }
  }
  for (const page of pages) {
    if (pages.length > 1 && !linked.has(page.metadata.title.toLowerCase()) && !page.body.includes('[[')) {
      issues.push({ code: 'orphan', severity: 'warning', ref: page.ref, message: '页面没有入链或出链' });
    }
  }
  return { valid: !issues.some((issue) => issue.severity === 'error'), checked: pages.length, issues };
}
