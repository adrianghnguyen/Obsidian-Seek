---
name: seek-playbook-catalog
description: Master index and dispatch for Seek telemetry scenarios (S1–S7 performance, F1–F10 functional). Use list-scenarios.ps1 to enumerate; run-scenario.ps1 -Id to execute drivers. Entry point before seek-telemetry-playbook or seek-functional-telemetry detail skills.
---

# Seek playbook catalog

**Start here** for baseline runs. Lists all scenarios and routes to shell drivers — no chat improvisation.

## Quick commands

```powershell
.\.cursor\skills\seek-playbook-catalog\scripts\list-scenarios.ps1
.\.cursor\skills\seek-playbook-catalog\scripts\run-scenario.ps1 -Id F3 -FixtureSet full -AllQueryCases
.\.cursor\skills\seek-playbook-catalog\scripts\run-scenario.ps1 -Id S1 -Vault plugin-sandbox-Obsidian -Run A
```

## Execution layers

```
Layer 1 — Shell driver (.ps1)     orchestrates steps, writes trace JSONL, exit 0/1
Layer 2 — Obsidian CLI            restart | eval | seek:search | seek:open | …
Layer 3 — Optional screenshot     obsidian dev:screenshot → .cursor/telemetry-screenshots/ (gitignored)
Layer 4 — Parse + canvas emit     Emit-CanvasRunJson.ps1 → append RUNS in canvas
```

**Serial CLI rule:** one Obsidian session; never parallel eval (see `seek-cli-startup-debug`).

## Registry

Machine-readable: [`playbook-scenarios.json`](playbook-scenarios.json)

| Column | Meaning |
|--------|---------|
| `id` | `S1`–`S7`, `F1`–`F10` |
| `status` | `full` = driver implemented; `stub` = fails loudly |
| `driverScript` | Relative to this skill folder |
| `vaultDefault` | Obsidian CLI vault name |
| `detailSkill` | `seek-telemetry-playbook` (S*) or `seek-functional-telemetry` (F*) |

## Detail playbooks

- **Performance S1–S7:** [`.cursor/skills/seek-telemetry-playbook/SKILL.md`](../seek-telemetry-playbook/SKILL.md)
- **Functional F1–F10:** [`.cursor/skills/seek-functional-telemetry/SKILL.md`](../seek-functional-telemetry/SKILL.md)
- **CLI startup probes:** [`.cursor/skills/seek-cli-startup-debug/SKILL.md`](../seek-cli-startup-debug/SKILL.md)

## Fixtures

```
fixtures/minimal/   — seeded seek-functional corpus (~15 notes)
fixtures/full/      — plugin-sandbox-Obsidian (~3k notes) query matrix
```

Functional queries: 10 intents × 3 cases = 30 globally distinct query strings. Validated by `src/test-harness/functional-telemetry/validate-fixture.test.ts`.

## Canvas

Local dashboard: `sandbox-run-history.canvas.tsx` (Cursor canvases folder). After any batch or scenario run, update `RUNS[]` and deviation charts per [`.cursor/rules/telemetry-canvas-update.mdc`](../../rules/telemetry-canvas-update.mdc). Schema reference: `Emit-CanvasRunJson.ps1`.
