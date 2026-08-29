# T6 — compose

**PR:** #14 · **Branch:** `path/compose-integration` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

Individual optimizations can each look successful in isolation yet break the product when combined — like tuning three departments separately until nobody can ship an order. Seek’s startup stack (greedy hydrate, batch RPC, persist restore, burst cap, yield) passed local tests on separate branches, but the merged vault regressed: noop peer sync blocked ~**200 s**, catch-up and restore fought over the database, and search timed out during backlog drain.

The underlying software concepts are **system integration**, **shared mutable state**, and **boot orchestration**. Multiple async pipelines (`reconcileOnLoad`, `restorePersistedCaches`, `runCatchUp`, `warmCaches`) raced on the same **IndexedDB mutex** and **iframe runner** without a unified policy for *when* each runs. That produces **emergent deadlocks and double work** — e.g. awaiting full warm before drain, or reconcile blocking the gate when `needed: 0`. Integration testing across feature flags is as important as unit-level perf wins.

T6 wires one boot story: deferred reconcile, drain-first catch-up, query-priority iframe, `warmDeferred`, mass-delete guards, ensureBm25 fix. **7/8 goals pass** on vault (noop **864 ms**, G2 **605 ms**, UI **429 ms**). **Verdict:** objective complete; `G_catchup_chunk` partial.

**Concepts worth researching:** integration vs unit performance testing · async boot orchestration · race conditions on shared stores · feature interaction matrix · deferred work / `void` fire-and-forget reconcile · idempotent warm paths · SLO regression guards

## 2. Why the bottleneck existed

Independent path branches optimized local SLOs but **interfered when combined**:

- **Noop sync ~200 s** — `reconcileOnLoad` + `ensureFrame` + `await warmCaches('startup')` blocked gate even when peer `needed: 0`.
- **IDB write races** — T4 restore + T5 drain + startup warm contended on `currentDelta` / mutex.
- **Double ensureFrame / BM25 fit** — search and catch-up both missed cache and rebuilt concurrently.
- **Invalid probe fixtures** — cleared file records triggered hydrate path instead of catch-up (261 s false fail).
- **ensureBm25 warm loop** — `warmPromise && !warming` guard missing → test hangs / infinite warm.

Root cause: no unified boot policy for reconcile timing, warm deferral, and iframe priority.

## 3. What we diagnosed

| Interaction | Symptom | Resolution |
|-------------|---------|------------|
| T4 restore + T5 drain | `rem=0` for minutes | Don't await restore/warm before `drainCatchUp` |
| T4 persist + T1 greedy gate | Noop ~200 s | `void reconcileOnLoad()`; early `indexGoodEnough` |
| Startup warm + catch-up | IDB hang | `warmDeferred`, async boot warm, light frame |
| Search + catch-up | 30s+ timeout | Query-priority iframe + stale frame during write |
| Mass-delete guard missing | 90s+ false rebuild | `shouldDeferMassDelete` |
| G2 double-restart | Fixture reconciled before probe | `prepare-g2-fresh-id-fixture.ps1` no pre-restart |
| ensureBm25 warm loop | Tests hang | Allow warm owner through when `warmPromise && !warming` |

**Verification matrix:** compose-noop, compose-g2-v5, persist-cache-g2-v2, g-eviction-steady, catchup-ux-backlog-4k.

## 4. How we solved it

1. **Deferred reconcile** — `void reconcileOnLoad()` off boot IIFE; gate releases during tier-0 greedy before mtime sweep completes.
2. **Drain-first catch-up** — `runCatchUp` immediately; no await on multi-minute restore.
3. **`warmDeferred`** — background warm no-ops while `catchUpPending || catchUpRunning`.
4. **Query-priority iframe** — single-flight pump; `embed` (query) ahead of `embed-batch` (`src/iframe-runner.ts`).
5. **Stale frame during writes** — `ensureFrame` serves generation-matched or stale frame while `isWriting()`; skip `listAllMeta` under `currentDelta`.
6. **ensureBm25 warm-owner fix** — stop infinite warm loop in tests and vault.
7. **Desktop catch-up when hidden** — CLI/headless drain (`document.hidden`).
8. **Probe/heal scripts** — `heal-catchup-backlog-fixture.ps1`, `run-catchup-ux-probe.ps1`, G2 fixture prep.

**Key files:** `src/main.ts`, `src/search.ts`, `src/iframe-runner.ts`, `src/catchup.ts`, `src/sidecar-sync.ts`.

### 4.1 Measurements / evidence

| Goal | Run | Baseline | Measured | SLO | Verdict |
|------|-----|----------|----------|-----|---------|
| G_noop_sync | A | ~200,611 ms | **864 ms** | ≤ 1.5 s | **Pass** |
| G_first_good | A | ~87 s | **403–605 ms** | ≤ 10 s | **Pass** |
| G_small_delta | A | ~87 s | **605 ms** (G2 v2) | ≤ 10–15 s | **Pass** |
| G_ui_responsive | A | — | **429 ms** p50 eval | ≤ 2 s | **Pass** |
| G_cold_recovery | A | 4462 RPC / files | **9 RPC**, **1 file**, **493 ms** rechunk | −15–35% | **Pass** (delta) |
| G_eviction | A | ~25.8 s | **1,951 ms** mutex | ≤ 2 s | **Pass** |
| G_catchup_ux | B | — | **468 ms** / **10.8 s** | ≤ 30 s | **Pass** |
| G_catchup_chunk | B | — | **164 ms** p50 / burst (n=99) | −20% vs baseline | **Partial** |

**Scorecards:** `compose-deferred-reconcile-2-*`, `persist-cache-g2-v2-cold-restart-parsed.json`, `persist-cache-catchup-ux-backlog-4k-*`

**Deploy:** `path/persist-cache @ 474dfb2`, `main.js` 366,750 bytes → `C:\Obsidian\.obsidian\plugins\seek\`

**Still open:** G_catchup_chunk baseline A/B; optional frame IDB persist (~171 s restore); delete 8 `Seek-G2-Fixture-*.md` vault notes.
