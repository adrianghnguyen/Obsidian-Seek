# Seek playbook catalog

Entry point for agents running Seek telemetry and functional scenarios. Lists all **S1–S7** (performance) and **F1–F10** (functional) scenarios and dispatches to driver scripts.

## Quick start

```powershell
# List all scenarios
.\.cursor\skills\seek-playbook-catalog\scripts\list-scenarios.ps1

# Run a scenario (stub drivers fail clearly until implemented)
.\.cursor\skills\seek-playbook-catalog\scripts\run-scenario.ps1 -Id F3 -Vault seek-functional
.\.cursor\skills\seek-playbook-catalog\scripts\run-scenario.ps1 -Id S1 -Vault plugin-sandbox-Obsidian -SampleIndex 2
```

## Execution layers

1. **Shell driver** (`.ps1`) — orchestrates steps, writes trace JSONL, exit 0 = pass
2. **Obsidian CLI** — `obsidian restart | eval | seek:search | seek:open | …`
3. **Optional screenshot** — `obsidian dev:screenshot path=<gitignored dir>`
4. **Parse + canvas emit** — `Emit-CanvasRunJson.ps1` → append to canvas `RUNS[]`

**Serial CLI rule:** one Obsidian session; no parallel eval (see `seek-cli-startup-debug`).

## Registry

Machine-readable registry: `playbook-scenarios.json`. Columns:

| Column | Meaning |
|--------|---------|
| `id` | `S1` … `S7`, `F1` … `F10` |
| `name` | Short label |
| `driverScript` | Relative path under this skill |
| `vaultDefault` | Default vault CLI name |
| `executionMode` | `cli`, `cli+eval`, `cli+eval+screenshot` |
| `status` | `stub` or `full` |
| `detailSkill` | `seek-telemetry-playbook` (S*) or `seek-functional-telemetry` (F*) |

## Detail playbooks

- **Performance timing (S*):** `.cursor/skills/seek-telemetry-playbook/SKILL.md`
- **Functional user flows (F*):** `.cursor/skills/seek-functional-telemetry/SKILL.md`
- **Startup CLI probes:** `.cursor/skills/seek-cli-startup-debug/SKILL.md`

## Canvas

Run history dashboard: `canvases/sandbox-run-history.canvas.tsx` (Seek telemetry baselines). Drivers append via `Emit-CanvasRunJson.ps1`.

## Fixtures

Functional query matrix: `fixtures/minimal/` and `fixtures/full/functional-queries.json` — validated by `src/test-harness/functional-telemetry/validate-fixture.test.ts`.
