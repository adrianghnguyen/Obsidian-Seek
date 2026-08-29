# T4 — persist-cache

**PR:** #13 · **Branch:** `path/persist-cache` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

After process eviction or cold boot with null resident caches, Seek rebuilt frame + BM25 from IDB from scratch — holding the write mutex for tens of seconds (~16k chunk deletes). T4 persists BM25 to IDB, restores caches before reconcile delta, and guards truncated enumeration with `shouldDeferMassDelete()`. On the steady production path, **G_eviction mutex = 1951 ms** with incremental delta (**pass**, SLO ≤ 2 s). Frame is not yet persisted to IDB (~171 s cold `ensureFrame` remains). **Verdict:** pass on steady eviction; known limitations on 1-file fallback and frame restore.

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
