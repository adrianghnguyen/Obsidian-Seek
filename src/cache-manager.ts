// CacheManager — owns in-memory caches for the search path: the resident
// frame (corpus text + binary index), the BM25 lexical index, the synonym
// dictionary, and the dense-background stats. Instantiated by
// SearchOrchestrator, which delegates all cache operations to it.

import type { App } from 'obsidian';
import type { ChunkMeta, ScoredChunk, SeekSettings } from './types';
import { MultiFieldBM25, DEFAULT_FIELD_BOOSTS } from './bm25';
import { buildSynonymMap, type SynonymMap } from './synonyms';
import { IndexStore } from './index-store';
import { IndexCoordinator } from './index-coordinator';
import { LocalEmbedder } from './embedder';
import { SeekLogger } from './logger';
import { Forensics } from './forensics';
import { concatPacked } from './binary';
import { selectTopNIndices } from './select';
import { BinaryScorerWorker } from './binary-scorer';
import type { QuantVec } from './quant';
import { buildBm25Stamp, bm25StampMatches } from './bm25-persist';
import { gzipString, gunzipToString, gzipAvailable } from './gzip';
import { isMobilePlatform, residentInt8Enabled } from './platform';
import { TaskContextTracker } from './task-context';
import { bm25PathFor, writeBytesAtomic, ensureDir } from './sidecar';
import { expectationFor } from './sidecar-meta';
import { rankAcceptedProducers } from './sidecar-sync';
import { ResidentFrame, shouldDiscardPartialFrame, buildResidentRerankBlock } from './frame-utils';
import { frameBm25Coherent } from './coherence';
import { cheapYield } from './pacer';
import { recencyDate } from './fusion';

export class CacheManager {
	// Binary index cache (binary.ts:concatPacked): the packed sign-bit
	// representation of every corpus vector, aligned by row. Built once per
	// dataGeneration, then cached in memory.
	binaryIndex: {
		ids: string[];
		packed: Uint8Array;
		bytesPerVec: number;
		generation: number;
	} | null = null;

	// Resident unified frame: the corpus in binary-index order (orphans
	// dropped) plus its aligned packed-binary buffer.
	frameCache: ResidentFrame | null = null;

	// Corpus dense-cosine background (dense-stats.ts), cached by dataGeneration.
	bgStatsCache: { mean: number; std: number } | null = null;
	bgStatsGen = -1;

	// BM25 cache and its validity metadata.
	bm25Cache: MultiFieldBM25 | null = null;
	bm25CacheGeneration = -1;
	bm25CacheChunkCount = -1;
	bm25CacheProps = false;
	bm25CacheHeadings = false;

	// Alias-dictionary synonym map (synonyms.ts).
	synonymCache: SynonymMap | null = null;

	// Throttled embed-free re-persist of the resident BM25 blob.
	lastBm25PersistMs = Number.NEGATIVE_INFINITY;
	static readonly BM25_PERSIST_THROTTLE_MS = 30_000;
	pendingPersistIdle: number | null = null;

	/** True while warmCaches is rebuilding frame/BM25 (observable boot gate). */
	warming = false;
	/** When true, background warm triggers no-op (catch-up owns IDB). */
	warmDeferred = false;
	/** In-flight warmCaches promise — concurrent callers await instead of no-op. */
	warmPromise: Promise<void> | null = null;

	/** True when the orchestrator is being torn down (stops idle persists). */
	disposed = false;

	constructor(
		private store: IndexStore,
		private coord: IndexCoordinator,
		private embedder: LocalEmbedder,
		private settings: SeekSettings,
		private app: App,
		private forensics: Forensics | null,
		private logger: SeekLogger,
		private taskCtx: TaskContextTracker | null,
	) {}

	setWarmDeferred(deferred: boolean): void { this.warmDeferred = deferred; }

	// ── Public API ───────────────────────────────────────────────────────

	/** True while warmCaches is rebuilding frame/BM25 (observable boot gate). */
	isWarmingCaches(): boolean {
		return this.warming;
	}

	/** Join startup/pre-catchup warm if already in flight (avoids parallel ensureFrame). */
	async awaitWarmCachesIfInFlight(): Promise<void> {
		if (this.warmPromise) await this.warmPromise;
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

	// Despite the name, invalidates BOTH the BM25 cache AND the resident
	// binary index — they share `dataGeneration` as the source of truth, so
	// bumping it forces both to reload on the next search.
	invalidateBm25Cache(): void {
		this.bm25Cache = null;
		this.bm25CacheGeneration = -1;
		this.bm25CacheChunkCount = -1;
		this.synonymCache = null;
		this.binaryIndex = null;
		this.frameCache = null;
		this.coord.bumpGeneration();
	}

	/** True when the BM25 cache is populated for the live generation (can serve lexical-only searches). */
	hasBm25Cache(): boolean {
		return this.bm25Cache !== null && this.bm25CacheGeneration === this.coord.generation && this.bm25CacheChunkCount > 0;
	}

	// Post-eviction / fresh-process boot: rebuild the resident frame from IDB and
	// load the persisted BM25 blob BEFORE reconcileOnLoad's first delta.
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

	// Ensure the resident frame is built and matches dataGeneration. Returns
	// the frame, or null if there's no usable index (empty vault / no binary
	// backfill yet).
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
		this.frameCache = {
			orderedChunks, orderedIds, activePacked, bytesPerVec,
			residentInt8: resident ? resident.int8 : null,
			residentScales: resident ? resident.scales : null,
			embDim: resident ? resident.embDim : 0,
			validRows: new Array<boolean>(orderedChunks.length).fill(true),
			tombstoneCount: 0,
			generation: buildGeneration,
		};
		return this.frameCache;
	}

	async ensureBm25(orderedChunks: ChunkMeta[]): Promise<boolean> {
		let hit = this.bm25CacheValid(orderedChunks);
		if (!hit) {
			if (this.warmPromise && !this.warming) {
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

	/** True if the resident BM25 cache matches the live generation + index shape. */
	bm25CacheValid(orderedChunks: ChunkMeta[]): boolean {
		return !!(
			this.bm25Cache &&
			this.bm25CacheGeneration === this.coord.generation &&
			this.bm25CacheChunkCount === orderedChunks.length &&
			this.bm25CacheProps === this.settings.searchableProperties &&
			this.bm25CacheHeadings === (this.settings.headingsField || this.settings.boostedBm25)
		);
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

	// Persist the warmed BM25 index so the next cold start can skip fit().
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

	// Producer side of the cross-device BM25 artifact (Phase 3).
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

	/** Throttled embed-free re-persist of the resident BM25 blob. */
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

	// Frame-lite hydration: results are spread from metadata-only frame rows, so
	// their `content` is the '' placeholder. Fetch the ≤topK bodies from chunk_body
	// and assign them.
	async hydrateBodies(results: ScoredChunk[]): Promise<void> {
		if (results.length === 0) return;
		const bodies = await this.store.getBodiesByIds(results.map(r => r.chunk_id));
		for (let i = 0; i < results.length; i++) results[i].content = bodies[i] ?? '';
	}

	/** Pick top-K chunks by recency descending. */
	topByRecency(chunks: ChunkMeta[], k: number, mask?: boolean[] | null): number[] {
		const n = chunks.length;
		const dates = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			if (mask && !mask[i]) { dates[i] = NaN; continue; }
			const raw = recencyDate(chunks[i], this.settings.recencyKey, this.settings.createdProp);
			const t = raw ? Date.parse(raw) : NaN;
			dates[i] = Number.isFinite(t) ? t : NaN;
		}
		return selectTopNIndices(n, k, i => dates[i], i => !Number.isNaN(dates[i]));
	}

	/** Corpus dense-cosine background stats, cached by dataGeneration. */
	async getDenseBgStats(): Promise<{ mean: number; std: number } | null> {
		if (this.bgStatsGen === this.coord.generation) return this.bgStatsCache;
		const m = await this.store.getMeta();
		this.bgStatsCache = (m.bgMean != null && m.bgStd != null && m.bgStd > 0)
			? { mean: m.bgMean, std: m.bgStd }
			: null;
		this.bgStatsGen = this.coord.generation;
		return this.bgStatsCache;
	}

	/** BM25 per-field boosts. */
	bm25FieldBoosts(): Record<string, number> {
		if (!this.settings.boostedBm25) return DEFAULT_FIELD_BOOSTS;
		return { ...DEFAULT_FIELD_BOOSTS, aliases: 9.0, tags: 2.0, headings: 4.0 };
	}

	// ── Private helpers ──────────────────────────────────────────────────

	/** Stamp the resident BM25 cache after (re)building it. Public so applyDelta (SearchOrchestrator) can re-stamp a patched cache. */
	stampBm25Cache(chunkCount: number): void {
		this.bm25CacheGeneration = this.coord.generation;
		this.bm25CacheChunkCount = chunkCount;
		this.bm25CacheProps = this.settings.searchableProperties;
		this.bm25CacheHeadings = this.settings.headingsField || this.settings.boostedBm25;
		this.synonymCache = null;
	}

	// Ensure the resident binary index is loaded and matches dataGeneration.
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

	private async runWarmCaches(trigger: string): Promise<void> {
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
					await this.ensureBm25(frame.orderedChunks);
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
}