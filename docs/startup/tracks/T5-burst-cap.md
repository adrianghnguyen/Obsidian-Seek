# T5 — burst-cap

**PR:** #12 · **Branch:** `path/burst-cap` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

After a reload, Seek may need to index thousands of notes that changed while you were away — the “Indexing…” badge with a huge remaining count. Users do not need the backlog to hit zero before search is useful; they need **the first relevant result within seconds** while indexing continues in the background. Before this track, search could hang 30+ seconds because indexing hogged shared resources.

Engineering-wise, this is **resource sharing and scheduling fairness**. Catch-up indexing and live search competed for the same **iframe embedder** (one RPC pump) and the same **IndexedDB write lock**. Large bursts (40 files / 15 s) maximized throughput for the indexer but starved query **`embed`** requests — classic **head-of-line blocking**. The fix space splits into **batch size** (how much work per slice) vs **priority inversion** (query jumps queue), addressed further in T6.

T5 shrinks desktop bursts to **8 files / 4 s** so the indexer yields more often. **T_first_hit = 468 ms** / **10.8 s** (SLO ≤ 30 s). Total drain time is unchanged; earlier first hit is the win. **Verdict:** pass. Query-priority RPC and `warmDeferred` ship in PR #14.

**Concepts worth researching:** backpressure and burst limits · priority queues / multi-lane RPC · producer–consumer contention · time-to-first-byte (TTFB) for search · background job scheduling · IndexedDB transaction locking

## 2. Why the bottleneck existed

Catch-up indexing and search share the **same iframe embedder** and **IDB write mutex**:

- **Large bursts** (40 files / 15 s) kept the write lock and iframe busy too long per yield window.
- **Query `embed` queued behind `embed-batch`** on a single-flight iframe runner.
- **Pre-catchup warm** could hold `rem=0` for minutes while `ensureFrame` / BM25 fit ran.
- **`seek:search` during catch-up** timed out waiting for index traffic to yield.

Goal is **earlier first useful hit**, not faster total drain (burst cap does not reduce total catch-up wall time).

## 3. What we diagnosed

| Finding | Evidence |
|---------|----------|
| Search blocked during 4k backlog | `seek:search` 30s+ timeout on shared embedder |
| Invalid fixture false fail | Cleared file records → **261 s** fake fail (hydrate path, not burst) |
| Valid fixture protocol | Stamp `mtime=0`, drop `contentHash`, keep `chunk_ids` |
| Burst constants tuned | 8 files / 4 s from experiments (was 40 / 15 s) |
| Further fixes needed | warmDeferred, query-priority RPC → T6 / PR #14 |
| Wedged vault recovery | `heal-catchup-backlog-fixture.ps1` — rem≈4500 → rem=0 |

**Run B only** — catch-up UX SLOs use `plugin:reload`, not cold restart.

## 4. How we solved it

### PR #12 scope (`path/burst-cap`)

1. **`DESKTOP_CATCHUP_MAX_FILES_PER_BURST = 8`** (was 40).
2. **`DESKTOP_CATCHUP_BURST_BUDGET_MS = 4000`** (was 15,000).
3. **Boot scheduling tweaks** in `src/main.ts` for catch-up priority.
4. **Tests** — `src/catchup.test.ts`.

### Extended in T6 (PR #14) — cross-reference

- Query-priority iframe RPC pump (`src/iframe-runner.ts`).
- `warmDeferred`, drain-first `runCatchUp`, stale frame during writes (`src/search.ts`, `src/main.ts`).

**Key files (this PR):** `src/catchup.ts`, `src/main.ts`, `src/catchup.test.ts`.

### 4.1 Measurements / evidence

| Metric | Run | Baseline | Measured | SLO | Verdict |
|--------|-----|----------|----------|-----|---------|
| `T_first_hit_ms` (warm frame+BM25) | B | — | **468 ms** | ≤ 30 s | **Pass** |
| `T_first_hit_ms` (warmDeferred probe) | B | — | **10,812 ms** | ≤ 30 s | **Pass** |
| `rem` at first hit | B | — | ~4,362–4,473 | > 0 expected | Search usable during backlog |
| Invalid fixture | B | — | ~261 s | — | **Fail** (wrong fixture) |

**Scorecard:** `.cursor/scorecards/persist-cache-catchup-ux-backlog-4k-20260828-204014.json`

**Commit:** `2894abf` — `feat(catchup): cap desktop catch-up bursts for earlier search`
