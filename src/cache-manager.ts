/**
 * @file cache-manager.ts
 * @module CacheManager
 *
 * ## Responsibilities
 * Single authority and lifecycle manager for all resident in-memory search caches:
 * - `frameCache`: The aligned `ResidentFrame` containing chunk metadata, 1-bit sign vectors,
 *   and quantized int8 vectors for Hamming/dot-product query execution.
 * - `bm25Cache`: The in-memory `MultiFieldBM25` lexical search index.
 * - `binaryIndex`: Contiguous binary sign vector index for fast Hamming distance scoring.
 * - `synonymCache`: Vault synonym lookup map (`SynonymMap`).
 * - Persisting and loading serialized BM25 index blobs to/from disk (`saveBm25DiskCache`,
 *   `loadBm25DiskCache`) to bypass expensive lexical re-parsing on startup.
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: State Authority Layer. Instantiated synchronously in the
 *   `SearchOrchestrator` constructor.
 * - **Initialization sequence**:
 *   1. Instantiated empty on plugin load.
 *   2. `IndexStore` opens and verifies schema/identity.
 *   3. `warmCaches()` is called after startup hydrate or initial delta scan completes.
 *   4. `SearchQuery` accesses `ensureFrame()` / `getBm25Cache()` during searches.
 *   5. On index writes or reindex, caches are mutated incrementally in lockstep or
 *      cleared atomically via `invalidateCaches()`.
 * - **Critical Invariants**:
 *   - **Single Cache Authority**: There are NO dual caches in `SearchOrchestrator`. All query
 *     and indexing operations interact with caches exclusively through this instance.
 *   - **Generation Freshness**: `ensureFrame()` captures `coord.generation` before reading
 *     from `IndexStore` and verifies it upon completion via `shouldDiscardPartialFrame()`.
 *     If the index generation advanced during assembly, the partial frame is immediately
 *     discarded to prevent serving stale/corrupt data.
 *   - **Write Mutex Coordination**: Invalidation and mutations must occur under
 *     `IndexCoordinator.runExclusive` or in locked coordination with write batches.
 */

import type { App } from 'obsidian';
import type { ChunkMeta, SeekSettings } from './types';
import { MultiFieldBM25 } from './bm25';
import { buildSynonymMap, type SynonymMap } from './synonyms';
import { TaskContextTracker } from './task-context';
import { IndexStore } from './index-store';
import { LocalEmbedder } from './embedder';
import { SeekLogger } from './logger';
import { Forensics } from './forensics';
import { concatPacked } from './binary';
import { type QuantVec } from './quant';
import {
    bm25PathFor,
    writeBytesAtomic,
    ensureDir,
} from './sidecar';
import { expectationFor } from './sidecar-meta';
import { rankAcceptedProducers } from './sidecar-sync';
import { gzipString, gunzipToString, gzipAvailable } from './gzip';
import { IndexCoordinator } from './index-coordinator';
import { cheapYield } from './pacer';
import { isMobilePlatform, residentInt8Enabled } from './platform';
import {
    buildResidentRerankBlock,
    type ResidentFrame,
} from './frame-utils';
import {
    shouldDiscardPartialFrame,
    frameBm25Coherent,
} from './coherence';
import {
    buildBm25Stamp,
    bm25StampMatches,
} from './bm25-persist';

export interface CacheManagerDeps {
    app: App;
    store: IndexStore;
    coord: IndexCoordinator;
    embedder: LocalEmbedder;
    settings: SeekSettings;
    logger: SeekLogger;
    forensics?: Forensics;
    taskCtx?: TaskContextTracker;
}

export class CacheManager {
    readonly app: App;
    readonly store: IndexStore;
    readonly coord: IndexCoordinator;
    readonly embedder: LocalEmbedder;
    readonly settings: SeekSettings;
    readonly logger: SeekLogger;
    readonly forensics?: Forensics;
    readonly taskCtx?: TaskContextTracker;
    disposed = false;

    // Stage-1 resident binary index. Loaded from IDB once per dataGeneration
    // then cached in memory; ~64 KB per 1k chunks at d=512, so 5.5k vault ≈
    // 350 KB resident. The packed buffer is one contiguous Uint8Array for
    // cache-friendly scoring (see binary.ts:concatPacked).
    binaryIndex: {
        ids: string[];
        packed: Uint8Array;
        bytesPerVec: number;
        generation: number;
    } | null = null;

    // Resident unified frame: the corpus in binary-index order (orphans
    // dropped) plus its aligned packed-binary buffer. Cached per dataGeneration
    // exactly like binaryIndex/bm25Cache.
    frameCache: ResidentFrame | null = null;

    // Corpus dense-cosine background (dense-stats.ts), cached by dataGeneration
    // exactly like the frame: read from persisted meta on the first query after a
    // reindex, then reused with zero IDB traffic until the next bump.
    bgStatsCache: { mean: number; std: number } | null = null;
    bgStatsGen = -1;

    // BM25 cache
    bm25Cache: MultiFieldBM25 | null = null;
    bm25CacheGeneration = -1;
    bm25CacheChunkCount = -1;
    bm25CacheProps = false;
    bm25CacheHeadings = false;

    // Alias-dictionary synonym map
    synonymCache: SynonymMap | null = null;

    // Throttled embed-free re-persist of the resident BM25 blob.
    private lastBm25PersistMs = Number.NEGATIVE_INFINITY;
    static readonly BM25_PERSIST_THROTTLE_MS = 30_000;
    pendingPersistIdle: number | null = null;

    // Warming state
    warming = false;
    warmDeferred = false;
    warmPromise: Promise<void> | null = null;

    constructor(deps: CacheManagerDeps) {
        this.app = deps.app;
        this.store = deps.store;
        this.coord = deps.coord;
        this.embedder = deps.embedder;
        this.settings = deps.settings;
        this.logger = deps.logger;
        this.forensics = deps.forensics;
        this.taskCtx = deps.taskCtx;
    }

    dispose(): void {
        this.disposed = true;
        if (this.pendingPersistIdle !== null && typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(this.pendingPersistIdle);
            this.pendingPersistIdle = null;
        }
    }

    setWarmDeferred(deferred: boolean): void {
        this.warmDeferred = deferred;
    }

    hasBm25Cache(): boolean {
        return this.bm25Cache !== null && this.bm25CacheGeneration === this.coord.generation && this.bm25CacheChunkCount > 0;
    }

    hasSearchableFrame(): boolean {
        return this.peekResidentFrame() != null;
    }

    peekResidentFrame(): ResidentFrame | null {
        const f = this.frameCache;
        if (!f || f.orderedChunks.length === 0) return null;
        if (f.generation === this.coord.generation) return f;
        if (this.coord.isWriting()) return f;
        return null;
    }

    async getDenseBgStats(): Promise<{ mean: number; std: number } | null> {
        if (this.bgStatsGen === this.coord.generation) return this.bgStatsCache;
        const m = await this.store.getMeta();
        this.bgStatsCache = (m.bgMean != null && m.bgStd != null && m.bgStd > 0)
            ? { mean: m.bgMean, std: m.bgStd }
            : null;
        this.bgStatsGen = this.coord.generation;
        return this.bgStatsCache;
    }

    async ensureBinaryIndex(expectedChunkCount: number): Promise<boolean> {
        if (
            this.binaryIndex &&
            this.binaryIndex.generation === this.coord.generation
        ) {
            return true;
        }
        const { ids, packed } = await this.store.listAllBinary();
        if (ids.length === 0) {
            this.binaryIndex = null;
            return false;
        }
        const bytesPerVec = packed[0].length;
        const concat = concatPacked(packed, bytesPerVec);
        this.binaryIndex = {
            ids,
            packed: concat,
            bytesPerVec,
            generation: this.coord.generation,
        };
        if (Math.abs(ids.length - expectedChunkCount) > expectedChunkCount * 0.05) {
            console.warn(
                `[seek] binary index has ${ids.length} rows vs ${expectedChunkCount} chunks ` +
                `(>5% divergence) — consider Full reindex`,
            );
        }
        return false;
    }

    async ensureFrame(opts?: { skipResidentInt8?: boolean; skipWarmJoin?: boolean }): Promise<ResidentFrame | null> {
        if (!opts?.skipWarmJoin && !this.frameCache && this.warmPromise) {
            await Promise.race([
                this.warmPromise.catch(() => {}),
                new Promise<void>(r => setTimeout(r, 8_000)),
            ]);
        }
        {
            const joined = this.frameCache;
            if (joined && joined.generation === this.coord.generation) {
                return joined;
            }
            if (joined && this.coord.isWriting()) {
                return joined;
            }
        }
        if (this.frameCache && this.frameCache.generation === this.coord.generation) {
            return this.frameCache;
        }
        if (this.frameCache && this.coord.isWriting()) {
            return this.frameCache;
        }
        if (this.coord.currentDelta) {
            while (this.coord.currentDelta) { try { await this.coord.currentDelta; } catch { /* delta logged it */ } }
            if (this.frameCache && this.frameCache.generation === this.coord.generation) {
                return this.frameCache;
            }
            if (this.frameCache && this.coord.isWriting()) {
                return this.frameCache;
            }
        }
        if (!this.frameCache && this.coord.isWriting()) {
            const deadline = performance.now() + 30_000;
            while (this.coord.isWriting() && performance.now() < deadline) {
                await new Promise<void>(r => setTimeout(r, 40));
            }
        }
        {
            const afterWait = this.frameCache;
            if (afterWait && afterWait.generation === this.coord.generation) {
                return afterWait;
            }
            if (afterWait && this.coord.isWriting()) {
                return afterWait;
            }
        }

        const buildGeneration = this.coord.generation;
        const chunks = await this.store.listAllMeta();
        await this.ensureBinaryIndex(chunks.length);
        if (chunks.length === 0 || !this.binaryIndex) {
            if (shouldDiscardPartialFrame(buildGeneration, this.coord.generation)) return this.ensureFrame();
            this.frameCache = null;
            return null;
        }
        const chunkByIdMap = new Map<string, ChunkMeta>();
        for (const c of chunks) chunkByIdMap.set(c.chunk_id, c);

        const rawIds = this.binaryIndex.ids;
        const rawPacked = this.binaryIndex.packed;
        const bytesPerVec = this.binaryIndex.bytesPerVec;

        const orderedChunks: ChunkMeta[] = [];
        const orderedIds: string[] = [];
        const filteredPacked = new Uint8Array(rawIds.length * bytesPerVec);
        let filteredCount = 0;
        for (let i = 0; i < rawIds.length; i++) {
            const c = chunkByIdMap.get(rawIds[i]);
            if (!c) continue;
            orderedChunks.push(c);
            orderedIds.push(rawIds[i]);
            filteredPacked.set(
                rawPacked.subarray(i * bytesPerVec, (i + 1) * bytesPerVec),
                filteredCount * bytesPerVec,
            );
            filteredCount++;
        }
        if (filteredCount < rawIds.length) {
            console.warn(`[seek] dropped ${rawIds.length - filteredCount} orphan binary rows (no chunk sibling) — index may be partially backfilled`);
        }
        const activePacked = filteredCount === rawIds.length
            ? rawPacked
            : filteredPacked.subarray(0, filteredCount * bytesPerVec);

        let resident: ReturnType<typeof buildResidentRerankBlock> = null;
        if (!opts?.skipResidentInt8 && residentInt8Enabled(orderedIds.length, bytesPerVec * 8)) {
            const { ids: embIds, vecs: embVecs } = await this.store.listAllEmbeddings();
            const embById = new Map<string, QuantVec>();
            for (let i = 0; i < embIds.length; i++) embById.set(embIds[i], embVecs[i]);
            resident = buildResidentRerankBlock(orderedIds, embById);
        }

        if (shouldDiscardPartialFrame(buildGeneration, this.coord.generation)) return this.ensureFrame();
        const assembled: ResidentFrame = {
            orderedChunks, orderedIds, activePacked, bytesPerVec,
            residentInt8: resident ? resident.int8 : null,
            residentScales: resident ? resident.scales : null,
            embDim: resident ? resident.embDim : 0,
            validRows: new Array<boolean>(orderedChunks.length).fill(true),
            tombstoneCount: 0,
            generation: buildGeneration,
        };
        if (this.coord.isWriting()) {
            return assembled;
        }
        this.frameCache = assembled;
        return this.frameCache;
    }

    bm25CacheValid(orderedChunks: ChunkMeta[]): boolean {
        return !!(
            this.bm25Cache &&
            this.bm25CacheGeneration === this.coord.generation &&
            this.bm25CacheChunkCount === orderedChunks.length &&
            this.bm25CacheProps === this.settings.searchableProperties &&
            this.bm25CacheHeadings === (this.settings.headingsField || this.settings.boostedBm25)
        );
    }

    stampBm25Cache(chunkCount: number): void {
        this.bm25CacheGeneration = this.coord.generation;
        this.bm25CacheChunkCount = chunkCount;
        this.bm25CacheProps = this.settings.searchableProperties;
        this.bm25CacheHeadings = this.settings.headingsField || this.settings.boostedBm25;
        this.synonymCache = null;
    }

    async ensureBm25(orderedChunks: ChunkMeta[], fromWarm = false): Promise<boolean> {
        let hit = this.bm25CacheValid(orderedChunks);
        if (!hit) {
            if (this.warmPromise && !fromWarm) {
                return this.bm25CacheValid(orderedChunks);
            }
            if (this.coord.isWriting()) {
                return false;
            }
            const propsEnabled = this.settings.searchableProperties;
            const headingsEnabled = this.settings.headingsField || this.settings.boostedBm25;
            this.taskCtx?.push('bm25-warm');
            try {
                const bodies = await this.store.getBodiesMap(orderedChunks.map(c => c.chunk_id));
                const built = await new MultiFieldBM25().fitAsync(orderedChunks, bodies,
                    { searchableProperties: propsEnabled, headingsField: headingsEnabled }, cheapYield);
                this.bm25Cache = built;
                this.stampBm25Cache(orderedChunks.length);
            } finally {
                this.taskCtx?.pop('bm25-warm');
            }
        }
        if (this.settings.synonymExpansion && !this.synonymCache) {
            this.synonymCache = buildSynonymMap(orderedChunks, t => this.bm25Cache!.termDocFraction(t));
        }
        return hit;
    }

    async tryLoadPersistedBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        try {
            const blob = await this.store.getBm25();
            if (!blob) return;
            const meta = await this.store.getMeta();
            if (!meta.lastIndexedAt) return;
            const live = buildBm25Stamp(meta, orderedChunks.length, this.settings);
            if (!bm25StampMatches(blob.stamp, live)) return;
            this.bm25Cache = new MultiFieldBM25().fromJSON(blob.json, orderedChunks, {
                searchableProperties: this.settings.searchableProperties,
                headingsField: this.settings.headingsField || this.settings.boostedBm25,
            });
            this.stampBm25Cache(orderedChunks.length);
        } catch (e) {
            console.warn('[seek] persisted BM25 load failed (refitting)', e);
        }
    }

    async tryLoadCrossDeviceBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        if (!this.coord.sidecarOn() || !gzipAvailable()) return;
        if (orderedChunks.length === 0) return;
        const dir = this.coord.dir;
        if (!dir) return;
        const adapter = this.app.vault.adapter;
        const meta = await this.store.getMeta();
        const expect = expectationFor();
        const live = buildBm25Stamp(meta, orderedChunks.length, this.settings);
        const devs = await rankAcceptedProducers(adapter, dir, expect);
        for (const dev of devs) {
            try {
                const bytes = await adapter.readBinary(bm25PathFor(dir, dev)).catch(() => null);
                if (!bytes) continue;
                const rec = JSON.parse(await gunzipToString(bytes)) as { json?: unknown; stamp?: unknown };
                if (typeof rec.json !== 'string') continue;
                if (!bm25StampMatches(rec.stamp, live)) continue;
                this.bm25Cache = new MultiFieldBM25().fromJSON(rec.json, orderedChunks, {
                    searchableProperties: this.settings.searchableProperties,
                    headingsField: this.settings.headingsField || this.settings.boostedBm25,
                });
                this.stampBm25Cache(orderedChunks.length);
                void this.persistBm25(orderedChunks);
                return;
            } catch (e) {
                console.warn(`[seek] cross-device BM25 load from ${dev} failed, trying next`, e);
            }
        }
    }

    async persistBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        try {
            if (!this.bm25Cache) return;
            const meta = await this.store.getMeta();
            if (!meta.lastIndexedAt) return;
            const stamp = buildBm25Stamp(meta, orderedChunks.length, this.settings);
            await this.store.putBm25(this.bm25Cache.toJSON(), stamp);
        } catch (e) {
            console.warn('[seek] BM25 persist failed (cold start will refit)', e);
        }
    }

    async emitCrossDeviceBm25(orderedChunks: ChunkMeta[]): Promise<void> {
        if (!this.coord.sidecarOn() || isMobilePlatform() || !gzipAvailable()) return;
        const dir = this.coord.dir;
        if (!dir || !this.bm25Cache) return;
        try {
            const meta = await this.store.getMeta();
            if (!meta.lastIndexedAt) return;
            const stamp = buildBm25Stamp(meta, orderedChunks.length, this.settings);
            const payload = JSON.stringify({ json: this.bm25Cache.toJSON(), stamp });
            const gz = await gzipString(payload);
            await ensureDir(this.app.vault.adapter, dir);
            await writeBytesAtomic(this.app.vault.adapter, bm25PathFor(dir, this.logger.deviceId), gz);
        } catch (e) {
            await this.logger.appendError('emitCrossDeviceBm25', e).catch(() => {});
        }
    }

    maybePersistResidentBm25(): void {
        const rf = this.frameCache;
        if (!rf || rf.generation !== this.coord.generation) return;
        if (!this.bm25CacheValid(rf.orderedChunks)) return;
        const now = performance.now();
        if (now - this.lastBm25PersistMs < CacheManager.BM25_PERSIST_THROTTLE_MS) return;
        this.lastBm25PersistMs = now;
        const run = (): void => {
            this.pendingPersistIdle = null;
            if (this.disposed) return;
            const live = this.frameCache;
            if (!live || live.generation !== this.coord.generation) return;
            void this.persistBm25(live.orderedChunks);
        };
        if (typeof activeDocument === 'undefined' || activeDocument.hidden || typeof requestIdleCallback !== 'function') {
            run();
            return;
        }
        this.pendingPersistIdle = requestIdleCallback(() => run(), { timeout: 5000 });
    }

    async restorePersistedCachesBeforeReconcile(): Promise<{
        frameRestored: boolean;
        bm25Restored: boolean;
        chunkCount: number;
    }> {
        const none = { frameRestored: false, bm25Restored: false, chunkCount: 0 };
        try {
            if (this.warmPromise) {
                await Promise.race([
                    this.warmPromise.catch(() => {}),
                    new Promise<void>(r => setTimeout(r, 8_000)),
                ]);
            }
            const frame = await this.ensureFrame({ skipWarmJoin: true, skipResidentInt8: true });
            if (!frame || frame.orderedChunks.length === 0) return none;
            const orderedChunks = frame.orderedChunks;
            if (!this.bm25CacheValid(orderedChunks)) {
                await this.tryLoadPersistedBm25(orderedChunks);
                if (!this.bm25CacheValid(orderedChunks)) {
                    await this.tryLoadCrossDeviceBm25(orderedChunks);
                }
            }
            const bm25Restored = this.bm25CacheValid(orderedChunks);
            if (bm25Restored && this.bm25Cache && !frameBm25Coherent(frame, this.bm25Cache)) {
                this.bm25Cache = null;
                this.bm25CacheGeneration = -1;
                this.bm25CacheChunkCount = -1;
                this.synonymCache = null;
                this.forensics?.beat('persist-cache-restore', {
                    frameRestored: true, bm25Restored: false, reason: 'incoherent',
                    chunkCount: orderedChunks.length,
                });
                return { frameRestored: true, bm25Restored: false, chunkCount: orderedChunks.length };
            }
            this.forensics?.beat('persist-cache-restore', {
                frameRestored: true,
                bm25Restored,
                chunkCount: orderedChunks.length,
            });
            return { frameRestored: true, bm25Restored, chunkCount: orderedChunks.length };
        } catch (e) {
            console.warn('[seek] persisted cache restore before reconcile failed (reconcile will cold-rebuild)', e);
            return none;
        }
    }

    async warmCaches(trigger: string): Promise<void> {
        const bgWarm = trigger === 'startup' || trigger === 'startup-good-enough'
            || trigger === 'pre-catchup' || trigger === 'modal-open';
        if (this.warmDeferred && bgWarm) return;
        if (this.warmPromise) return this.warmPromise;
        if (isMobilePlatform() && !this.embedder.loaded) {
            this.maybePersistResidentBm25();
            return;
        }
        this.warmPromise = this.runWarmCaches(trigger).finally(() => { this.warmPromise = null; });
        return this.warmPromise;
    }

    async runWarmCaches(trigger: string): Promise<void> {
        this.warming = true;
        this.forensics?.beat('bm25-warm-start', { trigger });
        try {
            let warmedChunks: ChunkMeta[] | null = null;
            const lightFrame = trigger === 'pre-catchup' || trigger === 'startup-good-enough'
                || trigger === 'startup' || trigger === 'post-catchup';
            const singlePass = lightFrame;
            do {
                const frame = await this.ensureFrame(
                    lightFrame ? { skipResidentInt8: true, skipWarmJoin: true } : { skipWarmJoin: true },
                );
                if (!frame) break;
                if (!this.bm25CacheValid(frame.orderedChunks)) {
                    await this.tryLoadPersistedBm25(frame.orderedChunks);
                }
                if (!this.bm25CacheValid(frame.orderedChunks) && !this.coord.isWriting()) {
                    await this.ensureBm25(frame.orderedChunks, true);
                }
                warmedChunks = frame.orderedChunks;
                if (singlePass) break;
            } while (this.bm25CacheGeneration !== this.coord.generation);

            if (warmedChunks && this.bm25CacheGeneration === this.coord.generation) {
                void this.persistBm25(warmedChunks);
                if (trigger === 'full-reindex') void this.emitCrossDeviceBm25(warmedChunks);
            }
        } catch (e) {
            console.warn('[seek] cache re-warm failed (next search rebuilds lazily)', e);
        } finally {
            this.warming = false;
        }
    }

    invalidateBm25Cache(): void {
        this.bm25Cache = null;
        this.bm25CacheGeneration = -1;
        this.bm25CacheChunkCount = -1;
        this.synonymCache = null;
        this.binaryIndex = null;
        this.frameCache = null;
        this.coord.bumpGeneration();
    }
}
