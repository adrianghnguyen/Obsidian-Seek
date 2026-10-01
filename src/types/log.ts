// NDJSON log schema: the LogEntry union and its per-entry shapes. Extracted
// from types.ts; the report renderer and logger consume these directly.

import type { Device, Dtype, RequestedDevice, QueryFilters, RecencyKeyChoice, ScoredChunk } from './types';
import type { DistributionStats } from './memory';

// ---- log entry types (NDJSON schema) ----

export interface InitEntry {
    type: 'init';
    timestamp: string;
    schemaVersion: number;
    buildTimestamp: string;
    transformersVersion: string;
    cdnUrl: string;
    iframeReady: boolean;
    // Wall time of the iframe build (createElement + srcdoc bootstrap + __ready
    // handshake). 0 when init early-returned because the iframe was already live
    // (recycle/teardown/unload re-entry), so a 0 here is "no build", not "instant".
    initMs: number;
    pluginVersion: string;
    error: string | null;
}

export interface AdapterLimits {
    maxBufferSize: number | null;
    maxStorageBufferBindingSize: number | null;
    maxComputeWorkgroupSizeX: number | null;
    maxComputeInvocationsPerWorkgroup: number | null;
}

export interface PlatformEntry {
    type: 'platform';
    timestamp: string;
    isMobile: boolean;
    userAgent: string;
    iosVersion: number | null;
    gpuAvailable: boolean;
    gpuAdapterDescription: string | null;
    // true = software fallback adapter (SwiftShader-class): the "GPU yes but
    // not really" case where ORT WebGPU init typically fails (e.g. hardware
    // acceleration disabled). null = attribute not exposed on this platform.
    gpuIsFallbackAdapter: boolean | null;
    gpuAdapterLimits: AdapterLimits | null;
    storageUsedMB: number | null;
    storageQuotaMB: number | null;
    persistGranted: boolean | null;
    heapAvailable: boolean;        // Whether performance.memory is exposed (false on iOS WebKit).
    measureMemoryAvailable: boolean; // Whether performance.measureUserAgentSpecificMemory exists.
    crossOriginIsolated: boolean;  // Required for measureUserAgentSpecificMemory.
}

export interface LoadEntry {
    type: 'load';
    timestamp: string;
    requestedDevice: RequestedDevice;
    actualDevice: Device;
    dtype: Dtype;
    // Output vector dimension AFTER MRL slicing (the on-the-wire / on-disk
    // shape). EmbeddingGemma's native output is 768; we slice + L2-renormalize
    // in the iframe so callers never see the full 768d.
    embeddingDim: number;
    coldStartMs: number;
    // Wall-time of the WebGPU warmup sweep (40 forced shader-compile
    // dispatches across batch × seq_bucket); included in coldStartMs. Use
    // (coldStartMs − warmupMs) to recover pre-warmup load time (Cache API
    // read + ONNX parse + WebGPU device init). NULL when:
    //   - WASM path (no warmup applies; warmupSkipped=false)
    //   - WebGPU + skipWarmup hit (fingerprint cache says shaders are warm;
    //     warmupSkipped=true)
    // The boolean disambiguates the two null cases.
    warmupMs: number | null;
    warmupSkipped: boolean;
    heapBeforeMB: number | null;
    heapAfterMB: number | null;
    heapDeltaMB: number | null;
    storageBeforeMB: number | null;
    storageAfterMB: number | null;
    storageDeltaMB: number | null;
    webgpuAttempted: boolean;
    webgpuFailed: boolean;
    webgpuError: string | null;
    // Non-null when a glue override applied: 'jspi' | 'asyncify' (WebKit
    // WebGPU) or 'plain' (non-WebKit wasm pin — the only ort-wasm build with
    // the CPU GatherBlockQuantized kernel). Previously only in `checks` text.
    glue: string | null;
    // WASM path only (issue #5): true when the session lives in ort-web's
    // proxy worker (compile + init + every run off the main thread). false +
    // proxyAttempted=true + proxyError = the proxy leg failed and we fell
    // back to in-thread wasm (the pre-1.0.7 behavior) — a fleet-wide silent
    // fallback here is a diagnosable regression, not an invisible one.
    proxy: boolean;
    proxyAttempted: boolean;
    proxyError: string | null;
    pass: boolean;
    checks: string[];
}

export interface IndexProgressEntry {
    type: 'index-progress';
    timestamp: string;
    phase: 'scan' | 'chunk' | 'embed' | 'bm25' | 'commit';
    filesSeen: number;
    filesTotal: number;
    chunksEmitted: number;
    elapsedMs: number;
    heapMB: number | null;
    storageMB: number | null;
}

export interface IndexCompleteEntry {
    type: 'index-complete';
    timestamp: string;
    mode: 'full' | 'incremental';
    // What dtype + dim were used to produce these vectors. Recorded so a
    // future model swap can detect that the on-disk index doesn't match the
    // currently loaded runtime.
    dtype: Dtype;
    embeddingDim: number;
    filesIndexed: number;          // files STARTED (== input length on a full reindex)
    // The subset of filesIndexed whose file-record was actually written (commitFile
    // succeeded). Drives the catch-up drain's forward-progress accounting — distinct from
    // filesIndexed whenever a file is empty/skipped/budget-deferred. See embedAndCommitFiles.
    committedFilePaths: string[];
    chunksIndexed: number;
    vectorsWritten: number;
    filesSkippedError: number;
    // The subset of filesSkippedError whose commit failed with QuotaExceededError
    // (device storage full). Split out because the remedy is environmental (free
    // disk space), not content- or code-shaped — the pass-end gate surfaces it as
    // its own check line + Notice instead of the generic "see error log". Optional:
    // absent on entries written before this field existed.
    filesSkippedQuota?: number;
    // Embed-failure quarantine (v14, issue #4): files committed WITH a failure
    // marker — some chunks deterministically failed (survived batch + solo
    // retries, each behind a device recycle) and were omitted; the rest of the
    // file stays searchable. A quarantined file also counts in
    // filesSkippedError (content IS missing), keeping the pass gate's meaning.
    filesQuarantined?: number;
    chunksFailedEmbed?: number;
    // Incremental budget: files in the input list that were never started because
    // a per-burst budget (maxFiles / budgetMs / shouldContinue) cut the pass short.
    // 0 on a full reindex (always unbounded) and on a delta that ran to completion.
    // The drain loop in main.ts reads this to decide whether to re-fire another
    // burst. Optional: absent on entries written before this field existed.
    filesDeferred?: number;
    // How many times the embed session was torn down + rebuilt mid-run to
    // recover from ORT-Web's WebGPU SafeInt overflow (embedder.recycle).
    // 0 on a healthy run; >0 means the overflow was hit and recovered.
    embedRecycles: number;
    // WS2.3 token-budget enforcement (token-budget.ts). splits = chunks whose
    // embed input exceeded the 512-token window and were re-packed under it;
    // overBudget = inputs that STILL exceed the window (unsplittable
    // ~window-filling titles only) and therefore truncate — the lone permitted
    // nonzero in the dense-invisible-share→0 invariant. Optional: absent on
    // pre-WS2.3 log entries.
    tokenBudgetSplits?: number;
    tokenBudgetOverBudget?: number;
    embedDurationMs: number;
    chunkDurationMs: number;
    bm25DurationMs: number;
    commitDurationMs: number;
    totalDurationMs: number;
    heapDeltaMB: number | null;
    storageDeltaMB: number | null;
    // Throughput rollups computed from totalDurationMs.
    chunksPerSec: number;
    filesPerSec: number;
    /** Cumulative padded embed tokens this pass (batch × seq length the GPU saw). Optional on older logs. */
    paddedTokens?: number;
    /** paddedTokens / (totalDurationMs/1000). Optional on older logs. */
    tokensPerSec?: number;
    // Per-file wall-clock distribution (chunk+embed+commit summed per file).
    perFileWallMs: DistributionStats | null;
    chunksPerFile: DistributionStats | null;
    // Per-embed-batch latency as reported by transformers.js inside the iframe.
    embedBatchLatencyMs: DistributionStats | null;
    // Cumulative wall-clock this pass spent awaiting the compositor pacer
    // between embed dispatches (v16, issue #5). The field-visible signature of
    // the hidden-window pacing inversion: ~1.5 s of embed compute arriving as
    // 92.8 s wall was invisible until this split pace-wait out of embed time.
    paceWaitMs?: number;
    pass: boolean;
    checks: string[];
}

// Issue #5 (v16): the incremental-patch outcome of one reindexDelta pass,
// written AFTER the write mutex releases — index-complete is the ENGINE's
// entry and predates applyDelta, so it cannot carry this. Closes the
// field-observability gap that made the hot-note cascade require live vault
// probes: whether the cheap in-place patch ran, why it declined when it
// didn't (each decline is a full O(corpus) cache rebuild), what the patch
// cost, and how long the write mutex was held (searches wait on that mutex
// inside ensureFrame — their idbReadMs includes it).
export interface DeltaApplyEntry {
    type: 'delta-apply';
    timestamp: string;
    appliedIncrementally: boolean;
    // deltaFallback slug ('cold caches', 'compaction due', 'removal-mismatch',
    // …) when the patch was attempted and declined. Absent on success and on
    // not-attempted passes.
    fallbackReason?: string;
    // Why the patch was not attempted at all: 'carry-over' (F13 vectors bypass
    // the change-set) or 'quarantine-unwind' (its deleteFile bypasses it).
    skippedBecause?: string;
    // NOTE: `removed` counts cache-level removals — IDB-applied deletions AND
    // the diff's reindex-row lane (rows whose IDB data remains; they appear in
    // `added` too). removed ≈ added on a metadata-drift pass is churn, not loss.
    removed: number;
    added: number;
    metaPatches: number;
    // Time inside applyDelta itself (absent when the patch was not attempted).
    applyDeltaMs?: number;
    // Wall-clock the write mutex was held for the WHOLE critical section.
    mutexHoldMs: number;
}

export interface SearchEntry {
    type: 'search';
    timestamp: string;
    query: string;
    topK: number;
    // Inline-filter parser output (v8+). `cleanedQuery` is the residual
    // semantic text actually embedded + BM25'd after stripping
    // #tag/tag:/path:/[k:v]/date operators; `filters` is the structured
    // extraction (null = plain query, no operators → pre-v8 behavior).
    cleanedQuery: string;
    filters: QueryFilters | null;
    // Stage timers — every one is wall-clock around a discrete pipeline phase.
    // Sum is ≤ totalMs; the residual is async scheduling overhead.
    //
    // Two-stage layout (v7+):
    //   idbReadMs        listAllChunks + listAllBinary (cached after first run)
    //   binaryMs         asymmetric float·sign-bit scoring across all chunks
    //   selectFetchMs    fp32 fetch for ONLY the union candidates (S2 prep)
    //   alignMs          building the chunk-subset → vector Map for the union
    //   cosineMs         exact cosine, but over the union — not all chunks
    //   bm25Ms / fusionMs / snippetMs unchanged
    idbReadMs: number;
    binaryMs: number;
    selectFetchMs: number;
    alignMs: number;
    queryEmbedMs: number;
    iframeEmbedMs: number;
    // T8: which realm embedded the query — 'worker' (background route) or
    // 'iframe' (default pipeline). Absent on entries that never embedded
    // (lexical-only failures, empty-index fast paths).
    embedRoute?: 'worker' | 'iframe';
    cosineMs: number;
    bm25Ms: number;
    bm25CacheHit: boolean;
    fusionMs: number;
    snippetMs: number;
    totalMs: number;
    totalChunks: number;
    // Two-stage candidate accounting:
    //   *TopN/M/K are the configured caps (read of the live config at search time);
    //   *Count are how many *unique* ids each arm contributed *before* union dedup;
    //   candidateUnionSize is the post-dedup size of the set fed to the S2 reranker.
    binaryTopN: number;
    bm25TopM: number;
    recencyTopK: number;
    binaryCount: number;
    bm25Count: number;
    recencyCount: number;
    candidateUnionSize: number;
    // True if the resident binary index was loaded from RAM (cache hit). False
    // means stage 1 paid an IDB cursor walk over the binary store this call.
    binaryCacheHit: boolean;
    rawDenseTop5: Array<{ chunk_id: string; score: number }>;
    rawBm25Top5: Array<{ chunk_id: string; score: number }>;
    // Ranking trace for offline analysis. Persisted depth is gated by the
    // verboseTrace setting: top-10 by default (exactly what the report renders,
    // keeping the append-only log small), or the full 50-deep tail when verboseTrace
    // is on — for spreadsheet / pandas eval over the long tail. NOTE: from v7
    // this trace is over the CANDIDATE UNION (~250), not all chunks — the
    // "rank" field is the candidate-set rank, not a global rank.
    fusedTop50: Array<{
        chunk_id: string;
        note_path: string;
        rank: number;
        score: number;
        dense: number;
        // Raw cosine before lexical-only floor + min-max (see ScoredChunk
        // ranking_signals.denseRaw) — the absolute dense match quality.
        denseRaw: number;
        bm25: number;
        recency: number;
        title_boost: number;
        title: string;
    }>;
    alpha: number;             // the dense weight in force (settings.denseWeight)
    // Since 2026-06-11 this carries the recency EPSILON (the additive tiebreaker
    // in final = hybrid + ε·recency + titleBoost). The field name is kept for
    // log-schema stability: rows before 06-08 hold the old blend weight, rows
    // 06-08..11 hold the parked 0, rows after hold ε (~0.02).
    recencyWeight: number;
    // Which date drove recency this search ('created' | 'modified'). Optional so
    // logs predating the recencyKey setting (2026-06-11) still parse; absent ⇒
    // the pre-key behavior (created with mtime fallback, same as 'created').
    recencyKey?: RecencyKeyChoice;
    // HISTORICAL (RRF deleted 2026-06-11): blend config, written only by rows
    // logged while the opt-in RRF mode existed (2026-06-09..11). Absent ⇒ linear.
    // Kept optional so those rows still parse; never written again.
    blendMode?: 'linear' | 'rrf';
    rrfK?: number;
    // Whether the soft-AND BM25 coverage weight was applied this search. Optional
    // so logs predating the lever still parse; absent ⇒ false (the old OR behavior).
    bm25Coverage?: boolean;
    // Whether last-token prefix expansion was applied this search. Optional so
    // logs predating the lever (2026-06-10) still parse; absent ⇒ false.
    prefixLastToken?: boolean;
    // Whether alias-dictionary synonym expansion was applied this search.
    // Optional so logs predating the lever still parse; absent ⇒ false.
    synonymExpansion?: boolean;
    // Whether frontmatter properties were indexed as a BM25 field this search.
    // Optional so logs predating the lever (2026-06-11) still parse; absent ⇒ false.
    searchableProperties?: boolean;
    // Whether the heading path was indexed as a BM25 field this search.
    // Optional so logs predating the lever (2026-06-12) still parse; absent ⇒ false.
    headingsField?: boolean;
    // Per-query theoretical BM25 bound (bm25.getQueryBound) the fusion divided
    // by; 0 ⇒ the bound had no opinion (fully-OOV query, or MiniSearch internals
    // unavailable) and fusion fell back to the empirical max. max(rawBm25)/bound
    // is the lexical channel's per-query confidence — the weak-lexical diagnostic.
    // Optional so logs predating the bound norm still parse.
    bm25Bound?: number;
    // Search-level identifier so click events can be correlated back to
    // the originating search row. Time-based since we don't have a UUID
    // generator hot path and the timestamp+query pair is already unique
    // in practice.
    searchId: string;
    // Name-prefilter telemetry (optional so rows predating early paint still parse).
    nameMatchMs?: number;
    nameHitCount?: number;
    nameEarlyPainted?: boolean;
    // t0 → onPartial fire (perceived TTFR). 0 / absent when no early paint.
    namePartialMs?: number;
    // Lexical partial telemetry (t0 → first lexical onPartial fire, if any).
    // 0 / absent when no lexical partial was emitted.
    lexPartialMs?: number;
    // True when the lexical BM25-only onPartial was emitted.
    lexPartialFired?: boolean;
    /** Exact / regex text lane (vNext): hybrid = default BM25+semantic. */
    textSearchKind?: 'hybrid' | 'exact' | 'regex';
    textSearchRegexInvalid?: boolean;
}

// First-page callback from search() — name hits only, before embed/binary finish.
export interface SearchPartial {
    results: ScoredChunk[];
    source: 'name' | 'lexical' | 'hybrid' | 'exact';
    /** Number of name hits scanned (only set when source === 'name'). */
    nameHitCount?: number;
    cleanedQuery: string;
}

// Emitted when the user clicks a search result. Captures both the chosen
// chunk and the top-10 chunk_ids the user passed over, so offline analysis
// can compute "did they click rank-1 or not" CTR-style relevance signals.
// `dwellMs` is the time between search-completion and click — proxies for
// "did they actually look at the results before clicking, or accept the
// first thing they saw."
export interface ClickEntry {
    type: 'click';
    timestamp: string;
    searchId: string;       // matches SearchEntry.searchId
    query: string;
    chunk_id: string;
    note_path: string;
    rank: number;            // 1-based rank in the deduped result list shown
    score: number;
    dense: number;
    bm25: number;
    recency: number;
    title_boost: number;
    titleNavOpen: boolean;   // open landed at doc top via the title-nav intent gate
    dwellMs: number;         // ms between search completion and the click
    shownTop10: string[];    // chunk_ids the user passed over (or chose from)
}

export interface ErrorEntry {
    type: 'error';
    timestamp: string;
    context: string;
    message: string;
    stack: string | null;
    // Running occurrence count carried on a milestone/flush row when errors are deduped
    // by message: how many times this message has fired this session as of this row.
    // Errors are written at exponential milestones (2,4,8,…), not one row each, so a
    // chronic fault like "iframe not initialized" costs ~log2(N) rows instead of N.
    // Absent ⇒ a first/only occurrence.
    repeated?: number;
}

export interface ResetEntry {
    type: 'reset';
    timestamp: string;
    droppedDatabase: string;
    chunksDeleted: number;
    vectorsDeleted: number;
    durationMs: number;
    pass: boolean;
    checks: string[];
}

// Long-running main-thread tasks observed via PerformanceObserver during
// indexing. iOS jank is invisible unless we record these — 250 ms is the
// rough threshold above which the user perceives a stutter.
export interface LongTaskEntry {
    type: 'long-task';
    timestamp: string;
    durationMs: number;
    startTimeMs: number;
    // HISTORICAL (v14 and earlier): TaskAttributionTiming.name, which the Long
    // Tasks spec defines as the constant string 'unknown'. It never carried
    // information. Kept so old rows parse; read `culprit` instead.
    attribution: string | null;
    // WHICH FRAME ran the task — PerformanceLongTaskTiming.name: 'self' (this
    // window, i.e. Obsidian core, another plugin, or Seek's own main-thread
    // work), 'same-origin-descendant' / 'cross-origin-descendant' (an iframe —
    // Seek's embedder is one, but so are Obsidian's PDF and embed frames), or
    // 'multiple-contexts' / 'unknown'. This is the field that separates "Seek's
    // model is stalling the app" from "something else in this window is", which
    // is precisely what issue #5's hourly 'idle' stalls needed and no report
    // could answer.
    culprit?: string | null;
    // The containing element of a descendant-frame task, when the platform
    // exposes it (same-origin frames only; cross-origin ones report empty).
    // containerSrc names the guilty iframe outright — a third-party plugin's
    // frame shows up here under its own URL.
    containerType?: string | null;
    containerId?: string | null;
    containerName?: string | null;
    containerSrc?: string | null;
    // Which plugin phase the task overlapped (span attribution — task-context.ts):
    // 'search' | 'indexing' | 'catchup' | 'model-load' | 'bm25-warm' | 'reconcile',
    // or 'idle' = genuinely no Seek phase was running (pre-1.0.7 reports labeled
    // ALL unattributed phases 'idle' — treat old 'idle' rows as unknown).
    context: string;
}

// Captured on `visibilitychange` (hidden) and `pagehide`. The user-visible
// motivation is iOS jetsam: if the WebView is killed under memory pressure,
// the last memory-pressure entry tells us what state we were in when killed.
export interface MemoryPressureEntry {
    type: 'memory-pressure';
    timestamp: string;
    event: 'visibility-hidden' | 'pagehide' | 'visibility-visible';
    heapMB: number | null;
    storageMB: number | null;
    persisted: boolean;
}

// Emitted when the embedder is proactively torn down to release the iframe's
// monotonically-growing WASM heap (WebAssembly.Memory never shrinks within a
// page, so a long mobile session ratchets to the OOM ceiling). 'idle' = no model
// use for IDLE_UNLOAD_MS in a quiescent state; 'background' = mobile app
// backgrounded (free before iOS can jetsam-kill). The next search/embed
// transparently reloads via ensureModelLoaded — the FOLLOWING LoadEntry's
// coldStartMs is the reload cost this trades for the heap reset. heapMB is the JS
// heap at unload (desktop only; null on iOS, where performance.memory is absent).
export interface ModelLifecycleEntry {
    type: 'model-lifecycle';
    timestamp: string;
    event: 'unload';
    reason: 'idle' | 'background';
    heapMB: number | null;
}

// ---- crash forensics (schema v10) ----

// One synchronous localStorage breadcrumb. Deliberately tiny (the ring is
// rewritten on every beat) and self-describing enough to reconstruct what the
// process was doing when it died: visibility state at write time plus a
// per-beat detail payload (filesCommitted, dispatch counters, ...).
export interface ForensicBreadcrumb {
    t: string;                       // ISO timestamp
    type: string;                    // 'session-start' | 'visibility-hidden' | 'index-flush' | ...
    vis: 'visible' | 'hidden';       // document.visibilityState at write time
    detail?: Record<string, number | string | boolean | null>;
}

// How bootInspect() classifies an unclean prior session. The verdict is the
// whole point of the forensics layer: it discriminates the iPhone-reindex
// death hypotheses that the async log physically cannot.
//   crash-while-indexing-foreground — process died mid-reindex, app visible:
//       memory-ceiling signature (jetsam under foreground GPU/heap burst).
//   crash-while-indexing-hidden — process died mid-reindex while backgrounded:
//       iOS background-GPU termination signature.
//   evicted-while-hidden — died backgrounded and idle: ordinary iOS
//       suspended-app eviction, expected lifecycle, not a bug.
//   crash-foreground — died visible but not indexing (load burst, query, ...).
//   unknown — no breadcrumbs beyond session-start.
export type CrashVerdict =
    | 'crash-while-indexing-foreground'
    | 'crash-while-indexing-hidden'
    | 'evicted-while-hidden'
    | 'crash-foreground'
    | 'unknown';

// Logged at boot when the previous session's forensics record has no clean-end
// marker. Carries the breadcrumb tail so the report can show the last thing
// the dead process did.
export interface CrashDetectedEntry {
    type: 'crash-detected';
    timestamp: string;
    // Identity of the session that died (NOT the booting session stamped by
    // the logger — that's the session that found the body).
    deadSessionId: string;
    verdict: CrashVerdict;
    // Last breadcrumb before death + how long after it the next boot happened.
    lastBeat: ForensicBreadcrumb | null;
    gapSeconds: number | null;
    // Tail of the ring (most recent last), capped — enough to see the run-up.
    breadcrumbs: ForensicBreadcrumb[];
}

// On-demand snapshot used after reindex and at other interesting moments.
// Cheaper than the full platform probe; only captures the volatile fields.
export interface StorageSnapshotEntry {
    type: 'storage-snapshot';
    timestamp: string;
    context: string;
    storageUsedMB: number | null;
    storageQuotaMB: number | null;
    heapMB: number | null;
}

// Promoted form of the coldStartMs ≥ 5000 check that lived inside the load
// entry's `checks` array. Surfacing it as its own event lets the report
// (and any future alerting) count occurrences without parsing free-text
// checklist strings. Carries the storage state at the moment of suspected
// eviction so a low storageUsedMB at the same timestamp confirms the
// cache was actually emptied (vs. a slow disk or thermal-throttle false
// positive).
export interface EvictionSuspectedEntry {
    type: 'eviction-suspected';
    timestamp: string;
    coldStartMs: number;
    actualDevice: Device;
    dtype: Dtype;
    storageUsedMB: number | null;
    storageQuotaMB: number | null;
    persisted: boolean | null;
}

// One-shot result of the `app://local/...` capability probe. Gates the
// Phase 3 model-shard pattern: if `ok`, the iframe can stream shards from
// the vault via a resource URL; if `blocked`, Phase 3 falls back to
// transferring shard bytes through postMessage at cold start.
export interface AppLocalFetchEntry {
    type: 'app-local-fetch';
    timestamp: string;
    result: 'ok' | 'blocked' | 'unknown';
    // Full resource URL we attempted (`app://local/...` on desktop,
    // `capacitor://localhost/...` on iOS Capacitor, etc.). Recorded so
    // the report can correlate the result with the platform's URL scheme.
    url: string;
    httpStatus: number | null;
    bodyMatched: boolean | null;
    error: string | null;
}

// Emitted once per successful model load by the production model-delivery layer
// (model-registry.ts + main.ts). `key`/`repo`/`revision` identify the active spec;
// `persisted` is navigator.storage.persisted() (Cache-API durability on this
// device); `cacheSeen`/`cacheEvicted` report the parent-side eviction sweep of the
// transformers-cache — `cacheSeen === 0` is the canary that the parent can't see
// the iframe's cache partition (move eviction to an iframe RPC if it ever appears).
export interface ModelDeliveryEntry {
    type: 'model-delivery';
    timestamp: string;
    key: string;
    repo: string;
    revision: string | null;
    persisted: boolean | null;
    cacheSeen: number;
    cacheEvicted: number;
}

// ---- runtime profile (wall-time decomposition) ----
//
// One cell per (batchSize, seqBucket). The point is NOT throughput — it's
// *where the wall time goes*, because that ratio is the decision variable
// the idea-list questions all reduce to:
//   - tokenizeSharePct high  → a WASM/Rust tokenizer is worth it (else noise)
//   - forwardSharePct high   → pipeline is GPU-forward-bound; I/O binding
//                              (which only removes copies/seam stalls) has
//                              little to recover — the v4 kernel fix already
//                              captured the win
//   - forwardSharePct low / post(readback) high → serialization-bound; the
//                              "36% GPU" diagnosis still holds on v4 and the
//                              worker / readback levers matter
// `postMs` = time to materialize last_hidden_state.data (forces the WebGPU
// GPU→CPU readback) — deliberately measured separately because the readback
// sync-stall is exactly what the "per-inference serialization" hypothesis is
// about. It is NOT full pool+normalize; it is the readback boundary cost.
// `pipelineTotalMs` runs the *production* pipeline() path on the same inputs
// as a decomposition sanity check (tokenize+forward+post should ≈ it).
export interface ProfileCell {
    batchSize: number;
    seqBucket: number;
    reps: number;
    tokenizeMs: DistributionStats | null;
    forwardMs: DistributionStats | null;
    postMs: DistributionStats | null;
    pipelineTotalMs: DistributionStats | null;
    // p50-derived shares — the actual decision read.
    forwardSharePct: number | null;
    tokenizeSharePct: number | null;
    // forward p50 ÷ batchSize: per-text GPU cost, the throughput proxy.
    perTextForwardMs: number | null;
}

export interface EmbedProfileEntry {
    type: 'embed-profile';
    timestamp: string;
    schemaVersion: number;
    device: Device;
    dtype: Dtype;
    transformersVersion: string;
    cells: ProfileCell[];
    // Heap Δ across the whole non-disposing run. The profile path deliberately
    // does NOT dispose output tensors, so a climbing delta here is an early,
    // free read on the "undisposed iframe output tensor" leak hypothesis —
    // without yet committing to the disposal change itself.
    heapDeltaMB: number | null;
    elapsedMs: number;
    notes: string;
}

// Phase-5 trimmed-model smoke test (seek-phase5-smoke command). A crash-survivable
// probe: one entry per stage is disk-flushed before the next heavy step. The
// per-stage payload (loadMs, dim, norm, device, error, …) varies by stage, so it
// stays open via an index signature — this is a debug-only log, not a schema'd
// analytics event.
export interface Phase5SmokeEntry {
    type: 'phase5-smoke';
    timestamp: string;
    stage: string;
    [key: string]: string | number | boolean | undefined;
}

// WebGPU device lifecycle event relayed from the iframe's requestDevice hook
// (kind: webgpu-device-created / webgpu-device-lost / webgpu-uncaptured-error).
// device-lost is the only JS-visible discriminator between a GPU-process death
// (page survives and sees it) and a WebContent kill (total silence) — the load-
// bearing diagnostic after three iPhone reindex deaths left zero OS-side
// forensics. The same event is ALSO written synchronously to the forensics
// breadcrumb ring (which survives process death); this NDJSON twin is the
// queryable copy for sessions that lived to tell.
export interface WebgpuEventEntry {
    type: 'webgpu-event';
    timestamp: string;
    kind: string;
    [key: string]: string | number | boolean | null | undefined;
}

// Sidecar hydrate diagnostics, persisted to NDJSON so they're visible on mobile
// (the prior console.log-only hook was invisible on iOS — why hydrate outcomes
// never appeared in phone reports). `phase` = the deps.log msg: 'sidecar-hydrate-scan'
// (early producer-file probe, carries producerFilesFound + devices — the decisive
// "did the desktop sidecar reach this device" signal) or 'sidecar-hydrate' (result:
// scanned/needed/hydrated/accepted/refusedProducers). Array fields are flattened to
// `<key>Count` by the writer to fit the scalar index signature.
export interface SidecarHydrateEntry {
    type: 'sidecar-hydrate';
    timestamp: string;
    phase: string;
    [key: string]: string | number | boolean | null | undefined;
}

// Whole-vault reChunkLive pass — tokenizer-only oracle walk (startup trace v17).
export interface RechunkLiveEntry {
    type: 'rechunk-live';
    timestamp: string;
    filesWalked: number;
    filesSkipped: number;
    tokenCountsRpc: number;
    durationMs: number;
    complete: boolean;
    subset?: boolean;
    filesInTier?: number;
}

export interface SidecarHydrateTierEntry {
    type: 'sidecar-hydrate-tier';
    timestamp: string;
    tier: string;
    filesWalked: number;
    chunksProduced: number;
    needed: number;
    hydrated: number;
    freshIdsRemaining: number;
    durationMs: number;
    gateReleased: boolean;
}

export interface SidecarHydrateGreedyEntry {
    type: 'sidecar-hydrate-greedy';
    timestamp: string;
    tiersRun: number;
    stoppedEarly: boolean;
    reason: string | null;
    T_first_good_ms: number | null;
    T_hydrate_total_ms: number;
}

// Boot/hydrate phase boundary markers for correlating CLI gate JSONL with NDJSON.
export interface StartupSpanEntry {
    type: 'startup-span';
    timestamp: string;
    span: string;
    phase: 'start' | 'end';
    durationMs?: number;
    [key: string]: string | number | boolean | null | undefined;
}

// Search gate release or gate test during Starting (startup trace v17).
export interface StartupGateEntry {
    type: 'startup-gate';
    timestamp: string;
    event: 'released' | 'tested';
    warmPhase: string | null;
    uiHealth: string;
    elapsedMs?: number;
    searchResult?: string;
}

export interface StoreLockRetryEntry {
    type: 'store-lock-retry';
    timestamp: string;
    attempt: number;
    delayMs: number;
    totalElapsedMs: number;
}

export interface StoreLockExhaustedEntry {
    type: 'store-lock-exhausted';
    timestamp: string;
}

export interface StoreForceResetEntry {
    type: 'store-force-reset';
    timestamp: string;
    nuked?: boolean;
}

/**
 * Boot watchdog fired: the post-layout boot did not become searchable within the
 * expected window (not merely slow — a wedged store open/read or a stalled
 * continuation). The UI flips to the Stuck state and offers manual recovery.
 */
export interface BootWatchdogEntry {
    type: 'boot-watchdog';
    timestamp: string;
    elapsedMs: number;
    reason: 'startup-not-searchable' | 'store-read-timeout';
    storeOpen: boolean;
    hydrating: boolean;
    /** Boot continuation reached its finalize step (the resume path ran to the end). */
    bootContinuationDone?: boolean;
    /** A writer holds the index mutex (a reindex/delta may be the stall). */
    writing?: boolean;
    /** An identity heal is mid-flight (rebuildFromSidecar / in-place stamp). */
    identityHeal?: boolean;
}

/** Catch-up armed because Honor / excluded folders changed. */
export interface ExclusionAlignEntry {
    type: 'exclusion-align';
    timestamp: string;
    newlyIncluded: number;
    newlyExcluded: number;
    newlyIncludedFolders: string[];
    newlyExcludedFolders: string[];
}

// Stamped onto every entry by logger.append(). Optional so pre-v9 logs (which
// predate device/session attribution) still parse — the report treats a missing
// deviceId as 'legacy' and a missing sessionId as un-scopable.
export interface LogMeta {
    deviceId?: string;
    sessionId?: string;
}

// Intersecting the union with LogMeta keeps `.type` discrimination working
// (TS distributes the intersection) while making `.deviceId` / `.sessionId`
// readable on any LogEntry without narrowing first.
export type LogEntry = (
    | InitEntry
    | PlatformEntry
    | LoadEntry
    | EmbedProfileEntry
    | IndexProgressEntry
    | IndexCompleteEntry
    | SearchEntry
    | ClickEntry
    | ErrorEntry
    | ResetEntry
    | LongTaskEntry
    | MemoryPressureEntry
    | ModelLifecycleEntry
    | CrashDetectedEntry
    | StorageSnapshotEntry
    | EvictionSuspectedEntry
    | AppLocalFetchEntry
    | ModelDeliveryEntry
    | Phase5SmokeEntry
    | WebgpuEventEntry
    | SidecarHydrateEntry
    | SidecarHydrateTierEntry
    | SidecarHydrateGreedyEntry
    | DeltaApplyEntry
    | RechunkLiveEntry
    | StartupSpanEntry
    | StartupGateEntry
    | StoreLockRetryEntry
    | StoreLockExhaustedEntry
    | StoreForceResetEntry
    | BootWatchdogEntry
    | ExclusionAlignEntry
) & LogMeta;
