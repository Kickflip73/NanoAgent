// Offscreen document for clipboard access (MV3 requirement)

chrome.runtime.onMessage.addListener((message: { type: string; text?: string }) => {
  if (message.type === 'COPY_TO_CLIPBOARD' && message.text) {
    navigator.clipboard.writeText(message.text).then(
      () => {
        console.log('[DevContext] Copied to clipboard');
        window.close();
      },
      (err) => {
        console.error('[DevContext] Clipboard failed:', err);
        window.close();
      }
    );
  }
  return true;
});
