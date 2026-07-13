# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.9.0] - 2026-07-14

### Added

- expose model, mode, output, Session, history, runtime status, and MCP lifecycle controls as Agent-callable tools
- defer destructive Session and terminal changes until the active turn is fully persisted
- expose both workspace and NanoAgent runtime roots so the Agent can inspect and modify its own code with existing file and Shell tools

## [0.8.0] - 2026-07-14

### Added

- add user-level `~/.nano-agent/NANO.md` and project-level `<workspace>/NANO.md` persistent instructions
- reload both instruction files before every Agent turn, with explicit project-over-user precedence
- add `/instructions` discovery and truncation status plus a project `NANO.md` example

## [0.7.1] - 2026-07-14

### Fixed

- replay persisted user and assistant messages after `/sessions` and `/switch`
- restore the active session transcript on startup, with the newest messages above the bottom input area
- keep tool calls and raw tool results out of the normal conversation replay

## [0.7.0] - 2026-07-13

### Added

- add Agent Skills-compatible YAML validation, resource roots, safe resource loading, diagnostics, and hot reload
- add MCP Streamable HTTP, `mcpServers` compatibility, environment-backed headers, failure isolation, status, reload, and Resources
- add durable Goal, checkpoint, next action, `/goal`, and `/resume` on top of the existing Plan store
- add bounded researcher and reviewer SubAgents through Agents SDK `Agent.asTool()`
- add lightweight runtime lifecycle Hooks and SubAgent trace events
- add memory importance/source metadata and incremental hybrid RAG retrieval
- add MCP, Skill resource, Goal, SubAgent, and Hook regression tests
- add serialized local state writes, bounded trace rotation, and executable Agent behavior evals

### Changed

- reposition NanoAgent as a lightweight general-purpose Agent for real work rather than an educational-only example
- split model creation, instructions, hooks, and the Agent composition root into `runtime/`
- make context trimming token-aware and replace raw JSON history snippets with structured summaries
- keep complete conversation turns within the context budget and reserve output capacity
- add a local `web_search` implementation for DeepSeek while retaining OpenAI hosted search
- reuse RAG indexes and embeddings when their content and model are unchanged
- update README, architecture, contribution guide, MCP examples, and package metadata for the new runtime

### Fixed

- prevent one unavailable MCP Server from blocking NanoAgent startup
- retain healthy MCP connections when a hot reload contains an invalid or unavailable replacement
- prevent Skill resources from escaping their root through traversal or symbolic links
- preserve legacy Plan JSON while migrating sessions to Goal-aware task state

## [0.6.0] - 2026-07-13 23:06

### Added

- add standard, planning, coding, and research presets through `/mode`
- add four lightweight `/output` event visibility levels from final-answer-only to full tool traces
- add configurable terminal event visibility (@Kickflip73)

### Changed

- keep the dashed single-line input box at the bottom, separate from runtime status
- replace transient queue counts with persistent one-line queued conversation previews
- simplify the startup header and add an animated runtime bar with mode, model, and context usage
- guide model responses toward compact terminal-first prose and defensively collapse excessive whitespace
- preserve every submitted user message in the terminal transcript when execution begins

## [0.5.0] - 2026-07-13 22:28

### Added

- Esc cancellation backed by SDK abort signals
- non-blocking FIFO input queue while an Agent task is running
- interactive slash-command completion and session picker
- `/model` runtime model selector plus `/context`, `/tools`, and `/mcp` inspection commands
- compact robot project banner with model, conversation, extension, and workspace details
- expanded interactive controls and navigation (@Kickflip73)

### Changed

- derive session titles and recent previews from conversation content
- clear the terminal after `/new`, `/clear`, and session switches
- restore the project banner after clearing or creating a conversation
- use a solid black cursor for active command, model, and session selections

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
