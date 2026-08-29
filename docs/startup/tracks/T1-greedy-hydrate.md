# T1 — greedy-hydrate

**PR:** #9 · **Branch:** `path/greedy-hydrate` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

When the sidecar introduced fresh chunk ids, Seek ran `reChunkLive()` on every indexable file (~4.4k × ~20 ms ≈ **88 s**) before releasing the search gate — even when only one peer note changed. T1 adds tiered mtime hydrate (`reChunkLiveSubset`), greedy stop when fresh ids are exhausted, and early `markIndexGoodEnough()` after tier 0. On the compose stack with the G2 fixture, **T_first_good = 403 ms** with **1 file walked** (SLO ≤ 10 s). **Verdict:** pass.

## 2. Why the bottleneck existed

`hydrateFromSidecar` treated every fresh sidecar chunk id as requiring a **whole-vault live rechunk** before any hydrate embeddings:

- **`reChunkLive()` walked all ~4.4k files** (read → chunk → tokenCounts per file) inside the sidecar IIFE.
- **Search stayed gated** (`warmPhase: starting`, `bootPending: true`) for the entire IIFE — users could not search recent notes until the full walk finished.
- **Small peer deltas were penalized like full cold recovery** — one changed note still triggered O(vault) chunk work.

Root cause: the hydrate oracle had no recency ordering, no subset rechunk, and no early gate release.

## 3. What we diagnosed

| Finding | Evidence |
|---------|----------|
| H1 — hydrate `reChunkLive` dominates | **Supported** — 53–265 s hydrate on cold recovery; chunk 48–185× embed |
| H2 — search gated until IIFE finishes | **Supported** — ~87 s `warmPhase: starting` |
| Isolated greedy probe blocked | Session `b9ce028a`: skip-rechunk boot, sidecar-hydrate 763 ms, **no** `sidecar-hydrate-greedy` tiers; gate-test failed @ 13.6 s |
| Greedy path needs fresh-id fixture | `prepare-g2-fresh-id-fixture.ps1`; compose G2 v5 session `37751f65` |
| Index count drift during long probe | 4277 → 838 files during 120 s cap (reindex in flight) |

**False lead:** Measuring greedy-hydrate on a vault boot without fresh ids — tiers never run, producing a false “blocked” result.

## 4. How we solved it

1. **Recency tiers** — 3d → 7d → 14d → 30d → 90d → full; each tier calls `reChunkLiveSubset(tierFiles)` instead of whole-vault `reChunkLive()`.
2. **Early gate release** — After tier 0 (or when `freshIdsRemaining` empty), `markIndexGoodEnough()` releases startup gate while later tiers continue in background.
3. **`listHydrateFilesForGreedy()`** — Mtime-sorted oracle; greedy stop when all fresh ids covered (`stopReason: gate-released`).
4. **Sidecar sync improvements** — `src/sidecar-sync.ts` oracle and tier telemetry (`sidecar-hydrate-greedy` beats).
5. **Fixture tooling** — `prepare-g2-fresh-id-fixture.ps1` (probe owns cold restart; no double-restart).

**Key files:** `src/search.ts` (`reChunkLiveSubset`, greedy loop), `src/main.ts` (`markIndexGoodEnough`), `src/sidecar-sync.ts`, `src/index-notice.ts`.

### 4.1 Measurements / evidence

| Metric | Run | Baseline | Measured | SLO | Verdict |
|--------|-----|----------|----------|-----|---------|
| `T_first_good_ms` | A (G2 v5 compose) | ~87,000 ms | **403 ms** | ≤ 10 s | **Pass** |
| `T_gate_release_ms` | A | — | **3,892 ms** | — | Gate released tier-0 |
| `files_walked` (tier 0) | A | ~4,427 | **1** | ≪ N_notes | **Pass** |
| `hydrated_tier0` | A | — | **2 chunks** | — | Peer-delta path |
| `greedy_stop_reason` | A | — | `gate-released` | — | — |

**Scorecards:** `.cursor/scorecards/compose-g2-v5-cold-restart-*`, `.cursor/handoff/T1.json` (compose stack metrics)

**Compose stack note:** G_small_delta **605 ms** (G2 v2) and noop gate **864 ms** depend on T6 deferred reconcile; greedy tier-0 is the core delta-path win.
