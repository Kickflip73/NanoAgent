# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.11.4] - 2026-07-20 11:15

### Fixed

- harden unattended execution reliability (@Kickflip73)

## [0.11.3] - 2026-07-20 09:57

### Fixed

- bound duplicate execution and delivery (@Kickflip73)

## [0.11.2] - 2026-07-20 00:59

### Fixed

- prevent duplicate connector deliveries (@Kickflip73)

## [0.11.1] - 2026-07-20 00:25

### Fixed

- preserve completion evidence across resumed runs (@Kickflip73)

## [Unreleased]

### Changed

- harden unattended execution with secret-free Shell environments, full process-group cleanup, public-network-only HTTP requests, persistent Connector inbound ACKs, poison-row quarantine, provider-bound model preferences, build-aware Daemon upgrades, and per-attempt logical side-effect identities
- replace fixed-count stability patches with evidence-aware completion progress, immutable Event-to-Session binding, route-scoped Outbox lanes, prompt-budgeted briefings, protocol-preserving context compaction, and persisted Connector delivery receipts
- bound Completion Gate deferrals and model turns, keep pure answers out of execution gating, isolate stale Goal/Plan/recovery context, preserve delivery suppression across crash recovery, batch briefing/context protocol units, and prevent one blocked IM channel from holding up another
- disable the generic NapCat OneBot client after a remembered QQ account has an account-specific client, preventing a permanent duplicate reverse-WebSocket reconnect loop
- keep CLI submission and event streaming alive across transient IPC timeouts, reconcile ambiguous submissions by stable Event ID, and forbid detached Shell work that escapes task ownership
- require Completion Contracts for execution tasks, keep failed checks inside the current task, and reject terminal success unless real ledger receipts, artifacts, tests and Plan state satisfy every criterion; external actions require confirmed rather than accepted delivery
- unify active source, tools, scripts, configuration examples, launchd identifiers and OpenClaw bridge names under MimiAgent, with old data handled only by the one-way migration boundary
- remove QQ/WeChat UI automation from fresh default configuration and document background-only transports: Tencent iLink Bot for Weixin and authenticated NapCat/OneBot for personal QQ
- keep the macOS NapCat loader, Shell, OneBot state and guarded launcher in the owner-only MimiAgent runtime instead of QQ's App Sandbox container; suppress raw startup logs, migrate duplicate OneBot entries, clear stale QR images before every start, and enable remembered-account quick login only for an exact NapCat-supported QQ build/architecture
- preserve QQ user/group/message identifiers as strings and add bounded recent-conversation, directory and friend/group history actions to the NapCat connector
- require OpenClaw Weixin readiness to verify both the Tencent channel account and the MimiAgent bridge, and expose a background health action
- add bounded local OpenClaw Weixin inbound-history recovery for messages retained in current or deleted session archives without claiming an upstream Tencent history API
- route OpenClaw Weixin through the inbound-only `inbound_claim` hook (instead of outbound `before_dispatch`), accepting account/sender fields from event or context, text-part bodies, and an explicit account fallback
- normalize legacy cross-provider assistant message IDs before OpenAI Responses calls, keep HTTP tool schemas portable across strict providers, and treat terminal provider 4xx responses as single-attempt background failures instead of quota-consuming retry storms
- replace the global single-Agent execution lane with keyed Session actors: the same Session remains FIFO while different Sessions run concurrently under `MIMI_SESSION_MAX_CONCURRENCY`
- keep one persistent Kernel as the owner of event durability, scheduling, Attention, Connector brokering and Outbox delivery; idle maintenance does not call the model
- restore the original CLI expectation that authenticated local owner General/Ultra runs have Shell and full built-in execution by default; migrate the legacy template's implicit workspace value, keep Plan and unmatched external events restricted, expose effective execution access in `/status`, and compare the daemon's reported permission so an idle old worker or stale launchd plist is safely replaced
- treat Event `trust` strictly as provenance: source policies now use fixed `reply` or `work` access (legacy omissions default to `reply`), and durable background tasks recompute that authority from a retained conversation root while malformed roots fail closed
- let authenticated owner runs use configured Connector actions and explicitly trusted MCP tools without switching the unrelated local file/Shell permission mode; make `/tools` reflect the complete permission-filtered Daemon Host/MCP catalog; enable the native WeChat sender on fresh macOS initialization and wait for cold-started WeChat UI readiness when Accessibility is available
- keep `connector_action` schemas compact and discover dynamic channel catalogs through exact Connector or keyword-filtered `inspect_mimi_capabilities` queries, avoiding repeated multi-kilobyte tool descriptions
- make the native WeChat sender honor daemon transaction deadlines, terminate timed-out AppleScript work, and verify that the editor cleared before recording a send as successful; migrate legacy 30-second WeChat timeouts and add missing default macOS connectors without enabling credential-backed channels
- dead-letter uncertain Connector deliveries on the first failed attempt instead of automatically retrying a message whose remote side effect may already have occurred
- treat expired `sending` leases as uncertain crash outcomes and dead-letter them atomically; extend the normal Outbox lease beyond every built-in delivery timeout so a live slow send cannot be reclaimed by another worker
- bound system notification delivery, gate daemon shutdown against Connector/Attention management mutations, and require launchd credentials to exist in the persisted environment file instead of accepting a shell-only key
- protect native MCP transport calls with the Daemon execution ledger and invalidate SDK tool caches on hot reload, so successful or uncertain external transactions are not silently repeated
- preserve every resolved non-secret runtime setting across detached and launchd starts, and upgrade an idle same-workspace legacy Daemon before a CLI reuses it while retaining an installed launchd supervisor
- migrate a legacy built-in Connector command from bare `node` to the packaged absolute Node executable when its script identity still matches, while preserving owner-custom commands; this prevents launchd `ENOENT` restart loops
- migrate the exact legacy `macos-system` provenance defaults to `source=macos-system` and `trust=system`, so its local health events receive the intended bounded recovery tools
- distinguish Connector process liveness from inbound/outbound readiness, including explicit unconfirmed UI-automation delivery
- unify interactive and one-shot usage with MimiAgent Daemon and its durable Owner Session; remove the parallel in-process CLI path and expose only the `mimi` command
- proxy the original MimiAgent session, model, mode, Skill, MCP, Memory, Plan and Goal CLI controls to the same daemon-owned Agent
- add non-sending Daxiang and QQ health actions that distinguish configured outbound APIs from missing inbound callback/WebSocket paths
- rename the product and primary package/CLI/API to MimiAgent, with canonical `MIMI_*` configuration and `MIMI.md`; retain the `MimiAgent` API alias, `AGENT_*`/`JARVIS_*`, `MIMI.md` and safe legacy data-directory compatibility, while removing the old `mimi-agent` shell alias
- keep `workspace` and `read-only` as explicit fail-closed deployment profiles and apply event policy to Host-provided tools
- make CLI commands and Daemon events share one serialized `MimiHost`, one `CommandHandler`, and FileSession as the only transcript truth
- extract a shared AgentRunService and provider bootstrap so interactive CLI and headless events use the same durable run lifecycle
- retain event-scoped semantic side-effect ledgers until the durable event transaction commits, preventing changed SDK call IDs from replaying successful actions after a crash
- persist deferred model, mode, output and Session RuntimeActions in completion receipts and replay their effects at most once after a daemon crash
- bound default CLI snapshots, page complete canonical history and Memory with revision checks, and keep Event/Run/Outbox/Schedule list RPCs on compact summaries with explicit detail lookup
- authenticate QQ/NapCat reverse WebSocket upgrades, separate optional HTTP/WS credentials, enforce one upstream and bound inbound frames
- ignore empty Mimi/Nano migration residue while still rejecting two populated runtime roots
- reject symlinks for automatically discovered workspace and daemon state roots
- forward live Plan updates and terminal RuntimeEffects from the daemon-owned Agent to the default CLI
- remove the unused Approval/Mandate execution path and keep its minimal schema through v6 while preserving legacy tables during upgrades

### Added

- add optional durable Codex CLI task execution with progress, cancellation and same-Event fallback to Mimi for independent completion-gate verification
- add a digest-verified, build-gated and reversible macOS NapCat CLI installer with owner-only OneBot configuration, a background LaunchAgent, persistent private-QQ selection, Tencent Team ID/Apple execution-policy verification before patching, ad-hoc signing of only the patched copy, a prohibited Electron activation policy, and guards that refuse to launch while either system/private ordinary QQ is running or after an upgrade resets the managed entry
- migrate exact legacy Mimi OneBot HTTP/reverse-WS names to one canonical entry so upgrades cannot bind the same loopback port twice
- add durable background-task delegation with isolated Task Sessions, bounded OS child-process workers, safe-point pause/resume/cancel controls, persistent blocked-input requests and `/tasks` / `/task` management; write tasks run workspace-exclusively, read tasks may run concurrently, and completion or required-input prompts return through the existing Outbox path without blocking the originating conversation
- persist running Task pause/cancel intent before acknowledging it, so lost worker IPC or a Kernel restart cannot replay cancelled work or forget a requested pause; cancel takes precedence and recovery settles at a safe durable state
- authenticate OpenClaw Weixin owner traffic with an exact `ownerSenders` allowlist instead of treating channel pairing as owner identity
- add conversation-controlled, auto-expiring Attention snooze for deferring non-urgent autonomy and scheduled briefings
- route voice wake-command results through the reliable Connector Outbox, read bounded replies aloud without self-wakeups, and persist listener enablement across restarts
- add conversation-controlled persistent clipboard change sensing to the macOS Desktop Connector
- add the MimiAgent long-running daemon with SQLite WAL inbox/outbox, leases, retries, schedules, run audit, Unix Socket control and macOS launchd installation
- add per-event provenance with external/public isolation from Session history, Memory, local files, Shell, MCP and external writes
- add durable completed-execution receipts so a crash between Session completion and Event/Outbox commit does not repeat the model run
- add isolated NDJSON child-process Connectors and a localhost-only authenticated Webhook for IM, news, weather and automation sources
- add proactive system/connector notifications with durable delivery acknowledgements
- add configurable MimiAgent attention policies with quiet hours, autonomous-run budgets, ordered source rules, durable digest items and proactive scheduled briefings
- add conversation-triggered immediate briefings over the same atomic digest, event and delivery path
- add self-wakeup tools for one-time follow-ups and bounded recurring routines, with inherited sessions, durable schedules and semantic retry deduplication
- add self-closing conditional watches that keep advancing a matter until its explicit completion condition is met
- wake conditional watches immediately on related Session events while retaining interval fallback and resolved cross-channel context
- add bounded same-Session activity recovery from existing Event and Run records without duplicating workflow state
- allow same-Session owner corrections to interrupt and cancel superseded active work
- unify each owner profile across CLI and authenticated Connector sessions, with direct commands treated as urgent
- route proactive work to each profile's recent owner Connector with bounded expiry and configured fallback
- invalidate a profile's failed recent Connector route atomically with terminal Outbox fallback
- archive queued schedule occurrences atomically when their schedule is cancelled
- add a compact daemon execution contract that consistently drives direct action, durable follow-up, memory and quiet completion
- add Connector Action Bridge request/result messaging, capability discovery and active Daxiang/QQ message sending
- add a dependency-free macOS life connector for Calendar, Reminders and notifications, with proactive upcoming, changed, deleted, completed and urgent overdue events plus meeting preparation/follow-up execution guidance
- add a dependency-free information radar connector for bounded RSS/Atom polling, Open-Meteo threshold events and on-demand snapshots
- add a dependency-free file activity radar for bounded metadata-only polling of Downloads, shared inboxes and automation outputs
- turn File Radar into an actionable inbox with two-scan file stability, direct processing guidance and follow-up extraction
- add a dependency-free Apple Mail connector for unread events, reading, sending, replying, read state and drafts
- add bounded Apple Mail attachment metadata, atomic explicit saves, and local-file attachments for send, draft and reply workflows
- add bounded Apple Mail inbox search, recursive mailbox discovery, flags, explicit moves and deletion for autonomous inbox triage
- make Apple Mail unread events immediately actionable with full-message/attachment triage, direct reply/organization guidance and reply watches
- add a lightweight macOS Messages connector for read-only incoming/history access and JXA-based iMessage, SMS and RCS sending
- add bounded Messages attachment metadata, atomic explicit saves, and native file sending for action and Outbox workflows
- make Messages inbound events reply-safe transactions with contextual history, silent no-op handling, duplicate-reply prevention and follow-up watches
- add a dependency-free macOS Contacts connector for contact resolution, details, creation and incremental updates
- add a dependency-free Apple Notes connector for folders, bounded search/read, creation, replacement and append workflows
- add a dependency-free macOS Shortcuts connector for discovering and running existing personal automations with bounded text, binary and file IO
- add durable Connector outage and stable-recovery events with restart-flap suppression and Attention-aware owner notifications
- turn trusted Connector and macOS resource alerts into bounded self-healing transactions with recovery watches and uncertain-action replay protection
- add a dependency-free macOS desktop connector for app/window context, clipboard awareness, application activation, opening items, menus and keyboard control
- add hot-reloadable daemon Standing Orders with bounded global and source/kind/actor/conversation-specific substitute-decision policies
- add a dependency-free Safari/Chrome connector for authenticated tab discovery, navigation, bounded page text and JavaScript DOM actions
- add a native macOS screen connector for bounded screenshots and local Vision OCR without continuous recording or image history
- add a native macOS voice connector for wake-phrase owner commands, bounded audio transcription and echo-suppressed system speech
- add timezone-aware Daily Routines with weekday filters, startup catch-up and event-key idempotency for proactive owner workflows
- add autonomous long-term memory for durable owner preferences, facts, decisions and commitments, with run provenance, legacy isolation and bounded storage
- add owner-managed cross-channel people aliases with stable Person sessions, trusted relationship context and person-aware memory recall
- add idempotent MimiAgent first-run initialization with absolute packaged Connector paths, open-by-default native macOS capabilities, owner-config preservation and a read-only `daemon doctor` covering live Connector outages and dead letters
- add a zero-dependency macOS system Connector for bounded battery, memory, load, network and storage snapshots plus proactive low-resource and connectivity events
- complete the macOS life transaction loop with stable-ID Calendar and Reminders update/delete actions, bounded fields and no-replay semantics
- add atomic, opt-out Connector action catalog upgrades so existing installations gain new built-in capabilities without overwriting owner runtime settings
- add explicit in-process Connector hot reload with validate-before-swap, in-flight transaction protection and stale notification route cleanup
- add safe urgent-event preemption for long-running daemon work while preserving single-Agent execution and in-flight tool transactions
- add explicit same-ID retry and archival controls for Event and Outbox dead letters without automatic replay or approval layers
- add bounded MimiAgent runtime self-inspection shared by proactive Agent routines and the daemon activity CLI/RPC
- add dynamic bounded Connector capability inspection and online/offline/disabled action discovery for autonomous channel selection
- add explicit Apple Mail historical-mailbox search and reusable source locators for read, attachment, reply, flag, move and delete workflows
- add an owner default reply route so autonomous results, briefings, routines and follow-up schedules can reliably reach a concrete Connector conversation
- add authenticated callback-relay reply routing with actor/conversation provenance, Connector targets, durable deduplication and explicit no-reply semantics
- add auditable silent completion for no-change autonomous checks while structurally preserving replies for direct commands
- add conversational Daily Routine listing, atomic upsert and removal without manual assistant configuration edits
- invalidate queued Daily Routine triggers before execution when their configuration is changed, disabled or removed
- add a zero-dependency generic HTTP Connector for cursor-based event intake, closed-loop replies and arbitrary external service transactions
- add conversational atomic enable/disable control for configured Connectors without exposing credentials or process configuration
- add conversational Standing Order listing, idempotent addition and removal with immediate daemon decisions
- add conversational source-, kind-, actor- and conversation-scoped policy management with atomic stable-ID updates
- add conversational cross-channel People listing, atomic upsert and removal with immediate identity resolution
- add conversational ordered Attention rule management for immediate run, digest, notify and ignore classification
- add conversational full-snapshot MimiAgent settings management without overwriting independently managed daemon domains
- add Agent-triggered Connector hot reload with discoverable config paths and existing in-flight transaction protection
- add atomic dead-letter escalation for failed events and non-system deliveries with bounded, non-recursive system fallbacks
- add a hot-reloadable Agent idle watchdog and retry-free graceful daemon shutdown recovery
- add schema v6 indexed history retention with active/dead-letter reference protection and low-frequency dispatcher maintenance

## [0.11.0] - 2026-07-14 18:16

### Added

- harden local agent runtime and orchestration (@Kickflip73)

## [0.10.1] - 2026-07-14

### Added

- add cross-process atomic JSON state, corruption quarantine, run ownership CAS, and an at-most-once ledger for local side-effect tools
- add workspace/read-only/trusted local permission profiles with workspace-safe defaults and Team builder path confinement
- add the conflict-free `mimi-agent` executable, clean builds, direct OpenAI dependency, coverage command, and Node 22 CI
- persist per-session run checkpoints so interrupted, failed, and process-exited tasks can resume from their latest recorded phase
- add layered context management with tool-result microcompaction, persistent context collapse, `/compact`, and final complete-turn truncation
- show recoverable sessions and detailed raw/effective/archive context usage in the CLI

### Changed

- position MimiAgent as both a lightweight general local Agent product and a reusable bounded multi-Agent orchestration framework
- make `/resume` explicitly best-effort, split runtime component initialization and Session-state rendering, and prevent cancelled SDK streams from being marked completed
- make Team waves atomically claim 1–4 ready tasks, require explicit retry after orphaned leases, and remove unsandboxed Shell from workers
- make `/resume` combine automatic run progress with Goal, Plan, and Ultra Team state instead of requiring a Goal
- preserve the full SDK transcript as the audit archive while compacting only the model-facing context view
- start interactive `nano` sessions in a new conversation by default unless `AGENT_SESSION` is explicitly set
- show up to five recent conversations in the startup selector for quick continuation
- open the recent-conversation selector on startup so ↑↓ and Enter can continue a previous session immediately
- persist mode, model and output level per session so switching conversations restores isolated runtime state
- stream Ultra Team worker creation, task assignment, completion summaries and failures into the terminal event flow
- show per-session long-running task plans and current progress directly above the interactive input
- unify startup and conversation switching through one complete session-state restoration path
- inject current session and plan progress into every model turn and require stage-by-stage task status updates
- support multiline editing, safe bracketed paste, Shift+Enter newlines and Command+arrow line navigation
- derive concise session titles from substantive conversation content and order history by latest activity
- use `deepseek-v4-pro` as the default DeepSeek model and list both V4 Pro and V4 Flash in the model selector
- repair duplicate tool results as well as dangling calls before resuming persisted sessions
- bind every active run, event, checkpoint, plan/team store and deferred action to its starting session; gate cross-session listing and long-term-memory writes on explicit user intent
- drive context windows and output reserves from per-model profiles, enforce a complete request budget, and report provider usage separately from local estimates
- block file, shell and RAG access to private runtime data; stop automatic global RAG injection and quarantine unconfirmed legacy memories
- isolate terminal input history and retry state per session, leaving explicit long-term memory as the only cross-session conversation channel

### Fixed

- append interactive streamed answer chunks at their real display column instead of the terminal edge, preventing huge gaps and unexpected wraps between chunks

## [0.10.0] - 2026-07-14

### Added

- add a lightweight Ultra Team runtime with five worker roles, persistent per-session task lists, dependencies, atomic claims, partial-failure reporting, and bounded concurrency
- add deterministic builder path-overlap protection, Team lifecycle traces, `/team`, resume context, and configurable `TEAM_MAX_CONCURRENCY`
- add Plan-mode tool policy, Team store/concurrency regressions, and a real Ultra Team Agent behavior eval

### Changed

- replace the four cosmetic presets with three capability-aware modes: General, read-only Plan, and Ultra Team
- scope SubAgent tools by mode and expose a read-only architect in Plan and Ultra
- document the mode contract, orchestration lifecycle, safety invariants, configuration, and extension boundaries

## [0.9.0] - 2026-07-14

### Added

- expose model, mode, output, Session, history, runtime status, and MCP lifecycle controls as Agent-callable tools
- defer destructive Session and terminal changes until the active turn is fully persisted
- expose both workspace and MimiAgent runtime roots so the Agent can inspect and modify its own code with existing file and Shell tools

## [0.8.0] - 2026-07-14

### Added

- add user-level `~/.mimi-agent/MIMI.md` and project-level `<workspace>/MIMI.md` persistent instructions
- reload both instruction files before every Agent turn, with explicit project-over-user precedence
- add `/instructions` discovery and truncation status plus a project `MIMI.md` example

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

- reposition MimiAgent as a lightweight general-purpose Agent for real work rather than an educational-only example
- split model creation, instructions, hooks, and the Agent composition root into `runtime/`
- make context trimming token-aware and replace raw JSON history snippets with structured summaries
- keep complete conversation turns within the context budget and reserve output capacity
- add a local `web_search` implementation for DeepSeek while retaining OpenAI hosted search
- reuse RAG indexes and embeddings when their content and model are unchanged
- update README, architecture, contribution guide, MCP examples, and package metadata for the new runtime

### Fixed

- prevent one unavailable MCP Server from blocking MimiAgent startup
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

- publish MimiAgent learning example (@Kickflip73)
