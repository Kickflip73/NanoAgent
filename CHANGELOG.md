# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Unreleased

- query retained conversation, background and scheduled results through one
  owner-scoped `task_history` tool, including observed file references and explicit
  pagination; reuse existing outputs without interpreting a lookup miss as a new task
- preserve bounded, redacted tool progress in Session checkpoints across interrupted
  attempts; show unfinished-run facts for model-decided conversational continuation
- classify nonzero process exits and structured failures by their actual result,
  not by whether the tool Promise resolved; keep finalization manifests consistent
- persist speech render receipts and audio IDs across runtimes, play existing audio
  files without synthesis, coalesce identical generation requests, and expose
  uncertain status instead of duplicating a timed-out render; clean owned command
  process groups on completion, timeout and cancellation

- resume the original conversation after newly delegated background work completes,
  so Mimi can inspect results and arrange requested follow-ups before reporting
- persist schedule workspace/context and the last outcome, and coalesce checks
  while an earlier occurrence remains outstanding (backed-up SQLite v17 migration)
- add `mimi daemon usage [days]` and model-readable usage statistics, distinguishing
  conversations, background tasks, scheduled checks, retries, latency and missing Token samples
- keep status probes lightweight, avoid write locks in idle task polling, and
  recognize real SDK connection errors for bounded retry
- remove mandatory Goal/Plan setup for simple background work; keep durable
  completion contracts for complex or resumed Goals

- keep every natural-language request on the main model path while making common
  file, shell, Web, Browser, Computer, artifact, and Memory tools direct and
  discovering lower-frequency capabilities on demand without injecting the full
  Skill catalog or broad Personal Context into every new turn
- normalize native Provider tool results, turn SDK-captured tool exceptions into
  structured failures recorded as failed by the execution ledger, and make
  `/clear` remove derived context snapshots, artifacts, archives, and manifests
- make fresh proactive configuration quiet by default, bound scheduled Routine
  and Briefing catch-up to 15 minutes, soften unknown optional Computer readiness,
  and give LaunchAgent plists atomic per-data-root ownership
- add an isolated 20-case real-model daily-usability canary covering answers,
  files, shell, Web, failures, memory, sessions, mode changes, Skills, and Plan
- stop rendering every SDK reasoning item as a misleading completed reasoning
  phase while preserving those events as Daemon run-liveness progress
- keep complementary tool results lossless throughout the active user turn while
  the request fits the model budget, preventing alternating rediscovery loops
  caused by eagerly replacing already-consumed evidence with partial summaries
- preserve OpenAI-compatible `reasoning_content` across streamed tool-call
  continuations so thinking-mode providers do not reject the follow-up request;
  normalize every Chat Completions request at the adapter boundary, including
  same-Run tool continuations, merge SDK-split assistant preambles back into
  their reasoning/tool-call message, and retain empty or answer-only reasoning
  required by Providers on later requests
- recover forward-compatible Session finalization evidence, count pre-dispatch
  failures as known zero-token runs, and reclassify retained historical task
  dead letters so they no longer block Briefing-driven Digest consumption
- always release a Session's in-memory and process-level Run ownership when
  failure-finalization persistence throws, so later owner input is not blocked
  by a task that has already stopped
- keep delayed streamed GFM rows inside their table, wrap wide cells to the
  terminal width, and preserve forward-compatible run-finalization fields when
  switching between builds instead of quarantining a valid commit journal
- let authenticated local Full Owner conversations execute `run_shell` directly
  on the Host so user-level `launchctl` and other native service operations are
  not rejected by Darwin Seatbelt, while restricted sources keep the sandbox
- make exact capability inspection return structured direct, deferred,
  source-mismatch, or unavailable states instead of turning recoverable routing
  mistakes into failed tool calls, and only instruct the model to use Browser
  tools when they are visible in the current Run
- refresh the TUI busy footer on its own timer so the Mimi animation and elapsed
  duration advance without requiring new streamed conversation output
- add native local speech primitives for voice discovery, ChatTTS/Kokoro
  synthesis, ordered playback, and direct speaking, exposed through Host APIs,
  and one compact model tool backed by a single managed renderer without
  rewriting caller text or falling back to TTS scripts and Skills; expose stable
  a curated allowlist of ten ChatTTS/Kokoro voices, including validated
  young/lively and mature/steady female voices,
  with per-call switching and a male default;
  resolve mixed Chinese/Latin auto routing to ChatTTS before invoking the renderer
- reorder the interactive status footer to show mode, effective Security profile,
  model, and context usage; make Shift+Tab cycle a real per-run Security ceiling,
  add mode cycling through terminal-reported Shift+Caps Lock with Shift+Up fallback,
  and make a single Esc immediately cancel the active conversation
- keep raw-mode TTY output aligned with explicit terminal newlines, redraw the
  bottom input panel relative to its tracked cursor after scrolling, avoid the
  duplicate startup frame, dynamically reflow long input across multiple rows,
  and fully erase queue, input, and status rows after terminal resizing
- identify Shell commands as unthrottled local-host execution, allow explicit
  deadlines up to two hours, report timeout, cancellation, and output-limit
  termination causes, and stop models from misattributing a tool deadline to
  the macOS capability sandbox
- add MemoryHub schema v2 with traceable L0 Evidence, L1 Atom, L2 Scene/Topic,
  token-budgeted read-only L3 Personal Context, correction/expiry lifecycle,
  and deterministic 60-question lexical/hybrid evaluation
- replace hot-path JavaScript vector scans with `sqlite-vec@0.1.9` vec0 KNN in
  the existing `memory.db`, including startup self-test, legacy BLOB migration,
  model/dimension isolation, lexical fallback, and packed-package coverage
- keep zero-key Memory retrieval on FTS5/BM25 and require a dedicated key for
  remote hybrid retrieval; retain direct BGE only as an explicitly injected
  library component after real Daemon validation showed synchronous ONNX can
  block IPC, cancellation, and ordinary model requests despite a fast warm
  microbenchmark
- retry a busy Daemon status probe without restarting its live process, refuse
  an implicit restart on IPC timeout, and reclaim supervised workers as soon as
  their durable task lease is lost
- add a provenance-bounded owner Session retrieval audit that reuses production
  Catalog search through an immutable read-only snapshot, refuses active WAL
  state, never invokes remote embeddings, and emits only unlabelled aggregates
- let direct authenticated Full Owner conversations use file tools as well as
  Shell on MimiAgent runtime paths, while preserving the path boundary for
  restricted profiles, delegated work, schedules, and external events
- accept and canonically migrate legacy versioned Connector configuration so an
  idle CLI/Daemon build upgrade cannot fail before replacing the old Daemon
- return structured Context Artifact rejections instead of generic SDK tool
  errors, and provide a current-Run replacement ref only when the same canonical
  result already has an explicit alias in the same Session
- stop exposing direct Browser tools when the Browser Connector lifecycle is
  disabled, offline, stale, or incomplete; preserve pre-dispatch Browser and
  Computer rejections as structured failed-safe results instead of generic SDK
  tool errors; add exact Connector capability discovery with legacy-name
  compatibility; and route owner-visible URL opens through one Computer launch
  action instead of address-bar click and key sequences
- reject direct execution of macOS application-bundle binaries at the Shell
  sandbox boundary so browser-backed CLIs cannot launch Chrome without GUI
  services and produce misleading AppKit crash dialogs
- promote delegated tasks that require `shell.execute` into the supervised
  exclusive worker lane even when the caller describes the workspace as read-only,
  and allow read-only Terminal observation while continuing to block Computer input
  injection into control-plane applications
- degrade unsupported app screenshot requests to AX semantic observations instead
  of discarding usable Computer state, and keep private runtime paths protected by
  routing model Skill activation through `use_skill` without disclosing `SKILL.md`
  filesystem locations
- retire every WeChat capability after an owner account-safety incident: remove
  personal and OpenClaw Connector catalog entries, bridge scripts, probes, Host
  channel schemas, and package examples; atomically delete legacy registrations
  during initialization without touching the official desktop client
- keep isolated Task worker Provider and embedding credentials available for the
  full lazy model/runtime lifecycle while continuing to exclude them from Shell,
  MCP payload copies, persisted state, and worker diagnostics
- refresh the daemon Run idle watchdog only for observable model, Agent, Tool, or
  Runtime progress so empty Provider chunks and metadata keepalives cannot hold a
  scheduled worker forever while later occurrences accumulate; persist expiry as
  a typed retryable transient failure so the existing bounded retry and execution
  ledger path remains authoritative
- constrain historical dead-letter projections to the frozen archive,
  retry-after-fix, blocked, or manual-verify contract; retain unknown rows as
  readiness blockers and require manual verification for legacy failures instead
  of allowing automatic replay
- bind every compiled daemon build to a packaged manifest containing the full Git
  commit and dirty flag, retain a content digest that is stable across reinstall
  timestamps, fail closed on stale or malformed provenance, and make Doctor report
  installed/running build alignment plus the optional workspace HEAD without
  changing the daemon or worktree
- split the three oversized composition roots without adding a service,
  dependency, ORM, or state system: one Run Pipeline prepares and executes a
  frozen Run, one Commit Coordinator owns completion/failure/recovery, daemon
  lifecycle and initialization leave `service.ts`, and table-specific
  Activity, Outbox, Schedule, Run, and Memory-observation invariants leave the
  transactional `MimiStore` facade; lock the roots at 1800/1800/1900 lines
- make the Host the single authority for ordinary Run finalization, derive
  `completed`, `partial`, `blocked`, `interrupted`, `failed`, or `uncertain`
  from structured SDK, Tool, Ledger, and Gate facts, constrain non-completed
  final answers, and persist the same evidence-bound Finalization through
  Session, Task, Trace, Journal, and Outbox recovery boundaries
- bind Shortcuts execution to structured stable IDs issued by the latest live
  Connector catalog instead of accepting guessed shortcut names
- route event-bound personal QQ context and single sends through
  `PersonalMessageHub` and `ComputerManager`, with account/conversation
  fingerprints, owner-activity and draft protection, and post-send readback
- accept the live-certified Cua Driver 0.16.0 boundary while retaining the
  previously tested exact versions
- unify each Run behind one immutable Host capability registry and one bounded
  discovery gateway, keep Browser, Computer, and personal routes direct, resolve
  the exact SDK tool surface once, and invalidate Connector discovery only when
  the semantic catalog revision changes
- enforce autonomous Run and Token budgets before creating non-urgent Connector,
  Routine, or scheduled Briefing work; preserve owner, urgent, and in-flight work;
  classify 24-hour usage by stable Event provenance; fail closed when historical
  token facts are unavailable; and expose one exhaustion/recovery transition in
  activity, Doctor, and redacted diagnostics
- persist a structured failure code and `RunFailureDisposition` at every daemon
  Task failure boundary, reserve `failed` for deterministic errors and
  `dead_letter` for exhausted transient or uncertain outcomes, classify activity
  without parsing natural-language errors, and transactionally backfill existing
  v16 terminal Tasks after creating a recoverable database backup
- make `Task.executor` the only daemon claim key, validate task route combinations
  at enqueue, migrate queued Briefings to isolated read workers in schema v16,
  collapse duplicate historical Connector-health Digest projections without
  deleting Events, and emit health work only on degradation, reason changes, or
  recovery while unchanged heartbeats remain model-free
- keep Bun-backed user CLIs available to launchd-hosted Shell runs, stop legacy
  Connector app claims from hiding applications from native Computer Use, and
  return retryable app discovery guidance instead of aborting on an empty
  `launch_app` target
- expose read-only Session listing/current-history tools on the initial model surface,
  make runtime capability queries use bounded multi-keyword matching with zero-result
  suggestions, and add chronological owner Session-round recall so empty semantic
  searches cannot be mistaken for missing Memory or missing conversations
- add first-class Host-owned Browser tools with strict provider-safe schemas,
  byte-bounded DOM observations, verified form/tab workflows and one-shot run
  cleanup that must finish before task completion, and settle link navigation
  before the next observation; emulate stable logical tabs with isolated
  background OpenCLI sessions so closing a new tab reliably restores the prior
  page; make
  Computer observations actionable only with semantic or visual evidence,
  separate transport from operational readiness, and replace the old model-facing
  Driver control surface with app-centric observe/act tools whose UI actions return
  fresh state directly; bind each launch to its newly created app window, keep
  uncertain transport protection inside the Host, and let authorized Full Owner
  runs fall back from explicit background-unsupported results without model routing
- resolve context windows per exact model registration or built-in profile when
  switching models, add GPT-5.6 family profiles, and limit legacy global context
  settings to unknown-model fallback instead of overriding every model
- enforce progressive capability discovery in Host code: keep low-level Connector
  tools behind the unified gateway, reject hidden tools that were not precisely
  inspected in the current Run, and reject guessed Connector capability/action
  pairs before dispatch
- distinguish the Darwin Shell sandbox from macOS app/signature failures in
  structured Shell results, keep screenshotless Computer actions available to
  non-vision models, and publish exact Connector target/payload examples so GUI
  app activation does not guess fields or fall back through Shell
- let durable Mimi background tasks carry an explicit exact
  `providerId/modelId` target through delegation, persistence, worker routing,
  and task inspection while retaining `background.default` routing when omitted
  and rejecting Mimi Provider targets for the independent Codex executor
- recognize raw `Command+Enter` modifier sequences before Node readline can
  split or discard them, preserving ordinary `Enter` FIFO behavior
- keep Plan as a user-interface progress surface rather than an ordinary Run
  completion gate, return actionable `update_plan` validation errors, and
  remove the persistent TUI Plan panel once every step is complete
- keep `/sessions` selection and TUI history snapshots responsive while the
  selected Session is running, without bypassing serialization for mutations
- remove the accidental default 32-call and 500K cumulative-input run caps;
  normal conversations are unlimited again unless an operator explicitly sets
  `MIMI_MAX_TURNS`, while every individual request still fits its model context
- replace fixed sentence extraction with a Provider-backed, no-tool semantic
  snapshot seam that makes 70% checkpoint preparation non-blocking and validates
  covered canonical prefixes before 80% compression; materialize native MCP
  tools behind the unified capability gateway so the SDK request has no hidden
  schemas while preserving exact discovery, Policy, and ExecutionLedger behavior
- separate consumed Tool artifacts, durable work snapshots, and 80% dialogue
  compression so 1M-window runs can read hash-verified canonical results without
  replaying effects; add policy-preserving progressive discovery for hidden
  builtin, MCP, Computer, Memory, Goal, Skill, and Connector capabilities,
  including generic Connector action metadata lookup through the unified
  capability gateway; store Memory embeddings per chunk with page aggregation
  and relevance/diversity MMR
- derive a bounded Context View before every model call while retaining the
  canonical Session, add 70% work snapshots and 80% semantic compression with
  intact recent turns and tool protocol units, progressively disclose Skill and
  Connector capabilities, recall only relevant bounded memories, separate
  actual/cumulative/view/reserve context metrics, and keep every individual
  request inside its model context window without imposing a cumulative Run cap
- stabilize Daxiang owner messaging when delivery receipts change during a read,
  index every authorized hidden Host capability by source and bounded exact names
  so progressive disclosure cannot make a model mistake an omitted schema or
  intentionally hidden Connector action for missing runtime support,
  remove duplicate pre-send context navigation, and classify all failures before
  the single send click as failed-safe instead of uncertain; synchronize React
  textarea tracking so a DOM-verified draft is also accepted by the page state,
  wait for that state commit before the single click, and require the optimistic
  outgoing bubble to acquire a non-empty server `data-mid`; load an exact numeric
  target through the bounded virtualized session list before declaring it absent;
  periodically refresh the idle dedicated web session through the read-only
  readiness probe so a stale page connection cannot remain superficially ready
- hot-reload complete model registry changes at the next Run even when a legacy
  writer did not bump routeVersion; allow concise model registration on an
  existing Provider, and add a bounded `daemon restart --force` that interrupts
  only model-only Runs while preserving Tool, worker, Host mutation, Outbox and
  at-most-once side-effect boundaries
- scope Provider circuit breakers to the resolved `providerId/modelId` for each
  Run, so a model-specific 429 on a shared gateway does not block other models
  while repeated requests to the limited model remain fenced
- move non-profile external-action safeguards out of model instructions and into
  Host/tool code: hide internal Connector actions, add business-only owner
  messaging, bind Computer observations internally, classify ordinary uncertain
  runs as incomplete, and route all KM Skills to the official Citadel CLI
- close the multi-Provider review gaps with a product `generate_image` Media
  WorkUnit, native Anthropic/Gemini image blocks, fail-closed capability checks,
  exact target/transport tool and transcript handling, and routeVersion refresh
  across cached Session actors while preserving frozen in-flight Run/Team bindings
- add strict Provider registry `add/set/list/test` commands and make
  `model_control` the only natural-language Session/route write surface; apply
  registered context windows and route turn/output budgets to frozen bindings,
  ContextManager and Provider requests without restarting the Daemon
- map Claude high reasoning through declared adapter capability to legal manual
  thinking budgets or adaptive thinking/effort, rejecting unsupported explicit
  reasoning instead of silently downgrading it
- add per-Session and per-WorkUnit model routing through a provider-neutral Gateway,
  native OpenAI Responses/OpenAI-compatible/Anthropic/Gemini adapters, frozen Run
  bindings, atomically frozen Team route snapshots, independently selected
  SubAgent/Team/background workers, binding/usage observations, and a distinct
  image-generation Runtime while preserving legacy environment configuration;
  add `/models` plus `/model current/inspect/use/auto/routes/route/doctor` over the
  Session-scoped Daemon control path without restarting it; derive each Daemon
  Run scenario from its durable task kind so Conversation Sessions retain their
  selected target; keep model listing side-effect free, and make explicit
  OpenAI-compatible doctor checks issue a bounded target-model completion so an
  invalid alias or missing entitlement cannot pass a Provider-only `/models` probe
- add a Mimi-only `~/.mimi-agent/PREFERENCES.md` for owner-confirmed behavior
  defaults, inject `MIMI.md` Soul first followed by core rules, Preferences,
  Runtime Context, and active Skills as pinned direct-owner context, and expose
  owner-only atomic list/add/remove tools
- isolate Daxiang polling and context navigation in an auto-provisioned inactive
  Chrome tab, and add bounded `search_targets` plus one-time-token
  `bind_target` actions so models can start an owner-authorized conversation
  without generic Browser/CUA/Shell maintenance or display-name sends
- supervise declared read-only Connector health actions outside model Runs,
  automatically restart only the affected Connector after bounded consecutive
  readiness failures, and prevent business Runs from spending turns on
  Connector infrastructure repair or crossing to another execution surface
- preserve the owner input and already-visible assistant text when Esc interrupts
  a Run, while continuing to discard incomplete tool protocol units so Session
  switching keeps context without making uncertain actions replayable
- stop exposing model-managed Connector `operationRef` fields and remove
  Browser `observationId` write gates while retaining Host ledger no-replay
  handling and post-write verification
- prevent macOS Terminal.app IME crashes by disabling autonomous TUI animation
  redraws there and deferring concurrent terminal output until an active
  long-text or multiline draft reaches a safe submit/clear boundary
- remove Host-side natural-language keyword routing for workspace selection,
  Project Guidance, Session controls, Completion Contracts, Memory provenance,
  personal-message auto sends, Session titles, and answer completion; use
  trusted workspace/resume metadata, explicit tool fields, source policy,
  schemas, execution receipts, and `/confirm-send` instead
- publish a completed Daemon Task only after its execution ledger is finalized,
  so the current conversation cannot reject its own deferred Provider restart;
  report saved-but-not-active Provider configuration truthfully and reject
  unsupported lifecycle flags instead of silently ignoring them
- validate Browser write payloads before consuming their Observation, return an
  explicit post-write `nextRead` so newly opened pages are discovered, and
  label Browser success as interaction-only until post-write business
  verification; require a fresh snapshot before arbitrary page JavaScript, bind
  Connector writes to stable operation references, replay confirmed receipts
  across temporary page/session/target changes, and preserve uncertain
  ActionIntent fences without blocking unrelated recovery actions
- fuse compiled Wiki and owner Session episodes before applying Memory search
  limits, require bounded query reformulation for irrelevant recall, and support
  an independent OpenAI-compatible Embedding endpoint instead of coupling
  MemoryHub vectors to the chat Provider
- preserve explicit pre-execution Connector rejections as `failed_safe` across
  the SDK tool boundary, so input, target, readiness, and business validation
  errors remain correctable without freezing the Run; keep timeout, disconnect,
  and explicitly uncertain results non-replayable
- preserve the concrete Connector rejection message instead of replacing it
  with a generic label, normalize Browser snapshot targets supplied as `ref`,
  `locator`, or `element`, and expose declared page JavaScript execution to
  Full Owner Browser sessions
- allow the authenticated Daemon control plane to resume any paused or blocked
  Task type that it can pause, including conversation Tasks
- replace the Safari/Chrome JXA `macos-browser` route with one Chrome-only
  Browser Connector backed by OpenCLI, including isolated/bound sessions,
  DOM/AX observations, semantic locators, bounded reads and structured page
  actions that consume a fresh observation before every write
- dynamically paginate every existing Daxiang web conversation for bounded reads,
  including direct, group, public-account, and collection sessions, while keeping
  polling and sends restricted to explicit owner-bound stable sids
- enforce Connector `routeOwner` claims across ordinary CLI Computer and desktop
  Connector actions even while the owning route is degraded; contain uncertain
  ActionIntents as a Run-local action fence so bounded reads and the final answer
  can continue without replay or route hopping; include bounded Connector-declared
  target and payload usage in the effective capability contract; keep Daxiang
  bounded reads ready on a virtualized session-list page before its composer is open;
  retain verified account identity across same-tab DOM virtualization while failing
  closed on contradictory evidence, and structurally bound context before tool caps
- keep bounded Daxiang web reads available when its dedicated tab is selected in a
  background Chrome window, restore the prior conversation after access, expose
  structured readiness reasons, detect missing owner bindings in Doctor, keep
  declared read capabilities out of the side-effect ledger, stop retrying uncertain
  external actions, keep internal personal-message event polling out of the model
  action catalog, filter currently unavailable Daxiang targets, forbid Connector
  fallback suggestions, and reject model answers that only promise the next step
- make legacy `/model <name>` a global selector across configured legacy Provider
  lists while the registry-backed `/model use/route` path switches exact targets
  on the next Run without a Provider restart
- make Safe, Workstation, and Full Owner the only user-facing authorization
  policies; let Workstation use the sandboxed Shell while excluding external
  transactions, remove model-facing Connector enable/reload and per-action
  approval, inject exact Connector capability operations into each Run, and add
  a confirmed `open_visible` desktop action for local files and URLs
- animate the TUI with distinct slow-thinking and fast-running Mimi expressions,
  and show elapsed command time with automatic seconds, minutes, and hours formatting
- add one-command atomic Provider configuration and Daemon restart through
  `mimi provider set`; automatically persist an already-authorized current
  Provider key into the owner-private environment instead of blocking launchd
  startup or requiring the Owner to resubmit it
- expose every configured Provider to `runtime_status` and add a deferred,
  idempotent `switch_provider` control so Kimi and DeepSeek remain selectable;
  ignore failed runtime-tool text in action recovery instead of misclassifying
  it as a corrupt ledger and retrying the same Task
- keep the configured CuaDriver daemon available from the Mimi background
  service with background startup, health monitoring, bounded crash recovery,
  read-only retry, and strict no-replay handling for uncertain GUI actions
- default authenticated local Owner runs to Full Owner, stop applying legacy
  per-Session security preferences, keep Safe/Workstation as explicit runtime-wide
  restrictions, and preserve the interactive arrow-key `/security` selector while
  external and background policies stay isolated
- return a retryable tool result when a model accidentally embeds an active Owner
  credential in tool arguments, so the same Run can retry through its ephemeral
  Shell environment; permit explicit owner-private Provider configuration without
  exposing the value to argv, ledgers, delegated work, or ordinary files
- reject model switches outside the active Provider's declared model list before
  scheduling or persisting the change, and ignore incompatible model preferences
  left by older Sessions instead of sending them to the wrong Provider
- add a generic `openai-compatible` model Provider with validated custom endpoint,
  API key and model configuration, including Session persistence, daemon Task
  credential isolation, model switching, offline contracts and setup guidance
- let a direct authenticated Owner in Full Owner mode expose a pasted sensitive
  value once to the current configured model Provider and main-Agent Shell while
  keeping the durable user input redacted; bind the in-memory lease to provenance,
  Event, Session, and Run ownership, deny inheritance by Safe/Workstation,
  background work, SubAgent/Team, MCP, and Connectors, and redact Session items,
  tool/ledger data, errors, streaming, traces, and final output before persistence
- serialize Attention configuration mutations across engine instances with the
  shared file lock so concurrent updates cannot silently overwrite each other
- add a bounded read-only `inspect_processes` Host Tool for macOS CPU/memory
  diagnosis without command-line arguments or Shell approval; keep GUI/control
  capabilities sandboxed, propagate failed Shell pipeline stages, and stop
  attributing MimiAgent sandbox denials to SIP
- keep the M1 canary host-idle gate independent from unrelated Connector readiness
  warnings; active Event, Task, Outbox, and host mutations still stop the whole run,
  while each fixed probe continues to enforce its own registered capability and
  readiness boundary
- let an authenticated fixed-profile read probe establish or refresh a 15-minute
  Connector readiness lease only after the registered `effect=read` action succeeds;
  keep declared unavailable, write, unknown-effect, route-drift, and failed actions
  fail-closed; recognize identical bounded script copies when syncing managed Connector
  action metadata without changing their configured execution path
- allow authenticated owner Runs with explicit background Computer capability to execute
  Observation-bound background UI actions through ActionIntent without an unreachable
  per-gesture approval; keep runtime target checks inside ComputerManager and external,
  foreground/admin, URL launch, and ungranted Computer actions fail-closed
- upgrade M1 Jarvis Eval to provenance-safe v2 evidence layers and explicit
  requested/eligible/executed denominators; reject v1 live credit, duplicate/conflicting
  runs, forged readiness-as-live evidence, and uncertain retry; replace direct Connector
  spawn/readiness canaries with an authenticated fixed-profile read probe through
  CapabilityResolver, Tool policy, ConnectorManager, and ComputerManager
- recognize Multica access tokens at the common persistence/display sanitization boundary,
  keep classified historical Task dead letters visible without blocking Doctor readiness,
  derive `/status` Skill availability from the effective capability snapshot, and
  add exact atomic Connector enable/disable CLI controls for staged runtime closeout
- require Daxiang allowlist targets to carry an owner authorization revision bound to the
  verified account fingerprint, stable sid, and conversation type; expose target-not-bound
  readiness, preserve bounded read/Draft on page-write mismatch, and keep timeout outcomes
  uncertain without Browser, Computer, or Shell fallback

- remove owner free-text and Shell command-string classification from capability
  routing; Darwin Shell now always runs behind a process capability sandbox that
  blocks Apple Events, Accessibility, LaunchServices, and registered local Unix
  sockets or loopback control ports while preserving ordinary development services
- add stable Connector `capability`, `effect`, `routeOwner`, catalog-before-filter
  evidence and claimed Computer app resources, so a business-word query miss cannot
  be mistaken for an absent capability or used to cross execution routes
- require structured capabilities before durable background delegation, expose
  confirmed ActionIntent/Connector receipts, and bind external Plan completion to
  those receipts while preventing completed steps from being silently reopened
- make MemoryHub a maintained three-layer LLMWiki with an Obsidian-ready owner
  Vault (`raw/`, `wiki/`, executable `WIKI.md`), one canonical topic resolver
  across remember/capture/maintenance, deterministic page rendering, Wiki-first
  retrieval, evidence compounding, lifecycle metadata, and receipt-backed merge,
  supersede, link, scope-move, stale-refresh, and deterministic lint repair;
  legacy hashed profile storage is backed up before one-time layout migration
- make `/security` an interactive `↑`/`↓` Session selector whose confirmed
  profile is persisted per conversation and applied to the next Run without
  editing environment files or restarting the Daemon
- bound combined `run_shell` output to the execution-ledger budget so large
  command responses are truncated with an explicit marker instead of turning a
  completed side effect into a non-retryable ledger failure
- render GFM Markdown tables as aligned terminal box tables in streamed and
  replayed TUI answers, including tables that omit leading and trailing pipes
- add the shared personal-message schemas, conservative `messageMode` policy,
  Run-bound single-use context tokens, and a disabled-by-default Daxiang personal
  account Connector using a background Chrome DOM bridge; QQ and personal WeChat
  adapters remain unimplemented, and generic Connector actions cannot bypass the
  personal-message send fence; first watch polls establish a message-ID-only
  baseline instead of replaying visible history, while conversation stabilization,
  explicit page-failure detection, and action/poll exclusion prevent send races
- require exact same-Session owner confirmation for personal-message Confirm drafts,
  preserving the original Event target and approved text across Runs
- route structured personal-message Events through bound Connector scopes and
  configured target listing, reject unknown exact IDs as non-offline misses, and
  remove Shell/Computer/CUA/Browser desktop fallbacks without deriving policy from
  owner wording
- index every completed owner conversation round and search private Session
  episodes by default so a new Session can recall relevant prior conversations
  without a separate history-intent or evidence flag
- remove the Daxiang, QQ OneBot/NapCat and generic HTTP Action/Event connectors,
  delete all QQ/Weixin/Daxiang AppleScript IM fallbacks and QQ installer paths,
  retain only OpenClaw iLink for Weixin and the CUA Skill for QQ, and purge retired
  connectors from existing runtime configurations during initialization
- discover Agent Skills across configured, project, user and package roots with
  deterministic precedence, manifest-allowlisted builtins, canonical deduplication
  and structured shadow diagnostics
- add owner-leading `$skill-name` activation, Session-persisted idempotent bindings,
  active/stale/deactivate inspection, protected full instruction recovery across
  restart and context compaction, and active-binding resource authorization
- apply one fail-closed Skill availability check to catalog disclosure, explicit
  and model activation, protected recovery and resource reads using the final Run
  tool set; `allowed-tools` remains non-authoritative metadata
- add a per-request Context Manifest with section-level estimates, deterministic
  compression records, provider actual-usage backfill, and a structured
  `actual`/`estimate`/`raw-history` chat status; daemon protocol 11 retains the
  derived `contextUsed` field for one compatibility cycle
- add Memory compilation V2 candidates, jobs, immutable page revisions and
  terminal receipts across remember/capture/ingest/maintenance, with digest-based
  crash recovery, explicit stale refresh, and bounded immutable Task evidence
  snapshots in the Daemon v15 migration
- split the main run into testable scope/state/capability/context/tool/request/
  commit stages, centralize file-backed state behind ports, and add a digest-only
  Run Commit Journal that preserves completion receipts across later failures
- unify SubAgent, Team worker, durable Background and detached Codex observations
  as WorkUnit results consumed by Trace, terminal progress and Completion Gate
- expose `mimi daemon start`, `stop`, and `restart` as supported one-command
  lifecycle operations with idempotent stop, readiness-confirmed startup, and a
  durable workspace binding so service management works from any directory
- make `mimi daemon status` human-readable by default, retain full machine output
  behind `--json`, show a direct start hint when the service is offline, and
  distinguish retained failures that need attention from an unavailable daemon
- macOS 日历与提醒事项 Connector 改用 EventKit 原生后台访问，轮询和操作不再启动或激活 Calendar/Reminders App。
- let the model recover from stale or hallucinated tool names instead of aborting
  the entire run with `Tool ... not found`
- resolve each owner task to its actual project workspace before the model runs:
  explicit paths or unique project names override the CLI launch directory,
  ordinary work and repository-local deliverables use that directory, and only
  standalone new projects that do not fit the current directory fall back to
  `~/MimiWorkspace/<task>`; Session runtimes rebuild at FIFO-safe boundaries,
  and durable background/Codex tasks inherit the resolved workspace
- bound the interactive input viewport for long text, preserve bracketed-paste
  markers split across terminal data chunks, and defer/coalesce Apple Terminal
  redraws outside IME key events; Apple Terminal uses a single physical-row
  viewport that never crosses its marked-text wrapping crash boundary while
  still submitting the complete input
- return the activated Skill resource root from `use_skill`, and make QQ desktop
  messaging a deterministic, background-only path that can read bounded visible
  context for summaries or contextual replies, confirm exact recipients, verify
  delivery by before/after differences, accept CuaDriver's textual action
  receipts, preserve non-empty user drafts, verify the exact prepared text before
  pressing send, and never retry or rename the recipient after a failed send
- let runtime-capability questions inspect `runtime_status` so unavailable
  Computer Use is explained from actual configuration instead of a reduced tool list
- bind capability-dependent Skills to the current Run's real tool set, report
  effective Computer Use configuration separately from Full Owner's potential
  permission, and require bounded fallback/state verification before declaring a
  task impossible or replaying an uncertain side effect
- keep compacted history in its dedicated instruction/archive section instead of
  persisting it as a synthetic user turn, remove affected legacy archive messages
  on Session load, and resolve short confirmations against the immediately
  preceding assistant proposal
- route status and prior-work follow-ups through the model instead of returning a
  keyword-triggered Host answer; background status remains limited to read-only
  task inspection tools

## [0.12.0] - 2026-07-24

### Added

- add opt-in macOS Computer Use through Cua Driver with bounded observations and actions, permission-aware policy, protected artifacts, background-first execution, and verified visible handoff
- progressively disclose bounded owner tools for status, Session, web, and lightweight questions; answer high-confidence status queries directly from bounded Host state without a model round, omit undisclosed Skill catalogs, cap focused history and output reservation, skip automatic memory work for focused requests, and make automatic embedding recall fail fast without retries
- add a desktop-QQ coexistence setup path for LLOneBot/LLBot, generalize the QQ bridge to preferred `QQ_ONEBOT_*` settings, and retain legacy NapCat compatibility
- replace the legacy `MemoryStore` and flat RAG index with a unified profile-isolated MemoryHub backed by Markdown Wiki pages, SQLite FTS5/BM25, optional embedding RRF, source receipts and forget suppressions
- split `MIMI.md` Soul from hierarchical `AGENTS.md` / `CLAUDE.md` project guidance, and replace legacy memory/RAG tools and CLI commands with the canonical `/memory` surface
- add an atomic one-time backup/conversion marker for usable legacy memories while skipping todo and unconfirmed entries
- index complete rounds as owner-gated episode evidence and add multi-page compilation plans, supersession intervals, deterministic lint, recurring Error Book entries, audit/conflict/capture commands, and bounded semantic maintenance
- register terminal Task observations transactionally and consolidate them through low-priority profile-scoped maintenance Tasks with strict tool, evidence, trust, page, retry, and fairness limits
- back up Mimi SQLite/WAL/SHM and legacy user Soul before cutover, move identifiable owner facts into private Wiki, and auto-create minimal AGENTS guidance only for writable development tasks

### Changed

- begin the Phase 2 hotspot split by moving the current Daemon schema and v13/v14 migrations behind the `MimiStore` transaction facade, and isolate Dispatcher retry policy with delivery recovery tests
- add an automated dependency-direction guard, remove every known `extensions -> runtime` reverse dependency, and move terminal interaction out of the Daemon RPC client
- extract role-scoped tool policy and run-context construction into focused core/runtime collaborators while preserving the public orchestration surface
- move the legacy Event/Task v12 cutover into a versioned migration with direct pre-check,
  post-check, foreign-key, and injected-failure rollback coverage
- move the v2-v11 Event schema preparation out of `MimiStore`, with direct idempotency
  and schema-evolution coverage before the v12 cutover
- extract Completion Gate evidence recovery, Plan/Team ownership checks, and progress
  fingerprinting from `MimiAgent` into a dedicated coordinator
- extract Runtime Action recovery, conflict detection, ordering, and at-most-once
  application from `MimiAgent` into a dedicated coordinator
- move Plan and Team SDK Tool construction out of core stores into runtime/extension
  adapters, and derive policy lookups from a single `ToolDescriptor` catalog
- add a source-level Tool catalog contract so every statically declared SDK Tool
  must register capability, mode, and side-effect metadata
- add a shared Daemon health model for `status`, `doctor`, and direct owner status
  answers, distinguishing ready, degraded, and unhealthy runtime states from
  process liveness while surfacing bounded backlog, dead-letter, and Connector risks
- add explicit Safe, Workstation, and Full Owner security profiles, default fresh
  configuration to Safe, expose the effective capability summary in `/status`,
  and prevent Safe from retaining legacy read-only Connector transactions
- add a no-clobber `daemon diagnostics` export with an explicit redaction
  allowlist, Doctor capacity thresholds for SQLite/logs/Memory, and bounded
  pre-restart rotation for daemon stdout/stderr logs
- add manifest-verified recovery backups using SQLite online snapshots, protected
  allowlisted state copies, SHA-256 verification, and no-clobber blank-root restore
- add Connector readiness freshness heartbeats and surface stale online pollers
  through capability inspection, unified health, Doctor, and redacted diagnostics
- add non-blocking capability onboarding through the interactive security-profile
  banner and `/security` comparison backed by the authoritative profile catalog
- add an isolated, parameterized Event/Task/Session/Memory capacity benchmark
  with versioned JSON throughput, environment, and storage-growth output
- add a checked-in offline Provider contract fixture and test for OpenAI/DeepSeek
  defaults, profiles, input portability, API-key boundaries, and Tool schemas
- add a small opt-in real Provider canary with fixed Safe-profile Tool tasks,
  isolated state, bounded turns, and redacted no-clobber reports
- add a checked-in Prompt Injection and permission eval matrix that intersects
  real event policy, security profiles, and the authoritative Tool catalog
- add a versioned public API contract with source, type, and packed-package
  compatibility checks for the two supported entrypoints
- classify every checked-in Skill as product or experimental and add a repository
  gate that keeps user projects, personal knowledge, and incubation assets out of npm
- make Daemon startup UI-silent by enabling only the non-GUI macOS System
  Connector by default, one-time disabling legacy canonical GUI defaults, refusing
  to launch closed Calendar/Reminders/Mail apps during polling, and reducing idle
  queue and system-health polling frequency
- serialize test files so macOS Connector contract fixtures do not starve each
  other's child processes, and degrade unavailable OS uptime/load metrics instead
  of making the system-health Connector entirely unavailable
- add a detached `codex` background executor that records process/thread artifacts and commits its own terminal result without Mimi fallback or validation
- split immutable daemon Events from executable Tasks, with atomic schema v12 cutover and no dual-write compatibility path
- move lease, retry, control, attempt, lifecycle, schedule occurrence, and Outbox ownership to Task IDs
- separate Event timeline and Task management in daemon CLI/IPC, including Task-only dead-letter retry
- open the CLI on an unpersisted draft, create its Session only on the first message, and derive evolving topic titles from conversation content

### Fixed

- invalidate in-flight clipboard polling before a MimiAgent self-write so a late
  pre-write read cannot be misreported as a second external clipboard change
- remove tracked authentication material, device identity, private QQ data, and browser snapshots; reject equivalent runtime artifacts in CI
- pin the supported npm and critical SDK dependency graph, keep Computer Tool schemas portable across SDK patch versions, and add Linux/macOS release-contract checks
- align package, lockfile, and Changelog identity on `0.12.0`
- restore current Event/Task v12 invariant coverage for authority revocation, Attention routing, leases, controls, attempts, Outbox delivery, schedules, retention, and dead-letter recovery
- keep Computer Use configuration out of isolated Task IPC so Codex workers can start, preserve worker initialization errors instead of replacing them with a generic exit, and require task inspection evidence for failure attribution
- keep explicitly requested visible app handoffs on the user's current desktop and require frontmost observation before reporting success
- let the CLI connect from any directory, re-adopt a replaced Host's workspace, and recover ordinary commands when the daemon socket is briefly unavailable
- expose bounded, persistent Codex JSONL progress through task inspection, guide Mimi to use it, and keep prior-attempt errors from masquerading as current running failures
- make repeated background delegation truly idempotent and provide both Codex and its Node shebang runtime when daemon launchd PATH is minimal
- stop legacy digested/ignored Events from becoming completed Tasks and safely remove artifact-free phantom Tasks during the backed-up v14 upgrade
- distinguish conversation executions from delegated background tasks in Mimi activity snapshots and include each recent Task's trigger Event source/type
- validate the physical v12 Event/Task schema and atomically recover empty half-migrated databases instead of trusting `user_version` alone
- keep the interactive input cursor clear of Terminal.app's IME wrapping boundary and remove high-frequency status redraws that could trigger native macOS 26 Terminal crashes
- soft-wrap editable CLI input across multiple terminal rows while preserving explicit newlines and cursor placement
- clear a non-empty CLI draft with double Escape while retaining the existing single-Escape action
- keep Up/Down navigation in input history when a recalled entry such as `/help` also matches command suggestions
- avoid repeating Markdown code gutters inside a source line when delayed streaming chunks flush before its newline
- let the process supervisor schedule persisted `codex` tasks and forbid failed background work from falling back to execution in the current Session
- fall back to a readable input width when a TTY temporarily reports zero columns instead of collapsing soft-wrapped input to two characters per row

## [0.11.7] - 2026-07-20 11:47

### Fixed

- remove fixed turn limits (@Kickflip73)

## [0.11.6] - 2026-07-20 11:41

### Fixed

- prevent repeated task execution (@Kickflip73)

## [0.11.5] - 2026-07-20 11:25

### Fixed

- tolerate legacy file residue during upgrade (@Kickflip73)

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

### Changed

- upgrade the lightweight coding I/O loop with bounded recursive directory discovery, path-only and ripgrep-backed regex/glob/context search, ranged digest-bearing reads, stale-safe unified-diff patches, and private-data-filtered Git change inspection
- remove generated max-turn defaults and fixed-count repeated-tool termination; normal Agent, SubAgent, and Team runs now stop from durable task state, explicit cancellation, timeout, or an operator-configured limit
- scope Completion Gate enforcement to explicit persistent Goals, stop replaying whole Events after an unfinished Goal, and reuse consecutive identical side-effect results instead of executing them again
- harden unattended execution with secret-free Shell environments, full process-group cleanup, public-network-only HTTP requests, persistent Connector inbound ACKs, poison-row quarantine, provider-bound model preferences, build-aware Daemon upgrades, and per-attempt logical side-effect identities
- replace fixed-count stability patches with evidence-aware completion progress, immutable Event-to-Session binding, route-scoped Outbox lanes, prompt-budgeted briefings, protocol-preserving context compaction, and persisted Connector delivery receipts
- keep pure answers out of execution gating, isolate stale Goal/Plan/recovery context, preserve delivery suppression across crash recovery, batch briefing/context protocol units, and prevent one blocked IM channel from holding up another
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
