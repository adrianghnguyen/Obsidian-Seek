/**
 * @file sidecar-coordinator.ts
 * @module SidecarCoordinator
 *
 * ## Responsibilities
 * Durability and multi-device synchronization manager for file-based sidecars (`.seek-artifacts/`):
 * - **Peer Hydration (`hydrateFromSidecar`)**: Reads sidecar chunk shards produced by other devices
 *   (e.g. desktop Mac/PC) and ingests them into the local IndexedDB without re-running embedding models.
 * - **Live Re-chunking (`rechunkLiveNotes`)**: Synchronizes hydrated chunk metadata with active vault
 *   file contents, updating text bodies and heading paths.
 * - **Shard Compaction & Coalescing (`compactDevice`, `coalesceSmallShards`)**: Merges fragmented append
 *   shards into dense, consolidated storage files to prevent vault clutter.
 * - **Dead Identity & Orphan Cleanup (`sweepDeadSidecarDevices`, `cleanStaleDeviceSidecars`)**: Purges
 *   abandoned device directories and incompatible sidecar format versions.
 * - **Sidecar Rebuild (`rebuildSidecar`)**: Exports current IndexedDB state to disk sidecars on reset.
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: Durability & Multi-Device Sync Layer. Instantiated inside `SearchOrchestrator`.
 * - **CRITICAL Lifecycle Ordering**:
 *   1. **Hydration MUST precede Catch-Up Indexing**: On startup, sidecar hydration MUST execute
 *      before `runCatchUp` computes vault deltas. Running hydration first ensures peer-embedded chunks
 *      are already present in IndexedDB, avoiding expensive, redundant re-embedding of peer notes.
 *   2. **Write Mutex Prerequisite**: Ingestion and compaction MUST run inside `IndexCoordinator.runExclusive`
 *      to serialize IndexedDB transactions and avoid concurrent write races.
 *   3. **Post-Hydration Cache Coordination**: Following hydration, `CacheManager` caches must either be
 *      incrementally updated via `pushDeltaAdds` or invalidated so the query frame reflects newly
 *      hydrated notes.
 *   4. **Deferred Background Sweeps**: Compaction, coalescing, and orphan sweeps are scheduled on deferred
 *      idle timers to avoid consuming CPU/IO during the initial startup burst.
 */

import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import {
    type IndexStore,
    stripContent,
    findOrphanChunkIds,
    META_SCHEMA_VERSION,
    type FileRecord,
} from './index-store';
import type { LocalEmbedder } from './embedder';
import { MODEL_ID, EMBEDDING_DIM } from './embedder';
import type { SeekLogger } from './logger';
import type { Forensics } from './forensics';
import type { SeekSettings, Chunk, ChunkMeta } from './types';
import { pluginIdentity } from './identity';
import { chunkMetaEqual, pushDeltaAdds, type DeltaAdd } from './frame-utils';
import { frameBm25Coherent } from './coherence';
import { enforceTokenBudget, createBatchedTokenCounter, TOKEN_COUNTS_BATCH } from './token-budget';
import { cheapYield } from './pacer';
import { MultiFieldBM25 } from './bm25';
import { isMobilePlatform } from './platform';
import type { CacheManager } from './cache-manager';
import type { IndexCoordinator } from './index-coordinator';
import { cyrb53Hex } from './chunker';
import {
    type CompactResult,
    type CoalesceResult,
    SIDECAR_FORMAT,
    sidecarDirSignature,
    shouldReconcileSidecar,
    listSidecarDeviceIds,
    clearDevice,
    staleSidecarFormat,
    listDeviceShards,
    compactDevice,
    coalesceSmallShards,
} from './sidecar';
import {
    readDeviceMeta,
    metaAccepts,
    expectationFor,
    type SidecarMeta,
    type MetaExpectation,
} from './sidecar-meta';
import {
    hydrateFromSidecar,
    rankAcceptedProducers,
    probePeerAhead,
    type ReChunkedNote,
    type HydrateResult,
    type HydrateDeps,
} from './sidecar-sync';

export interface SidecarCoordinatorDeps {
    app: App;
    store: IndexStore;
    coord: IndexCoordinator;
    embedder: LocalEmbedder;
    logger: SeekLogger;
    settings: SeekSettings;
    cacheManager: CacheManager;
    forensics?: Forensics | null;
    chunksFor: (content: string, path: string, modifiedIso: string | null) => Chunk[];
    indexableFiles: () => TFile[];
    shouldIndex: (path: string) => boolean;
    onGoodEnough?: () => void;
}

export class SidecarCoordinator {
    private app: App;
    private store: IndexStore;
    private coord: IndexCoordinator;
    private embedder: LocalEmbedder;
    private logger: SeekLogger;
    private settings: SeekSettings;
    private cacheManager: CacheManager;
    private forensics?: Forensics | null;
    private chunksFor: (content: string, path: string, modifiedIso: string | null) => Chunk[];
    private indexableFiles: () => TFile[];
    private shouldIndex: (path: string) => boolean;
    onGoodEnough?: () => void;

    private _peerAhead = false;
    private lastReconcileSig: string | null = null;
    private warnedRefusals = new Set<string>();
    private warnedStranded = false;

    constructor(deps: SidecarCoordinatorDeps) {
        this.app = deps.app;
        this.store = deps.store;
        this.coord = deps.coord;
        this.embedder = deps.embedder;
        this.logger = deps.logger;
        this.settings = deps.settings;
        this.cacheManager = deps.cacheManager;
        this.forensics = deps.forensics;
        this.chunksFor = deps.chunksFor;
        this.indexableFiles = deps.indexableFiles;
        this.shouldIndex = deps.shouldIndex;
        this.onGoodEnough = deps.onGoodEnough;
    }

    get peerAhead(): boolean {
        return this._peerAhead;
    }

    set peerAhead(val: boolean) {
        this._peerAhead = val;
    }

    // Rebuild the IDB index from the vault-file sidecar without re-embedding —
    // the iOS-eviction / fresh-device recovery path. Runs under the write mutex
    // (can't overlap a reindex/delta), reproduces ids by re-chunking the live
    // vault, and writes only the intersection that isn't already in IDB. Returns
    // null when the sidecar is off. Idempotent: a warm index hydrates nothing.
    async hydrateSidecar(): Promise<HydrateResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const result = await this.coord.runExclusive(() =>
            this.hydrateSidecarExclusive(),
        );
        return this.afterHydrateExclusive(result);
    }

    async hydrateFromSidecar(): Promise<{ importedChunks: number } | null> {
        if (!this.coord.sidecarOn()) return null;
        const result = this.coord.isWriting()
            ? await this.hydrateSidecarExclusive()
            : await this.hydrateSidecar();
        return result ? { importedChunks: result.hydrated } : null;
    }

    // Hydrate body that assumes the write mutex is already held. Used by
    // hydrateSidecar (which acquires the lock) and rebuildFromSidecar (which
    // must clearAllStores + hydrate in ONE critical section — releasing
    // between them left isWriting() false so flushDirty/full reindex could
    // run against an empty store). Must NOT call runExclusive (FIFO deadlock).
    async hydrateSidecarExclusive(): Promise<HydrateResult> {
        // Count inside the exclusive section (R3): a concurrent writer cannot
        // populate the store between the empty check and hydrate.
        const wasEmpty = (await this.store.count()).chunks === 0;
        const result = await hydrateFromSidecar(this.hydrateDepsGreedy());
        // Stamp the build identity when hydrating onto a PREVIOUSLY-EMPTY index: every
        // chunk came from a metaAccepts-filtered (current-identity) producer, so the
        // index is provably at the current identity. This lets a hydrate-only device
        // (cold iOS, lastIndexedAt=null) report a current identity on its next boot —
        // without it the boot gate would needlessly nuke+rehydrate, or (no peer that
        // boot) falsely drop into the "wait for desktop" empty state. NOT stamped on a
        // non-empty hydrate: that index may still hold stale orphans, and only a nuke
        // (or the Phase-3 subtractive hydrate) clears them — claiming current identity
        // there would mask them from the gate.
        if (wasEmpty && result.hydrated > 0) {
            const id = pluginIdentity();
            const m = await this.store.getMeta();
            await this.store.setMeta({
                ...m,
                modelId: m.modelId ?? MODEL_ID,
                chunkerVersion: id.chunkerVersion,
                analyzerVersion: id.analyzerVersion,
                revision: id.revision,
            });
        }
        // Inherit display calibration from the producer when this device has none
        // of its own (a hydrate-only iOS device that never full-reindexed). Only
        // fill when absent — a local full reindex's stats describe THIS index more
        // faithfully and must win. Invalidate the cached accessor so the next
        // search re-reads.
        if (result.bgMean != null && result.bgStd != null) {
            const m = await this.store.getMeta();
            if (m.bgMean == null) {
                await this.store.setMeta({ ...m, bgMean: result.bgMean, bgStd: result.bgStd });
                this.cacheManager.bgStatsGen = -1;
            }
        }
        return result;
    }

    // peerAhead + cache drop/warm AFTER the exclusive section (warm is off-mutex
    // by design). Shared by hydrateSidecar and rebuildFromSidecar.
    async afterHydrateExclusive(result: HydrateResult): Promise<HydrateResult> {
        this._peerAhead = result.peerAhead; // refresh the "newer index exists" signal per scan
        // A hydrate is a store mutation: drop caches so the next search rebuilds
        // against the restored index (mirrors reindex/delta completion).
        if (result.hydrated > 0) {
            this.cacheManager.invalidateBm25Cache();
            void this.cacheManager.warmCaches('hydrate');
            this.warnedStranded = false; // index is populated again — re-arm the empty-net warning
        } else {
            // Restored nothing — if the index is also empty, search will silently
            // return no results. Surface that (the net-is-gone case).
            await this.warnIfIndexStranded(result);
        }
        return result;
    }

    // Embed-free convergence: nuke this device's IDB, then hydrate it from the synced
    // sidecar. The mobile-safe counterpart to "Full reindex" — it loads the TOKENIZER
    // only (no 250 MB model, no WASM embed, no jetsam), so it rebuilds a clean index
    // in seconds instead of a hot multi-minute on-device embed.
    async rebuildFromSidecar(): Promise<HydrateResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const expect = expectationFor();
        const producers = await rankAcceptedProducers(this.app.vault.adapter, this.coord.dir!, expect);
        if (producers.length === 0) {
            return { scanned: 0, needed: 0, hydrated: 0, skippedPartialNotes: 0, refusedProducers: 0, acceptedProducers: 0, peerAhead: false, hydratedNotePaths: [] };
        }
        // Nuke + stamp + hydrate under ONE write mutex.
        const result = await this.coord.runExclusive(async () => {
            await this.store.clearAllStores();
            const id = pluginIdentity();
            await this.store.setMeta({
                embeddingDim: EMBEDDING_DIM,
                lastIndexedAt: null,
                schemaVersion: META_SCHEMA_VERSION,
                modelId: MODEL_ID,
                chunkerVersion: id.chunkerVersion,
                analyzerVersion: id.analyzerVersion,
                revision: id.revision,
            });
            return this.hydrateSidecarExclusive();
        });
        this.cacheManager.invalidateBm25Cache();
        return this.afterHydrateExclusive(result);
    }

    // Does ANY other device have a sidecar in the index dir, regardless of its identity?
    async peerSidecarPresent(): Promise<boolean> {
        if (!this.coord.sidecarOn()) return false;
        const ids = await listSidecarDeviceIds(this.app.vault.adapter, this.coord.dir!);
        return ids.some(id => id !== this.logger.deviceId);
    }

    // Referential-integrity sweep (Phase 3 steady-state GC): delete every chunk no
    // FILES record references — orphans from an overwritten file record or a missed delete event.
    async sweepOrphanChunks(opts: { shouldContinue?: () => boolean } = {}): Promise<{ removed: number; completed: boolean }> {
        const orphans = await this.coord.runExclusive(async () => {
            const allIds = await this.store.getAllChunkIds();
            const referenced = new Set<string>();
            for (const rec of await this.store.listFileRecords()) {
                for (const id of rec.chunk_ids) referenced.add(id);
            }
            return findOrphanChunkIds(allIds, referenced);
        });
        if (orphans.length === 0) return { removed: 0, completed: true };
        const BATCH = 500;
        let deleted = 0;
        let completed = true;
        for (let i = 0; i < orphans.length; i += BATCH) {
            if (opts.shouldContinue && !opts.shouldContinue()) { completed = false; break; }
            const batch = orphans.slice(i, i + BATCH);
            await this.coord.runExclusive(() => this.store.deleteChunksByIds(batch));
            deleted += batch.length;
        }
        if (deleted > 0) {
            this.cacheManager.invalidateBm25Cache();
            void this.cacheManager.warmCaches('orphan-sweep');
        }
        return { removed: deleted, completed };
    }

    // Dead-identity sidecar reap (Phase 3 §4): remove every other device's sidecar files
    // whose meta identity no longer matches this build.
    async reapDeadIdentitySidecars(): Promise<number> {
        if (!this.coord.sidecarOn()) return 0;
        const dir = this.coord.dir!;
        const adapter = this.app.vault.adapter;
        const expect = expectationFor();
        let reaped = 0;
        for (const dev of await listSidecarDeviceIds(adapter, dir)) {
            if (dev === this.logger.deviceId) continue; // never reap self
            if (metaAccepts(await readDeviceMeta(adapter, dir, dev), expect)) continue; // current peer — keep
            await clearDevice(adapter, dir, dev);
            reaped++;
        }
        return reaped;
    }

    // Post-recovery health check: rebuild frame + BM25 from IDB and assert coherence.
    async verifyCoherent(): Promise<boolean> {
        const frame = await this.cacheManager.ensureFrame();
        if (!frame) return true;
        await this.cacheManager.ensureBm25(frame.orderedChunks);
        if (!this.cacheManager.bm25Cache) return true;
        return frameBm25Coherent(frame, this.cacheManager.bm25Cache, true);
    }

    // Reconcile-signature storage key.
    private reconcileSigKey(): string {
        return `seek:reconcile-sig:${this.store.dbName}`;
    }

    private loadPersistedReconcileSig(): string | null {
        try {
            const v: unknown = this.app.loadLocalStorage(this.reconcileSigKey());
            return typeof v === 'string' ? v : null;
        } catch {
            return null;
        }
    }

    private persistReconcileSig(sig: string): void {
        this.lastReconcileSig = sig;
        try {
            this.app.saveLocalStorage(this.reconcileSigKey(), sig);
        } catch {
            // best-effort
        }
    }

    private async indexIsEmpty(): Promise<boolean> {
        try {
            return (await this.store.count()).files === 0;
        } catch {
            return true;
        }
    }

    async indexedChunkCount(): Promise<number | null> {
        try {
            return (await this.store.count()).chunks;
        } catch {
            return null;
        }
    }

    async reconcileSidecarIfChanged(): Promise<HydrateResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const sig = await sidecarDirSignature(this.app.vault.adapter, this.coord.dir!, this.logger.deviceId);
        const prev = this.lastReconcileSig ?? this.loadPersistedReconcileSig();
        if (!shouldReconcileSidecar(sig, prev, await this.indexIsEmpty())) {
            this._peerAhead = await probePeerAhead(this.app.vault.adapter, this.coord.dir!, expectationFor());
            return null;
        }
        const result = await this.hydrateSidecar();
        this.persistReconcileSig(sig);
        return result;
    }

    async compactOwnSidecar(): Promise<CompactResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const adapter = this.app.vault.adapter;
        const dir = this.coord.dir!;
        const dev = this.logger.deviceId;

        const ownMeta = await readDeviceMeta(adapter, dir, dev);
        if (staleSidecarFormat(ownMeta)) {
            const preWipe = await listDeviceShards(adapter, dir, dev);
            const bytesBefore = preWipe.reduce((sum, s) => sum + s.size, 0);
            await clearDevice(adapter, dir, dev, { preserveSeqFloor: true });
            this.forensics?.beat('sidecar-compact', {
                reason: 'format-mismatch',
                shardsBefore: preWipe.length,
                shardsAfter: 0,
                bytesBefore,
                bytesAfter: 0,
            });
            return {
                compacted: false,
                reason: 'format-mismatch',
                recordsBefore: 0,
                recordsAfter: 0,
                bytesBefore,
                bytesAfter: 0,
                shed: 0,
                shardsBefore: preWipe.length,
                shardsAfter: 0,
            };
        }

        const floor = isMobilePlatform() ? 4 * 1024 * 1024 : 2 * 1024 * 1024;
        const result = await compactDevice(
            adapter,
            dir,
            dev,
            () => this.collectLiveIds(),
            { minDeadRatio: 0.5, minShardBytes: floor },
        );
        this.forensics?.beat('sidecar-compact', {
            reason: result.reason ?? 'none',
            shardsBefore: result.shardsBefore,
            shardsAfter: result.shardsAfter,
            bytesBefore: result.bytesBefore,
            bytesAfter: result.bytesAfter,
        });
        if (result.compacted) {
            try {
                this.persistReconcileSig(await sidecarDirSignature(adapter, dir, dev));
            } catch (e) {
                await this.logger.appendError('compact-sig-refresh', e);
            }
        }
        return result;
    }

    async coalesceOwnSidecar(): Promise<CoalesceResult | null> {
        if (!this.coord.sidecarOn()) return null;
        const adapter = this.app.vault.adapter;
        const dir = this.coord.dir!;
        const dev = this.logger.deviceId;
        if (staleSidecarFormat(await readDeviceMeta(adapter, dir, dev))) return null;
        const result = await coalesceSmallShards(adapter, dir, dev);
        if (result.coalesced) {
            this.forensics?.beat('sidecar-coalesce', {
                smallShards: result.smallShards,
                shardsBefore: result.shardsBefore,
                shardsAfter: result.shardsAfter,
                bytesMoved: result.bytesMoved,
                shed: result.shed,
                skippedLines: result.skippedLines,
            });
            try {
                this.persistReconcileSig(await sidecarDirSignature(adapter, dir, dev));
            } catch (e) {
                await this.logger.appendError('coalesce-sig-refresh', e);
            }
        }
        return result;
    }

    private async reChunkOneLiveFile(
        f: TFile,
        countTokens: (texts: string[]) => Promise<number[]>,
        logLabel = 'reChunkLive',
    ): Promise<{ note: ReChunkedNote | null; skipped: boolean; abortWalk: boolean }> {
        let content: string;
        try {
            content = await this.app.vault.cachedRead(f);
        } catch {
            return { note: null, skipped: true, abortWalk: false };
        }
        let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
        if (chunks.length === 0) return { note: null, skipped: false, abortWalk: false };
        try {
            chunks = (await enforceTokenBudget(chunks, countTokens)).chunks;
        } catch (e) {
            await this.logger.appendError(`${logLabel}-tokenBudget:${f.path}`, e);
            const abortWalk = e instanceof Error && /Neither model nor tokenizer loaded/i.test(e.message);
            return { note: null, skipped: true, abortWalk };
        }
        if (chunks.length === 0) return { note: null, skipped: false, abortWalk: false };
        return {
            note: { notePath: f.path, mtimeMs: f.stat.mtime, chunks, contentHash: cyrb53Hex(content) },
            skipped: false,
            abortWalk: false,
        };
    }

    async reChunkLive(): Promise<ReChunkedNote[]> {
        const t0 = performance.now();
        await this.embedder.ensureTokenizer();
        const out: ReChunkedNote[] = [];
        let filesWalked = 0;
        let filesSkipped = 0;
        let tokenCountsRpc = 0;
        let complete = true;
        let sinceYield = 0;
        const files = this.indexableFiles().filter(f => this.shouldIndex(f.path));
        for (let i = 0; i < files.length; i += TOKEN_COUNTS_BATCH) {
            if (++sinceYield >= 8) { sinceYield = 0; await cheapYield(); }
            const batch = files.slice(i, i + TOKEN_COUNTS_BATCH);
            const batcher = createBatchedTokenCounter(ts => this.embedder.tokenCounts(ts));
            const results = await Promise.all(
                batch.map(f => {
                    filesWalked++;
                    return this.reChunkOneLiveFile(f, batcher.countTokens);
                }),
            );
            await batcher.flush();
            tokenCountsRpc += batcher.getRpcCount();
            for (const r of results) {
                if (r.skipped) filesSkipped++;
                if (r.note) out.push(r.note);
                if (r.abortWalk) {
                    complete = false;
                    break;
                }
            }
            if (!complete) break;
        }
        void this.logger.append({
            type: 'rechunk-live',
            timestamp: new Date().toISOString(),
            filesWalked,
            filesSkipped,
            tokenCountsRpc,
            durationMs: Math.round(performance.now() - t0),
            complete,
        }).catch(() => {});
        return out;
    }

    async reChunkLiveSubset(
        files: Array<{ path: string; mtimeMs: number }>,
        shouldStop?: () => boolean,
    ): Promise<ReChunkedNote[]> {
        const t0 = performance.now();
        await this.embedder.ensureTokenizer();
        const out: ReChunkedNote[] = [];
        let filesWalked = 0;
        let filesSkipped = 0;
        let tokenCountsRpc = 0;
        let complete = true;
        let sinceYield = 0;
        for (let i = 0; i < files.length; i += TOKEN_COUNTS_BATCH) {
            if (shouldStop?.()) {
                complete = false;
                break;
            }
            if (++sinceYield >= 8) { sinceYield = 0; await cheapYield(); }
            const batch = files.slice(i, i + TOKEN_COUNTS_BATCH);
            const batcher = createBatchedTokenCounter(ts => this.embedder.tokenCounts(ts));
            const results = await Promise.all(batch.map(async ref => {
                if (shouldStop?.()) return { note: null as ReChunkedNote | null, skipped: false, abortWalk: false, stopped: true };
                const f = this.app.vault.getAbstractFileByPath(ref.path);
                if (!(f instanceof TFile)) return { note: null, skipped: false, abortWalk: false, stopped: false };
                filesWalked++;
                const r = await this.reChunkOneLiveFile(f, batcher.countTokens, 'reChunkLiveSubset');
                return { ...r, stopped: false };
            }));
            await batcher.flush();
            tokenCountsRpc += batcher.getRpcCount();
            for (const r of results) {
                if (r.stopped) {
                    complete = false;
                    break;
                }
                if (r.skipped) filesSkipped++;
                if (r.note) out.push(r.note);
                if (r.abortWalk) {
                    complete = false;
                    break;
                }
            }
            if (!complete) break;
            if (shouldStop?.()) {
                complete = false;
                break;
            }
        }
        void this.logger.append({
            type: 'rechunk-live',
            timestamp: new Date().toISOString(),
            filesWalked,
            filesSkipped,
            tokenCountsRpc,
            durationMs: Math.round(performance.now() - t0),
            complete,
            subset: true,
            filesInTier: files.length,
        }).catch(() => {});
        return out;
    }

    listHydrateFilesSorted(): Array<{ path: string; mtimeMs: number }> {
        return this.indexableFiles()
            .filter(f => this.shouldIndex(f.path))
            .map(f => ({ path: f.path, mtimeMs: f.stat.mtime }))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    }

    async listHydrateFilesForGreedy(): Promise<Array<{ path: string; mtimeMs: number }>> {
        for (let i = 0; i < 40; i++) {
            const files = this.listHydrateFilesSorted();
            if (files.length > 0) return files;
            await new Promise(r => setTimeout(r, 50));
        }
        return this.listHydrateFilesSorted();
    }

    async collectLiveIds(): Promise<{ ids: Set<string>; complete: boolean }> {
        const ids = new Set<string>();
        try {
            await this.embedder.ensureTokenizer();
        } catch (e) {
            await this.logger.appendError('collectLiveIds-ensureTokenizer', e);
            return { ids, complete: false };
        }
        let complete = true;
        let sinceYield = 0;
        for (const f of this.indexableFiles().filter(f => this.shouldIndex(f.path))) {
            if (++sinceYield >= 8) { sinceYield = 0; await cheapYield(); }
            let content: string;
            try {
                content = await this.app.vault.cachedRead(f);
            } catch (e) {
                complete = false;
                await this.logger.appendError(`collectLiveIds-read:${f.path}`, e);
                continue;
            }
            let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
            if (chunks.length === 0) continue;
            try {
                chunks = (await enforceTokenBudget(chunks, ts => this.embedder.tokenCounts(ts))).chunks;
            } catch (e) {
                complete = false;
                await this.logger.appendError(`collectLiveIds-tokenBudget:${f.path}`, e);
                if (e instanceof Error && /Neither model nor tokenizer loaded/i.test(e.message)) {
                    return { ids, complete: false };
                }
                continue;
            }
            for (const c of chunks) ids.add(c.chunk_id);
        }
        return { ids, complete };
    }

    warnRefusedProducer(dev: string, meta: SidecarMeta | null, expect: MetaExpectation): void {
        const reason = !meta
            ? 'missing/unreadable meta'
            : [
                  meta.format !== SIDECAR_FORMAT ? `format ${meta.format}≠${SIDECAR_FORMAT}` : '',
                  meta.modelId !== expect.modelId ? `model ${meta.modelId}≠${expect.modelId}` : '',
                  meta.chunkerVersion !== expect.chunkerVersion ? `chunker v${meta.chunkerVersion}≠v${expect.chunkerVersion}` : '',
                  meta.dim !== expect.dim ? `dim ${meta.dim}≠${expect.dim}` : '',
              ]
                  .filter(Boolean)
                  .join(', ');
        const key = `${dev}:${reason}`;
        if (this.warnedRefusals.has(key)) return;
        this.warnedRefusals.add(key);
        console.warn(`[seek] skipping sidecar producer ${dev} (${reason}) — its index predates this device; will hydrate once that device re-embeds`);
        void this.logger.append({ type: 'sidecar-hydrate', timestamp: new Date().toISOString(), phase: 'version-gate-refused', device: dev, reason }).catch(() => {});
    }

    async warnIfIndexStranded(result: HydrateResult): Promise<void> {
        if (this.warnedStranded) return;
        const { chunks } = await this.store.count();
        if (chunks > 0) return;
        this.warnedStranded = true;
        const cause =
            result.refusedProducers > 0
                ? `all ${result.refusedProducers} sidecar producer(s) were version-refused — the other device's plugin/model is out of date`
                : result.skippedPartialNotes > 0
                  ? `sidecar files are still arriving (${result.skippedPartialNotes} note(s) only partially synced)`
                  : result.acceptedProducers === 0
                    ? 'no sidecar index files were found here — deleted, or no other device has synced its index to this folder yet'
                    : 'the sidecar held nothing this device could reproduce';
        console.error(
            `[seek] index is EMPTY and the sidecar restored nothing — search will return no results. ` +
                `Cause: ${cause}. Fix: run a full reindex on this device, or let another device's sidecar sync in.`,
        );
        void this.logger
            .append({
                type: 'sidecar-hydrate',
                timestamp: new Date().toISOString(),
                phase: 'index-stranded',
                cause,
                refusedProducers: result.refusedProducers,
                acceptedProducers: result.acceptedProducers,
                skippedPartialNotes: result.skippedPartialNotes,
            })
            .catch(() => {});
    }

    hydrateDeps(reChunk: () => Promise<ReChunkedNote[]>, addsSink?: DeltaAdd[]): HydrateDeps {
        return {
            adapter: this.app.vault.adapter,
            indexDir: this.coord.dir!,
            expect: expectationFor(),
            reChunk,
            existingIds: async () => new Set((await this.store.listAllMeta()).map(c => c.chunk_id)),
            putQuantized: async (chunks, tiers) => {
                await this.store.putBatchQuantized(chunks, tiers);
                if (addsSink) pushDeltaAdds(addsSink, chunks, tiers);
            },
            putFileRecord: rec => this.store.putFileRecord(rec),
            onRefusedProducer: (dev, meta, expect) => this.warnRefusedProducer(dev, meta, expect),
            log: (msg, detail) => {
                const flat: Record<string, string | number | boolean | null> = {};
                if (detail && typeof detail === 'object') {
                    for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
                        if (Array.isArray(v)) flat[`${k}Count`] = v.length;
                        else if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v ?? null;
                        else flat[k] = String(v);
                    }
                }
                void this.logger.append({ type: 'sidecar-hydrate', timestamp: new Date().toISOString(), phase: msg, ...flat }).catch(() => {});
            },
        };
    }

    hydrateDepsGreedy(addsSink?: DeltaAdd[]): HydrateDeps {
        const base = this.hydrateDeps(() => this.reChunkLive(), addsSink);
        return {
            ...base,
            greedyHydrate: true,
            listHydrateFiles: () => this.listHydrateFilesForGreedy(),
            ensureTokenizer: () => this.embedder.ensureTokenizer(),
            reChunkSubset: (files, shouldStop) => this.reChunkLiveSubset(files, shouldStop),
            onGoodEnough: () => {
                this.cacheManager.invalidateBm25Cache();
                this.onGoodEnough?.();
            },
            log: (msg, detail) => {
                const flat: Record<string, string | number | boolean | null> = {};
                if (detail && typeof detail === 'object') {
                    for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
                        if (Array.isArray(v)) flat[`${k}Count`] = v.length;
                        else if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v ?? null;
                        else flat[k] = String(v);
                    }
                }
                const ts = new Date().toISOString();
                if (msg === 'sidecar-hydrate-tier') {
                    void this.logger.append({ type: 'sidecar-hydrate-tier', timestamp: ts, ...flat } as import('./types').SidecarHydrateTierEntry).catch(() => {});
                } else if (msg === 'sidecar-hydrate-greedy') {
                    void this.logger.append({ type: 'sidecar-hydrate-greedy', timestamp: ts, ...flat } as import('./types').SidecarHydrateGreedyEntry).catch(() => {});
                } else {
                    void this.logger.append({ type: 'sidecar-hydrate', timestamp: ts, phase: msg, ...flat }).catch(() => {});
                }
            },
        };
    }

    async dedupViaSidecar(
        files: TFile[],
        addsSink?: DeltaAdd[],
        removedSink?: string[],
        removedBodiesSink?: Map<string, string>,
        metaPatchSink?: Array<{ id: string; meta: ChunkMeta }>,
    ): Promise<TFile[]> {
        if (!this.coord.sidecarOn() || files.length === 0) return files;
        await this.embedder.ensureTokenizer();
        const notes: ReChunkedNote[] = [];
        for (const f of files) {
            let content: string;
            try {
                content = await this.app.vault.cachedRead(f);
            } catch {
                continue;
            }
            let chunks = this.chunksFor(content, f.path, new Date(f.stat.mtime).toISOString());
            if (chunks.length === 0) continue;
            try {
                chunks = (await enforceTokenBudget(chunks, ts => this.embedder.tokenCounts(ts))).chunks;
            } catch (e) {
                await this.logger.appendError(`dedupViaSidecar-tokenBudget:${f.path}`, e);
                continue;
            }
            if (chunks.length > 0) notes.push({ notePath: f.path, mtimeMs: f.stat.mtime, chunks, contentHash: cyrb53Hex(content) });
        }
        if (notes.length === 0) return files;

        const oldRecs = new Map<string, FileRecord>();
        const oldStableMetas = new Map<string, ChunkMeta>();
        for (const n of notes) {
            const rec = await this.store.getFileRecord(n.notePath).catch(() => null);
            if (!rec) continue;
            oldRecs.set(n.notePath, rec);
            const newIdSet = new Set(n.chunks.map(c => c.chunk_id));
            const stableIds = rec.chunk_ids.filter(id => newIdSet.has(id));
            if (stableIds.length > 0) {
                try {
                    for (const [id, m] of await this.store.getChunkMetasByIds(stableIds)) oldStableMetas.set(id, m);
                } catch {
                    // ignore
                }
            }
        }
        const res = await hydrateFromSidecar(this.hydrateDeps(async () => notes, addsSink));
        this._peerAhead = res.peerAhead;
        const done = new Set(res.hydratedNotePaths);

        const newChunksByPath = new Map(notes.map(n => [n.notePath, n.chunks]));
        for (const p of res.hydratedNotePaths) {
            const rec = oldRecs.get(p);
            const newChunks = newChunksByPath.get(p);
            if (!rec || !newChunks) continue;
            const newIdSet = new Set(newChunks.map(c => c.chunk_id));
            const stale = rec.chunk_ids.filter(id => !newIdSet.has(id));
            try {
                if (stale.length > 0) {
                    if (removedBodiesSink) {
                        for (const [id, body] of await this.store.getBodiesMap(stale)) removedBodiesSink.set(id, body);
                        const missingBodies = stale.filter(id => !removedBodiesSink.has(id));
                        if (missingBodies.length > 0) {
                            throw new Error(`sidecar stale bodies missing (${missingBodies.length})`);
                        }
                    }
                    await this.store.deleteChunksByIds(stale);
                    removedSink?.push(...stale);
                }
                for (const c of newChunks) {
                    const old = oldStableMetas.get(c.chunk_id);
                    if (!old) continue;
                    const next = stripContent(c);
                    if (chunkMetaEqual(old, next)) continue;
                    if (MultiFieldBM25.docFieldsEqual(old, next)) {
                        metaPatchSink?.push({ id: c.chunk_id, meta: next });
                    } else if (removedSink && removedBodiesSink) {
                        removedBodiesSink.set(c.chunk_id, c.content ?? '');
                        removedSink.push(c.chunk_id);
                    }
                }
            } catch (e) {
                await this.logger.appendError(`sidecarDedup-stale-cleanup:${p}`, e);
            }
        }
        return files.filter(f => !done.has(f.path));
    }
}
