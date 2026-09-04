/**
 * @file search.ts
 * @module SearchOrchestrator
 *
 * ## Responsibilities
 * Primary coordinator for Seek's vault indexing and semantic/lexical search subsystem:
 * - Coordinates the end-to-end lifecycle: chunking -> embedding -> indexing -> caching -> retrieval.
 * - Manages full vault reindexing (`reindexAll`), incremental delta updates (`reindexDelta`), and
 *   coherence verification (`onCoherenceDrift`).
 *
 * ## Domain Submodule Architecture
 * `SearchOrchestrator` delegates specialized domains to extracted single-responsibility modules:
 * - **`CacheManager` (`src/cache-manager.ts`)**: Single authority owning all query-time RAM structures
 *   (`frameCache`, `bm25Cache`, `binaryIndex`, `synonymCache`). Zero dual-cache duplication.
 * - **`SearchQuery` (`src/search-query.ts`)**: Retrieval pipeline engine executing Stage 0 ladder,
 *   Stage 1 Hamming + BM25, candidate pooling, Stage 2 dense reranking, and TM2C2 score fusion.
 * - **`SidecarCoordinator` (`src/sidecar-coordinator.ts`)**: Multi-device sync, peer chunk hydration,
 *   shard compaction, and dead device directory sweeps.
 * - **`IndexCoordinator` (`src/index-coordinator.ts`)**: Concurrency authority providing the single
 *   write serialization mutex (`runExclusive`), generation counter, and cooperative pacer yielding.
 * - **`FrameUtils` (`src/frame-utils.ts`)**: Low-level packed sign vector and int8 row space layout.
 * - **`Coherence` (`src/coherence.ts`)**: Drift circuit breakers, generation guards, and coherence checks.
 * - **`Bm25Persist` (`src/bm25-persist.ts`)**: Disk serialization identity stamps for the BM25 index.
 *
 * ## Lifecycle & Order Dependencies
 * 1. **Initialization**:
 *    - `SearchOrchestrator` instantiates sub-coordinators (`IndexCoordinator`, `CacheManager`,
 *      `SearchQuery`, `SidecarCoordinator`).
 *    - Opens `IndexStore` and verifies database schema compatibility.
 * 2. **Startup Sequence**:
 *    - **Hydration First**: `sidecarCoord.hydrateFromSidecar()` runs before catch-up indexing.
 *      Hydrating peer embeddings directly into IndexedDB avoids redundant re-embedding.
 *    - **Cache Warming**: `cacheMgr.warmCaches()` loads resident frames and BM25 index into RAM.
 * 3. **Write Operations (`reindexDelta`, `reindexAll`)**:
 *    - Must acquire `IndexCoordinator.runExclusive()` to serialize IDB writes.
 *    - Mutates `CacheManager` in lockstep (`appendFrameRows` + `bm25.add`) or invalidates atomically.
 *    - Increments `IndexCoordinator.generation` to signal index changes.
 * 4. **Query Operations (`search`)**:
 *    - Strictly read-only; delegates to `SearchQuery.search()`.
 *    - Does NOT acquire the write mutex, allowing queries to interleave with paced background indexing.
 */

import type { App } from 'obsidian';
import { Notice, TFile } from 'obsidian'; // value imports: reindexDelta uses `instanceof TFile`; the quota gate toasts
import type { Chunk, ChunkMeta, ScoredChunk, SearchEntry, SearchPartial, IndexCompleteEntry, IndexProgressEntry, ResetEntry, DeltaApplyEntry, QueryFilters, FilterContext, SeekSettings, MemorySnapshot } from './types';
import { snapshotMemory, memoryDelta, distributionStats } from './types';
import { MarkdownChunker, cyrb53Hex } from './chunker';
import { extractBaseDocs } from './base-extractor';
import { MultiFieldBM25 } from './bm25';
import { buildSynonymMap, chunkDeclaresAlias, type SynonymMap } from './synonyms';
import { TaskContextTracker } from './task-context';
import type { FileCacheLite, VaultLexIndex } from './vault-lex';
import { IndexStore, classifyFileDelta, findOrphanChunkIds, isStoreClosedError, isQuotaError, stripContent, META_SCHEMA_VERSION, type MetaConfig, type FileRecord } from './index-store';
import { computeFolderCoverage, type FolderCoverageSummary } from './folder-coverage';
import { INDEX_QUOTA_MSG } from './index-notice';
import { LocalEmbedder, EMBEDDING_DIM, LEGACY_ENGLISH_MODEL_ID, MODEL_ID, PLUGIN_VERSION } from './embedder';
import { SeekLogger } from './logger';
import { seekPerf } from './perf-console';
import { Forensics } from './forensics';
import { selectIndexBucket } from './iframe-runner';
import { enforceTokenBudget, embedInput, createBatchedTokenCounter, TOKEN_COUNTS_BATCH, type TokenBudgetResult } from './token-budget';
import { packSignBits } from './binary';
import { BinaryScorerWorker } from './binary-scorer';
import { quantizeInt8, dequantizeInt8, type QuantVec } from './quant';
import { VecReservoir, denseBgStats, BG_RESERVOIR, MIN_BG_SAMPLE } from './dense-stats';
import { bulkAppend, clearDevice, sidecarDirSignature, shouldReconcileSidecar, staleSidecarFormat, SIDECAR_FORMAT, bm25PathFor, writeBytesAtomic, ensureDir, listSidecarDeviceIds, listDeviceShards, compactDevice, coalesceSmallShards, type CompactResult, type CoalesceResult, type TierBytes } from './sidecar';
import { writeDeviceMeta, readDeviceMeta, metaAccepts, expectationFor, type SidecarMeta, type MetaExpectation } from './sidecar-meta';
import { hydrateFromSidecar, rankAcceptedProducers, probePeerAhead, type ReChunkedNote, type HydrateResult, type HydrateDeps } from './sidecar-sync';
import { pluginIdentity, shouldStampLiveIdentity, identityHealEligibility, type IndexIdentity } from './identity';
import { gzipString, gunzipToString, gzipAvailable } from './gzip';
import { IndexCoordinator } from './index-coordinator';
import { CompositorPacer, cheapYield } from './pacer';
import { isMobilePlatform, residentInt8Enabled } from './platform';
import { CacheManager } from './cache-manager';
import { SearchQuery, type RecencyOverride, dedupByPath, topKByScore } from './search-query';
import { SidecarCoordinator } from './sidecar-coordinator';
import {
    alignCandidate,
    buildResidentRerankBlock,
    type ResidentFrame,
    type DeltaAdd,
    chunkMetaEqual,
    pushDeltaAdds,
    freshDeltaAdds,
    frameMetaOf,
    appendFrameRows,
    tombstoneFrameRows,
    buildSelectionMask,
} from './frame-utils';
import {
    COMPACTION_TOMBSTONE_FRACTION,
    COHERENCE_SAMPLES,
    COHERENCE_DRIFT_COOLDOWN_MS,
    coherenceDriftDecision,
    shouldDiscardPartialFrame,
    type DriftRecoveryState,
    driftRecoveryDecision,
    type RowSpaceProbe,
    frameBm25Coherent,
} from './coherence';
import {
    type Bm25PersistStamp,
    buildBm25Stamp,
    bm25StampMatches,
} from './bm25-persist';

// Indexing batches via PER-BUCKET ROLLING BUFFERS (2026-06-03 redesign).
//
// The problem: naive within-file batching ran an effective batch of ~2.2
// (chunks-per-file p50=1 / p95=6) AND padded every batch to its longest
// member's seq bucket. The offline padding sim measured this at 45% efficient
// — over half of all forward compute was padding.
//
// The fix: route each chunk into a buffer keyed by ITS OWN seq bucket
// (selectIndexBucket on the chunk's EXACT token count — WS2.3 replaced the
// chars/4.5 estimate, which under-bucketed dense text and silently truncated
// below the cap), and flush a buffer the instant it reaches its per-bucket
// size (rollingBatchFor), carrying the remainder across files. Because a buffer's chunks share
// a bucket, the dispatch pads to exactly that bucket (zero cross-length waste),
// and because the flush size is FIXED and warmed, the (batch×seq) shape set
// stays inside WARMUP_BATCH_SIZES — the precondition the reverted arbitrary-
// coalescer violated (it packed groups to 7/17/22… → SafeInt overflow). Sim:
// 45%→85% efficiency, −47% forward work, dispatches 1865→~520.
//
// Smoothness: the flush size is the stutter knob, not the pacer. A dispatch is
// non-preemptible once on Metal's queue, so the worst-case stall = the largest
// dispatch's forward time. ModernBERT's global-attention layers are ~O(seq²),
// so a full batch in the 512 bucket is the longest stall by far (measured p95
// 587 ms at a flat batch of 8, 2026-06-04). So we DON'T use a flat size — we
// hold batch×seq roughly constant at a token BUDGET: big buckets flush at a
// small batch (512→3), small buckets at the cap (8). This caps the worst stall
// while leaving the cheap short-bucket dispatches full. Per-chunk compute is
// unchanged (each chunk is one independent sequence); we trade a few extra
// dispatches in the rare long buckets for shorter individual stalls. pace()
// still runs between every flush, so duty cycle stays idle-gated.
//
// ROLLING_BUDGET ≈ target batch×seq per dispatch. 1536 → {512:3, 384:4, 256:6,
// ≤192:8}. Every resulting size is in WARMUP_BATCH_SIZES [1..8]. ROLLING_MAX is
// the warmed ceiling (also mobile's thermal-friendly flush size). Lower the
// budget to cut the p95 further (more dispatches); raise it for throughput.
const ROLLING_BUDGET = 512;
const ROLLING_MAX = 8;
// WASM batch experiment CLOSED (2026-06-11): a flat batch of 4 on the CPU EP
// measured a WASH against this token-budget sizing (3.60 vs 3.83 files/s on
// the same 365-file steady segment, iPhone 15 Pro) — per-call overhead is not
// the bottleneck, and neither is padding (exact-length cut padded tokens 13%
// at identical wall time; see iframe embedBatch). Single-thread CPU forward
// is at a floor only threads (COOP/COEP, Obsidian-core) would move. Reverted
// to one shared sizing: on wasm the budget also caps the synchronous
// main-thread stall per dispatch, which batch=4 made ~4× worse for nothing.
function rollingBatchFor(bucket: number): number {
    return Math.max(1, Math.min(ROLLING_MAX, Math.round(ROLLING_BUDGET / bucket)));
}

// How often to emit a progress entry during indexing (every N committed files).
const PROGRESS_EVERY = 25;
// Time floor for the progress cadence: never let the counter sit silent
// longer than this while files are committing (see the cadence comment at
// the emit site — two healthy iPhone WASM runs were force-quit as "stalled").
const PROGRESS_MAX_SILENCE_MS = 2500;

// Full-reindex soft preempt: while the user is typing in the search modal or a
// Minimum spacing between "storage full" toasts. Quota exhaustion re-surfaces on
// every retried pass (catch-up bursts re-fire), and the condition can persist for
// hours — one Notice per pass would be a toast storm saying the same thing.
const QUOTA_NOTICE_MIN_INTERVAL_MS = 5 * 60_000;

// ---- Stage-1 candidate-gen caps (Seek Retrieval Relevance & Query §Two-Stage
// ANN → Rerank, the [!done] callout). The union of the three arms feeds the fp32
// exact rerank in stage 2. The caps now SCALE with live corpus size (√N, clamped
// to per-arm floor/ceiling) so a fixed top-200 doesn't cover a shrinking fraction
// of a growing vault — see pool.ts for the full rationale, the cost model, and
// why recency is held flat. `poolCaps(liveN)` is computed per query off the live
// chunk count; at our current ~5k scale it returns exactly the old constants, so
// behaviour is identical until the vault grows past POOL_ANCHOR_N.

// Vault-root files that are machine-generated and would otherwise pollute
// the index with constant-touch recency. The mtime on these files moves
// every time the plugin writes, which means recency=~1.0 → +0.25 lift on
// every fused score, drowning out actual content matches.
//
// This is a v0 hardcoded list rather than a settings string because we
// have zero admin console in v0. Anything that turns into a recurring
// "where did my note go" complaint should be added here.
const EXCLUDED_PATHS = new Set([
    'seek-report.md',
    'spike-report.md',
]);
const EXCLUDED_PREFIXES = [
    // Future-proofing: if someone runs multiple spike variants, the
    // generated reports tend to share these stems.
    'spike-init',
    'seek-init',
    '.seek-artifacts/',
];

// Honor Obsidian's user-configured "Excluded files" (Settings → Files & Links).
// A user who hid a folder from Obsidian's own search/link suggestions expects
// Seek to hide it too — but vault.getMarkdownFiles() ignores that list, so we
// must filter it ourselves. The API isn't in the public typings, so reach the
// runtime defensively: prefer metadataCache.isUserIgnored() (Obsidian's own
// matcher — it handles both the folder-prefix and /regex/ filter forms and
// stays drift-free across versions), falling back to matching the raw
// userIgnoreFilters list on builds that predate that method.
function isUserIgnored(app: App, path: string): boolean {
    const mc = app.metadataCache as unknown as { isUserIgnored?: (p: string) => boolean };
    if (typeof mc.isUserIgnored === 'function') return mc.isUserIgnored(path);
    const getConfig = (app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig;
    const filters = (typeof getConfig === 'function'
        ? getConfig.call(app.vault, 'userIgnoreFilters')
        : null) as string[] | null;
    if (!Array.isArray(filters)) return false;
    return filters.some(filter => {
        // /pattern/ → regex (Obsidian's own delimiter convention).
        if (filter.length > 1 && filter.startsWith('/') && filter.endsWith('/')) {
            try { return new RegExp(filter.slice(1, -1)).test(path); } catch { return false; }
        }
        // Otherwise a folder/path prefix: match the file itself or anything under it.
        return path === filter || path.startsWith(filter.endsWith('/') ? filter : filter + '/');
    });
}

// The single index-membership predicate, exported so any code that offers a
// value SOURCED from the note (a filter pill, an autocomplete suggestion, …)
// can check whether the note it came from actually reaches the index — a
// pill built from Obsidian's raw metadataCache (which doesn't honor "Excluded
// files") can otherwise promise a result that the matcher will never return.
// SearchOrchestrator.shouldIndex delegates here so there is exactly one
// implementation to keep in sync (see the audit note in suggest.ts).
export function shouldIndexPath(app: App, settings: SeekSettings, path: string): boolean {
    if (EXCLUDED_PATHS.has(path)) return false;
    if (EXCLUDED_PREFIXES.some(p => path.startsWith(p))) return false;
    if (settings.honorIgnoredFolders && isUserIgnored(app, path)) return false;
    return true;
}


// 1C: an index pass's deferred sidecar flush. embedAndCommitFiles always runs
// inside the write mutex; instead of flushing the sidecar there (pure file IO the
// IDB index never depends on), it packages everything the flush needs and the
// pass runs it via flushSidecarAfterPass once the mutex has released. All fields
// are captured in the critical section, so the flush writes exactly what the
// pass indexed regardless of when the job actually runs.
interface SidecarFlushJob {
    pending: Array<{ id: string; tiers: TierBytes; mtime: number }>;
    mode: 'full' | 'incremental';
    bgMean: number | undefined;
    bgStd: number | undefined;
    identity: IndexIdentity;
}

export class SearchOrchestrator {
    private app: App;
    private store: IndexStore;
    private embedder: LocalEmbedder;
    private logger: SeekLogger;
    // Crash forensics (synchronous breadcrumbs). Null in tests / when the
    // plugin couldn't create it — every use is optional-chained.
    private forensics: Forensics | null;
    // Long-task attribution spans (owned by the plugin; null in tests). The
    // orchestrator marks its own main-thread-heavy phases — currently the BM25
    // cold build — so the longtask observer can attribute their jank.
    private taskCtx: TaskContextTracker | null;
    private chunker = new MarkdownChunker();
    // Live settings reference (the plugin mutates the same object on settings
    // change, so the orchestrator always reads current values). See types.ts.
    private settings: SeekSettings;
    // Shared index-mutation coordination — the write mutex, the in-flight delta
    // gate, the cache-generation counter, and the sidecar location/enablement.
    // Factored out so the indexing and searching halves share exactly this state.
    // See IndexCoordinator.
    private coord: IndexCoordinator;

    // Off-thread stage-1 binary scorer (desktop only; synchronous fallback
    // everywhere). Owns its Worker; disposed on plugin unload. See binary-scorer.ts.
    private binaryWorker: BinaryScorerWorker;
    private cacheManager: CacheManager;
    private searchQuery: SearchQuery;
    private sidecarCoordinator: SidecarCoordinator;

    // Set once, in dispose() (plugin unload / disable). A reindex that is still
    // embedding when the plugin unloads keeps running on the microtask queue AFTER
    // onunload has already closed the store — every subsequent commit would then throw
    // "IndexStore not opened", one error per remaining file (the ~980-error storm).
    // The embed loop checks this at its top + final drain to STOP promptly instead of
    // grinding through the rest of the vault against a dead connection. Sticky: the
    // orchestrator is being torn down, so a re-enable builds a fresh instance.
    private disposed = false;

    // Paths that failed to read during an embed attempt (e.g. an undownloaded
    // iCloud placeholder that throws on every read), mapped to the epoch ms their
    // backoff expires. Without this, a persistently-unreadable file's stale
    // record gets dropped as part of the failed re-embed, so every LATER
    // computeDelta sees prev===undefined and reports it dirty again forever —
    // which wedges reconcileIdentityInPlace in 'drained' permanently (see there).
    // Quarantining it lets computeDelta skip it until the backoff elapses, and a
    // full reindex (reindexAllInner) clears the map so it is always retried then.
    private static readonly UNREADABLE_QUARANTINE_MS = 30 * 60 * 1000; // 30 min
    private unreadableQuarantine = new Map<string, number>();

    // Last time the "storage full" Notice was shown (epoch ms). Rate-limits the
    // toast across passes (see QUOTA_NOTICE_MIN_INTERVAL_MS); the check line +
    // forensics beat still record every affected pass.
    private lastQuotaNoticeAt = 0;

    // S4 tripwire instrumentation: how often (and why) applyDelta declined the
    // incremental patch and forced a full O(corpus) cache rebuild this session.
    // Read nowhere yet — the counts ride each 'delta-fallback' forensics beat so
    // live sessions reveal whether fallback churn is worth engineering against.
    private readonly deltaFallbackCounts = new Map<string, number>();

    private isQuarantined(path: string): boolean {
        const until = this.unreadableQuarantine.get(path);
        return until !== undefined && Date.now() < until;
    }

    // Called wherever an indexable file's content could not be read. Logs once
    // per quarantine spell (not on every retry) so a wedged file doesn't spam.
    private quarantineUnreadable(path: string): void {
        const isNew = !this.unreadableQuarantine.has(path);
        this.unreadableQuarantine.set(path, Date.now() + SearchOrchestrator.UNREADABLE_QUARANTINE_MS);
        if (isNew) console.warn(`[seek] quarantining persistently unreadable file (will retry on backoff / next full reindex): ${path}`);
    }

    constructor(app: App, store: IndexStore, embedder: LocalEmbedder, logger: SeekLogger, settings: SeekSettings, forensics: Forensics | null = null, indexDir: string | null = null, taskCtx: TaskContextTracker | null = null) {
        this.app = app;
        this.store = store;
        this.embedder = embedder;
        this.logger = logger;
        this.settings = settings;
        this.forensics = forensics;
        this.taskCtx = taskCtx;
        this.coord = new IndexCoordinator(indexDir, settings);
        this.binaryWorker = new BinaryScorerWorker();
        this.cacheManager = new CacheManager({
            app: this.app,
            store: this.store,
            coord: this.coord,
            embedder: this.embedder,
            settings: this.settings,
            logger: this.logger,
            forensics: this.forensics ?? undefined,
            taskCtx: this.taskCtx ?? undefined,
        });
        this.searchQuery = new SearchQuery({
            app: this.app,
            store: this.store,
            cacheManager: this.cacheManager,
            coord: this.coord,
            embedder: this.embedder,
            binaryWorker: this.binaryWorker,
            settings: this.settings,
            logger: this.logger,
            shouldIndex: (path) => this.shouldIndex(path),
            onCoherenceDrift: (where) => this.onCoherenceDrift(where),
            delegates: {
                getBinaryWorker: () => this.binaryWorker,
                peekResidentFrame: () => this.peekResidentFrame(),
                topByRecency: (chunks, k, mask) => this.topByRecency(chunks, k, mask),
                appendSearchTelemetry: (entry) => this.appendSearchTelemetry(entry),
                emitVaultLadder: (cleanedQuery, topK, onPartial, signal, t0) =>
                    this.emitVaultLadder(cleanedQuery, topK, onPartial, signal, t0),
                vaultFilterBrowse: (filters, filterCtx, topK, signal) =>
                    this.vaultFilterBrowse(filters, filterCtx, topK, signal),
                hydrateBodies: (results) => this.hydrateBodies(results),
            },
        });
        this.sidecarCoordinator = new SidecarCoordinator({
            app: this.app,
            store: this.store,
            coord: this.coord,
            embedder: this.embedder,
            logger: this.logger,
            settings: this.settings,
            cacheManager: this.cacheManager,
            forensics: this.forensics,
            chunksFor: (content, path, modifiedIso) => this.chunksFor(content, path, modifiedIso),
            indexableFiles: () => this.indexableFiles(),
            shouldIndex: (path) => this.shouldIndex(path),
            onGoodEnough: () => this.onGoodEnough?.(),
        });
    }

    // Release the off-thread scorer's Worker. Called from the plugin's onunload
    // so a reload/disable doesn't leak the worker context. Also signals any in-flight
    // reindex to stop (the embed loop polls `disposed`) so it doesn't keep committing
    // against the store onunload is about to close.
    dispose(): void {
        this.disposed = true;
        this.binaryWorker.dispose();
        this.cacheManager.dispose();
    }

    // The cache-generation counter (bumped on every index mutation; see
    // IndexCoordinator). Public so the plugin's drift-recovery scheduler can key
    // re-escalation suppression to it: a degraded index re-trips drift on every
    // keystroke, but the generation only advances on a real mutation (delta /
    // reindex / invalidate / hydrate), so equal generation ⇒ "nothing changed since
    // we last escalated, don't re-escalate".
    currentGeneration(): number {
        return this.coord.generation;
    }

    // True while a reindex/delta/cold-build critical section is running under the
    // write mutex, OR while a pass's off-mutex sidecar flush (1C) is still in
    // flight. Every consumer (the reconcile poll's busy gate, the identity-heal
    // guard, runFullReindex's stacking guard — see main.ts) wants the conservative
    // reading: without the flush half, a second full reindex could pass the
    // stacking guard in the seconds-long window between the mutex releasing and
    // the whole-corpus flush landing, and the first pass's chained flush would
    // then append the entire prior corpus as litter behind the second's
    // clearDevice. Searches and deltas never consult this, so folding the flush
    // in does not re-serialize what 1C unlocked.
    isWriting(): boolean {
        return this.coord.isWriting() || this.sidecarFlushesInFlight > 0;
    }

    /** True while warmCaches is rebuilding frame/BM25 (observable boot gate). */
    isWarmingCaches(): boolean {
        return this.warming;
    }

    /** Join startup/pre-catchup warm if already in flight (avoids parallel ensureFrame). */
    async awaitWarmCachesIfInFlight(): Promise<void> {
        if (this.warmPromise) await this.warmPromise;
    }

    // Full reindex. Drops the database, walks all markdown, re-embeds everything.
    // Serialized against deltas via the write mutex (a delta mid-nuke would throw).
    async reindexAll(onProgress?: (msg: string) => void, opts: { shouldContinue?: () => boolean } = {}): Promise<IndexCompleteEntry> {
        let result: IndexCompleteEntry;
        try {
            const inner = await this.coord.runExclusive(() => this.reindexAllInner(onProgress, opts.shouldContinue));
            result = inner.entry;
            // 1C: the pass only PACKAGED its sidecar flush; run it now that the
            // mutex has released, still awaited so "reindexAll resolved ⇒ sidecar
            // flushed" holds for every caller.
            await this.flushSidecarAfterPass(inner.sidecarJob);
        } catch (e) {
            // Pass-level quota (S2): the per-file classifier only sees commitFile's
            // catch; on a truly full disk the pass's OWN writes (the post-nuke
            // setMeta, the end-of-pass meta stamp) can quota-throw too — the
            // highest-stakes case, since the nuke already dropped the previous
            // index. Surface the same actionable signal, then rethrow: the pass
            // still failed and the caller's generic handler still reports it.
            if (isQuotaError(e)) {
                this.forensics?.beat('index-quota-exhausted', { files: 0, mode: 'full-pass-write' });
                this.quotaToast();
            }
            throw e;
        }
        // Off the mutex: re-warm reads the committed index; a search arriving
        // first just does the same build itself (see warmCaches).
        void this.warmCaches('full-reindex');
        return result;
    }

    // Rate-limited (5 min) storage-full toast — catch-up bursts re-trip the quota
    // gate for as long as the disk stays full, and one actionable message is
    // signal where a toast-per-burst is noise.
    private quotaToast(): void {
        if (Date.now() - this.lastQuotaNoticeAt < QUOTA_NOTICE_MIN_INTERVAL_MS) return;
        this.lastQuotaNoticeAt = Date.now();
        new Notice(INDEX_QUOTA_MSG, 10000);
    }

    // ── 1C: off-mutex sidecar flush ─────────────────────────────────────────
    // An index pass no longer flushes the sidecar inside its write-mutex critical
    // section: embedAndCommitFiles packages a SidecarFlushJob and the pass runs it
    // here AFTER runExclusive releases, so searches (ensureFrame waiting on
    // currentDelta) and queued deltas stop paying for sidecar file IO. Callers
    // still await the flush before resolving — the public contract ("pass
    // resolved ⇒ sidecar flushed") is unchanged; only the lock hold shrinks.
    //
    // Jobs are chained strictly FIFO. File-level safety already comes from the
    // sidecar dir lock (bulkAppend / writeDeviceMeta / clearDevice / compact /
    // coalesce all serialize on it, and bulkAppend holds it across its whole
    // shard+jsonl span, so a reconcile compaction overlapping an in-flight flush
    // can never mistake a half-flushed shard for a crash orphan). What the dir
    // lock does NOT order is two whole read-meta → write-meta → append sequences:
    // with the mutex released before flushing, pass B's critical section can
    // complete while pass A's flush is still in flight, and unchained jobs could
    // interleave so A's meta write (older lastFullReindex / bg calibration) lands
    // after B's. The chain removes that class within this process; cross-process
    // ordering was never the mutex's to give (iCloud offers none) and stays with
    // the sidecar protocol's mtime-keyed resolution. The one remaining
    // same-process interleave is a FULL pass's in-mutex pass-START clearDevice
    // racing a prior delta's in-flight flush: clear-then-flush leaves pre-nuke
    // records as reclaimable litter (ids that survive the re-chunk resolve
    // identically; changed ids are compactDevice-oracle orphans; the seq floor is
    // preserved by both paths), flush-then-clear just wipes records the rebuild
    // is about to replace. Benign either way.
    private sidecarFlushChain: Promise<void> = Promise.resolve();
    // Jobs enqueued or running. Folded into isWriting() so the busy/stacking
    // guards treat an in-flight flush as "still indexing" (see isWriting).
    private sidecarFlushesInFlight = 0;

    private flushSidecarAfterPass(job: SidecarFlushJob | null): Promise<void> {
        if (!job) return Promise.resolve();
        this.sidecarFlushesInFlight++;
        // The .catch is load-bearing twice over, NOT belt-and-braces: runSidecarFlush
        // is written to never reject, but that rests on a non-local invariant (its
        // own catch handler's logging), and a single rejected link would (a) wedge
        // the chain so no future flush ever runs and (b) leak the stale error into
        // every later pass — reindexDelta's .finally would replace a SUCCESSFUL
        // critical section's result with it. Swallow here so both the chain and the
        // promise callers await are structurally rejection-free.
        const run = this.sidecarFlushChain
            .then(() => this.runSidecarFlush(job))
            .catch(() => {})
            .finally(() => { this.sidecarFlushesInFlight--; });
        this.sidecarFlushChain = run;
        return run;
    }

    // The flush body, moved verbatim from embedAndCommitFiles (1C). Best-effort:
    // a sidecar failure must never fail the (already-committed) IDB index — it
    // just means cross-device/eviction durability lags a pass.
    private async runSidecarFlush(job: SidecarFlushJob): Promise<void> {
        // A disposed orchestrator must not write: a queued job outliving onunload
        // would keep appending after a plugin disable, and across a disable→
        // re-enable the NEW instance serializes on a fresh module-scoped dir-lock
        // map — the detached writer and the new pass's clearDevice/bulkAppend
        // would no longer mutually exclude, and a last-rename-wins collision could
        // republish a shard seq with different bytes (the #91 invariant). Skipping
        // is the documented-safe direction: a durability lag hydrate self-heals.
        if (this.disposed) return;
        // Re-read the live setting: it can toggle off between the pass and this flush.
        if (!this.coord.sidecarOn()) return;
        try {
            const adapter = this.app.vault.adapter;
            // Create the sidecar dir up front. The F8 ordering writes meta FIRST,
            // and writeDeviceMeta (→ writeTextAtomic) does not create parents — so
            // on a fresh install the meta write would ENOENT and the catch below
            // would abort the WHOLE flush before bulkAppend (which ensures the dir
            // itself) ever runs, leaving no sidecar at all. ensureDir here makes the
            // dir exist before any write, independent of which write lands first.
            await ensureDir(adapter, this.coord.dir!);
            // F8: write/refresh meta BEFORE appending shard+jsonl. These three
            // writes aren't one transaction; ordering meta first means a crash
            // between them leaves meta-without-data (metaAccepts refuses cleanly;
            // the records re-embed next pass) instead of data-without-meta — a
            // fully-written sidecar the null-meta gate refuses, un-hydratable
            // until a full reindex, defeating the eviction-recovery the sidecar
            // exists for.
            const prior = await readDeviceMeta(adapter, this.coord.dir!, this.logger.deviceId);
            // A SIDECAR_FORMAT bump alone (no chunker/model/dim change) never forces
            // a full reindex — identityMatches deliberately excludes it (identity.ts).
            // An ordinary INCREMENTAL flush landing here after such a bump would
            // otherwise write the CURRENT format into meta below while every untouched
            // note's shard bytes are still in the PRIOR record stride — a lie that
            // later misleads this device's own compactOwnSidecar (and any peer
            // hydrating from it) into decoding stale-stride bytes as corrupt. A full
            // pass already clearDevice()'d at its start (prior reads null here), so
            // this only fires for the incremental case: wipe first so the meta write
            // below is never untrue relative to what's actually on disk.
            if (staleSidecarFormat(prior, job.identity.sidecarFormat)) {
                await clearDevice(adapter, this.coord.dir!, this.logger.deviceId, { preserveSeqFloor: true });
            }
            await writeDeviceMeta(adapter, this.coord.dir!, {
                // Canonical version slice (modelId/revision/chunkerVersion/dim)
                // from the single identity source — NOT embedder.modelId, which
                // is '' until a model load. format gates the cross-device protocol.
                ...expectationFor(job.identity),
                format: job.identity.sidecarFormat,
                deviceId: this.logger.deviceId,
                lastFullReindex: job.mode === 'full' ? new Date().toISOString() : (prior?.lastFullReindex ?? null),
                bgMean: job.bgMean,
                bgStd: job.bgStd,
            });
            await bulkAppend(adapter, this.coord.dir!, this.logger.deviceId, job.pending);
        } catch (e) {
            // Guarded so a logging failure can't turn into a rejection of this
            // method — the chain in flushSidecarAfterPass swallows anyway, but the
            // "never rejects" contract should hold locally, not by rescue.
            await this.logger.appendError('sidecar-commit', e).catch(() => {});
        }
    }

    private async reindexAllInner(onProgress?: (msg: string) => void, shouldContinue?: () => boolean): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null }> {
        const overallStart = performance.now();
        const memBefore = await snapshotMemory();

        // A full reindex re-attempts every file regardless of quarantine — clear
        // the backoff map so a file that has since become readable (e.g. an
        // iCloud placeholder that finished downloading) isn't skipped here too.
        this.unreadableQuarantine.clear();

        // Reset. Clear stores on the live connection — do not deleteDatabase.
        // A second vault window holding the same IDB blocks delete forever and
        // can freeze Electron if a later open races a pending delete.
        const resetStart = performance.now();
        const pre = await this.store.clearAllStores();
        await this.store.setMeta({
            embeddingDim: EMBEDDING_DIM,
            lastIndexedAt: null,
            schemaVersion: META_SCHEMA_VERSION,
            modelId: this.embedder.modelId,
        });
        const resetEntry: ResetEntry = {
            type: 'reset',
            timestamp: new Date().toISOString(),
            droppedDatabase: this.store.dbName,
            chunksDeleted: pre.chunks,
            vectorsDeleted: pre.embeddings,
            durationMs: parseFloat((performance.now() - resetStart).toFixed(2)),
            pass: true,
            checks: [
                `✅ dropped database "${this.store.dbName}"`,
                `ℹ️ removed ${pre.chunks} chunks, ${pre.embeddings} vectors, ${pre.files} file records`,
            ],
        };
        await this.logger.append(resetEntry);

        // Scan. Filter out (a) Seek's own diagnostic outputs / machine-generated
        // chatter (see EXCLUDED_PATHS) and (b) anything the user has hidden via
        // Obsidian's "Excluded files" setting (see isUserIgnored).
        const allFiles = this.indexableFiles();
        const skipped: string[] = [];
        const files = allFiles.filter(f => {
            const include = this.shouldIndex(f.path);
            if (!include) skipped.push(f.path);
            return include;
        });
        if (skipped.length > 0) {
            /* intentionally empty: skipped paths are collected above for the
               filter's side effect; no per-run action is taken on them here */
        }
        // Progressive ordering: index most-recently-modified files first. Since
        // search rebuilds BM25 in-memory and dense reads commit per file, the
        // index is queryable as it fills — recency-first means the notes a user
        // is most likely to search are searchable soonest, and on a phone that
        // may never finish a full pass, recency decides COVERAGE, not just order.
        files.sort((a, b) => b.stat.mtime - a.stat.mtime);
        await this.emitProgress('scan', 0, files.length, 0, performance.now() - overallStart);

        // shouldContinue in full mode = the soft preempt (pause/resume between
        // files while the user searches — see embedAndCommitFiles' budget comment).
        // The engine's sidecar flush comes back PACKAGED (1C) and rides through to
        // reindexAll, which runs it after the mutex releases.
        const result = await this.embedAndCommitFiles(files, 'full', onProgress, overallStart, memBefore, { shouldContinue });

        // Bump dataGeneration on COMPLETION. main.ts invalidates once BEFORE the
        // reindex, but a search firing during the rebuild then caches the frame /
        // binary index at that generation off the PARTIALLY-filled store; nothing
        // bumped again at the end, so a post-reindex search kept serving that
        // frozen partial frame (the frame + binary caches are generation-keyed
        // only — no chunk-count belt-and-braces like BM25 has). Invalidating here
        // forces the next search to rebuild against the complete index.
        this.invalidateBm25Cache();
        return result;
    }

    // The shared embed + commit engine behind both reindexAll (whole vault, after
    // nuke) and reindexDelta (just the changed files, after their stale chunks are
    // dropped). Per-bucket rolling-buffer batching, atomic per-file commit, the
    // ORT-Web WebGPU overflow recycle+retry, and the throughput rollups all live
    // here. Mode-dependent behavior is minimal: the post-index WebGPU pool reclaim
    // runs for 'full' only (a small delta never grows the pool to the high-water
    // mark, and a 2–4 s teardown per blur-flush would be absurd), and `mode` tags
    // the log entry. `files` is expected pre-sorted recency-first by the caller so
    // the index stays queryable as it fills.
    private async embedAndCommitFiles(
        files: TFile[],
        mode: 'full' | 'incremental',
        onProgress: ((msg: string) => void) | undefined,
        overallStart: number,
        memBefore: MemorySnapshot,
        // Per-burst budget. budgetMs applies ONLY in 'incremental' mode (a full
        // reindex is never time-bounded). The per-burst FILE cap is enforced by the
        // caller (reindexDelta slices its dirty list), so the engine only needs the
        // within-burst aborts: budgetMs = wall-clock ceiling for one pathological
        // huge note; shouldContinue = the live user-activity signal (false while the
        // app is hidden / a search is live). Mode decides what shouldContinue MEANS:
        // 'incremental' ABORTS the burst (files stay dirty; catch-up re-fires later),
        // 'full' PAUSES between files and resumes when the activity clears — a full
        // pass must finish, so it yields the iframe/GPU without giving up (3A).
        // All optional; an empty object = unbounded (the existing behavior).
        // addsSink (Seek scaling A1): when present, commitFile pushes each
        // ACTUALLY-committed chunk's {chunk, q, bin} into it — the add half of the
        // change-set reindexDelta's incremental cache path consumes. Driven off
        // real commits (not the pre-embed file list), so a mid-burst abort yields
        // exactly the rows that landed in IDB. Absent for a full reindex (it
        // rebuilds caches from scratch).
        // storeWasEmpty: the caller's PASS-START emptiness snapshot (reindexDelta
        // captures it before phase-1 + hydration). The engine must NOT re-derive it
        // here: by the time it runs, carry-over + sidecar dedup may have already
        // committed chunks, so a fresh count() would read non-empty on a cold build
        // that hydrated some files and mis-decide sawWholeCorpus. One snapshot, one
        // source. Omitted (reindexAll) = false, harmless since mode==='full' dominates.
        // removedSink / removedBodiesSink / metaPatchSink (chunk-diff commit,
        // issue #5): present only on the incremental delta path. Their presence
        // ENABLES the per-file diff-against-record (the delta's pre-delete is
        // gone — the engine now owns stale-row deletion), and they surface the
        // applied removals (ids + reconstruction bodies) and in-place metadata
        // patches for applyDelta, exactly like addsSink surfaces the commits.
        budget: {
            budgetMs?: number; shouldContinue?: () => boolean; addsSink?: DeltaAdd[]; storeWasEmpty?: boolean;
            removedSink?: string[]; removedBodiesSink?: Map<string, string>;
            metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>;
        } = {},
    ): Promise<{ entry: IndexCompleteEntry; sidecarJob: SidecarFlushJob | null; quarantineUnwound: number }> {
        // Per-bucket rolling-buffer embed. Each chunk lands in the buffer for
        // its own seq bucket; a buffer flushes as one warmed per-bucket-sized
        // dispatch the instant it fills, carrying the remainder across files.
        // Files commit atomically once their last chunk's vector lands. See the
        // ROLLING_BUDGET comment above for the why (45%→85% padding efficiency,
        // overflow-safe warmed shapes, budgeted per-bucket flush to cap stalls).
        let totalChunks = 0;
        // Chunks reconciled WITHOUT embedding (chunk-diff, issue #5): id-stable
        // rows a diff kept (untouched / meta-patch / reindex-row). A pure
        // metadata pass commits files with totalChunks 0 — a legitimate success
        // the pass gate below must not read as "no chunks produced".
        let chunksReconciled = 0;
        let totalVectors = 0;
        let chunkMs = 0;
        let embedMs = 0;
        let paceWaitMs = 0;   // cumulative pacer waits between dispatches (v16, issue #5)
        let commitMs = 0;
        let filesSkippedError = 0;
        let filesSkippedQuota = 0;   // subset of filesSkippedError: commit hit QuotaExceededError (disk full)
        let embedRecycles = 0;
        let filesCommitted = 0;
        // The paths whose file-record was ACTUALLY written (commitFile succeeded) — NOT
        // the same as the prefix of started files: an empty/below-min-chunk note or a
        // mid-list skip-error commits nothing yet still advances processedFiles, so a
        // count-based prefix over-reports. The catch-up drain shrinks its remainder by
        // exactly this set, so an un-committed file stays dirty and is retried (never
        // dropped from the work-list to spin the outer sweep). See reindexDelta.
        const committedFilePaths: string[] = [];
        let processedFiles = 0;   // files we STARTED (for the incremental burst budget + filesDeferred)
        let lastProgress = 0;
        let lastProgressAt = performance.now();
        let tokenBudgetSplits = 0;
        let tokenBudgetOverBudget = 0;
        // Embed-failure quarantine accounting (issue #4): files committed WITH a
        // failure marker (some chunks missing) and the total chunks they lost.
        // `quarantined` remembers each marker written this pass so the pass-end
        // mass-failure gate can UNWIND them: solo-retry evidence can't tell a
        // poisoned chunk from a wedged environment (device-lost storm, app
        // backgrounded mid-pass) — both retries share the same environment. The
        // discriminator is volume: deterministic content failures are rare by
        // nature (issue #4 = one file), an environmental storm hits every
        // in-flight file at once.
        let filesQuarantined = 0;
        let chunksFailedEmbed = 0;
        const quarantined: Array<{ path: string; kept: number }> = [];
        // Check lines minted before the `checks` array exists (the mass-unwind
        // runs right after the bucket drain); spliced into `checks` at build.
        const checksExtra: string[] = [];
        // Fix A (cold first-build identity + background): whether the store was EMPTY
        // before this pass committed anything, from the caller's pass-start snapshot
        // (see the `budget.storeWasEmpty` comment). A truly-empty store means every
        // chunk this pass writes is built by the CURRENT identity AND this single
        // incremental pass sees the WHOLE corpus — so it is functionally a full build.
        // `sawWholeCorpus` below lets it stamp the live identity and compute the
        // dense-cosine background, instead of copying prevMeta's absent fields as
        // `undefined` (the identity gate reads that as stale and "heals" with a spurious
        // full reindex). A NON-empty store with no identity is a LEGACY index (older
        // chunker/model): it must stay stale so the gate rebuilds it, so we gate
        // strictly on emptiness, never on "prevMeta lacks identity".
        const storeWasEmpty = budget.storeWasEmpty ?? false;
        // Corpus dense-cosine background accumulators (dense-stats.ts). Only a
        // FULL pass sees every vector, so only it produces stats; an incremental
        // pass leaves these at zero and carries the prior values forward at
        // setMeta below. bgSum is the running Σ vᵢ (→ exact closed-form μ);
        // reservoir is a uniform sample of vectors for the σ estimate.
        const bgSum = new Float64Array(EMBEDDING_DIM);
        let bgN = 0;
        const reservoir = new VecReservoir(BG_RESERVOIR);
        // Sidecar accumulator: derived (int8 + sign-bit) tiers for every committed
        // chunk, packaged after the embed loop into ONE SidecarFlushJob the caller
        // bulkAppends off the mutex (1C). bulkAppend is
        // append-only (1A: each flush = fresh shard file(s), no rewrite), so the
        // batching here is about shard-count hygiene — one shard per pass instead
        // of one tiny shard per file. A FULL reindex first drops this device's own
        // sidecar files (clearDevice) so the run REPLACES them rather than
        // doubling; an INCREMENTAL delta legitimately appends without clearing, so
        // superseded/deleted records accumulate in this device's jsonl/shards
        // until compactOwnSidecar (once per session) or the next full reindex
        // reclaims them. The growth is bounded and read-safe: hydrate re-chunks
        // the live vault and intersects ids (sidecar-sync), so stale records
        // never resolve — they only cost disk until reclaimed.
        const sidecarPending: Array<{ id: string; tiers: TierBytes; mtime: number }> = [];
        if (this.coord.sidecarOn() && mode === 'full') {
            try {
                // preserveSeqFloor: the rebuild's flushes must allocate ABOVE every
                // shard deleted here — a peer may still hold the old files, and a
                // republished embeddings.<dev>.N.bin with different bytes lets it
                // resolve fresh jsonl refs against stale bytes (sidecar.ts).
                await clearDevice(this.app.vault.adapter, this.coord.dir!, this.logger.deviceId, { preserveSeqFloor: true });
            } catch (e) {
                await this.logger.appendError('sidecar-clear', e);
            }
            // Reap OTHER devices' dead-identity sidecar files (identity ≠ this build).
            // Provably useless — the same metaAccepts gate that refuses them for
            // hydration means no current-version device can use them — so this is
            // sync-safe; an un-updated device simply re-creates its own files until it
            // updates (self-resolving). Stops fleet-wide version drift from piling up.
            // Best-effort: never fail the reindex on a reap error.
            try {
                await this.reapDeadIdentitySidecars();
            } catch (e) {
                await this.logger.appendError('sidecar-reap', e);
            }
        }
        // Forensic dispatch accounting. iOS exposes no heap numbers, so the
        // memory-ceiling hypothesis is tested by CORRELATION instead: every
        // breadcrumb carries cumulative dispatches + padded tokens (batch ×
        // seq-bucket — the real GPU working-set driver, padding included). If
        // repeated deaths cluster at similar cumulative volume, that's the
        // ceiling; deaths at random volume but always hidden are background
        // kills.
        let fDispatches = 0;
        let fPaddedTokens = 0;
        this.forensics?.beat('index-start', { mode, filesTotal: files.length });

        const perFileWallMs: number[] = [];
        const chunksPerFile: number[] = [];
        const embedBatchLatencyMs: number[] = [];

        // A file in flight: its chunks scatter across bucket buffers and resolve
        // as those buffers flush. `remaining` counts unresolved chunks; the file
        // commits (or is skipped, if any chunk errored) the moment it hits 0.
        interface FileState {
            file: (typeof files)[number];
            chunks: Chunk[];
            vectors: (Float32Array | null)[];
            remaining: number;
            hadError: boolean;
            fileStart: number;
            // mtime snapshotted at READ time (not commit time). The file commits
            // many ms later, after its chunks round-trip the embedder; reading
            // file.stat.mtime at commit would record whatever the file's mtime is
            // THEN, which — if the user edited the file mid-index — is newer than
            // the content we actually embedded. computeDelta compares stored mtime
            // to live mtime, so an over-stamped record makes the next delta think
            // the edit is already indexed and silently skips it. Pin the value
            // observed when we read the bytes. (TOCTOU, search.ts read↔commit.)
            mtimeMs: number;
            // cyrb53 of the bytes we read — stored in the file-record so the next
            // computeDelta can tell a real edit from a mtime-only re-stamp.
            contentHash: string;
            // Chunk-diff commit (issue #5): when a diff plan ran, `chunks` holds
            // only the ids that need EMBEDDING, while the file-record must list
            // every live chunk. allChunkIds = the full post-budget id list in
            // document order; keepIds = the id-stable subset whose rows stayed in
            // IDB. commitFile writes record ids = allChunkIds ∩ (keepIds ∪
            // committed) so a failed embed still drops out of the record exactly
            // as it does on the no-diff path.
            allChunkIds?: string[];
            keepIds?: Set<string>;
        }
        // A chunk waiting in a bucket buffer: where to write its vector back.
        // tokens = the chunk's exact token count (from enforceTokenBudget) —
        // on wasm the dispatch pads to the batch max, so the honest
        // paddedTokens forensics counter needs the real lengths.
        interface Pending { fs: FileState; slot: number; input: string; tokens: number; }

        // bucket → chunks awaiting a flush. Created lazily on first use.
        const buffers = new Map<number, Pending[]>();

        // One pacer for the whole run so its idle-slice budget carries across
        // dispatches: consecutive fast flushes can share a single idle window
        // instead of each paying a full yield (pacer.ts / PR #1).
        const pacer = new CompositorPacer();

        // Forensics suffix for embed-failure log contexts: enough to separate a
        // content-shaped failure (which token counts?) from an environment one
        // (which device/glue?) straight from a report — issue #4's log had
        // neither and the triage stalled on it. Counts only, never chunk text
        // (reports are shared). Goes in the CONTEXT, not the message: appendError
        // dedups on message, so a varying suffix here can't fragment the dedup key.
        const dispatchInfo = (inputs: string[], bucket: number, tokens?: number[]): string => {
            const glue = this.embedder.glue;
            return ` n=${inputs.length} bucket=${bucket} dev=${this.embedder.device}${glue ? `/${glue}` : ''}`
                + (tokens && tokens.length === inputs.length ? ` tok=[${tokens.join(',')}]` : '')
                + ` chars=[${inputs.map(t => t.length).join(',')}]`;
        };

        // Embed one warmed batch (≤ ROLLING_MAX inputs that all share a seq
        // bucket), pace after the dispatch, and recover from the ORT-Web WebGPU
        // SafeInt overflow via recycle+retry. The session poisons itself once
        // its int32 buffer accounting overflows (~2200 granite chunks, 2026-06-03
        // diagnosis); a failed dispatch is the signal to recycle (fresh device
        // resets the counter) and retry once. A second failure throws to the
        // caller. Mutates embedRecycles + embedBatchLatencyMs.
        const embedOneBatch = async (inputs: string[], bucket: number, label: string, tokens?: number[]): Promise<Float32Array[]> => {
            // Breadcrumb BEFORE the dispatch (synchronous): if this dispatch
            // kills the process, the ring's last entry says exactly which
            // batch shape died and at what cumulative volume.
            fDispatches++;
            // wasm pads to the batch max (exact-length mode, iframe embedBatch),
            // not the bucket — count what the forward pass actually sees.
            fPaddedTokens += (this.embedder.device === 'wasm' && tokens?.length === inputs.length)
                ? Math.max(...tokens) * inputs.length
                : bucket * inputs.length;
            this.forensics?.beat('index-flush', {
                bucket, n: inputs.length, dispatches: fDispatches,
                paddedTokens: fPaddedTokens, filesCommitted, chunks: totalChunks,
            });
            let result;
            try {
                result = await this.embedder.embedBatch(inputs, bucket);
            } catch (e) {
                // Intentional teardown (onunload → embedder.teardown → dispose)
                // rejects the in-flight RPC tagged 'DISPOSED'. Recycling on that
                // would rebuild a fresh iframe + reload ~250 MB into an already-
                // unloaded plugin (zombie iframe; on dev hot-reload it stacks every
                // cycle). Unwind instead. Recoverable errors (SafeInt overflow,
                // 'TIMEOUT', device-lost) fall through to recycle+retry below.
                if ((e as { code?: string } | null)?.code === 'DISPOSED') throw e;
                await this.logger.appendError(`embedBatch-recycle:${label}${dispatchInfo(inputs, bucket, tokens)}`, e);
                await this.embedder.recycle();
                embedRecycles++;
                result = await this.embedder.embedBatch(inputs, bucket);
            }
            embedBatchLatencyMs.push(result.iframeLatencyMs);
            // Pace against compositor pressure between dispatches — the rIC yield
            // keeps duty cycle capped (see "Seek System Bog-Down Diagnosis.md"
            // §PR #1). Degrades to setTimeout(0) on iOS (no rIC); takes the cheap
            // yield when hidden (no compositor — pacer.ts, issue #5). The wait is
            // timed into paceWaitMs so a pacing inversion (compute dwarfed by
            // pace waits) is visible in the field instead of hiding in embed time.
            const paceStart = performance.now();
            if (mode === 'full') await cheapYield();
            else await pacer.pace();
            paceWaitMs += performance.now() - paceStart;
            return result.vectors;
        };

        // Atomic per-file commit: chunks + vectors + file-record in ONE IndexedDB
        // transaction (S1) — a mid-commit kill lands either the whole file or
        // nothing, so commits can no longer strand record-less chunks (the orphan
        // class sweepOrphanChunks repairs; hydrate remains its only live producer).
        // putBatchQuantized asserts chunks.length === tiers.length, so a
        // mis-counted distribution throws here rather than corrupting the index.
        //
        // Embed-failure quarantine (issue #4): a file with hadError commits the
        // chunks that DID embed, and its file-record carries the failure marker
        // (embedFailedChunks + the plugin version — see FileRecord). The old
        // behavior (skip the whole file, no record) left the file dirty for every
        // computeDelta, so a DETERMINISTICALLY-failing chunk re-ran the full
        // recycle cascade (two iframe teardowns + model reloads) on every
        // reconcile poll and catch-up drain, and wedged reconcileIdentityInPlace
        // in 'drained' so the identity never stamped. The marker pins the file
        // 'clean' until an edit / release bump / full reindex / peer hydrate;
        // the missing chunk is invisible-not-wrong (content-addressed ids), and
        // the healthy chunks stay searchable instead of vanishing with it.
        const commitFile = async (fs: FileState): Promise<void> => {
            const commitStart = performance.now();
            const failed = fs.hadError ? fs.vectors.reduce((n, v) => n + (v === null ? 1 : 0), 0) : 0;
            const chunks = failed === 0 ? fs.chunks : fs.chunks.filter((_, i) => fs.vectors[i] !== null);
            // Derive both tiers ONCE from the fp32 vectors: int8 rerank (QuantVec)
            // + sign-bit candidate (packed from TRUE fp32 — the fidelity invariant
            // putBatch documents). Feed IDB via putBatchQuantized so the bytes IDB
            // holds and the bytes the sidecar persists are bit-identical (no double
            // quantization, no fp32→int8 drift between the two stores).
            const fp32 = failed === 0 ? fs.vectors as Float32Array[]
                : fs.vectors.filter((v): v is Float32Array => v !== null);
            // Feed the corpus background accumulators from the committed (known-
            // good) fp32 — the index holds exactly these vectors. Cost: 384 adds
            // + a bounded reservoir insert per vector. Only consumed on a FULL
            // pass (see setMeta below); harmless to accumulate on a delta.
            for (const v of fp32) {
                bgN++;
                for (let d = 0; d < v.length; d++) bgSum[d] += v[d];
                reservoir.add(v);
            }
            const derived = fp32.map(v => ({ q: quantizeInt8(v), bin: packSignBits(v) }));
            // Chunk-diff commit (issue #5): a diffed file's record lists every
            // live id (stable rows kept in IDB + the embeds that landed), in the
            // document order allChunkIds preserved; without a plan this reduces
            // to the historic chunks.map. Either way a failed embed's id is
            // absent, so the quarantine-marker semantics are unchanged.
            const committedIds = new Set(chunks.map(c => c.chunk_id));
            const recordIds = fs.allChunkIds && fs.keepIds
                ? fs.allChunkIds.filter(id => fs.keepIds!.has(id) || committedIds.has(id))
                : chunks.map(c => c.chunk_id);
            await this.store.putBatchQuantized(chunks, derived, {
                note_path: fs.file.path,
                // Read-time snapshot, NOT fs.file.stat.mtime (which may have
                // advanced if the file was edited during this index pass — see
                // FileState.mtimeMs). Recording the content's true mtime keeps
                // computeDelta able to detect a mid-index edit on the next pass.
                mtimeMs: fs.mtimeMs,
                chunk_ids: recordIds,
                contentHash: fs.contentHash,
                ...(failed > 0 ? { embedFailedChunks: failed, embedFailPluginVersion: PLUGIN_VERSION } : {}),
            });
            // Surface the committed rows for the incremental cache path (A1). Done
            // AFTER the IDB write so the sink only ever holds rows that truly landed.
            if (budget.addsSink) pushDeltaAdds(budget.addsSink, chunks, derived);
            if (this.coord.sidecarOn()) {
                for (let i = 0; i < chunks.length; i++) {
                    sidecarPending.push({
                        id: chunks[i].chunk_id,
                        tiers: { q: derived[i].q.q, s: derived[i].q.s, sign: derived[i].bin },
                        mtime: fs.mtimeMs,
                    });
                }
            }
            commitMs += performance.now() - commitStart;
            totalChunks += chunks.length;
            totalVectors += chunks.length;
            perFileWallMs.push(performance.now() - fs.fileStart);
        };

        // Write one chunk's embedding back into its file; commit/skip the file
        // when its last chunk lands. A null vector marks an embed failure → the
        // whole file is skipped (matches the old per-file skip precision).
        const resolveChunk = async (p: Pending, vec: Float32Array | null): Promise<void> => {
            p.fs.vectors[p.slot] = vec;
            if (vec === null) p.fs.hadError = true;
            if (--p.fs.remaining > 0) return;
            const failed = p.fs.hadError ? p.fs.vectors.reduce((n, v) => n + (v === null ? 1 : 0), 0) : 0;
            if (p.fs.hadError) {
                // Quarantine, don't skip (issue #4) — commitFile writes the
                // partial chunks + the failure-marker record; see its comment.
                // Counts ride in the CONTEXT so the constant message keeps
                // deduping across files during a mass-failure storm.
                await this.logger.appendError(`indexFile-incomplete:${p.fs.file.path} failed=${failed}/${p.fs.chunks.length}`,
                    new Error('one or more chunks failed to embed — quarantined (retries on edit / new release / full reindex)'));
            }
            try {
                await commitFile(p.fs);
                // Accounting only AFTER the commit landed: a failed commit takes
                // the catch's single filesSkippedError++, so no file ever counts
                // twice, and filesQuarantined counts only records actually written
                // (its documented meaning, and the mass-unwind below relies on it).
                if (p.fs.hadError) {
                    // filesSkippedError still counts a quarantined file so the
                    // index-complete pass gate (>2% skip = fail) keeps its
                    // meaning: content IS missing.
                    filesSkippedError++;
                    filesQuarantined++;
                    chunksFailedEmbed += failed;
                    quarantined.push({ path: p.fs.file.path, kept: p.fs.chunks.length - failed });
                } else {
                    filesCommitted++;
                }
                // Real progress for the catch-up drain — quarantined files too:
                // their record is written, so they are non-dirty by the drain's
                // own criterion and must not be re-fed to the embed loop.
                committedFilePaths.push(p.fs.file.path);
            } catch (ce) {
                // A closed store (onunload, or an onversionchange from another
                // instance deleting the DB mid-reindex) makes EVERY subsequent commit
                // throw this same error. Catching it per-file logged it ~once per
                // remaining file — the ~980-error storm. Rethrow so the whole pass
                // aborts after a single error; the caller logs it once and the next
                // reindex repairs the partial. An ordinary single-file commit failure
                // still skips just that file, as before.
                if (isStoreClosedError(ce)) throw ce;
                filesSkippedError++;
                // Disk full is environmental, not content: count it separately so the
                // pass-end gate can say "free up space" instead of "see error log"
                // (S2). Still per-file skip, not a pass abort — quota can clear
                // mid-pass (another app releases space), and the un-committed files
                // stay dirty for catch-up either way.
                if (isQuotaError(ce)) filesSkippedQuota++;
                await this.logger.appendError(`commitFile:${p.fs.file.path}`, ce);
            }
        };

        // Flush up to rollingBatchFor(bucket) chunks from a bucket as one dispatch.
        // On dispatch failure (after embedOneBatch's recycle+retry rethrows),
        // isolate each chunk with a solo embed so one genuinely-bad chunk skips
        // only its own file instead of poisoning the whole batch's files.
        const flushBucket = async (bucket: number): Promise<void> => {
            const buf = buffers.get(bucket);
            if (!buf || buf.length === 0) return;
            const batch = buf.splice(0, rollingBatchFor(bucket));
            const embedStart = performance.now();
            let vectors: Float32Array[] | null = null;
            try {
                vectors = await embedOneBatch(batch.map(p => p.input), bucket, `b${bucket}`, batch.map(p => p.tokens));
            } catch (e) {
                // Intentional teardown must unwind the whole pass, never reach the
                // solo/quarantine path — a DISPOSED batch's chunks would otherwise
                // all solo-fail DISPOSED too and quarantine healthy files against
                // a store that is about to close. Mirrors embedOneBatch's own
                // DISPOSED contract.
                if ((e as { code?: string } | null)?.code === 'DISPOSED') throw e;
                await this.logger.appendError(`flushBucket:${bucket}${dispatchInfo(batch.map(p => p.input), bucket, batch.map(p => p.tokens))}`, e);
            }
            if (vectors) {
                for (let i = 0; i < batch.length; i++) await resolveChunk(batch[i], vectors[i]);
            } else {
                for (const p of batch) {
                    try {
                        const v = await embedOneBatch([p.input], bucket, `b${bucket}-solo`, [p.tokens]);
                        await resolveChunk(p, v[0]);
                    } catch (se) {
                        if ((se as { code?: string } | null)?.code === 'DISPOSED') throw se;
                        await this.logger.appendError(`soloChunk:${p.fs.file.path}${dispatchInfo([p.input], bucket, [p.tokens])}`, se);
                        await resolveChunk(p, null);
                    }
                }
            }
            embedMs += performance.now() - embedStart;
        };

        for (const file of files) {
            // Plugin unloaded mid-pass (disable / reload): stop now rather than keep
            // embedding + committing against the store onunload is about to close.
            // Applies to BOTH modes — a full reindex and the incremental cold build.
            // Any meta stamped for the partial index is still CORRECT (Fix A: current
            // identity, merely incomplete), and the next load's catch-up finishes it.
            if (this.disposed) break;
            // Per-burst budget (incremental catch-up only): stop STARTING new files
            // once the wall-clock ceiling is spent or the app went hidden / search
            // resumed (shouldContinue→false). (The file-count cap is upstream — the
            // caller slices the dirty list.) Break at loop-top, BEFORE this file's
            // chunks enter the rolling buffers — so the unconditional bucket-drain
            // below commits exactly the files already started, and un-started files
            // stay dirty (their watermark never advanced) for the drain loop to
            // re-fire. A file already in flight is never interrupted mid-commit.
            if (mode === 'incremental'
                && ((budget.budgetMs !== undefined && performance.now() - overallStart > budget.budgetMs)
                    || (budget.shouldContinue !== undefined && !budget.shouldContinue()))) {
                break;
            }
            processedFiles++;
            const fileStart = performance.now();
            // Snapshot mtime BEFORE the read so the committed file-record reflects
            // the version we actually index, even if the file is edited mid-pass
            // (TOCTOU between this read and the much-later commit).
            const mtimeMs = file.stat.mtime;
            let fileChunks: Chunk[];
            let contentHash = '';
            let content: string;
            try {
                content = await this.app.vault.cachedRead(file);
            } catch (e) {
                // Read error (e.g. an undownloaded iCloud placeholder that throws
                // on every attempt) — skip this file (it never entered a buffer).
                // Its previous record and rows SURVIVE (the delta's wholesale
                // pre-delete is gone — chunk-diff, issue #5), so the last-indexed
                // version stays searchable; the stale-mtime record would still
                // re-report it dirty on every computeDelta, so quarantine it —
                // see the quarantine field comment for why that loop would
                // otherwise wedge reconcileIdentityInPlace.
                filesSkippedError++;
                await this.logger.appendError(`indexFile:${file.path}`, e);
                this.quarantineUnreadable(file.path);
                continue;
            }
            try {
                contentHash = cyrb53Hex(content);
                const modifiedIso = new Date(mtimeMs).toISOString();
                const chunkStart = performance.now();
                fileChunks = this.chunksFor(content, file.path, modifiedIso);
                chunkMs += performance.now() - chunkStart;
            } catch (e) {
                // Chunk error — skip this file (it never entered a buffer). Not
                // quarantined: this is a content/chunker problem, not a read
                // failure, so there is no reason to suppress future re-attempts.
                filesSkippedError++;
                await this.logger.appendError(`indexFile:${file.path}`, e);
                continue;
            }

            if (fileChunks.length === 0) {
                chunksPerFile.push(0); // empty / all below min_chunk_chars
                // Chunk-diff commit (issue #5): the delta's wholesale pre-delete is
                // gone, so an edit that EMPTIED the note must drop its stale rows +
                // record here or the pre-edit content ghosts in the index and the
                // stale-mtime record re-flags the file dirty forever. Bodies are
                // captured first so applyDelta can remove the rows exactly.
                if (mode === 'incremental' && budget.removedSink) {
                    if (budget.removedBodiesSink) await this.captureRemovalBodies(file.path, budget.removedBodiesSink);
                    budget.removedSink.push(...await this.store.deleteFile(file.path));
                }
                continue;
            }

            // Yield to a live query before the tokenizer/embed RPCs for this file
            // (G_catchup_ux: seek:search shares the iframe with catch-up).
            if (mode === 'incremental' && budget.shouldContinue !== undefined && !budget.shouldContinue()) {
                break;
            }

            // WS2.3 token-budget enforcement: re-pack any chunk whose embed
            // input exceeds the 512-token window (counted by the model's own
            // tokenizer — token-counts RPC) and capture the EXACT count of
            // every final input for bucket routing below. The count RPC is
            // tokenizer-only (~ms per file) — folded into chunk time.
            let budgeted: TokenBudgetResult;
            try {
                const tbStart = performance.now();
                budgeted = await enforceTokenBudget(fileChunks, ts => this.embedder.tokenCounts(ts));
                chunkMs += performance.now() - tbStart;
            } catch (e) {
                filesSkippedError++;
                await this.logger.appendError(`tokenBudget:${file.path}`, e);
                continue;
            }
            fileChunks = budgeted.chunks;
            tokenBudgetSplits += budgeted.splits;
            tokenBudgetOverBudget += budgeted.overBudget;
            chunksPerFile.push(fileChunks.length);

            // Chunk-diff commit (issue #5): content-hash ids make "what actually
            // changed" computable — diff the post-budget ids against the stored
            // file record instead of the old delete-all + re-embed-all. Unchanged
            // chunks keep their IDB rows AND their vectors (a stable id pins the
            // embed text by construction); a one-paragraph edit of a 91-chunk
            // note embeds ~3 chunks, and the untouched chunks stay searchable
            // through the whole pass (the pre-delete made the file vanish until
            // its re-commit). Incremental-only: a full reindex nuked the DB, so
            // there is no record to diff against.
            let embedChunks = fileChunks;
            let embedCounts = budgeted.counts;
            let keepIds: Set<string> | undefined;
            const allChunkIds = fileChunks.map(c => c.chunk_id);
            // All THREE sinks gate the diff — a partially-wired caller would
            // refresh IDB meta while silently dropping the frame-row patches,
            // the exact frame↔IDB divergence the lanes exist to prevent.
            if (mode === 'incremental' && budget.removedSink && budget.removedBodiesSink && budget.metaPatchSink) {
                try {
                    const plan = await this.diffFileAgainstStore(file.path, fileChunks, {
                        addsSink: budget.addsSink,
                        removedSink: budget.removedSink,
                        removedBodiesSink: budget.removedBodiesSink,
                        metaPatchSink: budget.metaPatchSink,
                    });
                    if (plan) {
                        keepIds = plan.keepIds;
                        chunksReconciled += plan.keepIds.size;
                        const nextChunks: Chunk[] = [];
                        const nextCounts: number[] = [];
                        for (let i = 0; i < fileChunks.length; i++) {
                            if (plan.embedIds.has(fileChunks[i].chunk_id)) {
                                nextChunks.push(fileChunks[i]);
                                nextCounts.push(budgeted.counts[i]);
                            }
                        }
                        embedChunks = nextChunks;
                        embedCounts = nextCounts;
                    }
                } catch (e) {
                    // The diff is an optimization; on failure restore the pre-diff
                    // contract exactly: drop the file's old rows wholesale (or its
                    // un-diffed stale ids would orphan into ghost results) and
                    // re-embed everything. Bodies were possibly not captured →
                    // applyDelta declines into the full rebuild. Slow, never wrong.
                    // Dedup against what the diff applied before it threw: its
                    // deleteChunksByIds ids are already in the sink, and the
                    // still-unrewritten record deleteFile reads lists them too —
                    // double entries would inflate DeltaApplyEntry.removed.
                    await this.logger.appendError(`chunkDiff:${file.path}`, e);
                    if (budget.removedBodiesSink) await this.captureRemovalBodies(file.path, budget.removedBodiesSink);
                    const alreadyRemoved = new Set(budget.removedSink);
                    const dropped = await this.store.deleteFile(file.path).catch(() => [] as string[]);
                    budget.removedSink.push(...dropped.filter(id => !alreadyRemoved.has(id)));
                    embedChunks = fileChunks;
                    embedCounts = budgeted.counts;
                    keepIds = undefined;
                }
            }

            // Everything id-stable: the whole edit was metadata/line drift (or a
            // no-op). commitFile only runs when a buffered chunk resolves, so the
            // record must be written here or the file re-flags dirty forever.
            if (keepIds && embedChunks.length === 0) {
                try {
                    await this.store.putBatchQuantized([], [], {
                        note_path: file.path, mtimeMs,
                        chunk_ids: allChunkIds.filter(id => keepIds.has(id)),
                        contentHash,
                    });
                    filesCommitted++;
                    committedFilePaths.push(file.path);
                    perFileWallMs.push(performance.now() - fileStart);
                } catch (e) {
                    // No record advance → the file stays dirty and retries next
                    // pass (same self-healing contract as a failed commitFile).
                    await this.logger.appendError(`recordOnlyCommit:${file.path}`, e);
                }
                continue;
            }

            const fs: FileState = {
                file, chunks: embedChunks,
                vectors: new Array<Float32Array | null>(embedChunks.length).fill(null),
                remaining: embedChunks.length, hadError: false, fileStart,
                mtimeMs, contentHash,
                ...(keepIds ? { allChunkIds, keepIds } : {}),
            };
            for (let slot = 0; slot < embedChunks.length; slot++) {
                const c = embedChunks[slot];
                const input = embedInput(c);
                // Token-exact routing: the bucket is the smallest warmed rung
                // ≥ the input's REAL token count, so truncation cannot fire
                // (enforceTokenBudget guarantees count ≤ 512 except for the
                // counted-and-logged oversize-title pathology).
                const bucket = selectIndexBucket(embedCounts[slot]);
                let buf = buffers.get(bucket);
                if (!buf) { buf = []; buffers.set(bucket, buf); }
                buf.push({ fs, slot, input, tokens: embedCounts[slot] });
                if (buf.length >= rollingBatchFor(bucket)) await flushBucket(bucket);
            }

            // UI progress: every newly committed file (status bar + Settings).
            // NDJSON index-progress stays on the file-or-time cadence below.
            if (filesCommitted > lastProgress) {
                onProgress?.(`Indexed ${filesCommitted} files · ${totalChunks} chunks`);
            }
            const progressOverdue = performance.now() - lastProgressAt >= PROGRESS_MAX_SILENCE_MS;
            if (filesCommitted > lastProgress && (filesCommitted - lastProgress >= PROGRESS_EVERY || progressOverdue)) {
                lastProgress = filesCommitted;
                lastProgressAt = performance.now();
                this.forensics?.beat('index-progress', { filesCommitted, filesTotal: files.length, chunks: totalChunks });
                await this.emitProgress('embed', filesCommitted, files.length, totalChunks, performance.now() - overallStart);
            }
        }

        // Drain every partial bucket (each remainder is 1..ROLLING_MAX-1, all
        // warmed). This is where the last chunk of most files lands and commits.
        // Skipped when disposed: the store is closing, so flushing buffered chunks
        // would just throw STORE_NOT_OPENED per bucket; the next reindex repairs.
        if (!this.disposed) for (const bucket of buffers.keys()) {
            while ((buffers.get(bucket)?.length ?? 0) > 0) await flushBucket(bucket);
        }

        // Mass-failure gate: solo-retry evidence can't distinguish a poisoned
        // chunk from a wedged ENVIRONMENT (device-lost storm, app backgrounded
        // mid-pass, model unload race) — both retries share the environment. A
        // per-release quarantine written during such a storm would silently hide
        // every affected file from search until the next release. Volume is the
        // discriminator: genuine content failures are rare (issue #4 = one
        // file), a storm hits every in-flight file. Over the cap, UNWIND the
        // markers — deleteFile drops each quarantined record + its partial
        // chunks, restoring the pre-quarantine behavior for exactly this case:
        // the files stay dirty and self-heal on the next poll once the
        // environment recovers. The cap mirrors the pass gate's skip-rate
        // threshold with an absolute floor so a single bad file in a small
        // vault still quarantines.
        const quarantineCap = Math.max(3, Math.ceil(files.length * 0.02));
        let quarantineUnwound = 0;
        if (filesQuarantined > quarantineCap) {
            const unwoundPaths = new Set(quarantined.map(q => q.path));
            for (const q of quarantined) {
                try {
                    await this.store.deleteFile(q.path);
                    totalChunks -= q.kept;
                    totalVectors -= q.kept;
                } catch (e) {
                    if (isStoreClosedError(e)) throw e;
                    unwoundPaths.delete(q.path);   // record survived — still honestly quarantined
                    await this.logger.appendError(`quarantine-unwind:${q.path}`, e);
                }
            }
            // Unwound files have no record again → dirty by the drain's own
            // criterion → must not be reported as committed progress.
            for (let i = committedFilePaths.length - 1; i >= 0; i--) {
                if (unwoundPaths.has(committedFilePaths[i])) committedFilePaths.splice(i, 1);
            }
            filesQuarantined -= unwoundPaths.size;
            quarantineUnwound = unwoundPaths.size;
            checksExtra.push(`⚠️ mass embed failure (${quarantined.length} files > cap ${quarantineCap}) — environmental, not content: unwound ${unwoundPaths.size} quarantine record(s); files stay dirty and retry on the next pass`);
        }
        // Quota gate (S2): commits failed because device storage is FULL — an
        // environmental condition no retry fixes while it persists. The affected
        // files are already safe (no record advance → they stay dirty and catch-up
        // heals them once space frees); what was missing was any actionable signal
        // — the pass just logged generic per-file skips and the drain re-fired
        // forever. Check line + forensics beat on every affected pass; the toast is
        // rate-limited because catch-up bursts re-trip this for as long as the disk
        // stays full.
        if (filesSkippedQuota > 0) {
            checksExtra.push(`⚠️ storage full: ${filesSkippedQuota} file(s) failed to commit with QuotaExceededError — free up disk space; the files stay dirty and catch up automatically`);
            this.forensics?.beat('index-quota-exhausted', { files: filesSkippedQuota, mode });
            this.quotaToast();
        }
        onProgress?.(`Indexed ${filesCommitted} files · ${totalChunks} chunks`);
        await this.emitProgress('embed', files.length, files.length, totalChunks, performance.now() - overallStart);

        // Corpus dense-cosine background (dense-stats.ts). A FULL pass saw every
        // vector, so it recomputes from scratch (or clears the stats when the
        // corpus is below MIN_BG_SAMPLE — too small to calibrate). An INCREMENTAL
        // pass saw only the changed files, far too few to estimate a corpus
        // global, so it carries the prior full-reindex values forward unchanged.
        // Computed HERE (before the sidecar job is packaged) so the device meta
        // the flush writes can carry it to hydrate-only peers.
        const prevMeta = await this.store.getMeta();
        // A FULL pass, or a cold first-build (storeWasEmpty), saw the whole corpus, so
        // it recomputes the background from scratch AND claims the live identity. An
        // ordinary delta saw only its changed files — far too few to move a corpus
        // global — so it carries the prior values forward. (On a mobile cold build
        // each 3-file burst is empty-then-not: the first burst stamps identity but
        // yields a sub-MIN_BG_SAMPLE → null background, which peers hydrate from a
        // desktop sidecar; later bursts carry that forward. See dense-stats.ts.)
        const sawWholeCorpus = shouldStampLiveIdentity(mode, storeWasEmpty);
        const bgStats = sawWholeCorpus ? denseBgStats(bgSum, bgN, reservoir.sample) : null;
        const bgMean = sawWholeCorpus ? bgStats?.mean : prevMeta.bgMean;
        const bgStd = sawWholeCorpus ? bgStats?.std : prevMeta.bgStd;
        // One identity read, shared by the sidecar meta (producer, below) and the
        // local meta commit. A full reindex stamps the live identity; an
        // incremental preserves prevMeta's — only a full rebuild claims a new one.
        const identity = pluginIdentity();

        // 1C: package the sidecar flush instead of performing it here. This engine
        // always runs inside the write mutex, and the flush is pure file IO the
        // IDB index never depends on — the meta read/write plus bulkAppend's
        // per-shard stat sweep and shard/jsonl writes were extending the critical
        // section that searches (ensureFrame waiting on currentDelta) and queued
        // deltas sit behind. The caller runs the job via flushSidecarAfterPass
        // once the mutex releases, still awaited before its own promise resolves.
        // Narrow window accepted: a pass that throws between here and returning
        // (the final setMeta below can quota-throw) drops the job where the old
        // inline flush had already run — a durability lag, not a correctness
        // loss (hydrate re-chunks and intersects ids, so peers and post-eviction
        // recovery just re-embed the missing records; nothing dangles).
        const sidecarJob: SidecarFlushJob | null =
            this.coord.sidecarOn() && sidecarPending.length > 0
                ? { pending: sidecarPending, mode, bgMean, bgStd, identity }
                : null;

        // BM25 doesn't need its own persisted index for v0 — it's rebuilt
        // in-memory at search time from the chunk store. Track the timing
        // as zero here; we'll measure it on the first search.
        const bm25Ms = 0;

        // Final commit: meta marker (bgMean/bgStd computed above and shared with
        // the packaged sidecar flush, so both stores agree)
        const commitFinalStart = performance.now();
        await this.store.setMeta({
            embeddingDim: EMBEDDING_DIM,
            lastIndexedAt: new Date().toISOString(),
            schemaVersion: META_SCHEMA_VERSION,
            modelId: this.embedder.modelId,
            // Identity: a full reindex — or a cold first-build (sawWholeCorpus) —
            // stamps the live build; an ordinary incremental preserves prevMeta so a
            // delta can't falsely re-stamp a stale index as current (mirrors bgMean /
            // lastFullReindex above). Fix A: the cold build must stamp, else its
            // `undefined` identity loops the gate into a spurious heal.
            chunkerVersion: sawWholeCorpus ? identity.chunkerVersion : prevMeta.chunkerVersion,
            analyzerVersion: sawWholeCorpus ? identity.analyzerVersion : prevMeta.analyzerVersion,
            revision: sawWholeCorpus ? identity.revision : prevMeta.revision,
            bgMean,
            bgStd,
        });
        commitMs += performance.now() - commitFinalStart;

        const memAfter = await snapshotMemory();
        const totalMs = performance.now() - overallStart;
        const memD = memoryDelta(memBefore, memAfter);

        // Throughput rollups. Guard against div-by-zero in the (degenerate)
        // case where reindex completed in <1 ms — happens when the vault is
        // completely empty after the EXCLUDED_PATHS filter.
        const seconds = totalMs / 1000;
        const chunksPerSec = seconds > 0 ? totalChunks / seconds : 0;
        const filesPerSec = seconds > 0 ? files.length / seconds : 0;

        const checks: string[] = [
            `✅ indexed ${files.length} files → ${totalChunks} chunks → ${totalVectors} vectors`,
            `ℹ️ embed: ${embedMs.toFixed(0)} ms, chunk: ${chunkMs.toFixed(0)} ms, commit: ${commitMs.toFixed(0)} ms`,
            `ℹ️ total wall time: ${totalMs.toFixed(0)} ms`,
            `ℹ️ throughput: ${chunksPerSec.toFixed(1)} chunks/s, ${filesPerSec.toFixed(1)} files/s`,
        ];
        // Rolling-buffer effectiveness: dispatches = number of embedBatch
        // forward passes; effective batch = vectors / dispatches. Within-file it
        // sat at ~2.2 (p50=1 chunk/file); per-bucket rolling should approach the
        // budget-weighted mean flush size. The measurement that says it worked.
        const embedDispatches = embedBatchLatencyMs.length;
        const effectiveBatch = embedDispatches > 0 ? totalVectors / embedDispatches : 0;
        checks.push(`ℹ️ embed: ${embedDispatches} dispatches, effective batch ≈ ${effectiveBatch.toFixed(1)} (budget ${ROLLING_BUDGET}, max ${ROLLING_MAX})`);
        if (mode === 'full') {
            checks.push(bgStats
                ? `ℹ️ dense background: μ=${bgStats.mean.toFixed(4)} σ=${bgStats.std.toFixed(4)} (${bgN} vecs, calibration on)`
                : `ℹ️ dense background: ${bgN} vecs < ${MIN_BG_SAMPLE} — calibration off`);
        }
        // A handful of genuinely-malformed files skipping is tolerable; a large
        // fraction skipping is the ORT-overflow cascade (or a new systemic fault)
        // and must NOT report success — pass gates on the skip rate so it fails
        // loudly (2026-06-03: 668/2190 skipped had reported pass:true).
        const skipRate = files.length > 0 ? filesSkippedError / files.length : 0;
        const SKIP_RATE_FAIL = 0.02; // >2% of files skipped ⇒ fail the run
        if (embedRecycles > 0) checks.push(`♻️ recycled embed session ${embedRecycles}× — ORT WebGPU overflow recovery (see embedder.recycle)`);
        if (filesSkippedError > 0) {
            const tag = skipRate > SKIP_RATE_FAIL ? '❌' : '⚠️';
            checks.push(`${tag} ${filesSkippedError}/${files.length} file(s) skipped due to error (${(skipRate * 100).toFixed(1)}%) — see error log`);
        }
        if (filesQuarantined > 0) {
            checks.push(`⚠️ ${filesQuarantined} file(s) quarantined (${chunksFailedEmbed} chunk(s) failed to embed after solo retry) — healthy chunks committed + searchable; retried on edit / new release / full reindex`);
        }
        checks.push(...checksExtra);
        // 1C: the flush itself runs off the mutex after this entry is logged, so
        // its duration is no longer inside commitDurationMs — the queued count is
        // the entry's honest record of what this pass handed the flush chain.
        if (sidecarJob) checks.push(`ℹ️ sidecar: ${sidecarJob.pending.length} tier record(s) queued for off-mutex flush`);
        if (totalChunks === 0 && chunksReconciled === 0) checks.push('⚠️ no chunks produced — vault may be empty or all files below min_chunk_chars');
        // WS2.3 invariant surface: splits are normal (every >512-token chunk
        // re-packs); a nonzero overBudget means some input still truncates
        // (unsplittable window-filling title) — warn, don't fail.
        checks.push(`ℹ️ token budget: ${tokenBudgetSplits} chunk(s) re-packed to ≤512 tokens`);
        if (tokenBudgetOverBudget > 0) {
            checks.push(`⚠️ ${tokenBudgetOverBudget} embed input(s) still over the 512-token window (title alone ~fills it) — dense tail truncated for those`);
        }
        if (memD.storageDeltaMB != null) checks.push(`ℹ️ storage delta: +${memD.storageDeltaMB.toFixed(1)} MB on disk (IDB)`);

        // Reclaim the WebGPU buffer-pool high-water-mark. Indexing (plus the
        // batch-8×512 warmup grid) grows ORT-Web's off-heap GPU pool to ~1.4 GB;
        // it never shrinks on its own and would otherwise sit resident for the
        // plugin's whole query-serving life, even though queries only need the
        // batch-1 pool. A full device teardown via recycle() drops it back to the
        // ~193 MB floor (verified by toggle-and-diff, 2026-06-03); the next query
        // lazily rebuilds just the small pool it needs. Reindex is infrequent and
        // already ~3 min, so the ~2–4 s teardown is in the noise. WebGPU-only
        // (WASM has no GPU pool to reclaim); best-effort — a cleanup failure must
        // not fail an otherwise-good index, and recycle() leaves the embedder
        // loaded and usable on success regardless.
        if (mode === 'full' && this.embedder.device === 'webgpu') {
            const recycleStart = performance.now();
            try {
                await this.embedder.recycle();
                checks.push(`🧹 released WebGPU buffer pool post-index (${(performance.now() - recycleStart).toFixed(0)} ms) — reclaims the indexing high-water-mark to the query floor`);
            } catch (e) {
                await this.logger.appendError('post-index-recycle', e);
                checks.push(`⚠️ post-index GPU pool release failed (non-fatal): ${e}`);
            }
        }

        const entry: IndexCompleteEntry = {
            type: 'index-complete',
            timestamp: new Date().toISOString(),
            mode,
            dtype: this.embedder.dtype,
            embeddingDim: EMBEDDING_DIM,
            // processedFiles, not files.length: a budgeted incremental burst may
            // have started fewer than it was handed (the rest are filesDeferred).
            // Identical to files.length on a full reindex (never budget-broken).
            filesIndexed: processedFiles,
            // The files actually committed this pass (record written), so the catch-up
            // drain advances by real progress, not by count-of-started. Distinct from
            // filesIndexed (started) whenever a file is empty/skipped/budget-deferred.
            committedFilePaths,
            chunksIndexed: totalChunks,
            vectorsWritten: totalVectors,
            filesSkippedError,
            filesSkippedQuota,
            filesQuarantined,
            chunksFailedEmbed,
            filesDeferred: files.length - processedFiles,
            embedRecycles,
            tokenBudgetSplits,
            tokenBudgetOverBudget,
            chunkDurationMs: parseFloat(chunkMs.toFixed(2)),
            embedDurationMs: parseFloat(embedMs.toFixed(2)),
            bm25DurationMs: parseFloat(bm25Ms.toFixed(2)),
            commitDurationMs: parseFloat(commitMs.toFixed(2)),
            totalDurationMs: parseFloat(totalMs.toFixed(2)),
            heapDeltaMB: memD.heapDeltaMB,
            storageDeltaMB: memD.storageDeltaMB,
            chunksPerSec: parseFloat(chunksPerSec.toFixed(2)),
            filesPerSec: parseFloat(filesPerSec.toFixed(2)),
            perFileWallMs: distributionStats(perFileWallMs),
            chunksPerFile: distributionStats(chunksPerFile),
            embedBatchLatencyMs: distributionStats(embedBatchLatencyMs),
            paceWaitMs: parseFloat(paceWaitMs.toFixed(2)),
            pass: (totalChunks > 0 || chunksReconciled > 0) && skipRate <= SKIP_RATE_FAIL,
            checks,
        };
        // Completion beat closes the indexing window: a death AFTER this reads
        // as idle/background eviction, not crash-while-indexing.
        this.forensics?.beat('index-complete', {
            mode, filesCommitted, chunks: totalChunks,
            dispatches: fDispatches, paddedTokens: fPaddedTokens,
        });
        seekPerf.recordIndexComplete(entry);
        await this.logger.append(entry);
        return { entry, sidecarJob, quarantineUnwound };
    }

    // The single index-membership predicate, shared by full reindex (the scan
    // filter) and every incremental path (computeDelta, reindexDelta). Live
    // events and full reindex MUST agree on what's in the index, or a
    // rename-into-Archive and a full reindex would disagree. Two unconditional
    // exclusions (Seek's own machine output) plus the user-toggleable "honor
    // ignored folders" — when on, Obsidian's "Excluded files" (e.g. Archive) are
    // out-of-index, so moving a note in is a soft-delete.
    private shouldIndex(path: string): boolean {
        return shouldIndexPath(this.app, this.settings, path);
    }

    // The candidate set for every collection site (reindexAll, computeDelta, and
    // the sidecar liveness oracles reChunkLive / collectLiveIds — all of which must
    // agree on the file set or base chunk_ids drift between writer and re-deriver).
    // getMarkdownFiles() is .md-only; we additionally index .base files (Obsidian
    // Bases — saved query/view definitions) via per-view synthetic documents. The
    // watcher in main.ts gates create/rename/delete on the same two extensions.
    private indexableFiles(): TFile[] {
        const md = this.app.vault.getMarkdownFiles();
        if (!this.settings.indexBases) return md;
        const bases = this.app.vault.getFiles().filter(f => f.extension === 'base');
        return bases.length === 0 ? md : [...md, ...bases];
    }

    // Content → chunks for one file, branching by extension. A .base file isn't
    // markdown — it's a YAML view definition — so it goes through extractBaseDocs
    // (one synthetic doc per view) + chunkBase, which builds a base-level chunk
    // plus one per non-generic view (each title-boosted, dense + BM25, the view
    // name in the 3.0x headings field). Every chunk-PRODUCTION site routes through
    // here so the .md/.base split lives in one place — reChunkLive, collectLiveIds,
    // dedupViaSidecar and carryOverHydrate all call this, not chunkContent, so a
    // base chunk's id is identical wherever it is re-derived. `modifiedIso` matches
    // the chunker's `modified` param contract.
    private chunksFor(content: string, path: string, modifiedIso: string | null): Chunk[] {
        if (path.endsWith('.base')) {
            return this.chunker.chunkBase(extractBaseDocs(content, path), path, modifiedIso);
        }
        return this.chunker.chunkContent(content, path, undefined, modifiedIso);
    }

    // Diff the persisted index against the live vault — the authoritative,
    // idempotent catch-up computation used by the startup sweep and the post-serve
    // hook. `dirty` = indexable files whose mtime advanced past the stored record
    // (or were never indexed); `deleted` = previously-indexed paths now gone OR no
    // longer indexable (moved into an ignored folder, or honor-ignored toggled on)
    // — a single "not in the live indexable set" test covers both.
    // Boot/sync races can briefly yield an empty vault enumeration or a live set
    // far smaller than the persisted index. Applying the deleted sweep then marks
    // every stored path gone and catch-up's first burst wipes the corpus (G_eviction
    // probe 2026-08-28: removed≈16742, compaction-due fallback, 0 chunks).
    private shouldDeferMassDelete(storedSize: number, liveCount: number, deletedCount: number): boolean {
        if (storedSize === 0 || deletedCount === 0) return false;
        if (liveCount === 0) return true;
        // Partial vault enumeration: deleted ≈ (stored − live) fakes a mass removal
        // (G_eviction 2026-08-28: live 4026 / stored 4473 → 447 spurious deletes).
        // Require a LARGE gap — when novel≈0, deleted ≡ stored−live always, so a
        // small real delete set (12 fixture leftovers on a 4.4k vault) must not
        // trip this arm.
        const enumGap = storedSize - liveCount;
        const minSuspiciousGap = Math.max(50, storedSize * 0.05);
        if (enumGap >= minSuspiciousGap && liveCount >= 50
            && deletedCount >= enumGap * 0.85
            && deletedCount <= enumGap * 1.15) {
            return true;
        }
        return storedSize >= 50
            && deletedCount >= storedSize * 0.9
            && liveCount < storedSize * 0.5;
    }

    private indexableLiveFiles(): TFile[] {
        return this.indexableFiles().filter(f => this.shouldIndex(f.path));
    }

    /** Retry when the vault file list is still filling in (boot / sync). */
    private async indexableLiveFilesWhenStored(storedSize: number): Promise<TFile[]> {
        let live = this.indexableLiveFiles();
        if (storedSize === 0) return live;
        // Wait only while the snapshot still looks like truncated enumeration
        // (empty OR a large stored−live gap). A few leftover stored paths are
        // real deletes — do not burn 2s on every computeDelta for those.
        // live===0 MUST wait: that is the boot race (G_eviction / main vault
        // 2026-08-29: stored 4468, live 0). Bailing immediately skipped the
        // poll and reconcileOnLoad applied neither deletes nor dirty.
        for (let i = 0; i < 40; i++) {
            const enumDeleted = Math.max(0, storedSize - live.length);
            if (!this.shouldDeferMassDelete(storedSize, live.length, enumDeleted)) break;
            await new Promise(r => setTimeout(r, 50));
            live = this.indexableLiveFiles();
        }
        return live;
    }

    async computeDelta(): Promise<{ dirty: string[]; deleted: string[] }> {
        const records = await this.store.listFileRecords();
        const stored = new Map<string, FileRecord>();
        for (const r of records) stored.set(r.note_path, r);

        let live = await this.indexableLiveFilesWhenStored(stored.size);
        const livePaths = new Set(live.map(f => f.path));

        // mtime advanced ≠ edited. An iCloud / Drive sync re-stamps a synced
        // file's mtime without changing a byte — on iOS that fires every couple
        // seconds, and keyed on mtime alone it re-embeds identical content
        // forever (each embed blocks the mobile main thread → 1 fps, and the
        // churn drives the jetsam crash-loop). classifyFileDelta confirms the
        // bytes actually changed via the stored content hash before flagging
        // dirty; we only pay the read+hash ('check-bytes') for files whose mtime
        // moved, and the hash is a sync ~5 µs cyrb53, never the embedder, so it
        // can't itself jank the UI.
        const dirty: string[] = [];
        for (const f of live) {
            // A persistently-unreadable file (quarantineUnreadable) is excluded
            // from dirty entirely while its backoff is live — otherwise its
            // dropped record makes classifyFileDelta report 'dirty' forever (see
            // the quarantine field comment), wedging every computeDelta caller.
            if (this.isQuarantined(f.path)) continue;
            const prev = stored.get(f.path);
            let decision = classifyFileDelta(prev, f.stat.mtime, undefined, PLUGIN_VERSION);
            if (decision === 'check-bytes') {
                try {
                    decision = classifyFileDelta(prev, f.stat.mtime, cyrb53Hex(await this.app.vault.cachedRead(f)), PLUGIN_VERSION);
                } catch {
                    decision = 'dirty';   // unreadable → let the embed path decide
                    this.quarantineUnreadable(f.path); // give it this one attempt, then back off
                }
            }
            if (decision === 'dirty') dirty.push(f.path);
        }
        const deleted: string[] = [];
        for (const path of stored.keys()) {
            if (!livePaths.has(path)) deleted.push(path);
        }
        if (this.shouldDeferMassDelete(stored.size, live.length, deleted.length)) {
            console.warn('[seek] computeDelta: deferring suspicious mass-delete sweep', {
                stored: stored.size, live: live.length, deleted: deleted.length,
                markdown: this.app.vault.getMarkdownFiles().length,
            });
            return { dirty, deleted: [] };
        }
        return { dirty, deleted };
    }

    // Per-folder embedder coverage for the settings surface. `allPaths` = every
    // indexable-extension file in the vault (before exclusions); `coveredPaths` = the
    // subset that has a FileRecord (committed through the embedder); `excludedPaths`
    // = the subset currently out of index because of Obsidian's "Excluded files" (and
    // the honor toggle). All three are live vault reads, so this reflects the current
    // exclusion state without waiting for a delta pass.
    async getFolderCoverage(): Promise<FolderCoverageSummary> {
        const all = this.indexableFiles();
        const allPaths = all.map(f => f.path);
        const excludedPaths = all.filter(f => !this.shouldIndex(f.path)).map(f => f.path);
        const coveredPaths = await this.store.listFilePaths();
        return computeFolderCoverage({ allPaths, coveredPaths, excludedPaths });
    }

    // Live paths that are indexable-by-extension but currently OUT of the index because
    // of Obsidian's "Excluded files" (+ the honor toggle). The exclusion-change detector
    // diffs the top-level folders of this set across polls to tell "a folder came back"
    // from "a folder was hidden".
    getExcludedLivePaths(): string[] {
        return this.indexableFiles().filter(f => !this.shouldIndex(f.path)).map(f => f.path);
    }

    // ── Heal a version-mismatched index WITHOUT a full re-embed, when it is provably
    // safe. enforceIndexIdentity (main.ts) calls this AFTER the embed-free sidecar
    // peer-hydrate attempt and BEFORE the desktop full-reindex / mobile-wait fallback,
    // so both platforms reach it. It is the fix for the cold-build identity bug
    // (PR #43): a huge vault's FIRST index is built by the incremental path, which
    // never stamped chunkerVersion/revision, so the gate reads a perfectly-current
    // index as stale and the only recovery used to be a ~7-min nuke+re-embed of chunks
    // already byte-identical to what a reindex would produce — visually identical to the
    // bug, and (stamping only at the end) re-run from zero on every interruption.
    //
    //   'stale'   — a GENUINELY old index: meta carries a PRESENT, differing
    //               chunker/model/dim. The caller runs the existing full-reindex / wait.
    //   'stamped' — the index was merely UNSTAMPED but is provably current (same model +
    //               dim, every file content-unchanged): stamp the live identity in place
    //               + recompute the display background, zero re-embed, never "0 files".
    //   'drained' — unstamped + a few files drifted: caught up via the normal resumable
    //               delta. Desktop (model loaded) then falls through to the stamp; mobile
    //               / model-not-loaded defers those embeds, so we report 'drained' —
    //               healed enough to stop the destructive loop, the deferred files stay
    //               invisible (content-addressed ids), never wrong.
    //
    // SAFETY: computeDelta proves the FILES are byte-unchanged, NOT that the stored
    // chunks were produced by the current chunker/model. So the stamp arm is gated on a
    // model+dim match — that rules out a cross-model index (old english-r2 vectors
    // stamped current = wrong dense scores, the one unacceptable outcome). The mismatch
    // that triggered the heal here is, by construction, only the absent chunker/revision
    // (modelId+dim already match, or identityMatches would not have failed on them alone
    // for an otherwise-current index). chunkerVersion/revision can't be verified without
    // re-chunking (the async enforceTokenBudget step we avoid to stay embed-free on
    // mobile), so they are ASSUMED current for a model-matching unstamped index: the
    // bounded worst case is stale chunk BOUNDARIES (same real text, same current model →
    // stale, never wrong), and any later edit re-chunks that file at the live version.
    async reconcileIdentityInPlace(): Promise<'stale' | 'stamped' | 'drained'> {
        // Almost always succeeds — enforceIndexIdentity read the meta moments ago to
        // detect the mismatch. A failure here is a transient mid-teardown read; return
        // 'stale' so the caller's fallback retries. Breadcrumb it: a PERSISTENT fault
        // would otherwise silently cost a reindex on every poll with no trace.
        const meta = await this.store.getMeta().catch(e => {
            console.warn('[seek] reconcileIdentityInPlace: meta unreadable, treating as stale', e);
            return null;
        });
        if (!meta) return 'stale';

        // Gate (identity.ts): only an UNSTAMPED, current-model+dim index is safe to stamp
        // in place. A present chunkerVersion (genuinely old / stamped-but-bumped) or a
        // cross-model/dim index falls through to the existing full-reindex / wait.
        if (identityHealEligibility(meta) === 'stale') return 'stale';

        // Prove the files are byte-unchanged (embed-free AND tokenizer-free; on a stable-
        // mtime vault classifyFileDelta never even reads a file).
        let delta = await this.computeDelta();
        if (delta.dirty.length || delta.deleted.length) {
            // A few files drifted since the index was built. Catch just those up through
            // the normal resumable delta — desktop embeds (only if the model is already
            // loaded; we never force a load here, that is the caller's job), mobile stays
            // embed-free and defers. reindexDelta takes its OWN write mutex, so it is NOT
            // nested under one here.
            const embed = !isMobilePlatform() && this.embedder.loaded;
            await this.reindexDelta(delta.dirty, delta.deleted, { embed });
            delta = await this.computeDelta();
            if (delta.dirty.length || delta.deleted.length) return 'drained'; // deferred / still behind — don't stamp
        }

        // STAMP — one atomic write transaction under the write mutex (serializes against
        // a concurrent flush). Recompute the display-only dense background from the
        // stored int8 vectors (embed-free): the same accumulation a full pass does, just
        // dequantized first; the ~0.1% int8 drift is below the display tolerance and the
        // background is NOT a ranking input (dense-stats.ts). Mirrors the proven in-place
        // stamp at hydrateSidecar.
        await this.coord.runExclusive(async () => {
            const { vecs } = await this.store.listAllEmbeddings();
            const bgSum = new Float64Array(EMBEDDING_DIM);
            let bgN = 0;
            const reservoir = new VecReservoir(BG_RESERVOIR);
            for (const qv of vecs) {
                const v = dequantizeInt8(qv.q, qv.s);
                bgN++;
                for (let d = 0; d < v.length; d++) bgSum[d] += v[d];
                reservoir.add(v);
            }
            const bg = denseBgStats(bgSum, bgN, reservoir.sample);
            const id = pluginIdentity();
            const m = await this.store.getMeta();
            await this.store.setMeta({
                ...m,
                embeddingDim: EMBEDDING_DIM,
                modelId: m.modelId ?? MODEL_ID,
                chunkerVersion: id.chunkerVersion,
                analyzerVersion: id.analyzerVersion,
                revision: id.revision,
                bgMean: bg?.mean ?? m.bgMean,
                bgStd: bg?.std ?? m.bgStd,
            });
        });
        this.bgStatsGen = -1;        // invalidate the cached bg accessor (mirrors hydrateSidecar)
        this.invalidateBm25Cache();  // bump dataGeneration so the next search rebuilds against the stamped meta
        return 'stamped';
    }

    // Incremental index update. Two phases:
    //   1. Structural (no embedder): drop deleted/moved-out paths. Always runs,
    //      so deletes + move-into-ignored take effect even on a cold mobile model.
    //   2. Embed (needs a loaded model): for dirty paths that should be indexed,
    //      drop their stale chunks then re-chunk + re-embed via the shared engine.
    //      Skipped when `opts.embed` is false (cold mobile) — the OLD version stays
    //      searchable and, since the file's mtime is still ahead of its stored
    //      record, the next computeDelta re-finds it once the model is warm.
    // Returns null embedded-entry when the embed phase didn't run. Runs under the
    // write mutex (so it can't overlap a full reindex or another delta) and sets
    // `currentDelta` for its critical section so a concurrent search's frame
    // rebuild waits for full application instead of reading a half-committed delta.
    //
    // ── Phase 4 decomposition seam (indexing) ── reindexDelta + applyDelta share
    // removal-body capture, incremental BM25 patch, and coord.currentDelta gating.
    // Extract only after CacheManager owns frameCache (Phase 2). See
    // docs/SEARCH-DECOMPOSITION.md
    async reindexDelta(
        dirtyPaths: string[],
        deletedPaths: string[],
        // Per-burst budget for the catch-up drain: maxFiles caps how many dirty
        // files this call deletes+re-embeds (slice below — keeps deferred files
        // searchable); budgetMs/shouldContinue are the within-burst aborts passed to
        // the engine. Omitted = unbounded (desktop, flushDirty, reindexAll).
        // onProgress: optional live-progress stream (embedAndCommitFiles calls it
        // in 'incremental' mode). No caller wires it to a Notice — indexing toasts
        // are start + end-summary only; live progress belongs to the settings tab.
        opts: { embed: boolean; maxFiles?: number; budgetMs?: number; shouldContinue?: () => boolean; onProgress?: (msg: string) => void },
    ): Promise<{ deletedPaths: number; deletedChunks: number; embedded: IndexCompleteEntry | null; deferredEmbed: number; sidecarHydrated: number; carriedOver: number; committedPaths: string[] }> {
        // Set inside the mutex by applyDelta; read after to gate the re-warm. A
        // successful incremental patch IS the warm, so warmCaches is skipped (it
        // would re-pay the O(N) fit the patch just avoided).
        let appliedIncrementally = false;
        // 1C: the engine's packaged sidecar flush, captured by closure the moment
        // the engine returns (NOT threaded through the result) so the .finally
        // below still flushes it even when a post-engine step (applyDelta, the
        // meta stamp) throws — parity with the old inline flush, which had
        // already completed by then.
        let sidecarJob: SidecarFlushJob | null = null;
        // v16 (issue #5): the incremental-patch outcome, appended as a
        // 'delta-apply' entry after the mutex releases. Built inside the
        // critical section (it owns the counters), mutexHoldMs stamped in the
        // finally so it covers the WHOLE hold searches can wait on.
        let deltaTelemetry: Omit<DeltaApplyEntry, 'type' | 'timestamp'> | null = null;
        const result = await this.coord.runExclusive(async () => {
            const mutexStart = performance.now();
            let release!: () => void;
            this.coord.currentDelta = new Promise<void>(r => { release = r; });
            try {
                // Fix A: snapshot emptiness BEFORE phase-1 drops — mirrors
                // embedAndCommitFiles. The common cold build runs an embed pass, which
                // stamps the live identity itself (read back into prevMeta below). This
                // covers the residual path where a cold build commits NOTHING via the
                // engine (every file hydrated from a peer sidecar / carried over), so
                // the meta stamp below is the ONLY one — it must still claim the live
                // identity rather than copy the empty store's `undefined` fields.
                const storeWasEmpty = (await this.store.count()).chunks === 0;
                // F13 carry-over: harvest tiers of chunks about to be removed, keyed
                // by embed text, so a move / no-op re-flush reuses the identical vector
                // instead of re-embedding. Deleted paths lose their chunks in phase 1,
                // so harvest them FIRST; only worth it when this pass will embed.
                const carryOver = new Map<string, { q: QuantVec; sign: Uint8Array }>();
                const wantCarryOver = opts.embed && this.embedder.loaded;
                // Defense-in-depth: refuse a near-total structural drop when the live
                // vault enumeration looks truncated (same guard as computeDelta).
                let phase1Deletes = deletedPaths;
                if (phase1Deletes.length > 0) {
                    const storedCount = (await this.store.listFileRecords()).length;
                    const liveCount = this.indexableLiveFiles().length;
                    if (this.shouldDeferMassDelete(storedCount, liveCount, phase1Deletes.length)) {
                        console.warn('[seek] reindexDelta: refusing suspicious mass-delete', {
                            deleted: phase1Deletes.length, stored: storedCount, live: liveCount,
                        });
                        phase1Deletes = [];
                    }
                }
                if (wantCarryOver) await this.harvestCarryOverInto(carryOver, phase1Deletes);

                // The change-set the incremental cache path consumes: ids removed
                // and chunks committed (filled by commitFile via addsSink). Three
                // removal sources: Phase-1 deletes, the engine diff's stale-row
                // drops (both IDB-applied), and the diff's REINDEX-ROW lane —
                // ids whose IDB rows deliberately REMAIN (metadata refreshed in
                // place) and ride the change-set only as a cache-level remove +
                // re-add with the stored vector. So `removedIds` is "rows the
                // CACHES must drop", not "rows gone from IDB", and
                // DeltaApplyEntry.removed counts both kinds (reindex-rows appear
                // symmetrically in `added`, so removed≈added reads as churn).
                const removedIds: string[] = [];
                const adds: DeltaAdd[] = [];
                // Bodies of the chunks about to be deleted, captured BEFORE
                // deleteFile drops them from IDB: applyDelta's removeExact()
                // reconstructs each removed doc (frame meta + content-addressed
                // body) to clean its postings synchronously. Capture is skipped
                // when the resident caches are absent — that pass falls back to
                // a full rebuild which never consults removal docs.
                const removedBodies = new Map<string, string>();
                // Capture whenever the frame is resident — applyDelta may patch
                // incrementally once BM25 is warm (restored or already live), and
                // bodies must be read BEFORE deleteFile drops them from IDB.
                const wantRemovalBodies = !!this.frameCache;
                // In-place metadata patches from the engine's chunk-diff: id-stable
                // chunks whose BM25-irrelevant metadata drifted (line numbers,
                // dates). applyDelta swaps the frame rows; IDB was already updated.
                const metaPatches: Array<{ id: string; meta: ChunkMeta }> = [];
                // Phase 1: structural drops (no model).
                let deletedChunks = 0;
                for (const path of phase1Deletes) {
                    if (wantRemovalBodies) await this.captureRemovalBodies(path, removedBodies);
                    const ids = await this.store.deleteFile(path);
                    deletedChunks += ids.length;
                    removedIds.push(...ids);
                }

                // Drop currentDelta for the embed phase. Note embeds can take seconds
                // per burst; holding currentDelta forced ensureFrame (and seek:search)
                // to wait the whole burst out (G_catchup_ux). Warm frames stay valid
                // until applyDelta below re-arms currentDelta for the cache patch.
                release();
                this.coord.currentDelta = null;

                // Phase 2: embed dirty files (only when we can do it now).
                const indexable = dirtyPaths.filter(p => this.shouldIndex(p));
                let embedded: IndexCompleteEntry | null = null;
                let deferredEmbed = 0;
                let sidecarHydrated = 0;
                let carriedOver = 0;
                let engineUnwound = 0;
                // Paths this burst actually committed (now non-dirty). Drives the
                // catch-up drain's advance-by-real-progress (see the computation after
                // the embed block, and drainCatchUp).
                let committedPaths: string[] = [];
                // Model-drift guard: if the loaded model differs from the one
                // that built the stored index (a legacy english-r2 index not
                // yet full-reindexed onto ml97), embedding dirty files
                // NOW would mix incompatible vector spaces in one index. Defer
                // the embed phase instead — old versions stay searchable, and
                // mtime keeps them dirty until the full reindex re-stamps meta.
                // A pre-stamp index (modelId undefined) is english-r2 by
                // construction — same default as main.ts warnOnModelIndexDrift.
                const metaModel = (await this.store.getMeta()).modelId ?? LEGACY_ENGLISH_MODEL_ID;
                const modelDrift = opts.embed
                    && this.embedder.loaded && metaModel !== this.embedder.modelId;
                if (opts.embed && !modelDrift && indexable.length > 0) {
                    const allDirty = indexable
                        .map(p => this.app.vault.getAbstractFileByPath(p))
                        .filter((f): f is TFile => f instanceof TFile);
                    // Per-BURST file cap (maxFiles), applied here rather than inside
                    // the engine, and recency-first: only the files this burst will
                    // actually re-embed get their stale chunks dropped — files
                    // deferred to a later burst keep their OLD searchable chunks
                    // until their turn (the drain loop's computeDelta re-finds them
                    // dirty and slices them into a subsequent burst). Deleting all
                    // dirty files up front would make every not-yet-embedded edit
                    // vanish from search for the whole multi-burst drain. undefined
                    // maxFiles (desktop / flushDirty / reindexAll) = the whole set.
                    allDirty.sort((a, b) => b.stat.mtime - a.stat.mtime);
                    const toEmbed = opts.maxFiles !== undefined ? allDirty.slice(0, opts.maxFiles) : allDirty;
                    // The dirty-path F13 harvest is GONE (chunk-diff commit, issue
                    // #5): a same-path edit's stable ids never re-embed now (the
                    // engine diffs against the file record and reuses stored
                    // vectors directly), so harvesting a recorded file's tiers on
                    // every commit was pure IDB tax on exactly the hot-note path
                    // this fix targets. Move sources were harvested above via
                    // deletedPaths — carry-over keeps its headline win (folder
                    // reorgs re-key for free). The one case that regresses is a
                    // whitespace-only same-path edit (every raw id changes, every
                    // embed text survives): it re-embeds once instead of carrying
                    // over. NOTE: the wholesale pre-delete is gone too — stale-row
                    // deletion now happens per-file at the point of truth (the
                    // engine's diff, carryOverHydrate, dedupViaSidecar), so a
                    // dirty file's old chunks stay searchable until replaced.
                    const afterCarry = await this.carryOverHydrate(toEmbed, carryOver);
                    carriedOver = toEmbed.length - afterCarry.length;
                    // Dedup-before-embed: hydrate the files the sidecar already covers
                    // (a peer device embedded this exact content) rather than
                    // re-embedding. Passes the removal sinks so it can drop + surface
                    // the stale rows the hydrated chunk set no longer references.
                    const remaining = await this.dedupViaSidecar(afterCarry, adds, removedIds, removedBodies, metaPatches);
                    sidecarHydrated = afterCarry.length - remaining.length;
                    remaining.sort((a, b) => b.stat.mtime - a.stat.mtime);
                    if (remaining.length > 0) {
                        const overallStart = performance.now();
                        const memBefore = await snapshotMemory();
                        // maxFiles is already enforced by the slice above; the engine
                        // only needs the wall-clock + hidden aborts (for one huge note
                        // or a mid-burst background).
                        const engineOut = await this.embedAndCommitFiles(remaining, 'incremental', opts.onProgress, overallStart, memBefore,
                            // Pass the PASS-START emptiness (captured above, before carry-over
                            // + sidecar hydration committed any chunk) so the engine's identity
                            // stamp + background recompute use the same cold-build signal as the
                            // meta stamp below — not a count() taken after hydration. The three
                            // diff sinks enable the per-file chunk-diff (issue #5) and surface
                            // its removals / meta patches into this delta's change-set.
                            {
                                budgetMs: opts.budgetMs, shouldContinue: opts.shouldContinue, addsSink: adds, storeWasEmpty,
                                removedSink: removedIds, removedBodiesSink: removedBodies, metaPatchSink: metaPatches,
                            });
                        embedded = engineOut.entry;
                        sidecarJob = engineOut.sidecarJob;
                        engineUnwound = engineOut.quarantineUnwound;
                    }
                    // Paths this burst actually committed (now non-dirty), so the catch-up
                    // drain advances by REAL progress instead of by maxFiles: carry-over
                    // reuse (toEmbed \ afterCarry) + sidecar hydration (afterCarry \
                    // remaining) + the files embedAndCommitFiles ACTUALLY committed
                    // (committedFilePaths — record written). NOT a count-based prefix of
                    // `remaining`: an empty/below-min-chunk note or a mid-list skip-error
                    // advances processedFiles without committing, so a prefix would punch a
                    // hole and drop a still-dirty file from the work-list — re-finding it
                    // dirty every sweep and spinning the outer loop. A budget-deferred file
                    // is likewise absent (stale chunks dropped, not re-embedded), so the
                    // drain retries it next burst (the searchable-during-drain invariant).
                    const afterCarrySet = new Set(afterCarry.map(f => f.path));
                    const remainingSet = new Set(remaining.map(f => f.path));
                    committedPaths = [
                        ...toEmbed.filter(f => !afterCarrySet.has(f.path)).map(f => f.path),   // carried over
                        ...afterCarry.filter(f => !remainingSet.has(f.path)).map(f => f.path), // sidecar-hydrated
                        ...(embedded?.committedFilePaths ?? []),                              // actually embedded + committed
                    ];
                } else {
                    deferredEmbed = indexable.length;
                }

                // Any store mutation must reach the in-memory caches. Prefer the
                // incremental patch (applyDelta mutates BM25 + the frame in place
                // and re-stamps the generation under THIS mutex); fall back to a
                // full invalidate+rebuild when the patch can't safely apply
                // (cold caches, index-shape flip, dim change, drift, or a due
                // compaction). Sidecar-hydrated chunks are in `adds` too, so a dedup
                // delta is incremental. Either way the next search sees a correct cache.
                const mutated = deletedChunks > 0 || phase1Deletes.length > 0 || embedded || sidecarHydrated > 0 || carriedOver > 0;
                if (mutated) {
                    // Re-arm currentDelta around the cache patch so a concurrent
                    // ensureFrame cold-miss waits for a consistent apply (not a
                    // half-mutated frame). Embed phase above left it null.
                    this.coord.currentDelta = new Promise<void>(r => { release = r; });
                    // F13 carry-over writes chunks the applyDelta change-set can't
                    // track (they bypass the model + the `adds` sink), so a delta that
                    // carried any vector over can't be patched incrementally — force
                    // the full invalidate+rebuild. The expensive re-embed is still
                    // avoided; only the cheaper in-memory cache fit is re-paid.
                    // A mass-failure quarantine UNWIND likewise bypasses the change-set
                    // (its deleteFile drops rows the addsSink already surfaced, and —
                    // under the chunk-diff — stable rows applyDelta would keep), so an
                    // unwound pass rebuilds from IDB truth too.
                    const skippedBecause = carriedOver > 0 ? 'carry-over'
                        : engineUnwound > 0 ? 'quarantine-unwind' : undefined;
                    let applyDeltaMs: number | undefined;
                    this.lastDeltaFallbackReason = null;
                    if (!skippedBecause) {
                        const applyStart = performance.now();
                        await this.fillRemovalBodiesFromStore(removedIds, removedBodies);
                        appliedIncrementally = await this.applyDelta(adds, removedIds, removedBodies, metaPatches);
                        applyDeltaMs = performance.now() - applyStart;
                    }
                    if (!appliedIncrementally) this.invalidateBm25Cache();
                    deltaTelemetry = {
                        appliedIncrementally,
                        ...(skippedBecause ? { skippedBecause } : {}),
                        ...(!skippedBecause && !appliedIncrementally && this.lastDeltaFallbackReason
                            ? { fallbackReason: this.lastDeltaFallbackReason } : {}),
                        removed: removedIds.length,
                        added: adds.length,
                        metaPatches: metaPatches.length,
                        ...(applyDeltaMs !== undefined ? { applyDeltaMs: parseFloat(applyDeltaMs.toFixed(2)) } : {}),
                        mutexHoldMs: 0,   // stamped in the finally (whole hold)
                    };
                }
                // Stamp meta ONLY when the corpus actually changed. A no-op delta (an
                // embed:false reconcile pass, or a computeDelta that found nothing)
                // rewriting lastIndexedAt + re-storing identical meta was pure write-
                // amplification — hundreds of redundant LevelDB writes across a churny
                // mobile session, feeding the bloat ratchet. And now that the BM25 stamp
                // gate tolerates a drifted lastIndexedAt (bm25StampMatches), there is
                // nothing to keep in sync on a no-op. Preserve the existing modelId: a
                // delta embeds with the loaded model, but the BULK of the index is
                // whatever the last full reindex wrote — only reindexAll claims a new id.
                if (mutated) {
                    const prevMeta = await this.store.getMeta();
                    // Fix A: a cold first-build (storeWasEmpty) claims the live identity
                    // here. For the common embed path this is a no-op — embedAndCommitFiles
                    // already stamped it, so prevMeta reads it back — but it is the ONLY
                    // stamp for the residual hydrate/carry-only cold build, whose prevMeta
                    // would otherwise be `undefined` and re-trip the gate. A NON-empty
                    // store carries identity forward unchanged: an ordinary delta never
                    // re-stamps, and a legacy index must stay stale for the gate to heal.
                    // reindexDelta is always an incremental (delta) pass, so a cold
                    // first-build (empty store) is its only stamp-live case.
                    const live = shouldStampLiveIdentity('incremental', storeWasEmpty) ? pluginIdentity() : null;
                    await this.store.setMeta({
                        embeddingDim: EMBEDDING_DIM,
                        lastIndexedAt: new Date().toISOString(),
                        schemaVersion: META_SCHEMA_VERSION,
                        // Prefer the existing modelId (embed path set it); fall back to
                        // the live model only when the cold build wrote none (hydrate-only).
                        modelId: prevMeta.modelId ?? live?.modelId,
                        // Carry identity + corpus background forward unchanged on a delta;
                        // a cold build claims live identity (see comment above). Only a
                        // full/cold pass refits the background (see dense-stats.ts).
                        chunkerVersion: live ? live.chunkerVersion : prevMeta.chunkerVersion,
                        analyzerVersion: live ? live.analyzerVersion : prevMeta.analyzerVersion,
                        revision: live ? live.revision : prevMeta.revision,
                        bgMean: prevMeta.bgMean,
                        bgStd: prevMeta.bgStd,
                    });
                }
                // deferredEmbed: the WHOLE embed phase was skipped (cold model / model
                //   drift) → indexable.length. The drain loop reads this as its
                //   no-forward-progress / drift signal. (Budget deferral is detected
                //   instead by the shrinking dirty set on the next computeDelta, so it
                //   needs no separate return field.)
                return { deletedPaths: phase1Deletes.length, deletedChunks, embedded, deferredEmbed, sidecarHydrated, carriedOver, committedPaths };
            } finally {
                if (deltaTelemetry) deltaTelemetry.mutexHoldMs = parseFloat((performance.now() - mutexStart).toFixed(2));
                release();
                this.coord.currentDelta = null;
            }
        }).finally(() =>
            // 1C: run the pass's packaged sidecar flush AFTER the mutex releases,
            // awaited before reindexDelta resolves (or rethrows) so callers keep
            // "delta resolved ⇒ sidecar flushed". flushSidecarAfterPass never
            // rejects, so this can't mask the critical section's own error.
            this.flushSidecarAfterPass(sidecarJob));
        // v16 (issue #5): persist the patch outcome. Off the mutex,
        // fire-and-forget — telemetry never delays the pass. (Local copy: the
        // closure assignment above defeats TS's narrowing on the outer let.)
        const patchOutcome: Omit<DeltaApplyEntry, 'type' | 'timestamp'> | null = deltaTelemetry;
        if (patchOutcome !== null) {
            const entry: DeltaApplyEntry = Object.assign(
                { type: 'delta-apply' as const, timestamp: new Date().toISOString() }, patchOutcome);
            void this.logger.append(entry).catch(() => {});
        }
        // Re-warm only when we did NOT patch incrementally (the patch is the warm).
        // Fire-and-forget, off the mutex — the moment the flush scheduler already
        // judged quiet enough for embed work, so the rebuild lands here rather than
        // on the next search. A carry-over delta always lands here (it forces the
        // non-incremental path above), so result.carriedOver gates a re-warm too.
        if (!appliedIncrementally
            && (result.deletedChunks > 0 || result.deletedPaths > 0 || result.embedded || result.sidecarHydrated > 0 || result.carriedOver > 0)) {
            void this.warmCaches('delta');
        } else if (appliedIncrementally) {
            // The incremental patch already kept the resident cache warm, so there is
            // no rebuild to do — but historically it also skipped persistBm25, leaving
            // the disk blob stale until a full rebuild. Re-persist (throttled, embed-
            // free) so the next cold start loads a near-fresh blob instead of refitting.
            // Ghost-discard dirt past the threshold instead takes the ordinary
            // rebuild (see reconcileGhostDirt) — the rebuild's own warm re-persists.
            if (!this.reconcileGhostDirt()) this.maybePersistResidentBm25();
        }
        return result;
    }

    // Ghost-dirt safety valve (issue #5). The only discard-path tombstones left
    // are the ghost guards (tolerant-load divergence) — a handful of postings
    // whose df effect self-heals per queried term (searches clean dirty
    // postings as they walk them). Small dirt is deliberately LEFT ALONE:
    // MiniSearch's vacuum() holds a live radix-tree iterator across its timer
    // yields, so a vacuum overlapping commits or search-time cleanup can have
    // its iterator invalidated mid-walk — and a REJECTED vacuum never resets
    // MiniSearch's _currentVacuum, permanently wedging every later vacuum on
    // that instance (2026-07-30 review; the off-mutex vacuum valve that
    // briefly lived here was retired for exactly this). Past the threshold —
    // pathological ghost accumulation — the safe reclaim is the ordinary
    // invalidate + rebuild: a fresh fit, no vacuum involved, built by the same
    // machinery every other fallback uses. Returns true when a rebuild was
    // kicked (the caller skips its own persist — the warm re-persists).
    private static readonly GHOST_DIRT_REFIT_THRESHOLD = 64;
    private reconcileGhostDirt(): boolean {
        const bm = this.bm25Cache;
        if (!bm) return false;
        const dirt = bm.dirtCount;
        if (dirt === 0) return false;
        this.forensics?.beat('ghost-dirt', { dirt, refit: dirt >= SearchOrchestrator.GHOST_DIRT_REFIT_THRESHOLD });
        if (dirt < SearchOrchestrator.GHOST_DIRT_REFIT_THRESHOLD) return false;
        this.invalidateBm25Cache();
        void this.warmCaches('ghost-dirt');
        return true;
    }

    // Capture a file's chunk bodies BEFORE deleteFile() drops them from IDB, so
    // applyDelta can reconstruct each removed doc for removeExact(). Chunk ids
    // are content hashes, so a captured body is byte-identical to what add()
    // indexed. Read failures degrade silently: a missing body makes applyDelta
    // decline into the ordinary full-rebuild fallback ("slow, never wrong").
    private async captureRemovalBodies(path: string, sink: Map<string, string>): Promise<void> {
        try {
            const rec = await this.store.getFileRecord(path);
            if (!rec || rec.chunk_ids.length === 0) return;
            for (const [id, body] of await this.store.getBodiesMap(rec.chunk_ids)) sink.set(id, body);
        } catch { /* handled at applyDelta as 'removal-body-missing' */ }
    }

    // Best-effort backfill for removal ids surfaced without a captured body
    // (getBodiesMap returns present ids only; a partial capture must not leave
    // removedSink ids body-less if the rows are still in IDB).
    private async fillRemovalBodiesFromStore(removedIds: string[], sink: Map<string, string>): Promise<void> {
        const missing = removedIds.filter(id => !sink.has(id));
        if (missing.length === 0) return;
        try {
            for (const [id, body] of await this.store.getBodiesMap(missing)) sink.set(id, body);
        } catch { /* applyDelta declines if still missing */ }
    }

    // Chunk-diff plan for one dirty file (issue #5). Returns null when there is
    // no stored record (new file) — the caller embeds everything. On a plan:
    // stale rows are deleted (bodies captured first for the exact-removal
    // patch), id-stable chunks are classified untouched / meta-patch /
    // reindex-row, and only genuinely-new ids remain to embed:
    //   - untouched: byte-identical ChunkMeta → nothing anywhere.
    //   - meta-patch: metadata drifted but none of it is BM25-indexed (line
    //     numbers after an edit above the chunk, created/modified dates) → IDB
    //     meta row refreshed here, frame row swapped in place by applyDelta.
    //   - reindex-row: BM25-indexed metadata drifted while the id held (an
    //     inline #tag in another section, a wikilink-target swap, a shape-junk
    //     property) → IDB meta refreshed here; the row rides the change-set as
    //     remove + re-add with its STORED tiers — no model forward pass.
    // Vector reuse is licensed by an EXPLICIT embed-text comparison, not by id
    // equality: on the v10 chunker "same id ⟹ same embed text" is provable
    // (embedInput consumes a strict subset of the id hash), but chunker lines
    // where the two compositions diverge (v11's per-chunk keyed suffix reads
    // metadata the note-level id hash summarizes lossily — e.g. a property KEY
    // rename moves the embed text but not the id) would silently reuse a stale
    // vector. Comparing the real embedInput old-vs-new makes the license hold
    // under ANY composition; a divergent chunk simply re-embeds.
    // Any read failure throws to the caller, whose fallback restores the
    // pre-diff wholesale delete + full re-embed.
    private async diffFileAgainstStore(
        path: string,
        fileChunks: Chunk[],
        budget: { addsSink?: DeltaAdd[]; removedSink: string[]; removedBodiesSink: Map<string, string>; metaPatchSink: Array<{ id: string; meta: ChunkMeta }> },
    ): Promise<{ keepIds: Set<string>; embedIds: Set<string> } | null> {
        const rec = await this.store.getFileRecord(path);
        if (!rec || rec.chunk_ids.length === 0) return null;
        const newIds = new Set(fileChunks.map(c => c.chunk_id));
        const staleIds = rec.chunk_ids.filter(id => !newIds.has(id));
        const oldIdSet = new Set(rec.chunk_ids);
        // Stale rows: capture bodies for removeExact, then delete. The sink gets
        // the ids AFTER the IDB delete so the change-set only holds applied rows.
        if (staleIds.length > 0) {
            for (const [id, body] of await this.store.getBodiesMap(staleIds)) budget.removedBodiesSink.set(id, body);
            const missingBodies = staleIds.filter(id => !budget.removedBodiesSink.has(id));
            if (missingBodies.length > 0) {
                throw new Error(`stale chunk bodies missing (${missingBodies.length})`);
            }
            await this.store.deleteChunksByIds(staleIds);
            budget.removedSink.push(...staleIds);
        }
        const keepIds = new Set<string>();
        const embedIds = new Set<string>();
        const stable: Chunk[] = [];
        for (const c of fileChunks) {
            if (oldIdSet.has(c.chunk_id)) stable.push(c);
            else embedIds.add(c.chunk_id);
        }
        if (stable.length > 0) {
            const oldMetas = await this.store.getChunkMetasByIds(stable.map(c => c.chunk_id));
            const metaPuts: ChunkMeta[] = [];
            // Pass 1: classify. Reindex-row candidates are collected so their
            // tier read is ONE batched transaction, not one per chunk — the
            // whole-note tag edit puts ~every chunk in this lane, and N serial
            // 4-store transactions inside the write mutex is exactly the
            // per-commit IDB tax this fix exists to remove.
            const reindexRows: Chunk[] = [];
            for (const c of stable) {
                const old = oldMetas.get(c.chunk_id);
                if (!old) { embedIds.add(c.chunk_id); continue; }   // meta row missing (torn IDB) — re-embed heals
                // The vector-reuse license (see the method comment): identical
                // bodies are id-guaranteed, so old embed text reconstructs from
                // the stored meta + this body.
                if (embedInput({ ...old, content: c.content ?? '' }) !== embedInput(c)) {
                    embedIds.add(c.chunk_id);
                    continue;
                }
                const next = stripContent(c);
                if (chunkMetaEqual(old, next)) { keepIds.add(c.chunk_id); continue; }
                if (MultiFieldBM25.docFieldsEqual(old, next)) {
                    metaPuts.push(next);
                    budget.metaPatchSink.push({ id: c.chunk_id, meta: next });
                    keepIds.add(c.chunk_id);
                } else {
                    reindexRows.push(c);
                }
            }
            // Pass 2: the batched tier read + the change-set entries.
            if (reindexRows.length > 0) {
                const tiers = await this.store.getTiersByIds(reindexRows.map(c => c.chunk_id));
                for (let i = 0; i < reindexRows.length; i++) {
                    const c = reindexRows[i];
                    const tier = tiers[i];
                    if (!tier) { embedIds.add(c.chunk_id); continue; }   // vector row missing — re-embed heals
                    // Removal reconstruction uses the OLD meta (the frame row) +
                    // this body — identical bytes by content-addressing.
                    metaPuts.push(stripContent(c));
                    budget.removedBodiesSink.set(c.chunk_id, c.content ?? '');
                    budget.removedSink.push(c.chunk_id);
                    budget.addsSink?.push({ chunk: c, q: tier.q, bin: tier.sign });
                    keepIds.add(c.chunk_id);
                }
            }
            if (metaPuts.length > 0) await this.store.putChunkMetas(metaPuts);
        }
        return { keepIds, embedIds };
    }

    // Incremental cache maintenance (Seek scaling A1). Mutate the live BM25 index +
    // resident frame in place from a delta's change-set instead of nuking and
    // full-rebuilding — per-edit work drops from O(N) to O(edit size + affected
    // terms). Returns true on a clean patch; false means the caller must fall back
    // to invalidateBm25Cache() + warmCaches (a full rebuild). Correctness NEVER
    // depends on the incremental path: every "can't safely apply" condition (cold
    // caches, index-shape flip, sidecar hydrate, dim change, missing/mismatched
    // removal doc, post-patch drift, due compaction) returns false and degrades
    // to "slow", never "wrong".
    //
    // MUST run inside reindexDelta's runExclusive critical section: it mutates
    // both caches and re-stamps the generation atomically, so a concurrent search
    // (which waits on coord.currentDelta in ensureFrame) sees either the old cache
    // or the fully-patched one, never a half-mutated frame. Since removals became
    // exact (removeExact) there is no in-mutex vacuum — the whole patch is
    // O(delta), never O(index), so the mutex hold no longer scales with the vault.
    private async applyDelta(
        adds: DeltaAdd[],
        removedIds: string[],
        removedBodies: ReadonlyMap<string, string>,
        metaPatches: ReadonlyArray<{ id: string; meta: ChunkMeta }> = [],
    ): Promise<boolean> {
        const frame = this.frameCache;
        const bm = this.bm25Cache;
        if (!frame || !bm) return this.deltaFallback('cold caches');
        if (frame.generation !== this.coord.generation
            || this.bm25CacheGeneration !== this.coord.generation) return this.deltaFallback('stale cache generation');
        // An index-shape flip changes the BM25 field set → must refit from scratch.
        if (this.bm25CacheProps !== this.settings.searchableProperties
            || this.bm25CacheHeadings !== (this.settings.headingsField || this.settings.boostedBm25)) {
            return this.deltaFallback('index-shape settings changed');
        }
        // Sidecar-hydrated rows ARE surfaced in `adds` now (dedupViaSidecar →
        // hydrateDeps.putQuantized → pushDeltaAdds), so a dedup delta applies
        // incrementally like any other — no sidecar-specific fallback.
        // Dim guard: a committed vector whose int8 dim differs from the resident
        // block's is a model/dim change mid-stream → rebuild. (Model drift normally
        // defers embeds so `adds` is empty; this guards a partial-stamp index.)
        if (frame.residentInt8 && adds.some(a => a.q.q.length !== frame.embDim)) {
            return this.deltaFallback('embedding dim mismatch');
        }

        // Resolve each removal to its reconstruction doc BEFORE mutating anything:
        // a missing body (capture skipped or failed in captureRemovalBodies)
        // declines the patch with the caches completely untouched — the cheapest
        // possible fallback. Ids with no live row are already gone (the historic
        // remove(id) tolerance for IDB↔cache divergence) and are skipped.
        const removals: Array<{ row: number; meta: ChunkMeta; body: string }> = [];
        for (const id of removedIds) {
            const row = bm.rowOf(id);
            if (row === undefined) continue;
            const body = removedBodies.get(id);
            if (body === undefined) return this.deltaFallback('removal-body-missing');
            removals.push({ row, meta: frame.orderedChunks[row], body });
        }

        // Removes first, then adds: an edit re-commits the SAME content-hash id only
        // after its stale chunk was dropped, so remove-before-add means mini.add()
        // never collides with a live duplicate. Rows were captured above BEFORE
        // removeExact() drops them from idToIdx, so the frame tombstones the right
        // holes. Wrapped in try/catch for exception safety: a throw mid-patch leaves
        // the in-place mutation half-applied, so degrade to a full rebuild (the caller
        // invalidates the suspect caches on a false return and re-warms from IDB,
        // the source of truth) rather than letting it escape — "slow, never wrong",
        // and never the crash-loop a thrown bm.add() caused on 2026-06-18.
        // The adds that actually land after the duplicate filter (declared out here
        // so the success log reports the true row count, not the pre-filter total).
        let fresh: DeltaAdd[] = [];
        // Did this delta touch an alias-bearing note? If not, the synonym
        // dictionary is provably unchanged and its O(notes) rebuild is skipped at
        // the commit below (chunkDeclaresAlias). Tracked across BOTH removes (an
        // alias deletion/edit drops the old alias-bearing row) and adds, so an
        // alias EDIT — remove-old + add-new — trips it from either side.
        let aliasDictDirty = false;
        try {
            const removeRows: number[] = [];
            for (const r of removals) {
                removeRows.push(r.row);
                if (chunkDeclaresAlias(r.meta)) aliasDictDirty = true;
                // Exact synchronous removal: postings cleaned NOW from the doc as
                // indexed (content-addressed body + as-committed frame meta) — no
                // discard tombstones, no vacuum debt, no first-search df drift. A
                // 'mismatch' means that reconstruction contract broke; the half-
                // removed doc makes the whole patch suspect, so decline and let
                // the caller rebuild from IDB truth.
                if (bm.removeExact(r.meta, r.body) === 'mismatch') return this.deltaFallback('removal-mismatch');
            }
            tombstoneFrameRows(frame, removeRows);
            // Drop adds whose id is already live in the row space (a hydrate-sourced
            // duplicate from an IDB↔cache divergence) or repeated within the batch;
            // see freshDeltaAdds. Runs AFTER the removes so edit re-commits survive.
            // The SAME list feeds bm.add and appendFrameRows → row spaces stay aligned.
            fresh = freshDeltaAdds(adds, id => bm.rowOf(id) !== undefined);
            if (!aliasDictDirty) aliasDictDirty = fresh.some(a => chunkDeclaresAlias(a.chunk));
            for (const a of fresh) bm.add(a.chunk, a.chunk.content ?? '');
            appendFrameRows(frame, fresh);
            // Meta-patches (chunk-diff, issue #5): id-stable chunks whose
            // BM25-irrelevant metadata drifted (line numbers after an edit above
            // them, dates). In-place frame row swap — same id, same row, same
            // vector; BM25 untouched (docFieldsEqual gated upstream). A missing
            // row means the frame diverged from the engine's view — decline.
            for (const p of metaPatches) {
                const row = bm.rowOf(p.id);
                if (row === undefined) return this.deltaFallback('meta-patch-row-missing');
                frame.orderedChunks[row] = p.meta;
            }
        } catch (e) {
            // console.* is invisible on mobile (no devtools) — write the NDJSON device
            // log too, so a recurring patch-throw stays field-observable. That exact
            // telemetry channel root-caused the 2026-06-18 meltdown; a silent
            // console.error would now hide any future throw past the L1 filter.
            console.error('[seek] applyDelta threw mid-patch — dropping to full rebuild', e);
            void this.logger.appendError('applyDelta-patch', e).catch(() => {});
            return this.deltaFallback('exception during patch');
        }

        // Drift detector: verify the row-space coupling survived the patch. On ANY
        // mismatch, abandon the (suspect) patch — the caller's invalidate+rebuild
        // makes it "slow, never wrong".
        if (!frameBm25Coherent(frame, bm)) {
            console.error('[seek] applyDelta produced an incoherent frame/BM25 row space');
            return this.deltaFallback('row-space drift');
        }

        // Compaction: too many tombstone holes → rebuild densely (the amortized O(N)
        // renumber). Returning false routes that through invalidate+warmCaches.
        const n = frame.orderedChunks.length;
        if (n > 0 && frame.tombstoneCount / n >= COMPACTION_TOMBSTONE_FRACTION) {
            return this.deltaFallback('compaction due', { tombstones: frame.tombstoneCount, rows: n });
        }

        // Commit: bump the generation so other readers re-validate, then re-stamp
        // the patched caches to it so the next search hits them (no rebuild).
        this.coord.bumpGeneration();
        frame.generation = this.coord.generation;
        this.stampBm25Cache(bm.size);
        // Synonym dict derives ONLY from alias-bearing notes (see chunkDeclaresAlias
        // / buildClasses), so refresh it — over LIVE rows only — when the expansion
        // toggle is on AND this delta actually touched an alias. A body-only edit
        // can't change the dictionary, so it skips the O(notes) rebuild. (The
        // df-ceiling guard then rides slightly stale between alias deltas; it's a
        // coarse 5% junk filter, refreshed on the next alias-touching delta, full
        // reindex, or cold lazy build in ensureBm25.)
        if (this.settings.synonymExpansion && aliasDictDirty) {
            const liveChunks = frame.tombstoneCount === 0
                ? frame.orderedChunks
                : frame.orderedChunks.filter((_, i) => frame.validRows[i]);
            this.synonymCache = buildSynonymMap(liveChunks, t => bm.termDocFraction(t));
        }
        // persistBm25 is no longer skipped here (2026-06-20): the caller re-persists
        // this patched index after the mutex via maybePersistResidentBm25 (throttled,
        // embed-free). The old skip assumed a cold stamp would reject the drifted
        // chunkCount anyway — but the tolerant gate now LOADS it, so keeping the disk
        // blob fresh is what lets a cold relaunch skip the all-bodies refit.
        // Report fresh.length (rows that landed), not adds.length — the difference is
        // duplicates the L1 filter absorbed; surface it so the hydrate-divergence
        // signal stays visible in the very telemetry used to diagnose this bug class.
        const filtered = adds.length - fresh.length;
        if (filtered > 0) console.warn(`[seek] applyDelta absorbed ${filtered} already-live/in-batch duplicate add(s) — hydrate/cache divergence`);
        return true;
    }

    // Log why the incremental path declined + signal the caller to full-rebuild.
    // S4 tripwire instrumentation: each decline is a full O(corpus) cache rebuild
    // (listAllMeta + listAllBinary + embeddings scan), so per-reason session counts
    // ride every beat — a churny session repeatedly tripping the SAME reason is the
    // signal that reducing fallback frequency is worth engineering against. Until
    // that data says otherwise, the fallback itself stays the correct design
    // ("slow, never wrong").
    // `reason` must be a STABLE slug — it keys deltaFallbackCounts, so per-call
    // values (counts, sizes) go in `detail`, which rides the beat payload only.
    // The most recent decline's slug, for the delta-apply entry (v16) — the
    // per-reason counts above ride heartbeats, but wlo2's reports showed those
    // don't surface the REASON of a specific pass's fallback.
    private lastDeltaFallbackReason: string | null = null;
    private deltaFallback(reason: string, detail?: Record<string, unknown>): false {
        this.lastDeltaFallbackReason = reason;
        const n = (this.deltaFallbackCounts.get(reason) ?? 0) + 1;
        this.deltaFallbackCounts.set(reason, n);
        // console.* is invisible on mobile; the beat is the field-observable channel.
        console.info(`[seek] applyDelta fallback: ${reason} — full cache rebuild (×${n} this session)`
            + (detail ? ` ${JSON.stringify(detail)}` : ''));
        this.forensics?.beat('delta-fallback', { reason, sessionCount: n, ...detail });
        return false;
    }

    // Drift-detector trip handler for the QUERY path (the applyDelta path returns
    // false to fall back instead). Logs loudly + a user Notice, drops the caches
    // for a full rebuild, and kicks a warm — turning a silent, in-bounds row-space
    // mis-join into a visible "rebuilt from scratch" event.
    private coherenceDriftCount = 0;          // log-only diagnostic counter (trip #N)
    private lastCoherenceWarmAt = -Infinity;  // performance.now() of the last drift re-warm
    // Injected by the plugin (setPersistentDriftHandler). Fired from onCoherenceDrift's
    // re-trip branch — the orchestrator is pull-based (it owns no outbound scheduling),
    // so this mirrors the modal's onSearchActivity/onQueryInFlight injection: the plugin
    // owns the embed-free recovery scheduler (runDriftRecovery) and the indexHealth flag.
    private onPersistentDrift?: () => void;
    setPersistentDriftHandler(fn: () => void): void {
        this.onPersistentDrift = fn;
    }
    // Injected by the plugin — tier 0 greedy hydrate releases the search gate early.
    private onGoodEnough?: () => void;
    setGoodEnoughHandler(fn: () => void): void {
        this.onGoodEnough = fn;
    }
    private onCoherenceDrift(where: string): void {
        this.coherenceDriftCount++;
        const now = performance.now();
        const { warm } = coherenceDriftDecision(now, this.lastCoherenceWarmAt, COHERENCE_DRIFT_COOLDOWN_MS);
        // Always drop the suspect caches — a mis-coupled frame/BM25 must never serve
        // (the cost is trivial and correctness-critical). Only the heavy re-warm and
        // the user-facing Notice are rate-limited (decision.warm).
        this.invalidateBm25Cache();
        if (!warm) {
            // Re-tripped inside the cooldown ⇒ a PERSISTENT mis-join, not a one-off.
            // Rebuilding again inline would just thrash (this turned one bad delta into
            // the 2026-06-18 mobile meltdown). The cache is invalidated; the next search
            // rebuilds it lazily via the cold path. Throttled log, no toast storm.
            console.error(`[seek] frame/BM25 drift at ${where} re-tripped within ${COHERENCE_DRIFT_COOLDOWN_MS / 1000}s (trip #${this.coherenceDriftCount}) — escalating to embed-free recovery`);
            // Hand off to the plugin's bounded, embed-free recovery ladder (sidecar
            // hydrate → warm → verify → degraded). It self-suppresses re-fires per
            // generation, so firing on every re-trip is cheap. No inline rebuild here.
            this.onPersistentDrift?.();
            return;
        }
        this.lastCoherenceWarmAt = now;
        console.error(`[seek] frame/BM25 row-space drift detected at ${where} — dropping caches for a full rebuild (trip #${this.coherenceDriftCount})`);
        void this.warmCaches('coherence-drift');
    }

    get peerAhead(): boolean {
        return this.sidecarCoordinator.peerAhead;
    }

    async hydrateSidecar(): Promise<HydrateResult | null> {
        return this.sidecarCoordinator.hydrateSidecar();
    }

    async rebuildFromSidecar(): Promise<HydrateResult | null> {
        return this.sidecarCoordinator.rebuildFromSidecar();
    }

    async peerSidecarPresent(): Promise<boolean> {
        return this.sidecarCoordinator.peerSidecarPresent();
    }

    async sweepOrphanChunks(opts: { shouldContinue?: () => boolean } = {}): Promise<{ removed: number; completed: boolean }> {
        return this.sidecarCoordinator.sweepOrphanChunks(opts);
    }

    /* internal */ async reapDeadIdentitySidecars(): Promise<number> {
        return this.sidecarCoordinator.reapDeadIdentitySidecars();
    }

    async verifyCoherent(): Promise<boolean> {
        return this.sidecarCoordinator.verifyCoherent();
    }

    async indexedChunkCount(): Promise<number | null> {
        return this.sidecarCoordinator.indexedChunkCount();
    }

    async reconcileSidecarIfChanged(): Promise<HydrateResult | null> {
        return this.sidecarCoordinator.reconcileSidecarIfChanged();
    }

    async compactOwnSidecar(): Promise<CompactResult | null> {
        return this.sidecarCoordinator.compactOwnSidecar();
    }

    async coalesceOwnSidecar(): Promise<CoalesceResult | null> {
        return this.sidecarCoordinator.coalesceOwnSidecar();
    }

    private async dedupViaSidecar(
        files: TFile[],
        addsSink?: DeltaAdd[],
        removedSink?: string[],
        removedBodiesSink?: Map<string, string>,
        metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>,
    ): Promise<TFile[]> {
        return this.sidecarCoordinator.dedupViaSidecar(files, addsSink, removedSink, removedBodiesSink, metaPatchSink);
    }

    // F13 carry-over: harvest the rerank/sign tiers of every chunk about to be
    // removed, keyed by EMBED TEXT (title\n\ncontent — path-independent). A move
    // re-keys identical content under a new path-salted chunk_id, so its vector is
    // unchanged; harvesting lets the embed phase reuse it verbatim. Reads the
    // affected files' stored chunks by id BEFORE they're deleted; merges into `map`
    // so the deleted-path and dirty-path harvests share one table.
    private async harvestCarryOverInto(
        map: Map<string, { q: QuantVec; sign: Uint8Array }>,
        paths: string[],
    ): Promise<void> {
        const seen = new Set<string>();
        for (const path of paths) {
            if (seen.has(path)) continue;
            seen.add(path);
            try {
                const rec = await this.store.getFileRecord(path);
                if (!rec || rec.chunk_ids.length === 0) continue;
                const tiers = await this.store.getTiersByIds(rec.chunk_ids);
                for (const t of tiers) {
                    if (t) map.set(embedInput(t.chunk), { q: t.q, sign: t.sign });
                }
            } catch (e) {
                // Carry-over is a pure optimization (reuse the identical vector on a
                // move / no-op re-flush). A harvest failure must NEVER abort the
                // delta — that would drop this edit from the index entirely. Record
                // it (forensics ring + per-device log) and fall through: this file
                // simply re-embeds normally.
                await this.logger.appendError(`carryOver-harvest:${path}`, e);
            }
        }
    }

    // F13: re-chunk each candidate and, if EVERY chunk's embed text is in the
    // carry-over map, write the chunks with their REUSED tiers (verbatim, no model
    // forward pass) and drop the file from the embed set. All-or-nothing per note,
    // mirroring dedupViaSidecar: a partially-changed file falls through to a normal
    // embed. The headline win is a folder reorg (pure moves) re-keying for free.
    private async carryOverHydrate(
        files: TFile[],
        carryOver: Map<string, { q: QuantVec; sign: Uint8Array }>,
    ): Promise<TFile[]> {
        if (carryOver.size === 0 || files.length === 0) return files;
        // The model-loaded embed path already has the tokenizer; the guard just
        // makes the chunk_id-reproduction dependency explicit (as in dedupViaSidecar).
        await this.embedder.ensureTokenizer();
        const done = new Set<string>();
        for (const f of files) {
            let content: string;
            try { content = await this.app.vault.cachedRead(f); } catch { continue; }
            let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
            if (chunks.length === 0) continue;
            try {
                chunks = (await enforceTokenBudget(chunks, ts => this.embedder.tokenCounts(ts))).chunks;
            } catch (e) {
                await this.logger.appendError(`carryOver-tokenBudget:${f.path}`, e);
                continue;
            }
            if (chunks.length === 0) continue;
            const tiers = chunks.map(c => carryOver.get(embedInput(c)));
            if (tiers.some(t => t === undefined)) continue;   // not fully covered → embed normally
            // The delta no longer pre-deletes a dirty file's rows (chunk-diff,
            // issue #5), so the old record — read BEFORE the overwrite below —
            // tells us which rows the hydrated chunk set no longer references.
            // They must be dropped or they orphan into ghost results on the next
            // cold frame rebuild. No change-set entries needed: a carry-over
            // delta always takes the full-rebuild path (carriedOver > 0).
            const oldRec = await this.store.getFileRecord(f.path).catch(() => null);
            // One atomic tx for chunks + record (S1), same as commitFile.
            try {
                await this.store.putBatchQuantized(chunks, tiers.map(t => ({ q: t!.q, bin: t!.sign })),
                    { note_path: f.path, mtimeMs: f.stat.mtime, chunk_ids: chunks.map(c => c.chunk_id), contentHash: cyrb53Hex(content) });
            } catch (e) {
                // A commit failure (quota, closing store) must not abort the whole
                // delta burst. Leave the file OUT of `done`: it falls through to
                // the normal embed path, whose per-file catch classifies quota
                // (S2) and keeps the file dirty for catch-up.
                await this.logger.appendError(`carryOver-commit:${f.path}`, e);
                continue;
            }
            if (oldRec) {
                const newIdSet = new Set(chunks.map(c => c.chunk_id));
                const stale = oldRec.chunk_ids.filter(id => !newIdSet.has(id));
                if (stale.length > 0) {
                    await this.store.deleteChunksByIds(stale)
                        .catch(e => this.logger.appendError(`carryOver-stale-cleanup:${f.path}`, e));
                }
            }
            done.add(f.path);
        }
        return files.filter(f => !done.has(f.path));
    }

    private async emitProgress(
        phase: IndexProgressEntry['phase'],
        filesSeen: number,
        filesTotal: number,
        chunksEmitted: number,
        elapsedMs: number,
    ): Promise<void> {
        // index-progress is a high-volume per-batch firehose that's ALSO mirrored into
        // the crash-forensics breadcrumb ring (the copy that survives a jetsam kill — the
        // one that matters for crash classification). Persist it to the NDJSON only under
        // verboseTrace; index-complete still records the per-run summary unconditionally.
        if (!this.settings.verboseTrace) return;
        // Storage probe runs alongside heap so iOS gets a non-null signal too.
        const mem = await snapshotMemory();
        const entry: IndexProgressEntry = {
            type: 'index-progress',
            timestamp: new Date().toISOString(),
            phase,
            filesSeen,
            filesTotal,
            chunksEmitted,
            elapsedMs: parseFloat(elapsedMs.toFixed(2)),
            heapMB: mem.heapMB,
            storageMB: mem.storageMB,
        };
        await this.logger.append(entry);
    }

    // Resolve the per-search FilterContext from live app + settings: the set of
    // Number-typed properties (read from Obsidian's registry each search — a cheap
    // dictionary lookup) and the date field the recency-gated `before:`/`after:`
    // filters key off. dateField is null when Recency is OFF (recencyEpsilon ≤ 0),
    // which is how the parser knows to leave a typed before:/after: as plain text.
    // recencyOverride (see search()) resolves the effective epsilon locally so a
    // query-time override never has to touch this.settings to take effect here.
    // See [[Seek Typed-Value Filters Design]].
    private buildFilterContext(recencyOverride?: RecencyOverride): FilterContext {
        return this.searchQuery.buildFilterContext(recencyOverride);
    }

    // Search path (two-stage, v7+):
    //
    // ── Phase 3 decomposition seam (SearchQuery) ── search() + searchLexicalOnly()
    // + telemetry belong in search-query.ts once CacheManager (Phase 2) is the sole
    // cache owner. Orchestrator should delegate, not duplicate. See
    // docs/SEARCH-DECOMPOSITION.md
    //
    //   S0  resident frame (corpus + binary index, cached by dataGeneration —
    //       listAllChunks runs only on a cache miss, i.e. after a reindex)
    //   S1  union of three candidate gens, fed by the resident tier:
    //         a. binary-top-N — asymmetric float·sign-bit dot product
    //         b. bm25-top-M   — multi-field BM25F (cached)
    //         c. recency-top-K — newest by frontmatter `created` (mtime fallback)
    //   S2  fp32 exact rerank ONLY over the union: load fp32 vectors for the
    //       union ids, cosine, then run the shipped α-min-max-hybrid + recency
    //       + title boost over the subset
    //   S3  file-level max-aggregation dedup, snippet, log
    //
    // The S1 union — not just binary — is mandatory per the design note: BM25
    // and recency arms exist precisely to recover the ~9% dense-unreachable
    // gold that exact dense itself caps at. Skipping them would regress
    // recall vs the old all-chunks scorer.
    //
    // recencyOverride: the seek:search CLI's per-query recencyWeight/
    // recencyHalflife params (see main.ts). Resolved locally into filterCtx/
    // rankConfig below — deliberately NEVER written into this.settings.
    // this.settings is a single live object shared by every concurrent
    // caller (other CLI calls, the search modal, openTopResult), so an
    // earlier version that mutated it for the override's duration let a
    // plain concurrent search silently rank against someone else's override
    // (2026-07-02 review). Passing the override as a call-local argument
    // instead makes overlapping searches independent by construction — no
    // shared mutable state, so nothing to race or leak.
    //
    // onPartial: optional first-paint callback. Fired once with high-confidence
    // basename/alias hits (prefix-aware last token) BEFORE query embed and the
    // binary scan finish, so the modal can show a useful row on a known-item
    // keystroke. Final fused results still come from the returned promise.
    // Serve from RAM only. A miss must NOT call listAllMeta / wait on
    // currentDelta / isWriting / warmPromise — those are the Starting locks.
    peekResidentFrame(): ResidentFrame | null {
        return this.cacheManager.peekResidentFrame();
    }

    private vaultFileCache(file: TFile): FileCacheLite | null {
        return this.searchQuery.vaultFileCache(file);
    }

    private async ensureVaultLex(signal?: AbortSignal): Promise<VaultLexIndex | null> {
        return this.searchQuery.ensureVaultLex(signal);
    }

    private async fillVaultSnippets(
        results: ScoredChunk[],
        bodies: ReadonlyMap<string, string> | null,
        cleanedQuery: string,
        signal?: AbortSignal,
    ): Promise<void> {
        return this.searchQuery.fillVaultSnippets(results, bodies, cleanedQuery, signal);
    }

    private async emitVaultLadder(
        cleanedQuery: string,
        topK: number,
        onPartial: ((partial: SearchPartial) => void | Promise<void>) | undefined,
        signal: AbortSignal | undefined,
        t0: number,
    ) {
        return this.searchQuery.emitVaultLadder(cleanedQuery, topK, onPartial, signal, t0);
    }

    private async vaultFilterBrowse(
        filters: QueryFilters,
        filterCtx: FilterContext,
        topK: number,
        signal?: AbortSignal,
    ): Promise<ScoredChunk[]> {
        return this.searchQuery.vaultFilterBrowse(filters, filterCtx, topK, signal);
    }

    async search(
        query: string,
        topK = 10,
        recencyOverride?: RecencyOverride,
        onPartial?: (partial: SearchPartial) => void | Promise<void>,
        signal?: AbortSignal,
    ): Promise<{ results: ScoredChunk[]; entry: SearchEntry }> {
        return this.searchQuery.search(query, topK, recencyOverride, onPartial, signal);
    }

    // ── Single Cache Authority (CacheManager) ──
    get frameCache(): ResidentFrame | null { return this.cacheManager.frameCache; }
    set frameCache(val: ResidentFrame | null) { this.cacheManager.frameCache = val; }
    get bm25Cache(): MultiFieldBM25 | null { return this.cacheManager.bm25Cache; }
    set bm25Cache(val: MultiFieldBM25 | null) { this.cacheManager.bm25Cache = val; }
    get bm25CacheGeneration(): number { return this.cacheManager.bm25CacheGeneration; }
    set bm25CacheGeneration(val: number) { this.cacheManager.bm25CacheGeneration = val; }
    get bm25CacheChunkCount(): number { return this.cacheManager.bm25CacheChunkCount; }
    set bm25CacheChunkCount(val: number) { this.cacheManager.bm25CacheChunkCount = val; }
    get bm25CacheProps(): boolean { return this.cacheManager.bm25CacheProps; }
    set bm25CacheProps(val: boolean) { this.cacheManager.bm25CacheProps = val; }
    get bm25CacheHeadings(): boolean { return this.cacheManager.bm25CacheHeadings; }
    set bm25CacheHeadings(val: boolean) { this.cacheManager.bm25CacheHeadings = val; }
    get binaryIndex() { return this.cacheManager.binaryIndex; }
    set binaryIndex(val) { this.cacheManager.binaryIndex = val; }
    get synonymCache() { return this.cacheManager.synonymCache; }
    set synonymCache(val) { this.cacheManager.synonymCache = val; }
    get warmPromise() { return this.cacheManager.warmPromise; }
    get warming() { return this.cacheManager.warming; }
    get warmDeferred() { return this.cacheManager.warmDeferred; }
    get pendingPersistIdle() { return this.cacheManager.pendingPersistIdle; }
    set pendingPersistIdle(val: number | null) { this.cacheManager.pendingPersistIdle = val; }
    get bgStatsGen(): number { return this.cacheManager.bgStatsGen; }
    set bgStatsGen(val: number) { this.cacheManager.bgStatsGen = val; }

    private async ensureBinaryIndex(expectedChunkCount: number): Promise<boolean> {
        return this.cacheManager.ensureBinaryIndex(expectedChunkCount);
    }

    private async getDenseBgStats(): Promise<{ mean: number; std: number } | null> {
        return this.cacheManager.getDenseBgStats();
    }

    private async ensureFrame(opts?: { skipResidentInt8?: boolean; skipWarmJoin?: boolean }): Promise<ResidentFrame | null> {
        return this.cacheManager.ensureFrame(opts);
    }

    private bm25CacheValid(orderedChunks: ChunkMeta[]): boolean {
        return this.cacheManager.bm25CacheValid(orderedChunks);
    }

    private stampBm25Cache(chunkCount: number): void {
        this.cacheManager.stampBm25Cache(chunkCount);
    }

    private async ensureBm25(orderedChunks: ChunkMeta[], fromWarm = false): Promise<boolean> {
        return this.cacheManager.ensureBm25(orderedChunks, fromWarm);
    }

    private async tryLoadPersistedBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        return this.cacheManager.tryLoadPersistedBm25(orderedChunks);
    }

    private async tryLoadCrossDeviceBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        return this.cacheManager.tryLoadCrossDeviceBm25(orderedChunks);
    }

    private async persistBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        return this.cacheManager.persistBm25(orderedChunks);
    }

    private async emitCrossDeviceBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        return this.cacheManager.emitCrossDeviceBm25(orderedChunks);
    }

    private maybePersistResidentBm25(): void {
        this.cacheManager.maybePersistResidentBm25();
    }

    async restorePersistedCachesBeforeReconcile(): Promise<{
        frameRestored: boolean;
        bm25Restored: boolean;
        chunkCount: number;
    }> {
        return this.cacheManager.restorePersistedCachesBeforeReconcile();
    }

    setWarmDeferred(deferred: boolean): void {
        this.cacheManager.setWarmDeferred(deferred);
    }

    hasBm25Cache(): boolean {
        return this.cacheManager.hasBm25Cache();
    }

    hasSearchableFrame(): boolean {
        return this.cacheManager.hasSearchableFrame();
    }

    async warmCaches(trigger: string): Promise<void> {
        return this.cacheManager.warmCaches(trigger);
    }

    get vaultLex(): VaultLexIndex | null { return this.searchQuery.vaultLex; }
    set vaultLex(val: VaultLexIndex | null) { this.searchQuery.vaultLex = val; }
    get vaultLexPromise(): Promise<VaultLexIndex> | null { return this.searchQuery.vaultLexPromise; }
    set vaultLexPromise(val: Promise<VaultLexIndex> | null) { this.searchQuery.vaultLexPromise = val; }

    private async hydrateBodies(results: ScoredChunk[]): Promise<void> {
        return this.searchQuery.hydrateBodies(results);
    }

    private topByRecency(chunks: ChunkMeta[], k: number, mask?: boolean[] | null): number[] {
        return this.searchQuery.topByRecency(chunks, k, mask);
    }

    private async appendSearchTelemetry(entry: SearchEntry): Promise<void> {
        return this.searchQuery.appendSearchTelemetry(entry);
    }

    private emptySearchEntry(
        query: string,
        cleanedQuery: string,
        filters: QueryFilters | null,
        topK: number,
        searchId: string,
        idbReadMs: number,
        totalMs: number,
    ): SearchEntry {
        return this.searchQuery.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, totalMs);
    }

    async searchLexicalOnly(
        query: string,
        topK = 10,
        onPartial?: (partial: SearchPartial) => void | Promise<void>,
        signal?: AbortSignal,
    ): Promise<{ results: ScoredChunk[] }> {
        return this.searchQuery.searchLexicalOnly(query, topK, onPartial, signal);
    }

    private bm25FieldBoosts(): Record<string, number> {
        return this.searchQuery.bm25FieldBoosts();
    }

    invalidateBm25Cache(): void {
        this.cacheManager.invalidateBm25Cache();
    }
}

// Assemble the resident int8 rerank block for a frame. For each chunk_id in
// `orderedIds` (frame row order, already orphan-filtered by ensureFrame), copy
// its stored int8 components into a contiguous Int8Array and its scale into a
// parallel Float64Array, so block row j ↔ orderedIds[j] ↔ activePacked row j.
//
// All-or-nothing: returns null (caller falls back to the per-id IDB read) when
// the embeddings store is empty OR any frame row lacks a same-dim embedding
// sibling. That keeps stage-2 behaviour identical to the IDB path in every
// inconsistent state (putBatch writes chunk+emb+bin atomically, so a surviving
// frame row should always have an embedding — the guard is defensive against a
// half-migrated/corrupted store) and merely faster in the consistent case.
//
// Scales are Float64 (NOT Float32): s = max|vᵢ|/127 is a float64, and stage-2
// dequantizes with dequantizeInt8(int8.subarray(...), scales[j]) — the SAME
// function getEmbeddingsByIds calls on the on-disk {q,s}. Holding s at full
// float64 precision makes that dequant bit-identical to the IDB path; a Float32
// scale would round s and could shift a dequantized component, breaking the
// relevance-identical guarantee.
// Stage-2 candidate alignment decision: whether `v` (this candidate's fp32
// row) is usable, and — if not — the degraded ChunkMeta to rank it with
// instead of dropping it. A missing/mismatched row (no chunk sibling in the
// embeddings store: a half-migrated upgrade, storage corruption, or, on
// mobile — which ALWAYS takes the per-id getEmbeddingsByIds path, never the
// resident RAM block — a chunk whose vector hasn't hydrated/embedded on this
// device yet) degrades to the SAME lexical-only floor ranker.ts already
// applies to body-less title-only chunks, rather than silently dropping a
// candidate BM25 may have ranked first. Returns null only when there is no
// chunk metadata at all (nothing to rank or render). The returned chunk is a
// COPY when degraded — the caller's orderedChunks entry is shared across
// queries and must never be mutated in place.
export {
    alignCandidate,
    buildResidentRerankBlock,
    type ResidentFrame,
    type DeltaAdd,
    chunkMetaEqual,
    pushDeltaAdds,
    freshDeltaAdds,
    frameMetaOf,
    appendFrameRows,
    tombstoneFrameRows,
    buildSelectionMask,
} from './frame-utils';
export {
    COMPACTION_TOMBSTONE_FRACTION,
    COHERENCE_SAMPLES,
    COHERENCE_DRIFT_COOLDOWN_MS,
    coherenceDriftDecision,
    shouldDiscardPartialFrame,
    type DriftRecoveryState,
    driftRecoveryDecision,
    type RowSpaceProbe,
    frameBm25Coherent,
} from './coherence';
export {
    type Bm25PersistStamp,
    buildBm25Stamp,
    bm25StampMatches,
} from './bm25-persist';


export {
    SearchQuery,
    type RecencyOverride,
    dedupByPath,
    topKByScore,
} from './search-query';
export {
    SidecarCoordinator,
    type SidecarCoordinatorDeps,
} from './sidecar-coordinator';

