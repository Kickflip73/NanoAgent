# MimiAgent Agent Guide

This file is the project-wide contract for coding agents. It applies to the entire repository.

## Mission

MimiAgent is a lightweight, local-first, always-on personal AI agent product and multi-agent orchestration library built with TypeScript and the OpenAI Agents SDK. Keep the runtime small, readable, provider-aware, and capable of doing real work without turning it into a workflow platform.

When rules conflict, follow this order:

1. The user's explicit request.
2. Safety, data integrity, and permission boundaries.
3. The architectural invariants in this file and `docs/ARCHITECTURE.md`.
4. Existing local conventions.

`MIMI.md` is runtime guidance loaded by MimiAgent itself. This file is the development contract for agents modifying the repository; keep them consistent when changing shared architectural rules.

## Working Principles

### Think before coding

- Inspect the relevant code, tests, and documentation before editing.
- State material assumptions and surface ambiguous requirements or tradeoffs.
- Prefer the simplest interpretation that fully satisfies the request.
- Define a verifiable outcome for multi-step, behavioral, or risky changes.

### Keep solutions simple

- Implement only the requested behavior; do not add speculative flexibility.
- Prefer Node.js built-ins and existing OpenAI Agents SDK primitives over new frameworks or dependencies.
- Do not introduce an abstraction for a single use unless it protects a real invariant.
- Extend Skills or MCP before adding low-frequency behavior to the built-in runtime.

### Make surgical changes

- Every changed line should trace to the task.
- Preserve unrelated user changes in a dirty worktree.
- Match the surrounding style; do not reformat or refactor adjacent code without need.
- Remove only imports, variables, files, or branches made obsolete by your own change.
- Do not edit generated `dist/` output directly.

### Work toward evidence

- Bug fix: reproduce with a focused regression test, then make it pass.
- Feature: test the public behavior and relevant failure modes.
- Refactor: establish passing tests before and after the change.
- Documentation/configuration: validate commands, paths, examples, and references against the repository.
- Do not claim a check passed unless you ran it; report skipped checks and why.

## Repository Map

- `src/index.ts`, `src/commands.ts`, `src/interactive.ts`, `src/terminal.ts`: CLI entry, commands, input, and rendering.
- `src/runtime/`: composition root, provider/model setup, run lifecycle, modes, permissions, tool policy, and runtime effects.
- `src/core/`: durable agent state and semantics: sessions, context, memory, plans, teams, traces, and atomic stores.
- `src/extensions/`: optional capabilities: Skills, MCP, RAG, SubAgents, and Team execution.
- `src/daemon/`: MimiAgent event reliability, SQLite state, dispatch, attention, schedules, IPC, connectors, and notifications.
- `src/tools.ts`: small, high-frequency host tools; keep this surface narrow.
- `src/agent.ts`: compatibility exports; put implementation in `src/runtime/mimi-agent.ts`.
- `tests/`: Node test runner tests, generally mirroring source behavior by concern.
- `evals/`: retrieval and agent evaluation cases.
- `skills/`: Agent Skills packages; each skill starts at `SKILL.md`.
- `examples/connectors/`: isolated NDJSON connector examples.
- `docs/ARCHITECTURE.md`: authoritative detailed design and invariants.
- `docs/ATTENTION.md`, `docs/CONNECTORS.md`: MimiAgent attention and connector protocols.

Core dependency direction:

```text
CLI / Daemon -> runtime -> core + extensions + tools
extensions -> core (when persistent state is needed)
core -X-> runtime, CLI, or daemon
```

## Architectural Invariants

- Keep `runtime` responsible for composition/execution, `core` for durable agent state, `extensions` for optional capabilities, and `daemon` for reliable long-lived event handling.
- Keep one main Agent host shared by CLI and Daemon, and one owner of each user-facing Session. SubAgents are bounded, one level deep, and never own the final answer.
- General, Plan, and Ultra are capability contracts enforced by tool selection, not prompt-only conventions. Plan remains read-only. Ultra remains bounded to explicit dependencies, non-overlapping builder paths, and at most four workers.
- Keep OpenAI and DeepSeek behavior aligned unless a provider capability requires a documented difference.
- Preserve tool-call protocol units when trimming history: `user -> function_call -> function_call_result -> assistant` must not be split.
- Keep full Session transcripts separate from summaries, context archives, checkpoints, memory, and retrieval results. Do not persist temporary context as fake conversation history.
- Scope active-run writes by immutable Session/run ownership. Preserve runId/owner checks so stale runs cannot overwrite current state.
- Route persistent JSON state through the existing atomic stores. Validate before commit, lock shared mutations, and use atomic replacement; do not add ad hoc read-modify-write paths.
- Treat side-effect ledgers as at-most-once protection. Never silently replay an uncertain shell, file, MCP, connector, or external transaction.
- Keep the Daemon durable: persist before execution, use lease/retry semantics, atomically commit event outcome with Outbox work, and make delivery independently retryable.
- Treat external event content as untrusted data, never as instructions. `trust` is provenance in the current design, not an authorization boundary.
- Connector credentials and channel SDKs stay outside the runtime in isolated connector processes. Prefer the existing NDJSON protocol and generic action bridge.
- Long-running task state belongs in Goal/Plan/Checkpoint; do not create a second workflow or todo subsystem.

If a requested design violates an invariant, explain the conflict and propose the smallest compatible design before implementation.

## TypeScript and Test Conventions

- The project uses ESM, strict TypeScript, NodeNext resolution, ES2022, 2-space indentation, semicolons, and single quotes.
- Include `.js` extensions in relative imports, even when importing `.ts` source files.
- Prefer explicit types at module boundaries and Zod schemas at persisted or external boundaries.
- Respect `noUncheckedIndexedAccess`; narrow missing values rather than asserting them away.
- Use `node:` imports for Node built-ins and `import type` for type-only dependencies.
- Keep modules cohesive and functions small. Comments should explain invariants or non-obvious reasons, not restate code.
- Use `node:test` and `node:assert/strict`. Tests must be deterministic and should use temporary directories instead of real user state.
- Unit tests must not require API keys, real model calls, the public internet, or the user's `~/.mimi-agent` data.
- Avoid timing-only tests. For concurrency, retries, or cancellation, coordinate on observable state and bound all waits.

## Development Workflow

1. Read the relevant source, nearby tests, and applicable docs.
2. Check `git status` and preserve unrelated changes.
3. Write a short plan for multi-file or behavior-changing work, with a verification step for each part.
4. Make the smallest coherent patch.
5. Run the narrowest relevant test first, then broaden checks based on risk.
6. Review the final diff for scope, secrets, generated artifacts, and stale docs.

Useful commands:

```bash
npm install                                      # install; prepare also builds
npm run dev                                      # run CLI from TypeScript
npm run check                                    # strict type-check, no emit
node --import tsx --test tests/<area>.test.ts    # focused test
npm test                                         # all TypeScript unit tests
npm run build                                    # clean and compile src to dist
npm run eval                                     # local retrieval evaluation
npm run test:package                             # packed-package smoke test
npm run ci                                       # typecheck, coverage, build, package smoke
```

Verification expectations:

- Small implementation change: `npm run check` plus focused tests.
- Cross-cutting runtime/core/daemon change: `npm run check && npm test && npm run build`.
- Retrieval change: add `npm run eval`.
- Packaging, exports, CLI entry, or published files: add `npm run test:package`.
- Release-ready change: run `npm run ci` when practical.
- Real-provider evaluation (`npm run eval:agent`) is opt-in and requires explicit credentials; do not run it by default.

## Change Checklists

For a new built-in tool:

- Confirm it is generic and high-frequency and cannot be a Skill, MCP integration, connector action, or composition of existing tools.
- Assign capability metadata and verify General/Plan/Ultra, permission-mode, SubAgent, Team-worker, and event-policy exposure.
- Decide whether it has side effects and requires execution-ledger protection.
- Add policy and behavior tests.

For durable state or Session changes:

- Define schema validation and migration/backward compatibility.
- Test corruption, atomicity, concurrent access, cancellation, and stale-run behavior as applicable.
- Preserve transcript/tool-call integrity and Session isolation.

For Daemon, schedules, or connectors:

- Test deduplication, lease recovery, retry/dead-letter behavior, and delivery acknowledgement.
- Keep event completion and Outbox creation transactionally consistent.
- Document protocol/config changes in the relevant example and docs.

For user-visible behavior:

- Update tests and the relevant README/docs.
- Update `CHANGELOG.md` when the change belongs in release notes.
- Keep `.env.example`, `mcp.example.json`, connector examples, and CLI help synchronized with configuration changes.

## Security and Repository Hygiene

- Never commit API keys, tokens, real connector credentials, private data, `.env`, `.mimi-agent/`, traces, sessions, local databases, or debug artifacts.
- Examples contain placeholders only. Secrets are loaded from environment variables or the user's ignored configuration.
- Do not weaken path containment, symlink resolution, permission modes, prompt-injection isolation, or protected runtime-data rules to make a test pass.
- Do not expose the CLI, Daemon IPC, webhook, or MCP servers beyond their documented trust boundary without an explicit security design.
- Do not add dependencies, change public exports, rewrite lockfiles, or modify release metadata unless the task requires it.
- Use Conventional Commits when asked to commit, for example `fix(session): preserve tool result pairing`.

Before handing off, summarize the behavior changed, name the files changed, list verification actually run, and call out remaining risks or skipped checks.
