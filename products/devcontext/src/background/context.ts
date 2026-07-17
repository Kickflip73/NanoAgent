// Code context detection and formatting

export interface CodeContext {
  language: string;
  sourceUrl: string;
  sourceTitle: string;
  fileName: string;
  lineCount: number;
  startLine?: number;
  endLine?: number;
  repoInfo?: string;
  surroundingCode?: string;
}

/**
 * Detect programming language from code snippet using heuristics.
 */
export function detectLanguage(code: string): string {
  const patterns: [RegExp, string][] = [
    [/^(import|export|const|let|var|function|async|await)\s/m, 'typescript'],
    [/^(def |class |import |from |if __name__)/m, 'python'],
    [/^(func |package |import \(|go )/m, 'go'],
    [/^(public class|private |protected |import java)/m, 'java'],
    [/^(#include|int main|printf)/m, 'c/c++'],
    [/^(<\?php|namespace |use )/m, 'php'],
    [/^(\s*\.\w+\s*\{|@import|@include)/m, 'css/scss'],
    [/^(<template>|<script>|export default)/m, 'vue'],
    [/^(import React|useState|useEffect|jsx)/m, 'tsx'],
    [/^(require\(|module\.exports)/m, 'javascript'],
    [/^(SELECT |INSERT |UPDATE |CREATE TABLE)/i, 'sql'],
    [/^(#!\/bin\/|^[a-z]+=|^if \[\[)/m, 'shell'],
    [/^(\.\.\.|#{1,6} |\[.*\]\(.*\))/m, 'markdown'],
    [/^(<[a-zA-Z]+|<\/[a-zA-Z]+)/m, 'html'],
    [/^(---\n|apiVersion:|kind:)/m, 'yaml'],
  ];

  for (const [pattern, lang] of patterns) {
    if (pattern.test(code.trim())) return lang;
  }

  return 'text';
}

/**
 * Extract code context from a page element and surrounding nodes.
 */
export function extractCodeContext(
  element: Element,
  selectedText: string
): Partial<CodeContext> {
  const context: Partial<CodeContext> = {};
  const doc = element.ownerDocument;

  // Detect language from the page
  context.language = detectLanguageFromPage(element, doc) || detectLanguage(selectedText);

  // Try to get file name from breadcrumbs, title, or path
  context.fileName = findFileName(element, doc);

  // Try to find line numbers
  const lineInfo = findLineNumbers(element);
  if (lineInfo) {
    context.startLine = lineInfo.start;
    context.endLine = lineInfo.end;
    context.lineCount = lineInfo.end - lineInfo.start + 1;
  } else {
    context.lineCount = selectedText.split('\n').length;
  }

  // Detect repo info (GitHub, GitLab, etc.)
  context.repoInfo = detectRepoInfo(doc);

  return context;
}

function detectLanguageFromPage(el: Element, doc: Document): string | null {
  // Check data attributes and classes
  const codeBlock = el.closest('[data-language], [class*="language-"], [class*="lang-"]');
  if (codeBlock) {
    const dataLang = codeBlock.getAttribute('data-language');
    const classMatch = codeBlock.className.match(/language-(\w+)|lang-(\w+)/);
    return dataLang || classMatch?.[1] || classMatch?.[2] || null;
  }

  // Check for GitHub-style language indicators
  const langEl = el.closest('[itemprop="programmingLanguage"]');
  if (langEl) return langEl.textContent?.trim() || null;

  return null;
}

function findFileName(el: Element, doc: Document): string {
  // GitHub: file header breadcrumb
  const breadcrumb = el.closest('[data-path]') || doc.querySelector('[data-path]');
  if (breadcrumb) {
    const path = breadcrumb.getAttribute('data-path');
    if (path) return path.split('/').pop() || path;
  }

  // GitHub: file header
  const fileHeader = el.closest('.file-header') || doc.querySelector('.file-header');
  if (fileHeader) {
    const name = fileHeader.querySelector('.file-info a, [data-testid="breadcrumbs-filepath"]');
    if (name) return name.textContent?.trim().split('/').pop() || 'unknown';
  }

  // Stack Overflow: question title
  const title = doc.querySelector('title');
  if (title) {
    const text = title.textContent || '';
    const match = text.match(/^(.+?)\s*[-|]\s*Stack Overflow/);
    if (match) return match[1].trim();
  }

  // Fallback: page title
  return doc.title || 'unknown';
}

function findLineNumbers(el: Element): { start: number; end: number } | null {
  // Look for line number elements near the selection
  const container = el.closest('.highlight, [class*="line"], .code, pre, .react-code-lines');
  if (!container) return null;

  const lineEls = container.querySelectorAll('[data-line-number], .line-number, .blob-num, [id^="L"]');
  if (lineEls.length === 0) return null;

  // Find the first and last line numbers based on selection range
  const selection = el.ownerDocument?.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const startLine = findClosestLine(range.startContainer, lineEls);
  const endLine = findClosestLine(range.endContainer, lineEls);

  if (startLine && endLine) {
    return { start: startLine, end: endLine };
  }

  return null;
}

function findClosestLine(node: Node, lineEls: NodeListOf<Element>): number | null {
  for (let i = 0; i < lineEls.length; i++) {
    const lineEl = lineEls[i];
    const num = parseInt(lineEl.getAttribute('data-line-number') || lineEl.textContent || '', 10);
    if (!isNaN(num) && lineEl.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      return num;
    }
  }
  return null;
}

function detectRepoInfo(doc: Document): string | undefined {
  // GitHub
  const ghRepo = doc.querySelector('[data-repo]') || doc.querySelector('meta[name="hovercard-subject-tag"]');
  if (ghRepo) {
    const repo = ghRepo.getAttribute('data-repo') || ghRepo.getAttribute('content');
    if (repo) return `github.com/${repo}`;
  }

  // GitLab
  const glProject = doc.querySelector('meta[property="og:site_name"][content="GitLab"]');
  if (glProject) {
    const url = doc.querySelector('meta[property="og:url"]')?.getAttribute('content');
    if (url) {
      const match = url.match(/gitlab\.com\/(.+?)(\/-\/|\/blob|$)/);
      if (match) return `gitlab.com/${match[1]}`;
    }
  }

  return undefined;
}

/**
 * Format the code with context into a structured block ready for AI assistants.
 */
export function formatContext(code: string, context: Partial<CodeContext>): string {
  const lang = context.language || 'text';
  const source = context.sourceUrl || '';
  const file = context.fileName || '';
  const title = context.sourceTitle || '';
  const repo = context.repoInfo || '';
  const lines = context.startLine
    ? `L${context.startLine}-L${context.endLine || context.startLine}`
    : '';

  const header: string[] = [];
  if (file) header.push(`// 📄 ${file}`);
  if (lang) header.push(`// 🔤 Language: ${lang}`);
  if (lines) header.push(`// 📍 Lines: ${lines}`);
  if (repo) header.push(`// 📦 Repo: ${repo}`);
  if (source) header.push(`// 🔗 Source: ${source}`);
  if (title) header.push(`// 📝 Page: ${title}`);

  const headerBlock = header.join('\n');
  const separator = '\n\n';

  return `${headerBlock}${separator}\`\`\`${lang}\n${code.trim()}\n\`\`\``;
}
