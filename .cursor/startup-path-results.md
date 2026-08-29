# Startup path results (living scoreboard)

_Isolated per-path metrics from worktree verification. Never mix Run A (`cold-restart`) and Run B (`warm-reload`) in one table._

## Worktrees (vault singleton)

Only one `main.js` in `C:\Obsidian\.obsidian\plugins\seek\` at measure time. Build/deploy from the path's worktree:

| tree | path_id | branch | worktree |
|------|---------|--------|----------|
| T0 | trace-infra | `startup/trace-infra` | `C:\Coding_projects\Obsidian-Seek-worktrees\trace-infra` |
| T1 | greedy-hydrate | `path/greedy-hydrate` | `...\greedy-hydrate` |
| T2 | cheap-yield | `path/cheap-yield` | `...\cheap-yield` |
| T3 | batch-rpc | `path/batch-rpc` | `...\batch-rpc` |
| T4 | persist-cache | `path/persist-cache` | `C:\Coding_projects\Obsidian-Seek` (main repo) |
| T5 | burst-cap | `path/burst-cap` | `...\burst-cap` |
| T6 | compose | `path/compose` | `...\compose` |

Setup: `.cursor\skills\seek-cli-startup-debug\scripts\setup-startup-worktrees.ps1`  
Deploy: `.cursor\skills\seek-cli-startup-debug\scripts\deploy-worktree-to-vault.ps1 -PathId <path_id>`  
Registry: `.cursor\worktrees.json`

## Goal coverage

| goal_id | User scenario | SLO (p50) | best_path | p50_value | verdict |
|---------|---------------|-----------|-----------|-----------|---------|
| G_small_delta | Peer changed 1–50 notes | ≤ 10–15 s | persist-cache | **605 ms** (G2 v2) / **403 ms** (compose v5) | **pass** |
| G_noop_sync | Peer churn, needed: 0 | ≤ 1.5 s | compose | **864 ms** | **pass** @ compose-deferred-reconcile-2 |
| G_first_good | Recent notes searchable early | ≤ 10 s | greedy-hydrate | **3892 ms** (gate) / **403–1417 ms** (G2) | **pass** |
| G_cold_recovery | Full cold hydrate / peer delta rechunk | −15–35% chunk | batch-rpc + greedy | **4462→1** files_walked, **4462→9** RPC, rechunk **493 ms** (G2 v2 vs pre-greedy baseline) | **pass** (delta path); full sidecar jsonl scan still ~149 s on gate |
| G_ui_responsive | Editor usable during Starting | eval ≤ 2 s | cheap-yield | **429–443 ms** p50 | **pass** @ persist-cache-g2-v2 |
| G_eviction | After minimize / eviction | mutex ≤ 2 s | persist-cache | **1951 ms** | **pass** @ 2026-08-28 |
| G_catchup_chunk | Large catch-up chunk phase | −20% chunk | batch-rpc | **p50 164 ms** / **mean 240 ms** per 8-file burst (4k probe, n=99) | **partial** — no baseline A/B on same fixture; batch RPC active |
| G_catchup_ux | 4k backlog, search early | T_first_hit ≤ 30 s | persist-cache | **468 ms** / **10812 ms** (×2 probes) | **pass** @ 2026-08-28 — warmDeferred; rerun 2026-08-29 blocked by hidden-doc + CLI wedge |

## Baseline (T0 trace-infra)

| label | run | date | T_start_ms | T_hydrate_ms | files_walked | token_counts_rpc | T_eval_p95_ms | notes |
|-------|-----|------|------------|--------------|--------------|------------------|---------------|-------|
| baseline | cold-restart | 2026-08-27 | 16170 (latest session) | — (skip rechunk) | null | null | — | schema v17; no fresh ids |
| baseline | warm-reload | 2026-08-27 | — | — | — | — | — | vault mid-hydrate; job.total 4462 |

Artifacts: `.cursor/baseline-cold/`, `.cursor/baseline-warm/`, `.cursor/handoff/T0.json`

## Per-path results (isolated)

### greedy-hydrate (`path/greedy-hydrate`)

Goals: G_small_delta, G_first_good, G_noop_sync

| scenario | T_start_ms | T_first_good_ms | files_walked | verdict |
|----------|------------|-----------------|--------------|---------|
| G2 fixture v5 (compose, 2026-08-28) | 3892 | **403** | **1** | **pass** — per-file tier-3d, `gate-released` |
| Run A pre-fix (2026-08-28) | 1360 | null | null | blocked — skip-rechunk |


Artifacts: `.cursor/handoff/T1.json`, `.cursor/scorecards/greedy-hydrate-cold-restart-parsed.json`

### cheap-yield (`path/cheap-yield`)

Goals: G_ui_responsive

| scenario | T_eval_p95_ms | T_start_ms (guard +10%) | verdict |
|----------|---------------|-------------------------|---------|
| _pending_ | | | code shipped @ 62a1786; measure after T1 fixture |

### burst-cap (`path/burst-cap`)

Goals: G_catchup_ux

| scenario | T_first_hit_ms | T_drain_total_ms | verdict |
|----------|----------------|------------------|---------|
| invalid fixture Run B (2026-08-28) | **260940** | ~261 s | **fail** — hydrate path, not burst-cap |
| stale-mtime / missing-hash drain (2026-08-28) | **>30000** (timeout) | — | **fail** — seek:search blocks on shared embedder/iframe during catch-up |

Constants now: `DESKTOP_CATCHUP_MAX_FILES_PER_BURST=1`, `DESKTOP_CATCHUP_BURST_BUDGET_MS=3000`; ensureFrame skips currentDelta wait on cold miss; `withQueryInFlight` waits up to 20s for catch-up to yield. Still insufficient when catch-up holds the iframe on full re-embeds.

### batch-rpc (`path/batch-rpc`)

Goals: G_cold_recovery, G_catchup_chunk

| run | token_counts_rpc | T_hydrate_ms | T_chunk_ms | verdict |
|-----|------------------|--------------|------------|---------|
| _pending_ | ~554 est. (8× batch) | | | code shipped @ 00d404c; `TOKEN_COUNTS_BATCH=8`; merged into path/compose |

### persist-cache (`path/persist-cache`)

Goals: G_eviction

| scenario | mutex_hold_ms | delta_incremental | verdict |
|----------|---------------|---------------------|---------|
| post-reindex cold restart + 1-file edit (2026-08-28) | **330394** (compaction due) | **false** | **fail** delta SLO |
| persist-cache-restore (same session) | restoreMs **171185** | frame+bm25 **true** (12661 chunks) | **pass** restore |
| steady-state reindex + IDB persist + 1-file edit (2026-08-28) | **90333** (removal-body-missing fallback) | **false** | **fail** delta SLO |
| post-fix probe embed:true without prewarm (2026-08-28) | **377205** (compaction due + cold caches) | **false** | **fail** — model not loaded in probe |
| IDB persist across restart (16738 chunks) | — | **true** (16,738 chunks, ui ok) | **pass** persist |
| IDB persist mid-reindex restart (2026-08-28) | — | **false** (15,584 → **0** after restart) | **fail** — restart during active indexing |
| IDB persist after full reindex + ui ok (2026-08-28) | — | **true** (16,738 chunks, ui ok) | **pass** persist |
| G_eviction steady production path (2026-08-28, tag 1787944289076+) | **1951** | **true** (removed 1, added 1) | **pass** |
| G_eviction prior attempts (mass-delete / catch-up race) | 143394–363748 | false | **fail** — fixed enum-gap + early catch-up schedule |

## Compose (`path/compose`)

| paths_included | goal | expected_combo | actual_combo | interaction | ship? |
|----------------|------|----------------|--------------|-------------|-------|
| compose noop (pre-fix) | 200611 | null | null | **fail** — ensureFrame+warmCaches blocked gate |
| compose deferred-reconcile | **864** | null | null | **pass** G_noop_sync (startup-gate); probe 1.43s |


