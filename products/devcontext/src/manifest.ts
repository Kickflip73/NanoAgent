import { ManifestV3Export } from '@crxjs/vite-plugin';

const manifest: ManifestV3Export = {
  manifest_version: 3,
  name: 'DevContext',
  version: '0.1.0',
  description: 'Right-click any code on the web, copy it with full context for AI coding assistants',
  permissions: ['contextMenus', 'storage', 'clipboardWrite', 'activeTab', 'offscreen'],
  host_permissions: ['<all_urls>'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'DevContext',
  },
  icons: {
    16: 'icons/icon16.svg',
    48: 'icons/icon48.svg',
    128: 'icons/icon128.svg',
  },
};

export default manifest;
