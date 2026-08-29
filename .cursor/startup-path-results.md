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
| G_small_delta | Peer changed 1–50 notes | ≤ 10–15 s | — | — | pending |
| G_noop_sync | Peer churn, needed: 0 | ≤ 1.5 s | — | — | pending |
| G_first_good | Recent notes searchable early | ≤ 10 s | greedy-hydrate | — | blocked (no fresh ids) |
| G_cold_recovery | Full cold hydrate | −15–35% chunk | — | — | pending |
| G_ui_responsive | Editor usable during Starting | eval ≤ 2 s | — | — | pending |
| G_eviction | After minimize / eviction | mutex ≤ 2 s | — | — | pending |
| G_catchup_chunk | Large catch-up chunk phase | −20% chunk | — | — | pending |
| G_catchup_ux | 4k backlog, search early | T_first_hit ≤ 30 s | — | — | pending |

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
| Run A cold-restart (2026-08-28) | 1360 | null (120s cap) | null | **blocked** — skip-rechunk; greedy tiers never ran |

Notes: session `b9ce028a`; sidecar-hydrate span 763ms; gate-test failed @ 13.6s; no `startup-gate` released. Needs controlled fresh-id or peer-delta scenario (G2/G3) to score SLOs.

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
| _pending_ | | | code shipped @ 2894abf; merged into path/compose; Run B measure |

Constants: `DESKTOP_CATCHUP_MAX_FILES_PER_BURST=40`, `DESKTOP_CATCHUP_BURST_BUDGET_MS=15000`

### batch-rpc (`path/batch-rpc`)

Goals: G_cold_recovery, G_catchup_chunk

| run | token_counts_rpc | T_hydrate_ms | T_chunk_ms | verdict |
|-----|------------------|--------------|------------|---------|
| _pending_ | ~554 est. (8× batch) | | | code shipped @ 00d404c; `TOKEN_COUNTS_BATCH=8`; merged into path/compose |

### persist-cache (`path/persist-cache`)

Goals: G_eviction

| scenario | mutex_hold_ms | delta_incremental | verdict |
|----------|---------------|---------------------|---------|
| _pending_ | | | WIP in stash |

## Compose (`path/compose`)

| paths_included | goal | expected_combo | actual_combo | interaction | ship? |
|----------------|------|----------------|--------------|-------------|-------|
| T1+T2+T3+T4+T5 | quick startup | full stack | @ 2e4103d compose | worktrees isolated | building |

Handoffs: `.cursor/handoff/T1.json` … `T6.json`
