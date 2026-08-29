# T2 — cheap-yield

**PR:** #10 · **Branch:** `path/cheap-yield` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

During `reChunkLive` and greedy tier walks, the main thread ran tight loops (read → chunk → tokenCounts) with no scheduler yields. Obsidian felt frozen for tens of seconds during `Starting` even when total hydrate wall time was acceptable. T2 adds `cheapYield()` every 8 files in all live rechunk paths. **G_ui_responsive** measured **429 ms** eval p50 during Starting on the G2 v2 probe (SLO ≤ 2 s). **Verdict:** pass (UX improvement; ~0% faster total hydrate).

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
