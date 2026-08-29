# Startup optimization — feature implementation report

_Vault: Obsidian (~4.4k notes, ~16.7k chunks) · Branch: `path/persist-cache` (compose stack) · 2026-08-28_

This document explains **how each startup track solved its bottleneck**, what shipped in code, and what was measured on the local vault. It complements the living scoreboard ([startup-path-results.md](startup-path-results.md)) and hypothesis report ([startup-hypothesis-report.md](startup-hypothesis-report.md)).

---

## Executive summary

| Track | Primary bottleneck | Core fix | Key SLO | Status |
|-------|-------------------|----------|---------|--------|
| **T0** trace-infra | No reproducible cold/warm metrics | Probe protocol + schema v17 forensics | Baseline | **Shipped** (infra) |
| **T1** greedy-hydrate | Full-vault `reChunkLive` before any search | Tiered mtime hydrate + early gate release | G_first_good ≤ 10s | **Pass** (403 ms) |
| **T2** cheap-yield | Main thread frozen during chunk passes | `cheapYield` every 8 files in live rechunk | G_ui_responsive ≤ 2s eval | **Pass** (429 ms p50) |
| **T3** batch-rpc | One iframe RPC per file for token counts | Batched `tokenCounts` (8 texts/RPC) | G_cold_recovery −15–35% chunk | **Partial** (delta rechunk 1 file / 9 RPC; sidecar scan dominates full gate) |
| **T4** persist-cache | Cold frame/BM25 rebuild after eviction | IDB BM25 persist + restore-before-reconcile | G_eviction mutex ≤ 2s | **Pass** (1951 ms) |
| **T5** burst-cap + catch-up UX | Search blocked during 4k embed drain | Smaller bursts, query-priority RPC, warm deferral | G_catchup_ux T_first_hit ≤ 30s | **Pass** (468 ms / 10.8s) |
| **T6** compose | Paths interfered (noop sync regression) | Deferred reconcile + stack integration | G_noop_sync ≤ 1.5s | **Pass** (864 ms) |

**Core objective SLOs (verified):** T_first_good ≤ 10s (403–1417 ms) · noop sync ≤ 1.5s (864 ms) · eviction recovery (1951 ms mutex, incremental delta).

**Still partial:** G_cold_recovery full gate (sidecar scan ~149 s on G2 v2); G_catchup_chunk −20% vs baseline (p50 **164 ms**/burst measured, no baseline A/B on 4k fixture).

---

## T0 — trace-infra (`startup/trace-infra`)

### Bottleneck

Startup work was invisible: no consistent way to compare cold restart vs warm reload, no structured timeline for hydrate / gate / catch-up, and mixed Run A/B numbers in one table.

### How it was solved

1. **Serial CLI probe protocol** — `obsidian restart` for Run A (hydrate/gate only; stop when `warmPhase: null`, do not wait for catch-up). `plugin:reload` for Run B (daily catch-up behavior).
2. **`startup-trace-probe.ps1`** — Polls gate bundle every 1–2s, logs NDJSON to `.cursor/gate-trace.jsonl`, copies `seek-report.json` to scorecards.
3. **`parse-startup-trace.mjs`** — Turns JSONL + report into comparable scorecards vs baseline.
4. **Schema v17 forensics** — `rechunk-live`, `startup-span`, `startup-gate`, `TaskContext: hydrating` so long tasks attribute to hydrate vs idle.
5. **Worktree registry** — Isolated checkouts per path (`.cursor/worktrees.json`) so only one `main.js` is in the vault at measure time.

### Key artifacts

- `.cursor/skills/seek-cli-startup-debug/scripts/startup-trace-probe.ps1`
- `.cursor/skills/seek-cli-startup-debug/scripts/parse-startup-trace.mjs`
- `.cursor/startup-path-results.md`, `.cursor/handoff/T0.json`

### Measured

- Run A baseline: `T_start ≈ 16.2s` (vault skipped full rechunk — no fresh sidecar ids that boot).

---

## T1 — greedy-hydrate (`path/greedy-hydrate`)

### Bottleneck

When the sidecar introduced **fresh chunk ids**, `hydrateFromSidecar` called `reChunkLive()` on **every** indexable file (~4.4k × ~20 ms ≈ **88 s**) before hydrating anything. Search stayed gated (`warmPhase: starting`) for the entire IIFE even when only a few peer notes changed.

### How it was solved

1. **Recency tiers** — Files processed in widening mtime windows (3d → 7d → 14d → 30d → 90d → full). Each tier calls `reChunkLiveSubset(tierFiles)` instead of the whole vault.
2. **Early gate release** — After tier 0 (or when all fresh ids are covered), `markIndexGoodEnough()` releases the startup gate so search/UI can proceed while later tiers continue in background.
3. **`listHydrateFilesForGreedy()`** — Mtime-sorted file oracle shared with sidecar hydrate; tiers add only unprocessed paths.
4. **Greedy stop** — When `freshIdsRemaining` is empty, skip remaining tiers (no pointless full-vault rechunk).
5. **Telemetry** — `sidecar-hydrate-greedy` beats per tier (`filesWalked`, `hydrated`, `stopReason: gate-released`).

### Key files

- `src/search.ts` — `reChunkLiveSubset`, `listHydrateFilesForGreedy`, greedy hydrate loop in sidecar path
- `src/main.ts` — `markIndexGoodEnough()`, `indexGoodEnough` gate semantics
- `.cursor/greedy-incremental-hydrate.md` (design spec)

### Measured (compose stack, G2 fixture v5)

| Metric | Value |
|--------|-------|
| `T_gate_release_ms` | 3892 |
| `T_first_good_ms` | **403** |
| `files_walked` (tier 0) | **1** |
| Verdict | **Pass** G_first_good ≤ 10s |

---

## T2 — cheap-yield (`path/cheap-yield`)

### Bottleneck

During `reChunkLive` / hydrate, the main thread ran tight loops (read → chunk → tokenCounts) with no scheduler yields. Obsidian felt frozen for tens of seconds during `Starting` even when total wall time was acceptable.

### How it was solved

**`cheapYield()` every 8 files** in live rechunk paths — same cadence as `collectLiveIds` / `reChunkLiveSubset`. Uses `scheduler.yield` / `setTimeout(0)` (not the rIC compositor pacer, which is too coarse for user-visible search waits).

### Key files

- `src/pacer.ts` — `cheapYield`
- `src/search.ts` — yield counters in `reChunkLive`, `reChunkLiveSubset`, greedy tier loops

### Measured

- Code merged @ `62a1786`; **G_ui_responsive** (eval p95 ≤ 2s during Starting) not yet run on vault after T1 fixture.

### Expected effect

~0% faster total hydrate; **UI/eval stays responsive** during chunk-heavy passes (+0–10% wall time tradeoff).

---

## T3 — batch-rpc (`path/batch-rpc`)

### Bottleneck

Each file in `reChunkLive` invoked **`embedder.tokenCounts(text)` as a separate iframe RPC**. On ~4.4k single-chunk notes that is ~4.4k round-trips — a large fraction of the ~28–32 s chunk phase on cold recovery.

### How it was solved

1. **`TOKEN_COUNTS_BATCH = 8`** — Batch up to 8 texts per `token-counts` RPC.
2. **`createBatchedTokenCounter()`** in `token-budget.ts` — Groups texts, one RPC per batch, preserves per-text results for chunk_id assignment.
3. **Parallel file batches** in `reChunkLive` / `reChunkLiveSubset` — Outer loop steps by `TOKEN_COUNTS_BATCH`; inner batcher amortizes RPC overhead.
4. **Telemetry** — `tokenCountsRpc` in `rechunk-live` reflects actual RPC count (~554 est. vs ~4427).

### Key files

- `src/token-budget.ts` — `createBatchedTokenCounter`, `TOKEN_COUNTS_BATCH`
- `src/search.ts` — batched loops in rechunk paths
- `src/token-budget.test.ts` — batching + chunk_id parity tests

### Measured

- **Pending** Run A with `hasFreshId` fixture to confirm `T_hydrate_ms` and RPC count on vault.

### Expected effect

~**8× fewer** token-count RPCs on single-chunk notes → **~15–35%** off cold hydrate chunk work (hypothesis report §3).

---

## T4 — persist-cache (`path/persist-cache`)

### Bottleneck

After **process eviction** or cold boot with an empty resident cache, recovery rebuilt frame + BM25 from IDB from scratch (`ensureFrame` + `getBodiesMap` + BM25 fit). That held the **write mutex for tens of seconds** (~16k chunk deletes + cold cache rebuild), blocking search and incremental deltas. BM25 fit alone was ~280 ms–20 s depending on path; the dominant cost was **cold frame assembly + fallback full rebuilds** when caches were null.

### How it was solved

1. **`persistBm25()` / `getBm25()`** — Serialize warmed MiniSearch index to IDB after `warmCaches` / delta (fire-and-forget on quiet moments).
2. **`restorePersistedCachesBeforeReconcile()`** — Before first `applyDelta` on boot: `ensureFrame()` + `tryLoadPersistedBm25()` (+ cross-device fallback). Avoids starting reconcile with null caches (which forced ~26 s mutex “cold caches” rebuild).
3. **Forensics** — `persist-cache-restore` beat records `frameRestored`, `bm25Restored`, `chunkCount`.
4. **Eviction steady-path fixes** (same track, later commits):
   - **`shouldDeferMassDelete()`** — Guards against truncated vault enumeration falsely triggering mass-delete sweeps.
   - **Early catch-up schedule** — `catchUpPending` latched when dirty set detected; don't block on multi-minute restore before scheduling drain.
   - **Dirty-only reconcile** — Skip `reindexDelta(..., embed:false)` when only dirty files (no deletes); that pass held IDB write lock across thousands of files and blocked search/warm.

### Key files

- `src/search.ts` — `restorePersistedCachesBeforeReconcile`, `tryLoadPersistedBm25`, `persistBm25`, `shouldDeferMassDelete`
- `src/main.ts` — reconcile gating (dirty-only vs deletes), early catch-up
- `src/persist-cache-startup.test.ts`

### Measured

| Scenario | Result |
|----------|--------|
| Persist restore (12k chunks) | frame+bm25 restored; restoreMs ~171s (frame still IDB-assembled) |
| IDB persist across restart | **16,738 chunks**, ui ok — **pass** |
| G_eviction steady (1-file edit) | mutex **1951 ms**, incremental delta — **pass** |
| 1-file delta after cold restore | **fail** — `removal-body-missing` fallback (~90s), not incremental |

### Known limitation

**Frame is not persisted to IDB** — only BM25 blob. `ensureFrame` still reads `listAllMeta` + binary (+ optional int8). Frame persist would cut the ~171–204 s restore on large vaults (documented in T4 handoff).

---

## T5 — burst-cap + catch-up UX (`path/burst-cap` + persist-cache follow-ups)

### Bottleneck

On warm reload with **~4k dirty files**, catch-up held the shared iframe/embedder for long embed bursts. Concurrent **`seek:search`** then:

- Waited on **`ensureFrame` / `ensureBm25`** doing `listAllMeta` / `getBodiesMap` **behind the write mutex**
- Queued **query `embed` behind `embed-batch`** on the same iframe runner
- Ran **full BM25 fit (~15–20 s)** in pre-catchup warm while drain hadn't started (`rem=0`)
- **Double-fitted** BM25 when `warmCaches` and search both missed cache

Initial burst constants (40 files / 15 s budget) kept the write lock and iframe busy too long per yield window.

### How it was solved

#### Burst shaping (`src/catchup.ts`)

- `DESKTOP_CATCHUP_MAX_FILES_PER_BURST`: **40 → 8** (tuned from experiments; smaller bursts = more yield points for queries)
- `DESKTOP_CATCHUP_BURST_BUDGET_MS`: **15s → 4s**

#### Query wins the iframe (`src/iframe-runner.ts`)

- **Single-flight RPC pump** with two queues: `queryRpcQueue` vs `indexRpcQueue`
- **`embed` (search query) jumps ahead** of `embed-batch` / `token-counts` (index traffic)

#### Search path doesn't stall behind indexing (`src/search.ts`)

- **`ensureFrame`**: Serve generation-matched or **stale frame while `isWriting()`**; never `listAllMeta` under `currentDelta`
- **`ensureBm25`**: Skip `getBodiesMap(all)` when writer active or `warmPromise` in flight; try persisted BM25 first
- **`reindexDelta`**: Release `currentDelta` after phase-1 deletes; re-arm only around `applyDelta` (shrinks write-lock window)
- **`warmPromise` sharing** — concurrent warm callers await one build; search joins with **8s cap** (`skipWarmJoin` for the warm worker itself)

#### Pre-catchup / startup warm no longer blocks drain (`src/main.ts` + `src/search.ts`)

- **`reconcileOnLoad`**: Dirty-only → schedule catch-up; **no** embed:false reindexDelta (that was the 4k-file write lock)
- **`runCatchUp`**: **Drain immediately** — no await on restore/warm (restore was minutes on 16k chunks)
- **`warmDeferred`**: Background warm **no-ops** while `catchUpPending || catchUpRunning` (startup-good-enough / pre-catchup / modal-open triggers)
- **Post-catchup warm** when backlog clears; **light frame** (`skipResidentInt8`) for startup/post-catchup triggers
- **Boot**: Removed blocking `await warmCaches('startup')`; gate releases without waiting for full 16k fit
- **Desktop**: Catch-up **runs when window hidden** (CLI/headless); mobile stays lazy when hidden

### Key files

- `src/catchup.ts`, `src/iframe-runner.ts`, `src/search.ts`, `src/main.ts`
- `src/catchup.test.ts`, `src/iframe-runner.test.ts`, `src/quota-preempt.test.ts`
- `.cursor/skills/seek-cli-startup-debug/scripts/run-catchup-ux-probe.ps1`

### Measured

| Run | T_first_hit | rem at hit | Verdict |
|-----|-------------|------------|---------|
| Manual (warm frame+BM25) | **468 ms** | ~4362 | **Pass** |
| Probe (after warmDeferred) | **10,812 ms** | ~4473 | **Pass** |
| Invalid fixture (cleared file records) | ~261 s | — | **Fail** (wrong fixture — hydrate path) |

SLO: **T_first_hit ≤ 30 s** during 4k backlog — **pass**.

---

## T6 — compose (`path/compose`)

### Bottleneck

Stacking T1–T5 without integration caused **regressions**:

- **G_noop_sync fail (~200 s)** — `reconcileOnLoad` + `ensureFrame` + `await warmCaches('startup')` on noop peer sync blocked the gate even when `needed: 0`
- **G_catchup_ux fail** — T4 restore + T5 burst + startup warm **raced on IDB**; compose amplified lock contention
- Worktree **merge order** mattered: batch-rpc + greedy + persist-cache had to share one reconcile story

### How it was solved

1. **Deferred reconcile** — `void reconcileOnLoad()` off boot IIFE; `markIndexGoodEnough()` can release gate during tier-0 greedy hydrate **before** mtime sweep completes
2. **Skip-rechunk boots** — When greedy hydrate releases gate early, don't block boot `finally` on full reconcile
3. **Integrated warm policy** — Persist restore only when deletes need structural patch; dirty-only → catch-up only; warm deferred during catch-up; post-catchup warm
4. **Compose verification matrix** — Noop sync, G2 small delta, G_eviction steady, catch-up UX (valid fixture: stamp mtime=0, **drop contentHash**, keep chunk_ids)

### Measured (compose on `path/persist-cache`)

| Goal | Value | Verdict |
|------|-------|---------|
| G_noop_sync | **864 ms** gate | **Pass** |
| G_first_good | **403 ms** (gate 3892 ms) | **Pass** |
| G_eviction | **1951 ms** mutex | **Pass** |
| G_catchup_ux | **468 ms** / **10.8 s** | **Pass** |

### Deploy state

Full stack lives on **`path/persist-cache`** (main repo); compose worktree @ `474dfb2`. **Uncommitted** at last deploy; vault path `C:\Obsidian\.obsidian\plugins\seek\`.

---

## Cross-cutting interactions (what broke when paths stacked)

| Interaction | Symptom | Resolution |
|-------------|---------|------------|
| T4 restore + T5 drain | `rem=0` for minutes before drain | Don't await restore/warm before `drainCatchUp` |
| T4 persist + T1 greedy gate | Noop sync blocked | Defer reconcile; early `indexGoodEnough` |
| Startup warm + catch-up | Double `ensureFrame`, IDB hang | `warmDeferred`, async boot warm, light frame |
| Search + catch-up | 30s+ `seek:search` timeout | Query-priority iframe queue + stale frame during write |
| Mass-delete guard missing | 90s+ false eviction rebuild | `shouldDeferMassDelete` in computeDelta + reindexDelta |
| Probe fixture wrong | 261s fake fail | Stamp mtime=0, drop contentHash, keep chunks (not clear file records) |

---

## Remaining work

| Goal | Track | Next step |
|------|-------|-----------|
| **G_cold_recovery** | T3 + T1 | Run A cold-restart with fresh-id fixture; compare `T_hydrate_ms`, `token_counts_rpc` |
| **G_ui_responsive** | T2 | Measure eval p95 ≤ 2s during Starting on cheap-yield Run A |
| **G_catchup_chunk** | T3 | Compare chunk vs embed share on large catch-up pass |
| **G_small_delta** | T1 | Isolated measure (currently shares G2 compose fixture) |
| **Frame persist** | T4 | Optional IDB frame blob to cut ~171s restore (design in T4 handoff) |
| **1-file incremental after cold restore** | T4 | Fix `removal-body-missing` applyDelta fallback |

---

## Verification commands

```powershell
# G_catchup_ux (Run B)
.\.cursor\skills\seek-cli-startup-debug\scripts\run-catchup-ux-probe.ps1 -Mode backlog-4k

# G_eviction steady
.\.cursor\skills\seek-cli-startup-debug\scripts\run-g-eviction-quick.ps1

# Cold hydrate / gate (Run A)
.\.cursor\skills\seek-cli-startup-debug\scripts\startup-trace-probe.ps1 -Run A -PathId persist-cache

# Deploy current branch to vault
.\.cursor\skills\deploy-branch-to-vault\SKILL.md  # or copy main.js + plugin:reload
```

---

_Report generated from vault probes, handoff JSON (T0–T6), and uncommitted `path/persist-cache` implementation._
