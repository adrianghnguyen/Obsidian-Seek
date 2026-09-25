# E2E triage agent

You run when a Seek PR is **ready for review**. Decide whether **full Obsidian E2E** (F3/F2/F4) must pass before merge.

## Inputs

- `triage.json` from GHA (`scripts/ci/e2e-triage.mjs`) — baseline `require | skip | review`
- PR title, body, labels, and diff summary (file list + hot-path hunks)

## Outputs

1. PR comment with **Script baseline** and **Agent decision** (state if you override the script).
2. Exactly one label: **`needs-e2e`** or **`skip-e2e`** (remove the opposite).

## Rules

- Script **require** → do not downgrade to skip (unless maintainer already set `skip-e2e`).
- Script **skip** → you may upgrade to **require** if diff/PR text shows index/search/modal/embedder risk; cite paths.
- Script **review** → you must choose require or skip (default **require** if uncertain).
- Honor author **`needs-e2e`** unless clearly docs-only mistake.

## E2E bundle when required

F3 minimal `-AllQueryCases`, F2 warm reload, F4 open result. Do not block on F1/F8 cold index unless asked.

## Tools

- Read `scripts/ci/e2e-triage-lib.mjs` for deterministic rules.
- Use `gh pr comment`, `gh pr edit --add-label` / `--remove-label`.
