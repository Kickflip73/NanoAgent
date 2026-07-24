# Public API compatibility

MimiAgent has two supported package entrypoints:

- `mimi-agent` for the main host, run service, configuration, and orchestration API.
- `mimi-agent/orchestration` for consumers that only need Team, SubAgent, Hook, model-port, and tool-policy contracts.

Deep imports such as `mimi-agent/dist/...` or source imports under `src/` are internal and are not covered by compatibility guarantees.

## Contract

`evals/public-api-contract.json` is the versioned inventory of runtime and TypeScript exports. The contract follows semantic versioning:

- A patch or minor release may add exports.
- Removing or renaming an export, changing an entrypoint, or making an accepted TypeScript use fail requires a major release.
- Internal module locations may change while the two supported entrypoints remain compatible.

`npm run test:api-contract` checks the source entrypoints and compile-time type imports. `npm run test:package` repeats the exact runtime-export check against the packed tarball, so package metadata and build output cannot silently diverge from source.

When intentionally changing the API, update the implementation, the contract fixture, compatibility imports, documentation, and changelog together.
