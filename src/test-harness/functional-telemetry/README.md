# Functional telemetry harness

Vitest contracts for functional playbook fixtures and trace parsers — no Obsidian runtime required.

| Path | Role |
|------|------|
| `validate-fixture.test.ts` | Asserts `functional-queries.json` shape (30 cases, 3×10 intents, distinct queries) |
| `parse-functional-trace.test.ts` | Parser contracts for F* driver JSONL (when added) |

Playbook entry point: `.cursor/skills/seek-playbook-catalog/SKILL.md`
