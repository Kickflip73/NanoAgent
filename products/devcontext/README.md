# DevContext

**Right-click any code on the web → copy with full context for AI coding assistants.**

Paste into Cursor, ChatGPT, Claude, Copilot — with language, file path, line numbers, repo info, and source URL.

## Why?

When you copy code from GitHub/Stack Overflow/docs into an AI coding assistant, you lose context. The AI doesn't know:
- What language it is
- What file it's from
- What repo/project it belongs to
- Where you found it

DevContext wraps every copy in a structured header, so the AI gets the full picture.

## Features

- ✅ Right-click any code selection → "Copy with DevContext"
- ✅ Auto-detects language, file name, line numbers, repo
- ✅ Works on GitHub, GitLab, Stack Overflow, and any code page
- ✅ Copy history with search
- ✅ Clean dark-themed popup

## Install (Dev)

```bash
npm install
npm run dev
# Load unpacked extension from dist/ in chrome://extensions
```

## Build

```bash
npm run build
```

## Tech Stack

- TypeScript
- Vite + @crxjs/vite-plugin
- Chrome Extension Manifest V3

## Roadmap

- [ ] v0.2: Settings page (custom format, default language)
- [ ] v0.3: AI-powered code explanation sidebar
- [ ] v0.5: Keyboard shortcut (Ctrl+Shift+C)
- [ ] v1.0: Pro tier — AI analysis, cloud sync, team sharing
