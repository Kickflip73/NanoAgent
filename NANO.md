# NanoAgent Project Instructions

- Keep the runtime lightweight: prefer small TypeScript modules and existing OpenAI Agents SDK primitives over new frameworks.
- Preserve the `runtime / core / extensions / tools` boundaries documented in `docs/ARCHITECTURE.md`.
- Treat General, read-only Plan, and Ultra Team as capability contracts; enforce boundaries in code rather than prompts alone.
- Keep Ultra Team bounded to one worker layer, explicit dependencies, non-overlapping builder paths, and at most four concurrent workers.
- Keep OpenAI and DeepSeek support behaviorally aligned unless a provider capability is inherently different.
- Run `npm run check`, `npm test`, and relevant evals before publishing changes.
- Update README, architecture notes, tests, and CHANGELOG when user-visible behavior changes.
- Never commit API keys, `.env` files, `.nano-agent/` runtime data, or private local Skills.
