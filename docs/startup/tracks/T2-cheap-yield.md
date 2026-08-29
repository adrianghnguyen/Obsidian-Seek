# T2 — cheap-yield

**PR:** #10 · **Branch:** `path/cheap-yield` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

Even when total startup time is acceptable, the app can *feel* broken: the window freezes, the editor ignores input, and “Starting…” sits on screen while a background loop crunches through thousands of files. Users care about **responsiveness** separately from **throughput** — a 60-second job that yields every few files feels better than a 55-second job that never lets the UI breathe.

The engineering issue is **main-thread monopolization**. `reChunkLive` ran a tight synchronous chain (read file → chunk text → call tokenizer) on JavaScript’s single UI thread without **`scheduler.yield()`** or equivalent cooperative multitasking. In browser/Electron apps, long tasks block rendering and input; the **event loop** never gets a turn. We deliberately avoided the compositor’s `requestIdleCallback` pacer here because it is too coarse for sub-second search-wait scenarios — a tradeoff between **idle scheduling** and **interactive latency**.

T2 inserts `cheapYield()` every 8 files — small pauses that let Obsidian stay usable during Starting. **G_ui_responsive:** **429 ms** eval p50 (SLO ≤ 2 s). Wall-clock hydrate is ~unchanged (~0% faster). **Verdict:** pass (UX, not raw speed).

**Concepts worth researching:** event loop and long tasks · cooperative yielding (`scheduler.yield`) · UI thread vs worker threads · latency vs throughput · `requestIdleCallback` vs explicit yield · perceived performance

## 2. Why the bottleneck existed

`reChunkLive`, `reChunkLiveSubset`, and greedy tier loops are **CPU- and RPC-heavy synchronous chains** on the main thread:

- Each file: vault read → chunk → iframe `tokenCounts` — no await between files except implicit microtasks.
- **Long tasks blocked the UI** — Obsidian’s `Starting` badge persisted with no opportunity for `obsidian eval` or editor input.
- The compositor **rIC pacer** was too coarse for sub-second search-wait responsiveness.

H4 predicted this: `reChunkLive` monopolizes the main thread when hydrate spans are uninstrumented.

## 3. What we diagnosed

| Finding | Evidence |
|---------|----------|
| H4 — main thread monopolized | **Supported** — no yield in rechunk loops before T2 |
| Long tasks unattributed pre-T0 | `TaskContext: hydrating` added in T0; eval latency measurable during Starting |
| Tradeoff accepted | Hypothesis §2: **~0% faster** hydrate; **+0–10%** wall time acceptable for responsiveness |
| Measurement requires T1 fixture | G_ui_responsive probed on `persist-cache-g2-v2` cold-restart after greedy + batch stack |

**Probe:** `obsidian eval` p50 during `warmPhase: starting` / `TaskContext: hydrating`.

## 4. How we solved it

1. **`cheapYield()`** in `src/pacer.ts` — uses `scheduler.yield()` when available, else `setTimeout(0)`.
2. **Yield every 8 files** in `reChunkLive`, `reChunkLiveSubset`, and greedy tier loops — matches `TOKEN_COUNTS_BATCH` cadence (T3).
3. **Not the rIC compositor pacer** — too coarse for user-visible search waits during Starting.

**Key files:** `src/pacer.ts`, `src/search.ts` (yield counters in rechunk paths).

### 4.1 Measurements / evidence

| Metric | Run | Baseline | Measured | SLO | Verdict |
|--------|-----|----------|----------|-----|---------|
| `T_eval_p95_ms` during Starting | A (G2 v2) | Unbounded (frozen UI) | **429 ms** p50 | ≤ 2,000 ms | **Pass** |
| Total hydrate wall time | A | — | ~unchanged | — | Expected ~0% gain |

**Scorecard:** `.cursor/scorecards/persist-cache-g2-v2-cold-restart-parsed.json`

**Commit:** `62a1786` — `perf(hydrate): yield main thread during reChunkLive oracle walk`
