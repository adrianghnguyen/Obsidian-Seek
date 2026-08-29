# T3 — batch-rpc

**PR:** #11 · **Branch:** `path/batch-rpc` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

Seek’s embedding model runs inside an isolated **iframe** (a separate JavaScript context for security and WASM). Every time the indexer asked “how many tokens is this note?” it sent a separate message across that boundary — like making 4,400 individual phone calls instead of one conference call with eight people per line. On a ~4.4k-note vault, that overhead alone consumed a large slice of the ~28–32 s chunk phase.

The bottleneck is **RPC amplification** (Remote Procedure Call): **chatty cross-boundary APIs**. Each `tokenCounts()` call pays fixed latency (serialization, postMessage, iframe scheduling) regardless of payload size. When work is embarrassingly parallel per file but the transport is serial, total time scales with **number of round-trips**, not amount of text — the **N+1 calls** antipattern applied to indexing. Batching amortizes fixed cost across multiple texts in one RPC.

T3 batches up to 8 texts per `token-counts` call via `createBatchedTokenCounter()`. On the G2 v2 delta path: **4462 → 9** RPCs, **493 ms** rechunk. Full cold gate still ~149 s (sidecar scan, not RPC-bound). **Verdict:** pass on delta path; partial on full hydrate gate.

**Concepts worth researching:** RPC / IPC overhead · batching and amortization · iframe isolation in Electron · N+1 query (or call) problem · postMessage latency · tokenizer pipelines in ML plugins

## 2. Why the bottleneck existed

The rechunk oracle called `tokenCounts` **once per file** over the iframe boundary:

- **~4.4k RPCs** on a full-vault walk (~20 ms round-trip each → tens of seconds of pure RPC overhead).
- Chunk phase was **48–185×** embed time on large passes (H1) — tokenizer RPC amplification was a major slice.
- Parallel file batches still issued one RPC per file inside the batch loop before batching.

Root cause: no amortization of iframe `token-counts` calls across texts from the same rechunk batch.

## 3. What we diagnosed

| Finding | Evidence |
|---------|----------|
| RPC count scales with files | Pre-fix estimate ~4,427 RPCs on single-chunk notes |
| 8× batching hypothesis | ~4,427 → ~554 RPCs theoretical (`TOKEN_COUNTS_BATCH=8`) |
| Delta path verified | G2 v2: **9 RPCs**, **1 file walked**, **493 ms** rechunk |
| Full gate still slow | `T_hydrate_ms` **149,629 ms** — sidecar scanned 29,378 ids (not chunk-RPC bound) |
| `G_catchup_chunk` | Not isolated on same 4k fixture (no trace-infra A/B) |

**Telemetry:** `tokenCountsRpc` in `rechunk-live` forensics reflects actual RPC count post-fix.

## 4. How we solved it

1. **`TOKEN_COUNTS_BATCH = 8`** — batch up to 8 texts per `token-counts` RPC.
2. **`createBatchedTokenCounter()`** in `src/token-budget.ts` — groups texts, one RPC per batch, preserves per-text results for chunk_id assignment.
3. **Outer rechunk loops** step by batch in `reChunkLive` / `reChunkLiveSubset` (`src/search.ts`).
4. **Tests** — `src/token-budget.test.ts` batching + chunk_id parity.

**Key files:** `src/token-budget.ts`, `src/search.ts`, `src/token-budget.test.ts`.

### 4.1 Measurements / evidence

| Metric | Run | Baseline | Measured | SLO | Verdict |
|--------|-----|----------|----------|-----|---------|
| `token_counts_rpc` | A (G2 v2) | ~4,462 | **9** | ~8× reduction | **Pass** |
| `rechunk_duration_ms` | A (G2 v2) | — | **493 ms** | Delta path | **Pass** |
| `files_walked` | A (G2 v2) | ~4,462 (pre-greedy) | **1** | ≪ vault | **Pass** |
| `T_hydrate_ms` (full gate) | A | ~159,000 ms est. | **149,629 ms** | −15–35% chunk | **Partial** (sidecar scan dominates) |

**Scorecard:** `.cursor/scorecards/persist-cache-g2-v2-cold-restart-parsed.json`

**Commit:** `00d404c` — `perf(hydrate): batch tokenizer RPCs in reChunkLive oracle`
