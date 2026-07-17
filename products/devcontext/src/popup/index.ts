// Popup UI for DevContext
// Shows copy stats and history

interface HistoryEntry {
  text: string;
  url: string;
  title: string;
  timestamp: number;
}

document.addEventListener('DOMContentLoaded', async () => {
  const { history = [] } = await chrome.storage.local.get('history');
  const entries = history as HistoryEntry[];

  updateStats(entries);
  renderHistory(entries);

  document.getElementById('clearBtn')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await chrome.storage.local.set({ history: [] });
    renderHistory([]);
    updateStats([]);
  });
});

function updateStats(entries: HistoryEntry[]): void {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayCount = entries.filter(e => e.timestamp >= today.getTime()).length;
  const totalCount = entries.length;

  const todayEl = document.getElementById('copyCount');
  const totalEl = document.getElementById('totalCount');
  if (todayEl) todayEl.textContent = String(todayCount);
  if (totalEl) totalEl.textContent = String(totalCount);
}

function renderHistory(entries: HistoryEntry[]): void {
  const container = document.getElementById('historyList');
  if (!container) return;

  if (entries.length === 0) {
    container.innerHTML = '<p class="empty">No copies yet. Right-click code → "Copy with DevContext"</p>';
    return;
  }

  container.innerHTML = entries.slice(0, 20).map((entry) => {
    const time = formatTime(entry.timestamp);
    const preview = entry.text.slice(0, 80).replace(/\n/g, ' ');
    const domain = extractDomain(entry.url);

    return `
      <div class="history-item">
        <div class="history-meta">
          <span class="history-domain">${domain}</span>
          <span class="history-time">${time}</span>
        </div>
        <div class="history-preview" title="${escapeHtml(entry.text.slice(0, 200))}">
          ${escapeHtml(preview)}${entry.text.length > 80 ? '...' : ''}
        </div>
        <button class="history-copy" data-text="${escapeHtml(entry.text.slice(0, 500))}">
          📋 Copy again
        </button>
      </div>
    `;
  }).join('');

  // Add click handlers for copy buttons
  container.querySelectorAll('.history-copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-text') || '';
      await navigator.clipboard.writeText(text);
      btn.textContent = '✅ Copied!';
      setTimeout(() => { btn.textContent = '📋 Copy again'; }, 1500);
    });
  });
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return '';
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
