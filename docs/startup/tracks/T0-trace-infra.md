# T0 — trace-infra

**PR:** #8 · **Branch:** `startup/trace-infra` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

If you restart Obsidian and search feels “stuck on Starting” for a minute, the first question is: *which part* of startup is slow — loading the plugin, syncing notes from a peer, building the search index, or catching up after a reload? Before this track, we could not answer that reliably. Numbers from “restart Obsidian” and “reload the plugin” were mixed in the same tables, so a team might optimize catch-up behavior while the real problem was cold-start hydrate, or vice versa.

From an engineering standpoint, the bottleneck was **missing observability and experimental controls**, not a single slow function. Seek’s startup spans several phases (hydrate, gate release, catch-up drain), each triggered by different events. Without structured logging (forensics beats), a serial probe protocol, and isolated git worktrees, every optimization branch risked **confounding variables** — measuring the wrong run type, a polluted vault state, or the wrong build of `main.js`. That is a classic **measurement validity** problem: you cannot improve what you cannot isolate.

T0 adds the measurement layer: Run A (cold restart) vs Run B (warm reload), NDJSON gate traces, scorecard parsers, and one deployed branch at a time. This track ships no user-facing speedup; it makes T1–T6 trustworthy. **Verdict:** shipped — Run A baseline recorded (`T_start` ≈ 16.2 s on skip-rechunk boot).

**Concepts worth researching:** observability / structured logging · A/B vs confounded experiments · cold start vs warm path · git worktrees for parallel feature validation · SLOs and p50 metrics · CDP / devtools buffer limits

## 2. Why the bottleneck existed

Before trace-infra, there was no disciplined way to answer “how long until search works?” on a real vault:

- **Run types were conflated.** Cold restart (hydrate + gate) and warm reload (catch-up) measure different subsystems but were often compared in one table.
- **Hydrate was a black box.** The sidecar hydrate IIFE, `reChunkLive` walks, and gate release had no structured timeline in `seek-report.json`.
- **CDP buffer limits** hid early startup events unless forensics were flushed deliberately.
- **Concurrent path deploys** meant the vault could be running an unknown mix of features during probes.

Without labeled Run A / Run B artifacts, every feature track risked optimizing the wrong phase or reporting polluted numbers (e.g. a cold probe that spawned 4k+ catch-up and invalidated Run B baselines).

## 3. What we diagnosed

| Finding | Evidence |
|---------|----------|
| Search blocked ~87 s after cold restart | H2 **Supported** — `warmPhase: starting` until hydrate IIFE finished |
| Hydrate dominated by `reChunkLive`, not embed | H1 **Supported** — chunk/embed ratio 48–185× on 4k passes |
| Historical logs mixed runs | Run B baseline polluted: 4,461 `job.remaining` after a cold H2 session |
| Skip-rechunk boots hide rechunk-live | T0 handoff: no fresh sidecar ids → `rechunk-live` never emitted; greedy tiers untestable without G2 fixture |
| Need explicit hydrate attribution | H4 **Supported** — no `cheapYield`; long tasks unattributed before `TaskContext: hydrating` |

**Probe protocol decisions:** Run A stops when `warmPhase: null` (do not wait for catch-up). Run B requires idle precheck (`uiHealth: ok`, `remaining === 0`). One `seek:search` gate test during Starting only on Run A.

**Artifacts:** `.cursor/handoff/T0.json`, `.cursor/baseline-cold/`, `.cursor/baseline-warm/`, hypothesis report Run A/B tables.

## 4. How we solved it

1. **`startup-trace-probe.ps1`** — Serial gate polling (1–2 s), NDJSON to `.cursor/gate-trace.jsonl`, scorecard copy on completion. Supports `-Run A` (cold-restart) and `-Run B` (warm-reload) with distinct stop conditions.
2. **`parse-startup-trace.mjs`** — Merges gate trace + `seek-report.json` into comparable parsed scorecards.
3. **Schema v17 forensics** — `rechunk-live`, `startup-span`, `startup-gate` beats; `TaskContext: hydrating` for long-task attribution (`src/logger.ts`, `src/task-context.ts`, `src/types.ts`).
4. **Deploy script** — `deploy-worktree-to-vault.ps1` from the main repo checkout; Cursor agent worktrees via `.cursor/worktrees.json`.
5. **Living scoreboard** — `.cursor/startup-path-results.md` and per-track `.cursor/handoff/T{n}.json`.

**Key files:** `src/logger.ts`, `src/main.ts` (gate bundle exposure), `src/search.ts` (startup-gate hooks), `.cursor/skills/seek-cli-startup-debug/scripts/*`.

### 4.1 Measurements / evidence

| Metric | Run | Baseline / context | Measured | SLO | Verdict |
|--------|-----|-------------------|----------|-----|---------|
| `T_start_ms` | A (cold-restart) | Historical ~87 s gate block | **16,170 ms** | Record baseline | n/a (skip-rechunk boot) |
| `schema_version` | A | — | **17** | — | Forensics active |
| Run B precheck | B | Idle required | Failed once (mid-hydrate session) | — | Documented caveat |

**Scorecards:** `.cursor/scorecards/baseline-cold-restart-parsed.json`, `.cursor/scorecards/baseline-warm-reload-parsed.json`

**Note:** 16.2 s Run A did not exercise full `reChunkLive` (no fresh ids). Feature tracks use G2/G3 fixtures on top of this protocol.
