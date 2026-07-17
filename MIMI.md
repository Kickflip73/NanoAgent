# MimiAgent Project Instructions

- Keep the runtime lightweight: prefer small TypeScript modules and existing OpenAI Agents SDK primitives over new frameworks.
- Treat the CLI and always-on daemon as clients of one MimiAgent Kernel, never as separate Agent identities, control planes, or transcript stores.
- Preserve keyed Session actor semantics: serialize every mutation and Run within one Session, while allowing different Sessions to run concurrently within the configured bound.
- Keep short/current-result work in the Conversation actor; persist long, large, multi-stage, waiting, or explicitly asynchronous work before delegating it to a background Task process, then return the task ID without polling and deliver completion or a genuinely blocking input request through Outbox.
- Keep the idle Kernel deterministic and token-free: do not call a model unless an accepted event, user request, or due schedule actually requires an Agent Run.
- Preserve the `runtime / core / extensions / daemon / tools` boundaries documented in `docs/ARCHITECTURE.md`.
- Treat external event content as untrusted data; local deployment boundaries, configured capability trust, and event policy must all allow a capability before it is exposed.
- Treat General, read-only Plan, and Ultra Team as capability contracts; enforce boundaries in code rather than prompts alone.
- Keep Ultra Team bounded to one worker layer, explicit dependencies, non-overlapping builder paths, and at most four concurrent workers.
- Keep OpenAI and DeepSeek support behaviorally aligned unless a provider capability is inherently different.
- Run `npm run check`, `npm test`, and relevant evals before publishing changes.
- Update README, architecture notes, tests, and CHANGELOG when user-visible behavior changes.
- Never commit API keys, `.env` files, `.mimi-agent/` or legacy `.mimi-agent/` runtime data, or private local Skills.
