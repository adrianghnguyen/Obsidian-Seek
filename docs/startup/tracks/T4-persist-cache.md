# T4 — persist-cache

**PR:** #13 · **Branch:** `path/persist-cache` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

When Windows or Electron reclaims memory, Seek may lose its in-RAM search caches. The next boot can look like “rebuild everything from scratch” — search locked out while the plugin deletes and re-assembles tens of thousands of index chunks. Users experience this as a multi-minute stall after leaving Obsidian idle or minimizing it, even for a small edit afterward.

The core concepts are **cache persistence**, **write mutex serialization**, and **cold vs incremental recovery**. Seek keeps a resident **frame** (chunk metadata + binary vectors) and a **BM25** text index in memory; after eviction they are null. Rebuilding under a single **write mutex** blocks both search and incremental updates. We initially suspected BM25 rebuild was the villain; measurement **falsified** that — BM25 fit is ~300 ms; the cost is **mass chunk deletes** and **frame assembly from IndexedDB**. A secondary trap was **incomplete enumeration** triggering false “mass delete everything” paths.

T4 persists BM25 to IndexedDB, restores caches before reconcile, and guards truncated enumeration with `shouldDeferMassDelete()`. Steady eviction path: **1951 ms** mutex (SLO ≤ 2 s). Frame is not yet persisted (~171 s cold restore remains). **Verdict:** pass on steady path; partial on frame restore and 1-file fallback edge case.

**Concepts worth researching:** process eviction / memory pressure · IndexedDB persistence · read-through vs write-through caches · mutex / lock contention · incremental vs full rebuild · MiniSearch / BM25 index lifecycle · false-positive deletion guards

## 2. Why the bottleneck existed

When frame/BM25 resident caches were null after eviction or long idle:

- **`ensureFrame` + `getBodiesMap` + BM25 fit** ran under the write mutex before incremental deltas could proceed.
- **~16k chunk deletes** in “cold caches” recovery dominated mutex time — not BM25 fit alone (~300 ms).
- **Truncated vault enumeration** could trigger false mass-delete sweeps (90s+ fallbacks).
- **Reconcile on boot** with null caches forced full cold rebuild paths instead of incremental applyDelta.

Initial hypothesis T1 (“BM25 cold-cache costs tens of seconds”) was **falsified** — mutex time is chunk deletes and frame assembly, not MiniSearch fit.

## 3. What we diagnosed

| Finding | Evidence |
|---------|----------|
| T1 BM25 tens of seconds | **Falsified** — BM25 ~300 ms; mutex is delta deletes |
| T2 hidden eviction → expensive boot | **Supported** — 12/12 evicted; recoveries show `cold caches` pattern |
| IDB BM25 persist works | **16,738 chunks** persisted across restart — ui ok |
| Cold restore slow | `restoreMs` **171,185 ms** (12k chunks); frame from IDB meta+binary, not blob |
| 1-file delta fallback | `removal-body-missing` → **90,333 ms** mutex, `incremental: false` |
| Steady path after fixes | **1,951 ms** mutex, incremental delta **true** (compose stack) |
| Mass-delete false positive | Fixed with `shouldDeferMassDelete()` — enum-gap guard |

**Early probes failed** (compaction due, mid-reindex restart, embed:false 4k reindexDelta). Steady 1-file edit path passes after compose integration.

## 4. How we solved it

1. **`persistBm25()` / `getBm25()`** — serialize warmed MiniSearch to IDB after warm/delta.
2. **`restorePersistedCachesBeforeReconcile()`** — before first `applyDelta` on boot: `ensureFrame()` + `tryLoadPersistedBm25()`.
3. **`shouldDeferMassDelete()`** — guard truncated enumeration in `computeDelta` / `reindexDelta`.
4. **Dirty-only reconcile** — schedule catch-up instead of embed:false `reindexDelta` on 4k dirty files.
5. **Early `catchUpPending`** — do not block drain on multi-minute restore.
6. **Tests** — `src/persist-cache-startup.test.ts` (restore paths).

**Key files:** `src/search.ts`, `src/main.ts`, `src/persist-cache-startup.test.ts`.

### 4.1 Measurements / evidence

| Scenario | Run | Baseline | Measured | SLO | Verdict |
|----------|-----|----------|----------|-----|---------|
| G_eviction steady (1-file edit) | A | ~25,800 ms | **1,951 ms** mutex | ≤ 2 s | **Pass** |
| IDB persist across restart | A | — | **16,738 chunks**, ui ok | — | **Pass** |
| Cold restore `ensureFrame` | A | — | **171,185 ms** (12k) | Frame not persisted | **Partial** |
| 1-file delta after cold restore | A | — | **90,333 ms**, `removal-body-missing` | Incremental | **Fail** (edge case) |

**Limitations (documented):** Frame not in IDB; optional follow-up would cut ~171–204 s restore. Fix `removal-body-missing` applyDelta fallback for 1-file edits.

**Commit:** `2e4103d` — `perf(startup): restore BM25 cache from IDB before reconcile delta`
