// Background Service Worker for DevContext
// Handles context menu creation, code processing, and clipboard operations

import { formatContext, detectLanguage, extractCodeContext } from './context';

// --- Context Menu Setup ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'copy-with-context',
    title: '📋 Copy with DevContext',
    contexts: ['selection'],
    documentUrlPatterns: ['<all_urls>'],
  });

  chrome.contextMenus.create({
    id: 'copy-plain',
    title: '📋 Copy Code Only',
    contexts: ['selection'],
    documentUrlPatterns: ['<all_urls>'],
  });
});

// --- Context Menu Click Handler ---
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  const selectedText = info.selectionText;
  if (!selectedText || selectedText.length < 2) return;

  try {
    if (info.menuItemId === 'copy-with-context') {
      // Ask content script to gather context around selection
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GET_CONTEXT',
        selectedText,
      });

      const context = response?.context || buildFallbackContext(tab, selectedText);
      const formatted = formatContext(selectedText, context);
      await copyToClipboard(formatted);

    } else if (info.menuItemId === 'copy-plain') {
      await copyToClipboard(selectedText);
    }

    // Save to history
    await saveHistory({
      text: selectedText,
      url: tab.url || '',
      title: tab.title || '',
      timestamp: Date.now(),
    });

  } catch (err) {
    console.error('[DevContext] Error processing selection:', err);
    // Fallback: just copy the text
    try {
      await copyToClipboard(selectedText);
    } catch (_) {}
  }
});

// --- Clipboard ---
async function copyToClipboard(text: string): Promise<void> {
  // Use offscreen document for clipboard access in MV3
  await chrome.offscreen.createDocument({
    url: 'src/offscreen/clipboard.html',
    reasons: ['CLIPBOARD' as chrome.offscreen.Reason],
    justification: 'Copy formatted code context to clipboard',
  });

  await chrome.runtime.sendMessage({
    type: 'COPY_TO_CLIPBOARD',
    text,
  });

  await chrome.offscreen.closeDocument();
}

// --- History ---
interface HistoryEntry {
  text: string;
  url: string;
  title: string;
  timestamp: number;
}

async function saveHistory(entry: HistoryEntry): Promise<void> {
  const { history = [] } = await chrome.storage.local.get('history');
  const updated = [entry, ...history].slice(0, 100); // Keep last 100
  await chrome.storage.local.set({ history: updated });
}

function buildFallbackContext(tab: chrome.tabs.Tab, text: string) {
  const language = detectLanguage(text);
  const url = tab.url || '';
  return {
    language,
    sourceUrl: url,
    sourceTitle: tab.title || '',
    fileName: extractFileName(url),
    lineCount: text.split('\n').length,
  };
}

function extractFileName(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'unknown';
  } catch {
    return 'unknown';
  }
}
