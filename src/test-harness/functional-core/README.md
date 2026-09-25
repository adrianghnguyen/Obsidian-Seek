# Functional acceptance (fixtures)

Fast CI path that mirrors playbook **F3 minimal** without Obsidian.

## What runs

- `functional-queries.harness.test.ts` — loads [`fixtures/seek-functional/`](../fixtures/seek-functional/) into the Tier-2 `Scenario` harness and asserts query cases from `.cursor/skills/seek-playbook-catalog/fixtures/minimal/functional-queries.json`.
- Also included in `npm run test:functional-fixtures`: `validate-fixture.test.ts`, `scenario.test.ts`, `search-regression.test.ts`.

## Divergence from real-vault F3

- **`no_answers_possible`** intents are skipped under the fake embedder (lexical/BM25 can still return hits for nonsense strings).
- Rank-1 expectations are tuned for **deterministic fake embeddings**; note bodies in `seek-functional/` may differ from the live `seek-functional` vault.

## Local commands

```bash
npm run test:functional-fixtures
node scripts/ci/e2e-triage.mjs --files-json /path/to/payload.json --dry-run
```

Obsidian parity: `run-scenario.ps1 -Id F3 -FixtureSet minimal -AllQueryCases`.

GitHub Actions Obsidian E2E runs only when the repository variable **`SEEK_OBSIDIAN_E2E_IN_GHA`** is `true` (Cloud Agent layout required).
