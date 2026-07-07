# Seek startup performance findings

Benchmark harness: `npm run bench` (`src/test-harness/startup.bench.ts`, corpus seeded via `putBatch` in `corpus.ts`).

> **Status:** Iteration 1 implemented — H7 (persisted BM25 in the warm path) and H1
> (skip redundant boot `saveData`). See [Iteration 1](#iteration-1--implemented-fixes-h7--h1) for
> the fail-fast before/after results.

## Measurement caveat

These numbers come from **Node + fake-indexeddb + a deterministic fake embedder**. They are excellent for **scaling shape and regression detection**, but they are **not** absolute Obsidian / WKWebView latencies. IndexedDB throughput, main-thread scheduling, and iframe model load differ materially on real devices.

For production numbers, use in-app telemetry already wired in v15:

- **`BootEntry`** — per-phase blocking `onload()` timing (`loadDataMs`, `saveDataMs`, `storeOpenMs`, `backfillMs`, `wireMs`, `totalMs`)
- **`CacheWarmEntry`** — `warmCaches()` duration, frame/BM25 split, `bm25Source`, overlap with model load
- **`LoadEntry` / first-search telemetry** — model cold start, `cacheWarmFinishedBeforeModel`, boot → first search

Summarized in the generated log report (`seek-generate-log`).

---

## Bench results (2026-07-07)

Run: `npm run bench` (two processes: 1k then 5k chunks, 8 GB heap cap). Mean times below.

| Operation | ~1k chunks | ~5k chunks | 1k → 5k scaling |
|-----------|-----------:|-----------:|----------------:|
| `store.open` (fresh DB) | 0.03 ms | 0.04 ms | flat |
| `listAllMeta` | 3.9 ms | 19.9 ms | **5.1×** |
| `listAllBinary` | 6.0 ms | 31.4 ms | **5.2×** |
| `listAllEmbeddings` | 6.8 ms | 37.4 ms | **5.5×** |
| `warmCaches` (cache hit) | 0.05 ms | 0.05 ms | flat |
| `warmCaches` (cold miss) | 230 ms | 6,720 ms | **~29×** (super-linear) |
| `computeDelta` (steady vault) | 0.66 ms | 2.6 ms | **4.0×** |
| `BM25 fit` (cold) | 219 ms | 6,962 ms | **~32×** (super-linear) |
| `BM25 fromJSON` (persisted) | 5.5 ms | 37.2 ms | **6.8×** |
| `backfillBinaryIfMissing` (no-op) | 0.41 ms | 0.34 ms | flat |

Production bundle (separate from bench): **`main.js` ≈ 305 KB** minified (`npm run build`).

---

## Hypothesis mapping

### H1 — Unconditional `saveData` on every boot

**Hypothesis:** `onload()` always `await saveData(settings)` even when nothing changed, adding vault I/O on every app open.

**Bench signal:** Not exercised (Obsidian `Plugin.saveData` has no Node stub).

**In-app signal:** `BootEntry.saveDataMs` — compare p50 across boots where `settingsMigrated === false`.

**Verdict:** Plausible low-to-mid cost on Sync-heavy vaults; cheap when settings unchanged on local disk. **Fix when `saveDataMs` shows up in boot p95.**

**Recommended fix:** Skip `saveData` when `!settingsMigrated` and merged settings are deep-equal to persisted raw (still save after migration).

---

### H2 — `backfillBinaryIfMissing` blocks onload

**Hypothesis:** Binary-index backfill on the blocking boot path adds noticeable latency at scale.

**Bench signal:** Steady-state no-op **0.3–0.4 ms** at 1k and 5k chunks. First-install backfill (legacy rows missing binary siblings) is not modeled here.

**In-app signal:** `BootEntry.backfillMs`.

**Verdict:** **Not a steady-state bottleneck.** Legacy backfill may matter once per upgrade; keep awaited (orchestrator assumes binary index loadable) but do not prioritize over BM25/frame work.

---

### H3 — Serial `onload` awaits (loadData / saveData / store.open / backfill)

**Hypothesis:** Strictly sequential awaits sum into a visible boot tax.

**Bench signal:** Individual ops are fast except corpus-scale reads (see H6/H7). `store.open` ~0.03 ms (empty/fresh DB name).

**In-app signal:** `BootEntry` phase breakdown vs `totalMs`.

**Verdict:** **Confirmed structurally** — phases are serial. Magnitude is dominated by **store.open on a warm vault** (WKWebView) and **backfill on legacy stores**, not by micro-ops measured here.

**Recommended fix (ordering):** After H7/H8, parallelize **independent** work (e.g. fire-and-forget logger maintenance already off-path; consider overlapping `loadData` parse with non-dependent setup) without breaking identity/backfill ordering.

---

### H4 — `main.js` parse/eval bundle size

**Hypothesis:** ~300 KB minified CJS bundle adds main-thread parse cost at plugin load.

**Bench signal:** **305 KB** built artifact; not timed in Node bench.

**Verdict:** Fixed cost per session, independent of corpus. Likely **tens of ms** on desktop, more on mobile — worth monitoring but **below BM25/frame/model** for perceived “ready to search.”

**Recommended fix:** Defer non-critical imports, audit inline worker string growth; measure with Performance API / Long Task entries on device.

---

### H5 — Model delivery dominates first-search

**Hypothesis:** First query waits on ~100 MB model fetch + WASM/WebGPU init.

**Bench signal:** Not modeled (fake embedder is instant).

**In-app signal:** `LoadEntry.coldStartMs`, first-search `totalMs`, `ModelDeliveryEntry`.

**Verdict:** **Dominant on cold devices** (seconds). Orthogonal to index size.

**Recommended fix:** Already partially addressed (model cache, prewarm command, sidecar hydrate without embed on mobile). Continue tuning delivery + cache hit rate; use **`cacheWarmFinishedBeforeModel`** to quantify overlap (H8).

---

### H6 — `ensureFrame` / `listAllEmbeddings` scales with corpus

**Hypothesis:** Resident frame build scans all chunks + all embeddings — O(n) with corpus.

**Bench signal:** `listAllEmbeddings` mean **6.8 ms → 37.4 ms** (5.5× for 5× chunks). `listAllMeta` / `listAllBinary` scale similarly (~5×). Cold `warmCaches` (**230 ms → 6.7 s**) tracks frame + BM25 rebuild.

**Verdict:** **Confirmed linear-ish IDB scan cost**, compounding with BM25 in cold warm path.

**Recommended fix:** Keep resident cache across session; ensure cold boot hits **persisted BM25** (H7) so `ensureFrame` + `fromJSON` replace `fit`. Incremental frame/BM25 patches already exist for deltas — protect warm path from unnecessary invalidation.

---

### H7 — Persisted BM25 `fromJSON` vs cold `fit`

**Hypothesis:** Loading serialized BM25 beats refitting from all bodies at boot.

**Bench signal:**

| | ~1k | ~5k | fit / fromJSON ratio |
|--|-----|-----|----------------------|
| `BM25 fit` | 219 ms | 6,962 ms | |
| `BM25 fromJSON` | 5.5 ms | 37 ms | **40× / 188× faster** |

**Verdict:** **Strongest corpus-scaled win.** At 5k chunks, cold fit is ~7 s in harness; fromJSON is ~37 ms.

**Recommended fix:** **Priority #1** — ensure boot / `warmCaches` / first-search paths prefer **`bm25Source: persisted`** (validate stamp, tolerate drift rules already in code). Investigate any production logs still showing `fit` on clean launch.

---

### H8 — `warmCaches` overlaps model load

**Hypothesis:** Running frame/BM25 warm during `ensureModelLoaded` hides index prep behind model I/O.

**Bench signal:** Cache hit **~0.05 ms** (resident). Cold miss **230 ms @ 1k** — comparable to BM25 fit portion; at 5k, cold warm ≈ fit-dominated **~6.7 s**. Code already fires `warmCaches('model-load')` concurrently with model load (`main.ts`).

**In-app signal:** `CacheWarmEntry` with `trigger: 'model-load'`, `finishedBeforeModelLoad`; `LoadEntry.cacheWarmFinishedBeforeModel`.

**Verdict:** **Architecture correct; overlap value is device-dependent.** If warm finishes before model (likely @ 1k–5k on desktop), first search avoids index rebuild stall. If model finishes first, user still waits on model.

**Recommended fix:** **Priority #2** — validate overlap telemetry on real devices; combine with H7 so overlap work is **`fromJSON` not `fit`**. Mobile cold path intentionally skips build until model loaded — keep persist-if-resident behavior.

---

## Recommended fix ordering

| Priority | Hypothesis | Rationale |
|:--------:|------------|-----------|
| **1** | **H7** | Largest corpus-scaled savings (~40–190× in bench); directly cuts cold warm / first-search lexical prep. |
| **2** | **H8** | Overlap already implemented — tune using `CacheWarmEntry` + ensure persisted load (H7) so overlap hides cheap work. |
| **3** | **H6** | Linear IDB scans drive cold warm; mitigated by resident cache + persisted BM25, not by micro-optimizing cursors alone. |
| **4** | **H3** | Parallelize only after correctness ordering preserved; modest vs H7 at large N. |
| **5** | **H1** | Skip redundant `saveData` when migration didn't run. |
| **6** | **H5** | Real-device model delivery; use cache/prewarm, not index changes. |
| **7** | **H4** | One-time parse cost; monitor but don't block H7/H8. |
| **8** | **H2** | Steady-state backfill no-op < 1 ms in bench; legacy path only. |

---

## Iteration 1 — implemented fixes (H7 + H1)

Approach: **fail fast**. Implement, run the quick 1k bench as a green-light gate,
then scale to 5k only on green.

### H7 — persisted BM25 in the cold-start warm path (implemented)

**Root gap:** `warmCaches()` called `ensureBm25()` directly, which goes straight to
`fit()` on a cache miss. Only the *search hot path* first tried `tryLoadPersistedBm25()`.
So the cold-boot overlap warm (`warmCaches('model-load')`) always paid a full `fit()`
even when a valid persisted MiniSearch blob existed in IndexedDB.

**Fix:** `warmCaches()` now tries `tryLoadPersistedBm25()` → `tryLoadCrossDeviceBm25()`
before `ensureBm25()` on every trigger except `full-reindex` (where a fresh authoritative
`fit()` is the point, then re-published). `bm25StampMatches` still gates correctness, so an
incompatible blob is refused and falls back to `fit()` — the change can only ever go faster.
Also hardened `persistBm25()` to snapshot the cache ref (a fire-and-forget `toJSON()` could
NPE if `invalidateBm25Cache()` nulled the cache across its `await`).

**Result (warmCaches cold-start path, persisted vs forced `fit`):**

| Corpus | Persisted (H7) | Forced `fit` (baseline) | Speedup |
|-------:|---------------:|------------------------:|--------:|
| ~1k | ~25 ms (min) | ~224 ms (min) | **~9×** |
| ~5k | ~113 ms (min) / 257 ms (mean) | ~5,620 ms | **~22–50×** |

Standalone BM25 `fromJSON` vs `fit`: **37× @ 1k**, **188× @ 5k**. **The win grows with
corpus size** because it removes the super-linear `fit()` from the cold path. Green at both
scales → proceed.

### H1 — skip redundant boot `saveData` (implemented)

`onload()` unconditionally `await`ed `saveData(settings)` on every app open.
Now gated by `settingsDifferFromDisk(merged, raw)` (exported from `main.ts`): save only
when a migration ran or the defaults-merge introduced a new/changed key. Removes a
synchronous `data.json` write from every clean boot (which also fans out to every device on
an Obsidian-Sync vault). Measured via `BootEntry.saveDataMs` on device.

### H5 (partial) — desktop cold-start model prewarm (implemented)

**Why:** cold start (time-to-first-usable-search) is dominated by the lazy model load
(~250 MB init; on an uncached device also a ~100 MB fetch). Because `warmCaches` already
overlaps the model load (H8), *everything else is hidden behind it* — so the only lever for
cold start is the model load itself. The first search pays it in full because the model is
loaded lazily on modal open.

**Fix:** proactively load the model shortly after boot (`scheduleColdStartPrewarm` →
`maybeColdStartPrewarm` in `main.ts`), so it's ready — or in flight — before the user opens
search. `ensureModelLoaded()` also warms the frame + BM25 caches, so a successful prewarm
makes the first search fully warm (model **and** caches). The decision is a pure,
unit-tested predicate, `shouldPrewarmModelOnStart`, with hard safety gates:

- **Desktop only** — mobile stays lazy (250 MB on boot risks jetsam, and the mobile
  idle-unload timer would tear it right back down: pure churn).
- **Model already cached** — never triggers a boot-time ~100 MB CDN fetch on a metered or
  first-run connection; only the bounded WASM/GPU init.
- **Index non-empty** — a brand-new vault loads the model on its first reindex anyway.
- **Nothing already loading** — coalesces with `reconcileOnLoad`'s load if one started.
- **User opt-out** — `prewarmModelOnStart` setting (default on; Model & performance toggle,
  desktop-only in the UI).

Deferred ~3 s past `onload` so it never taxes app-open. **Not Node-benchable** (the fake
embedder is instant); validated on device via the existing telemetry: `LoadEntry.coldStartMs`
plus first-search `modelReadyMs` / `sessionBootMs` / `isFirstSearchOfSession` — with prewarm,
the model is ready before the modal opens, so the first search's model wait ≈ 0.

### Bench harness hardening (found while scaling to 5k)

Scaling to 5k surfaced three harness OOMs (not product bugs), each fixed:

1. **`store.open` bench** created a new randomly-named IndexedDB every iteration
   (~15k/run); fake-indexeddb retains every DB → OOM. Now reuses one fixed name and
   closes the connection.
2. **Heavy benches** (`BM25 fit`/`fromJSON`, `warmCaches` cold) used time-based sampling,
   allocating dozens of 5k-doc MiniSearch objects per window faster than GC. Pinned to fixed
   iteration counts.
3. **`warmCaches (cache hit)`** fires a fire-and-forget `persistBm25` (multi-MB `toJSON` at
   5k) on *every* call; thousands of time-based samples OOM'd. Bounded to a fixed count.

Also: benches now run in a `forks` pool with `--max-old-space-size=8192` (the default
`threads` pool ignores the heap flag), and the corpus seeds a stamp-matching persisted BM25
blob so the H7 fast path is exercised end-to-end.

---

## Running benchmarks

```bash
npm run bench          # 1k + 5k sequentially (separate processes, avoids OOM)
npm run bench:1000     # single size
npm run bench:5000
npm run bench:full     # adds 20k when SEEK_BENCH_FULL=1
```

Setup uses **`putBatch` seeding** (not full `reindexAll`) so `beforeAll` completes in seconds, not minutes.
