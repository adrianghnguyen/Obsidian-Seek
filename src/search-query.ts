// SearchQuery — handles search(), searchLexicalOnly(), and telemetry for the
// two-stage search path. Instantiated by SearchOrchestrator, which delegates
// all query operations to it.

import type { App } from 'obsidian';
import type { ChunkMeta, ScoredChunk, SearchEntry, SearchPartial, QueryFilters, FilterContext, SeekSettings, MemorySnapshot } from './types';
import { MultiFieldBM25, DEFAULT_FIELD_BOOSTS, PREFIX_LAST_TOKEN, FUZZY_BY_LENGTH, ANALYZER_VERSION, BM25_COVERAGE_POW } from './bm25';
import { buildSynonymMap, SYNONYM_WEIGHT, type SynonymMap } from './synonyms';
import { rank, cosineScores, DEFAULT_RANKING_CONFIG } from './ranker';
import { browseOrder } from './fusion';
import { collectNameHits, shouldEarlyPaint } from './name-match';
import { IndexStore } from './index-store';
import { IndexCoordinator } from './index-coordinator';
import { LocalEmbedder } from './embedder';
import { SeekLogger } from './logger';
import { Forensics } from './forensics';
import { selectTopNIndices } from './select';
import { poolCaps, POOL_FLOORS } from './pool';
import { BinaryScorerWorker, binaryCandidatesAsync } from './binary-scorer';
import { dequantizeInt8 } from './quant';
import { calibratedConfidence } from './dense-stats';
import { parseQuery, compileMatcher, excludedNotePaths } from './query-parser';
import { makeSnippet, SNIPPET_PREVIEW_LIMITS } from './snippet';
import { buildPassageTerms } from './passage';
import { topNIndices, concatPacked } from './binary';
import { ResidentFrame, DeltaAdd, alignCandidate, buildSelectionMask, shouldDiscardPartialFrame, freshDeltaAdds, appendFrameRows, tombstoneFrameRows, buildResidentRerankBlock } from './frame-utils';
import { frameBm25Coherent, COHERENCE_SAMPLES } from './coherence';
import { buildBm25Stamp, bm25StampMatches } from './bm25-persist';
import { cheapYield } from './pacer';
import { cleanDenseText } from './dense-clean';
import { isMobilePlatform, residentInt8Enabled } from './platform';
import { LEGACY_ENGLISH_MODEL_ID, EMBEDDING_DIM } from './embedder';
import { gzipString, gunzipToString, gzipAvailable } from './gzip';
import { enumerateNumberPropertyNames } from './prop-types';
import { CacheManager } from './cache-manager';
import { seekPerf } from './perf-console';

// Per-call recency override for search() — the seek:search CLI's
// recencyWeight/recencyHalflife params (main.ts). Either field may be absent
// (only one of the two CLI params given); absent means "use this.settings
// for that field".
export interface RecencyOverride {
	epsilon?: number;
	halfLifeDays?: number;
}

export class SearchQuery {
	constructor(
		private app: App,
		private store: IndexStore,
		private embedder: LocalEmbedder,
		private logger: SeekLogger,
		private settings: SeekSettings,
		private forensics: Forensics | null,
		private cacheManager: CacheManager,
		private binaryWorker: BinaryScorerWorker,
		private coord: IndexCoordinator,
		private onCoherenceDrift: (where: string) => void,
	) {}

	// ── Public API ───────────────────────────────────────────────────────

	// Search path (two-stage, v7+):
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
	// recencyOverride: the seek:search CLI's per-query recencyWeight/
	// recencyHalflife params (see main.ts). Resolved locally into filterCtx/
	// rankConfig below — deliberately NEVER written into this.settings.
	async search(
		query: string,
		topK = 10,
		recencyOverride?: RecencyOverride,
		onPartial?: (partial: SearchPartial) => void | Promise<void>,
		signal?: AbortSignal,
	): Promise<{ results: ScoredChunk[]; entry: SearchEntry }> {
		const throwIfAborted = (): void => {
			if (signal?.aborted) {
				throw Object.assign(new Error('Query superseded'), { name: 'AbortError', code: 'ABORTED' });
			}
		};
		throwIfAborted();
		const t0 = performance.now();
		const searchId = `${Date.now()}-${query.slice(0, 20)}`;

		const filterCtx = this.buildFilterContext(recencyOverride);
		const { cleanedQuery, filters } = parseQuery(query, filterCtx);

		// ---- S0: resident-tier read ------------------------------------
		const idbStart = performance.now();
		const frameWasCached = !!(this.cacheManager.frameCache && this.cacheManager.frameCache.generation === this.coord.generation);
		const frame = await this.cacheManager.ensureFrame();
		const idbReadMs = performance.now() - idbStart;
		throwIfAborted();
		const binaryCacheHitFlag = frameWasCached;

		if (!frame) {
			const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
			await this.appendSearchTelemetry(entry);
			return { results: [], entry };
		}

		const orderedChunks = frame.orderedChunks;
		const orderedIds = frame.orderedIds;
		const activePacked = frame.activePacked;
		const bytesPerVec = frame.bytesPerVec;
		const residentInt8 = frame.residentInt8;
		const residentScales = frame.residentScales;
		const embDim = frame.embDim;
		const frameGen = frame.generation;

		// ---- Corpus-scaled candidate-pool caps --------------------------
		const liveN = orderedChunks.length - frame.tombstoneCount;
		const caps = poolCaps(liveN);

		// ---- Inline-filter pre-filter (match-mask) ---------------------
		const matcher = filters ? compileMatcher(filters, filterCtx) : null;
		let mask = buildSelectionMask(orderedChunks, frame.validRows, frame.tombstoneCount, matcher);

		if (filters?.exclude && filters.exclude.length > 0) {
			const bodyMap = await this.store.getBodiesMap(orderedIds);
			const excludedNotes = excludedNotePaths(orderedChunks, filters.exclude, id => bodyMap.get(id));
			if (excludedNotes.size > 0) {
				if (!mask) mask = new Array<boolean>(orderedChunks.length).fill(true);
				for (let i = 0; i < orderedChunks.length; i++) {
					if (mask[i] && excludedNotes.has(orderedChunks[i].note_path ?? '')) {
						mask[i] = false;
					}
				}
			}
		}

		// ---- Filter-only fast path ------------------------------------
		if (cleanedQuery === '') {
			const matchedChunks: ChunkMeta[] = [];
			for (let i = 0; i < orderedChunks.length; i++) {
				if (!mask || mask[i]) matchedChunks.push(orderedChunks[i]);
			}
			const seenPaths = new Set<string>();
			const results: ScoredChunk[] = [];
			for (const c of browseOrder(matchedChunks, this.settings.recencyKey, this.settings.createdProp)) {
				if (seenPaths.has(c.note_path)) continue;
				seenPaths.add(c.note_path);
				results.push({
					...c,
					content: '',
					score: 0,
					ranking_signals: { dense: 0, bm25: 0, hybrid: 0, recency: 0, title_boost: 0, denseRaw: 0 },
				});
				if (results.length >= topK) break;
			}
			await this.cacheManager.hydrateBodies(results);
			const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
			for (const r of results) r.snippet = makeSnippet(r.content, [], snippetChars);
			const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
			entry.totalChunks = orderedChunks.length;
			entry.candidateUnionSize = matchedChunks.length;
			entry.recencyCount = matchedChunks.length;
			await this.appendSearchTelemetry(entry);
			return { results, entry };
		}

		// ---- S0.5: query embedding (overlapped with name + BM25) --------
		const qStart = performance.now();
		type EmbedOk = { ok: true; vector: Float32Array; iframeLatencyMs: number; queryEmbedMs: number };
		type EmbedFail = { ok: false; reason: 'nonfinite' | 'dim'; dim: number; iframeLatencyMs: number; queryEmbedMs: number };
		let binaryStart = 0;
		let binaryPromise: Promise<number[]> | null = null;
		const embedPromise: Promise<EmbedOk | EmbedFail> = this.embedder.embed(cleanDenseText(cleanedQuery), signal).then(embedded => {
			const queryEmbedMs = performance.now() - qStart;
			const queryVec = embedded.vector;
			if (!queryVec.every(Number.isFinite)) {
				return { ok: false, reason: 'nonfinite' as const, dim: queryVec.length, iframeLatencyMs: embedded.iframeLatencyMs, queryEmbedMs };
			}
			if (bytesPerVec !== ((queryVec.length + 7) >> 3)) {
				return { ok: false, reason: 'dim' as const, dim: queryVec.length, iframeLatencyMs: embedded.iframeLatencyMs, queryEmbedMs };
			}
			binaryStart = performance.now();
			binaryPromise = binaryCandidatesAsync(
				this.binaryWorker, frameGen, queryVec, activePacked,
				orderedChunks.length, bytesPerVec, caps.binary, mask ?? null,
			);
			return { ok: true, vector: queryVec, iframeLatencyMs: embedded.iframeLatencyMs, queryEmbedMs };
		});

		// ---- S0.6: name prefilter (early paint) -------------------------
		const nameStart = performance.now();
		const nameHits = collectNameHits(orderedChunks, cleanedQuery, mask);
		const nameMatchMs = performance.now() - nameStart;
		let nameEarlyPainted = false;
		let namePartialMs = 0;
		if (onPartial && shouldEarlyPaint(nameHits)) {
			const titleBoost = this.settings.navTitleBoost;
			const early: ScoredChunk[] = nameHits.slice(0, topK).map(h => {
				const c = orderedChunks[h.index];
				return {
					...c,
					content: '',
					score: h.score,
					ranking_signals: {
						dense: 0, bm25: 0, hybrid: 0, recency: 0,
						title_boost: titleBoost * h.score,
						denseRaw: 0,
					},
					lexicalOnly: true,
				};
			});
			await this.cacheManager.hydrateBodies(early);
			const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
			const passageTerms = buildPassageTerms(cleanedQuery, () => 0);
			for (const r of early) r.snippet = makeSnippet(r.content, passageTerms, snippetChars);
			namePartialMs = performance.now() - t0;
			nameEarlyPainted = true;
			await onPartial({
				results: early,
				source: 'name',
				nameHitCount: nameHits.length,
				cleanedQuery,
			});
			await cheapYield();
		}

		// ---- S1b: BM25 candidate-gen (cached) ---------------------------
		const bm25Start = performance.now();
		if (!this.cacheManager.bm25CacheValid(orderedChunks)) {
			if (!(this.cacheManager.bm25Cache && this.coord.isWriting())) {
				await this.cacheManager.tryLoadPersistedBm25(orderedChunks);
				if (!this.cacheManager.bm25CacheValid(orderedChunks)) {
					await this.cacheManager.tryLoadCrossDeviceBm25(orderedChunks);
				}
			}
		}
		const bm25CacheHit = await this.cacheManager.ensureBm25(orderedChunks);
		if (!this.cacheManager.bm25Cache) {
			const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
			await this.appendSearchTelemetry(entry);
			return { results: [], entry };
		}
		if (this.cacheManager.bm25Cache && !frameBm25Coherent(frame, this.cacheManager.bm25Cache)) {
			this.onCoherenceDrift('search');
			const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
			await this.appendSearchTelemetry(entry);
			return { results: [], entry };
		}
		const synEnabled = this.settings.synonymExpansion;
		const { scores: bm25Scores, coverage: bm25Coverage, bound: bm25Bound } = this.cacheManager.bm25Cache!.getScoresWithCoverage(cleanedQuery, {
			boosts: this.cacheManager.bm25FieldBoosts(),
			fuzzy: this.settings.fuzzyEnabled ? FUZZY_BY_LENGTH : false,
			prefix: this.settings.prefixLastToken ? PREFIX_LAST_TOKEN : false,
			...(synEnabled && this.cacheManager.synonymCache && this.cacheManager.synonymCache.mates.size > 0 && {
				synonyms: { map: this.cacheManager.synonymCache.mates, weight: SYNONYM_WEIGHT },
			}),
		});
		const bm25TopIdx = topNIndices(bm25Scores, caps.bm25, mask);
		const bm25Ms = performance.now() - bm25Start;

		// ---- S1c: recency candidate-gen ---------------------------------
		const recencyTopIdx = this.cacheManager.topByRecency(orderedChunks, caps.recency, mask);

		// ---- S1d: lexical partial (BM25 + recency + title boost only) ---
		let lexPartialFired = false;
		const lexPartialMsStart = performance.now();
		if (onPartial) {
			const lexRankConfig = {
				...DEFAULT_RANKING_CONFIG,
				alpha: this.settings.denseWeight,
				titleBoost: this.settings.navTitleBoost,
				recencyEpsilon: recencyOverride?.epsilon ?? this.settings.recencyEpsilon,
				recencyHalfLifeDays: recencyOverride?.halfLifeDays ?? this.settings.recencyHalfLifeDays,
				recencyKey: this.settings.recencyKey,
				createdProp: this.settings.createdProp,
			};
			const lexUnion = new Set<number>();
			for (const i of bm25TopIdx) lexUnion.add(i);
			for (const i of recencyTopIdx) lexUnion.add(i);
			if (lexUnion.size > 0) {
				const lexIndices = Array.from(lexUnion);
				const lexChunks = lexIndices.map(i => orderedChunks[i]);
				const lexBm25 = lexIndices.map(i => bm25Scores[i]);
				const zeroDense = new Float64Array(lexIndices.length);
				const lexPoolSize = Math.min(caps.binary + caps.bm25 + caps.recency, lexIndices.length);
				const { results: lexRanked } = rank(
					lexChunks, zeroDense, new Float64Array(lexBm25),
					cleanedQuery, lexPoolSize, lexRankConfig, bm25Bound,
				);
				for (const r of lexRanked) r.lexicalOnly = true;
				const lexResults = dedupByPath(lexRanked, topK);
				if (lexResults.length > 0) {
					await this.cacheManager.hydrateBodies(lexResults);
					const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
					const passageTerms = buildPassageTerms(cleanedQuery, () => 0);
					for (const r of lexResults) r.snippet = makeSnippet(r.content, passageTerms, snippetChars);
					await onPartial({
						results: lexResults,
						source: 'lexical',
						cleanedQuery,
					});
					lexPartialFired = true;
				}
			}
		}
		const lexPartialMs = performance.now() - lexPartialMsStart;

		// Embed may still be in flight. Binary launches from embed's then().
		const embedded = await embedPromise;
		const queryEmbedMs = embedded.queryEmbedMs;
		const iframeEmbedMs = embedded.iframeLatencyMs;
		if (!embedded.ok) {
			if (embedded.reason === 'nonfinite') {
				await this.logger.appendError(
					'searchQueryVectorNonFinite',
					new Error(`Query embedding contains non-finite values (dim ${embedded.dim}) — corrupt embedder output; retry the search.`),
				);
			} else {
				await this.logger.appendError(
					'searchDimMismatch',
					new Error(
						`Binary index was packed for ${bytesPerVec * 8}-d vectors but the loaded model emits ` +
						`${embedded.dim}-d. Run "Seek: Full reindex" to rebuild.`,
					),
				);
			}
			const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
			entry.nameMatchMs = parseFloat(nameMatchMs.toFixed(2));
			entry.nameHitCount = nameHits.length;
			entry.nameEarlyPainted = nameEarlyPainted;
			entry.namePartialMs = parseFloat(namePartialMs.toFixed(2));
			await this.appendSearchTelemetry(entry);
			return { results: [], entry };
		}
		const queryVec = embedded.vector;

		const binaryTopIdx = binaryPromise ? await binaryPromise : [];
		const binaryMs = binaryStart > 0 ? performance.now() - binaryStart : 0;

		// ---- S1 union ---------------------------------------------------
		const unionSet = new Set<number>();
		for (const i of binaryTopIdx) unionSet.add(i);
		const binaryCount = unionSet.size;
		for (const i of bm25TopIdx) unionSet.add(i);
		const bm25Count = unionSet.size - binaryCount;
		for (const i of recencyTopIdx) unionSet.add(i);
		const recencyCount = unionSet.size - binaryCount - bm25Count;
		const candidateIndices = Array.from(unionSet);

		// ---- S2 prep: rerank vectors for the candidate union -----------
		const fetchStart = performance.now();
		let fp32Maybe: Array<Float32Array | null>;
		if (residentInt8 && residentScales) {
			fp32Maybe = candidateIndices.map(idx =>
				dequantizeInt8(residentInt8.subarray(idx * embDim, (idx + 1) * embDim), residentScales[idx]));
		} else {
			const candidateIds = candidateIndices.map(i => orderedIds[i]);
			fp32Maybe = await this.store.getEmbeddingsByIds(candidateIds);
		}
		const selectFetchMs = performance.now() - fetchStart;

		const zeroFp32 = new Float32Array(queryVec.length);
		const alignStart = performance.now();
		const candidateChunks: ChunkMeta[] = [];
		const candidateFp32: Float32Array[] = [];
		const candidateBm25: number[] = [];
		const applyCoverage = this.settings.bm25Coverage;
		for (let i = 0; i < candidateIndices.length; i++) {
			const idx = candidateIndices[i];
			const aligned = alignCandidate(orderedChunks[idx], fp32Maybe[i], queryVec.length);
			if (!aligned) continue;
			candidateChunks.push(aligned.chunk);
			candidateFp32.push(aligned.missingFp32 ? zeroFp32 : (fp32Maybe[i] as Float32Array));
			candidateBm25.push(applyCoverage ? bm25Scores[idx] * Math.pow(bm25Coverage[idx], BM25_COVERAGE_POW) : bm25Scores[idx]);
		}
		const alignMs = performance.now() - alignStart;

		// ---- S2 score: exact cosine over the candidate set --------------
		const cosineStart = performance.now();
		const denseScoresCand = cosineScores(queryVec, candidateFp32);
		const cosineMs = performance.now() - cosineStart;

		// ---- S2 fuse + rank ---------------------------------------------
		const rankConfig = {
			...DEFAULT_RANKING_CONFIG,
			alpha: this.settings.denseWeight,
			titleBoost: this.settings.navTitleBoost,
			recencyEpsilon: recencyOverride?.epsilon ?? this.settings.recencyEpsilon,
			recencyHalfLifeDays: recencyOverride?.halfLifeDays ?? this.settings.recencyHalfLifeDays,
			recencyKey: this.settings.recencyKey,
			createdProp: this.settings.createdProp,
		};
		const fusionStart = performance.now();
		const rankPoolSize = candidateChunks.length;
		const { results: rankedPool, breakdown } = rank(
			candidateChunks,
			denseScoresCand,
			new Float64Array(candidateBm25),
			cleanedQuery,
			rankPoolSize,
			rankConfig,
			bm25Bound,
		);
		const fusionMs = performance.now() - fusionStart;

		// ---- S3: dedup + snippet ----------------------------------------
		const results = dedupByPath(rankedPool, topK);

		await this.cacheManager.hydrateBodies(results);

		const bgStats = await this.cacheManager.getDenseBgStats();
		if (bgStats) {
			for (const r of results) {
				r.ranking_signals.confidence = calibratedConfidence(
					r.ranking_signals.denseRaw, bgStats.mean, bgStats.std);
			}
		}

		const snippetStart = performance.now();
		const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
		const passageTerms = buildPassageTerms(
			cleanedQuery, t => this.cacheManager.bm25Cache?.termDocFraction(t) ?? 0);
		for (const r of results) r.snippet = makeSnippet(r.content, passageTerms, snippetChars);
		const snippetMs = performance.now() - snippetStart;

		// ---- Telemetry ---------------------------------------------------
		const rawDenseTop5 = topKByScore(denseScoresCand, candidateChunks, 5);
		const rawBm25Top5 = topKByScore(new Float64Array(candidateBm25), candidateChunks, 5);
		const traceDepth = this.settings.verboseTrace ? 50 : 10;
		const fusedTop50 = rankedPool.slice(0, traceDepth).map((r, i) => ({
			chunk_id: r.chunk_id,
			note_path: r.note_path,
			rank: i + 1,
			score: r.score,
			dense: r.ranking_signals.dense,
			denseRaw: r.ranking_signals.denseRaw,
			bm25: r.ranking_signals.bm25,
			recency: r.ranking_signals.recency,
			title_boost: r.ranking_signals.title_boost,
			title: r.title,
		}));

		const totalMs = performance.now() - t0;
		const entry: SearchEntry = {
			type: 'search',
			timestamp: new Date().toISOString(),
			query, topK,
			cleanedQuery, filters,
			idbReadMs: parseFloat(idbReadMs.toFixed(2)),
			binaryMs: parseFloat(binaryMs.toFixed(2)),
			selectFetchMs: parseFloat(selectFetchMs.toFixed(2)),
			alignMs: parseFloat(alignMs.toFixed(2)),
			queryEmbedMs: parseFloat(queryEmbedMs.toFixed(2)),
			iframeEmbedMs: parseFloat(iframeEmbedMs.toFixed(2)),
			cosineMs: parseFloat(cosineMs.toFixed(2)),
			bm25Ms: parseFloat(bm25Ms.toFixed(2)),
			bm25CacheHit,
			fusionMs: parseFloat(fusionMs.toFixed(2)),
			snippetMs: parseFloat(snippetMs.toFixed(2)),
			totalMs: parseFloat(totalMs.toFixed(2)),
			totalChunks: orderedChunks.length,
			binaryTopN: caps.binary,
			bm25TopM: caps.bm25,
			recencyTopK: caps.recency,
			binaryCount,
			bm25Count,
			recencyCount,
			candidateUnionSize: candidateChunks.length,
			binaryCacheHit: binaryCacheHitFlag,
			rawDenseTop5,
			rawBm25Top5,
			fusedTop50,
			alpha: rankConfig.alpha,
			recencyWeight: rankConfig.recencyEpsilon,
			recencyKey: rankConfig.recencyKey,
			bm25Coverage: applyCoverage,
			prefixLastToken: this.settings.prefixLastToken,
			synonymExpansion: synEnabled,
			searchableProperties: this.settings.searchableProperties,
			headingsField: this.settings.headingsField,
			nameMatchMs: parseFloat(nameMatchMs.toFixed(2)),
			nameHitCount: nameHits.length,
			nameEarlyPainted,
			namePartialMs: parseFloat(namePartialMs.toFixed(2)),
			lexPartialMs: parseFloat(lexPartialMs.toFixed(2)),
			lexPartialFired,
			bm25Bound: parseFloat(bm25Bound.toFixed(4)),
			searchId,
		};
		await this.appendSearchTelemetry(entry);

		void breakdown;
		return { results, entry };
	}

	/**
	 * Lexical-only search (BM25 + recency + title boost, no embedder).
	 */
	async searchLexicalOnly(
		query: string,
		topK = 10,
		onPartial?: (partial: SearchPartial) => void | Promise<void>,
	): Promise<{ results: ScoredChunk[] }> {
		const t0 = performance.now();
		const cleanedQuery = parseQuery(query, this.buildFilterContext()).cleanedQuery;
		if (!cleanedQuery.trim()) return { results: [] };

		const frame = await this.cacheManager.ensureFrame({ skipResidentInt8: true });
		if (!frame || frame.orderedChunks.length === 0) return { results: [] };

		const orderedChunks = frame.orderedChunks;
		if (!this.cacheManager.bm25CacheValid(orderedChunks)) {
			await this.cacheManager.tryLoadPersistedBm25(orderedChunks);
		}
		const bm25CacheHit = await this.cacheManager.ensureBm25(orderedChunks);
		if (!this.cacheManager.bm25Cache) return { results: [] };
		if (!frameBm25Coherent(frame, this.cacheManager.bm25Cache)) return { results: [] };

		const { scores: bm25Scores, bound: bm25Bound } = this.cacheManager.bm25Cache.getScoresWithCoverage(cleanedQuery, {
			boosts: this.cacheManager.bm25FieldBoosts(),
			fuzzy: this.settings.fuzzyEnabled ? FUZZY_BY_LENGTH : false,
			prefix: this.settings.prefixLastToken ? PREFIX_LAST_TOKEN : false,
		});
		void bm25CacheHit;

		const caps = poolCaps(orderedChunks.length - frame.tombstoneCount);
		const bm25TopIdx = topNIndices(bm25Scores, caps.bm25, null);
		const recencyTopIdx = this.cacheManager.topByRecency(orderedChunks, caps.recency, null);

		let nameEarlyPainted = false;
		if (onPartial) {
			const nameHits = collectNameHits(orderedChunks, cleanedQuery);
			if (shouldEarlyPaint(nameHits)) {
				const titleBoost = this.settings.navTitleBoost;
				const early: ScoredChunk[] = nameHits.slice(0, topK).map(h => {
					const c = orderedChunks[h.index];
					return {
						...c, content: '', score: h.score,
						ranking_signals: { dense: 0, bm25: 0, hybrid: 0, recency: 0, title_boost: titleBoost * h.score, denseRaw: 0 },
						lexicalOnly: true,
					};
				});
				await this.cacheManager.hydrateBodies(early);
				const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
				const passageTerms = buildPassageTerms(cleanedQuery, () => 0);
				for (const r of early) r.snippet = makeSnippet(r.content, passageTerms, snippetChars);
				nameEarlyPainted = true;
				await onPartial({ results: early, source: 'name', nameHitCount: nameHits.length, cleanedQuery });
			}
		}

		const lexUnion = new Set<number>();
		for (const i of bm25TopIdx) lexUnion.add(i);
		for (const i of recencyTopIdx) lexUnion.add(i);
		if (lexUnion.size === 0) return { results: [] };

		const lexIndices = Array.from(lexUnion);
		const lexChunks = lexIndices.map(i => orderedChunks[i]);
		const lexBm25 = lexIndices.map(i => bm25Scores[i]);
		const zeroDense = new Float64Array(lexIndices.length);
		const lexRankConfig = {
			...DEFAULT_RANKING_CONFIG,
			alpha: this.settings.denseWeight,
			titleBoost: this.settings.navTitleBoost,
			recencyEpsilon: this.settings.recencyEpsilon,
			recencyHalfLifeDays: this.settings.recencyHalfLifeDays,
			recencyKey: this.settings.recencyKey,
			createdProp: this.settings.createdProp,
		};
		const { results: lexRanked } = rank(
			lexChunks, zeroDense, new Float64Array(lexBm25),
			cleanedQuery, Math.min(caps.binary + caps.bm25 + caps.recency, lexIndices.length),
			lexRankConfig, bm25Bound,
		);
		for (const r of lexRanked) r.lexicalOnly = true;
		const results = dedupByPath(lexRanked, topK);
		await this.cacheManager.hydrateBodies(results);
		const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
		const passageTerms = buildPassageTerms(cleanedQuery, () => 0);
		for (const r of results) r.snippet = makeSnippet(r.content, passageTerms, snippetChars);

		if (onPartial && !nameEarlyPainted) {
			await onPartial({ results, source: 'lexical', cleanedQuery });
		}

		return { results };
	}

	// ── Private helpers ──────────────────────────────────────────────────

	private buildFilterContext(recencyOverride?: RecencyOverride): FilterContext {
		const epsilon = recencyOverride?.epsilon ?? this.settings.recencyEpsilon;
		const recencyOn = epsilon > 0;
		return {
			dateField: recencyOn
				? { key: this.settings.recencyKey, createdProp: this.settings.createdProp }
				: null,
			numericKeys: enumerateNumberPropertyNames(this.app),
		};
	}

	private async appendSearchTelemetry(entry: SearchEntry): Promise<void> {
		seekPerf.recordSearch(entry);
		await this.logger.append(entry);
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
		return {
			type: 'search',
			timestamp: new Date().toISOString(),
			query, topK,
			cleanedQuery, filters,
			idbReadMs: parseFloat(idbReadMs.toFixed(2)),
			binaryMs: 0,
			selectFetchMs: 0,
			alignMs: 0,
			queryEmbedMs: 0, iframeEmbedMs: 0,
			cosineMs: 0,
			bm25Ms: 0, bm25CacheHit: false,
			fusionMs: 0, snippetMs: 0,
			totalMs: parseFloat(totalMs.toFixed(2)),
			totalChunks: 0,
			binaryTopN: POOL_FLOORS.binary,
			bm25TopM: POOL_FLOORS.bm25,
			recencyTopK: POOL_FLOORS.recency,
			binaryCount: 0, bm25Count: 0, recencyCount: 0,
			candidateUnionSize: 0,
			binaryCacheHit: false,
			rawDenseTop5: [], rawBm25Top5: [], fusedTop50: [],
			nameMatchMs: 0, nameHitCount: 0, nameEarlyPainted: false, namePartialMs: 0,
			lexPartialMs: 0, lexPartialFired: false,
			alpha: this.settings.denseWeight,
			recencyWeight: this.settings.recencyEpsilon,
			recencyKey: this.settings.recencyKey,
			searchId,
		};
	}
}

// ── Internal helpers (used only inside SearchQuery) ──────────────────
function dedupByPath(rankedPool: ScoredChunk[], topK: number): ScoredChunk[] {
	const seenPaths = new Set<string>();
	const out: ScoredChunk[] = [];
	for (const r of rankedPool) {
		if (seenPaths.has(r.note_path)) continue;
		seenPaths.add(r.note_path);
		out.push(r);
		if (out.length >= topK) break;
	}
	return out;
}

function topKByScore(scores: Float64Array, chunks: ChunkMeta[], k: number): Array<{ chunk_id: string; score: number }> {
	const indices = Array.from({ length: scores.length }, (_, i) => i);
	indices.sort((a, b) => scores[b] - scores[a]);
	return indices.slice(0, k).map(i => ({ chunk_id: chunks[i].chunk_id, score: scores[i] }));
}