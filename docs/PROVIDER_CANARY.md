# Real Provider canary

The Provider canary is a small, opt-in, billable release check. It runs one fixed tool-use task through the real MimiAgent CLI for OpenAI and DeepSeek. Each run uses an isolated temporary data root, the Safe security profile, a six-turn limit, and the provider defaults covered by the offline contract.

Run one provider:

```bash
npm run eval:canary -- --provider openai
npm run eval:canary -- --provider deepseek
```

Run both and write a no-clobber, mode-0600 metadata report:

```bash
npm run eval:canary -- --provider all --output ./provider-canary.json
```

The command loads the normal `.env` file and requires `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, or both according to the selection. Reports contain only provider, pass/fail, duration, expected-tool status, and a bounded local error description. They never contain credentials, prompts, model output, Session content, or temporary paths.

This check is intentionally excluded from `npm run ci`: it needs credentials, public network access, spends API quota, and can be affected by transient Provider availability. Run it before a release after the deterministic `test:provider-contract` gate passes.
