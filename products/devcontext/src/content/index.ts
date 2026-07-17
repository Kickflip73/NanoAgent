// Content Script for DevContext
// Injected into every page to detect code elements and provide context

import type { CodeContext } from '../background/context';

interface ContextRequest {
  type: 'GET_CONTEXT';
  selectedText: string;
}

// --- Message Handler ---
chrome.runtime.onMessage.addListener((request: ContextRequest, _sender, sendResponse) => {
  if (request.type === 'GET_CONTEXT') {
    const context = gatherContext(request.selectedText);
    sendResponse({ context });
  }
  return true; // Keep channel open for async
});

function gatherContext(selectedText: string): Partial<CodeContext> {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return buildPageContext(selectedText);
  }

  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container.nodeType === Node.ELEMENT_NODE
    ? container as Element
    : container.parentElement;

  if (!element) return buildPageContext(selectedText);

  return {
    language: detectLanguageFromPage(element) ?? undefined,
    sourceUrl: window.location.href,
    sourceTitle: document.title,
    fileName: findFileName(element),
    lineCount: selectedText.split('\n').length,
    startLine: findStartLine(element),
    endLine: findEndLine(element, selectedText),
    repoInfo: detectRepoInfo(),
    surroundingCode: getSurroundingCode(element),
  };
}

function buildPageContext(text: string): Partial<CodeContext> {
  return {
    language: detectLanguageFromPage(document.body) || detectLanguageBasic(text),
    sourceUrl: window.location.href,
    sourceTitle: document.title,
    fileName: document.title,
    lineCount: text.split('\n').length,
    repoInfo: detectRepoInfo(),
  };
}

// --- Language Detection ---
function detectLanguageFromPage(el: Element): string | null {
  const codeBlock = el.closest('[data-language], [class*="language-"], [class*="lang-"]');
  if (codeBlock) {
    const dataLang = codeBlock.getAttribute('data-language');
    const classMatch = codeBlock.className.match(/language-(\w+)|lang-(\w+)/);
    return dataLang || classMatch?.[1] || classMatch?.[2] || null;
  }

  const langEl = el.closest('[itemprop="programmingLanguage"]');
  if (langEl) return langEl.textContent?.trim() || null;

  return null;
}

function detectLanguageBasic(code: string): string {
  if (/^(import|export|const|let|function|async)\s/m.test(code)) return 'typescript';
  if (/^(def |class |import |from )/m.test(code)) return 'python';
  if (/^(func |package )/m.test(code)) return 'go';
  if (/^(SELECT|INSERT|CREATE)/i.test(code)) return 'sql';
  return 'text';
}

// --- File Name Detection ---
function findFileName(el: Element): string {
  // GitHub
  const breadcrumb = el.closest('[data-path]') || document.querySelector('[data-path]');
  if (breadcrumb) {
    const path = breadcrumb.getAttribute('data-path') || '';
    return path.split('/').pop() || path;
  }

  const fileHeader = el.closest('.file-header') || document.querySelector('.file-header');
  if (fileHeader) {
    const name = fileHeader.querySelector('.file-info a, [data-testid="breadcrumbs-filepath"]');
    if (name) return name.textContent?.trim().split('/').pop() || 'unknown';
  }

  // GitLab
  const glFile = document.querySelector('.file-title-name');
  if (glFile) return glFile.textContent?.trim() || 'unknown';

  // Stack Overflow
  const title = document.querySelector('title');
  if (title) {
    const text = title.textContent || '';
    const match = text.match(/^(.+?)\s*[-|]\s*Stack Overflow/);
    if (match) return match[1].trim();
  }

  return document.title || 'unknown';
}

// --- Line Number Detection ---
function findStartLine(el: Element): number | undefined {
  const container = el.closest('.highlight, [class*="line"], .code, pre');
  if (!container) return undefined;

  const lineEls = container.querySelectorAll('[data-line-number], .line-number, .blob-num, [id^="L"]');
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;

  const range = selection.getRangeAt(0);
  for (let i = 0; i < lineEls.length; i++) {
    const lineEl = lineEls[i];
    if (range.startContainer.compareDocumentPosition(lineEl) & Node.DOCUMENT_POSITION_FOLLOWING ||
        lineEl.contains(range.startContainer) ||
        lineEl === range.startContainer.parentElement) {
      const num = parseInt(lineEl.getAttribute('data-line-number') || lineEl.textContent || '', 10);
      if (!isNaN(num)) return num;
    }
  }

  return undefined;
}

function findEndLine(el: Element, text: string): number | undefined {
  const startLine = findStartLine(el);
  if (startLine === undefined) return undefined;
  const lineCount = text.split('\n').length;
  return startLine + lineCount - 1;
}

// --- Repo Detection ---
function detectRepoInfo(): string | undefined {
  // GitHub
  const ghRepo = document.querySelector('[data-repo]') ||
    document.querySelector('meta[name="hovercard-subject-tag"]');
  if (ghRepo) {
    const repo = ghRepo.getAttribute('data-repo') || ghRepo.getAttribute('content');
    if (repo) return `github.com/${repo}`;
  }

  // GitHub URL parsing
  const ghMatch = window.location.href.match(/github\.com\/([^/]+\/[^/]+)/);
  if (ghMatch) return `github.com/${ghMatch[1]}`;

  // GitLab
  const glMatch = window.location.href.match(/gitlab\.com\/([^/]+(?:\/[^/]+){0,2})/);
  if (glMatch && document.querySelector('meta[property="og:site_name"][content="GitLab"]')) {
    return `gitlab.com/${glMatch[1]}`;
  }

  return undefined;
}

// --- Surrounding Code ---
function getSurroundingCode(el: Element): string | undefined {
  const pre = el.closest('pre');
  if (!pre) return undefined;

  const code = pre.textContent || '';
  if (code.length > 5000) {
    // Truncate to avoid too much data
    return code.slice(0, 5000) + '\n// ... (truncated)';
  }
  return code;
}
