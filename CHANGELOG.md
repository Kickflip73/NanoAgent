# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.4.0] - 2026-07-13 22:05

### Added

- installable `nano` executable with interactive, one-shot, help, and version modes
- `/status`, `/skills`, `/memories`, `/plan`, and `/retry` CLI commands
- `search_files`, `edit_file`, `move_file`, and `http_request` tools
- dedicated TypeScript build configuration and CLI regression tests

### Changed

- move slash-command routing from the CLI entrypoint into `commands.ts`
- package only the two built-in example Skills while preserving locally installed Skills

### Documentation

- document installation, PATH conflicts, commands, tools, build flow, and security boundaries

## [0.3.0] - 2026-07-13 21:51

### Added

- JSON-backed persistent sessions and CLI session management
- context trimming, lightweight history compaction, and dynamic instruction assembly
- cross-session memory tools for preferences, facts, decisions, and todos
- Markdown Skills with progressive loading
- stdio MCP server configuration and SDK-native tool discovery
- local RAG with optional OpenAI embeddings and lexical fallback
- per-session plans, JSONL traces, and retrieval evals
- example Skills, MCP configuration, knowledge documents, and eval cases

### Changed

- organize runtime state under `core/` and optional capabilities under `extensions/`
- render CLI events with low-saturation colors and terminal-friendly Markdown
- stream single-line answers incrementally instead of waiting for a newline
- limit npm packages to intentional project files

### Fixed

- preserve function-call/result pairs when trimming long conversations
- keep generated history summaries out of persistent sessions and clean legacy artifacts
- fall back to lexical RAG when the Embedding API is unavailable

### Documentation

- expand README with configuration, concepts, CLI behavior, and extension guides
- document architecture boundaries and context protocol invariants
- add contribution and security policies

## [0.1.0] - 2026-07-13 20:56

### Added

- publish NanoAgent learning example (@Kickflip73)
