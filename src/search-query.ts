import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type {
    ChunkMeta,
    ScoredChunk,
    SearchEntry,
    SearchPartial,
    QueryFilters,
    FilterContext,
    SeekSettings,
} from './types';
import {
    MultiFieldBM25,
    DEFAULT_FIELD_BOOSTS,
    PREFIX_LAST_TOKEN,
    FUZZY_BY_LENGTH,
    BM25_COVERAGE_POW,
} from './bm25';
import { SYNONYM_WEIGHT } from './synonyms';
import { rank, cosineScores, DEFAULT_RANKING_CONFIG } from './ranker';
import { browseOrder, recencyDate } from './fusion';
import { collectNameHits, shouldEarlyPaint } from './name-match';
import {
    buildVaultLexIndex,
    vaultFileSignature,
    vaultFileToMeta,
    type FileCacheLite,
    type VaultLexIndex,
} from './vault-lex';
import { IndexStore } from './index-store';
import { LocalEmbedder } from './embedder';
import { SeekLogger } from './logger';
import { seekPerf } from './perf-console';
import { selectTopNIndices } from './select';
import { topNIndices } from './binary';
import { poolCaps, POOL_FLOORS } from './pool';
import { BinaryScorerWorker, binaryCandidatesAsync } from './binary-scorer';
import { dequantizeInt8 } from './quant';
import { calibratedConfidence } from './dense-stats';
import { IndexCoordinator } from './index-coordinator';
import { cheapYield } from './pacer';
import { parseQuery, compileMatcher, excludedNotePaths } from './query-parser';
import { makeSnippet, SNIPPET_PREVIEW_LIMITS } from './snippet';
import { buildPassageTerms } from './passage';
import { enumerateNumberPropertyNames } from './prop-types';
import { cleanDenseText } from './dense-clean';
import {
    alignCandidate,
    buildSelectionMask,
    type ResidentFrame,
} from './frame-utils';
import { frameBm25Coherent } from './coherence';
import { CacheManager } from './cache-manager';

export interface RecencyOverride {
    epsilon?: number;
    halfLifeDays?: number;
}

export function dedupByPath(rankedPool: ScoredChunk[], topK: number): ScoredChunk[] {
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

export function topKByScore(scores: Float64Array, chunks: ChunkMeta[], k: number): Array<{ chunk_id: string; score: number }> {
    const indices = Array.from({ length: scores.length }, (_, i) => i);
    indices.sort((a, b) => scores[b] - scores[a]);
    return indices.slice(0, k).map(i => ({ chunk_id: chunks[i].chunk_id, score: scores[i] }));
}

export interface SearchQueryDelegates {
    getBinaryWorker?: () => BinaryScorerWorker;
    peekResidentFrame?: () => ResidentFrame | null;
    topByRecency?: (chunks: ChunkMeta[], k: number, mask?: boolean[] | null) => number[];
    appendSearchTelemetry?: (entry: SearchEntry) => Promise<void>;
    emitVaultLadder?: (
        cleanedQuery: string,
        topK: number,
        onPartial: ((partial: SearchPartial) => void | Promise<void>) | undefined,
        signal: AbortSignal | undefined,
        t0: number,
    ) => Promise<{
        results: ScoredChunk[];
        namePainted: boolean;
        lexPainted: boolean;
        nameMatchMs: number;
        nameHitCount: number;
        namePartialMs: number;
        lexPartialMs: number;
    }>;
    vaultFilterBrowse?: (
        filters: QueryFilters,
        filterCtx: FilterContext,
        topK: number,
        signal?: AbortSignal,
    ) => Promise<ScoredChunk[]>;
    hydrateBodies?: (results: ScoredChunk[]) => Promise<void>;
}

export interface SearchQueryDeps {
    app: App;
    store: IndexStore;
    cacheManager: CacheManager;
    coord: IndexCoordinator;
    embedder: LocalEmbedder;
    binaryWorker: BinaryScorerWorker;
    settings: SeekSettings;
    logger: SeekLogger;
    shouldIndex: (path: string) => boolean;
    onCoherenceDrift?: (where: string) => void;
    delegates?: SearchQueryDelegates;
}

export class SearchQuery {
    readonly app: App;
    readonly store: IndexStore;
    readonly cacheManager: CacheManager;
    readonly coord: IndexCoordinator;
    readonly embedder: LocalEmbedder;
    readonly binaryWorker: BinaryScorerWorker;
    readonly settings: SeekSettings;
    readonly logger: SeekLogger;
    readonly shouldIndex: (path: string) => boolean;
    readonly onCoherenceDrift?: (where: string) => void;
    delegates?: SearchQueryDelegates;

    vaultLex: VaultLexIndex | null = null;
    vaultLexPromise: Promise<VaultLexIndex> | null = null;

    constructor(deps: SearchQueryDeps) {
        this.app = deps.app;
        this.store = deps.store;
        this.cacheManager = deps.cacheManager;
        this.coord = deps.coord;
        this.embedder = deps.embedder;
        this.binaryWorker = deps.binaryWorker;
        this.settings = deps.settings;
        this.logger = deps.logger;
        this.shouldIndex = deps.shouldIndex;
        this.onCoherenceDrift = deps.onCoherenceDrift;
        this.delegates = deps.delegates;
    }

    buildFilterContext(recencyOverride?: RecencyOverride): FilterContext {
        const epsilon = recencyOverride?.epsilon ?? this.settings.recencyEpsilon;
        const recencyOn = epsilon > 0;
        return {
            dateField: recencyOn
                ? { key: this.settings.recencyKey, createdProp: this.settings.createdProp }
                : null,
            numericKeys: enumerateNumberPropertyNames(this.app),
        };
    }

    vaultFileCache(file: TFile): FileCacheLite | null {
        try {
            const cache = this.app.metadataCache as { getFileCache?: (f: TFile) => FileCacheLite | null };
            return cache.getFileCache?.(file) ?? null;
        } catch {
            return null;
        }
    }

    async ensureVaultLex(signal?: AbortSignal): Promise<VaultLexIndex | null> {
        const files = this.app.vault.getMarkdownFiles().filter(f => this.shouldIndex(f.path));
        if (files.length === 0) return null;
        const sig = vaultFileSignature(files);
        if (this.vaultLex && this.vaultLex.signature === sig) return this.vaultLex;
        if (this.vaultLexPromise) {
            try { return await this.vaultLexPromise; } catch { return this.vaultLex; }
        }
        const work = buildVaultLexIndex(
            files,
            f => this.vaultFileCache(f),
            f => this.app.vault.cachedRead(f),
            {
                searchableProperties: this.settings.searchableProperties,
                headingsField: this.settings.headingsField || this.settings.boostedBm25,
                yieldFn: cheapYield,
                signal,
            },
        );
        this.vaultLexPromise = work;
        try {
            const built = await work;
            if (built.signature === vaultFileSignature(
                this.app.vault.getMarkdownFiles().filter(f => this.shouldIndex(f.path)),
            )) {
                this.vaultLex = built;
            }
            return built;
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') throw e;
            console.warn('[seek] vault lexical index failed', e);
            return null;
        } finally {
            if (this.vaultLexPromise === work) this.vaultLexPromise = null;
        }
    }

    async fillVaultSnippets(
        results: ScoredChunk[],
        bodies: ReadonlyMap<string, string> | null,
        cleanedQuery: string,
        signal?: AbortSignal,
    ): Promise<void> {
        const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
        const passageTerms = buildPassageTerms(cleanedQuery, () => 0);
        for (const r of results) {
            if (signal?.aborted) {
                throw Object.assign(new Error('Query superseded'), { name: 'AbortError', code: 'ABORTED' });
            }
            let body = bodies?.get(r.chunk_id) ?? '';
            if (!body) {
                const file = this.app.vault.getAbstractFileByPath(r.note_path);
                if (file instanceof TFile) {
                    try { body = await this.app.vault.cachedRead(file); } catch { body = ''; }
                }
            }
            r.content = body;
            r.snippet = makeSnippet(body, passageTerms, snippetChars);
        }
    }

    async emitVaultLadder(
        cleanedQuery: string,
        topK: number,
        onPartial: ((partial: SearchPartial) => void | Promise<void>) | undefined,
        signal: AbortSignal | undefined,
        t0: number,
    ): Promise<{
        results: ScoredChunk[];
        namePainted: boolean;
        lexPainted: boolean;
        nameMatchMs: number;
        nameHitCount: number;
        namePartialMs: number;
        lexPartialMs: number;
    }> {
        const empty = {
            results: [] as ScoredChunk[],
            namePainted: false, lexPainted: false,
            nameMatchMs: 0, nameHitCount: 0, namePartialMs: 0, lexPartialMs: 0,
        };
        if (!cleanedQuery.trim()) return empty;
        const throwIfAborted = (): void => {
            if (signal?.aborted) {
                throw Object.assign(new Error('Query superseded'), { name: 'AbortError', code: 'ABORTED' });
            }
        };

        const files = this.app.vault.getMarkdownFiles().filter(f => this.shouldIndex(f.path));
        const nameChunks: ChunkMeta[] = files.map(f => vaultFileToMeta(f, this.vaultFileCache(f)));
        const nameStart = performance.now();
        const nameHits = collectNameHits(nameChunks, cleanedQuery);
        const nameMatchMs = performance.now() - nameStart;
        let namePainted = false;
        let namePartialMs = 0;
        let results: ScoredChunk[] = [];
        if (shouldEarlyPaint(nameHits)) {
            const titleBoost = this.settings.navTitleBoost;
            const early = nameHits.slice(0, topK).map(h => {
                const c = nameChunks[h.index];
                return {
                    ...c,
                    title: c.note_path.split('/').pop()?.replace(/\.md$/i, '') ?? c.title,
                    content: '',
                    score: h.score,
                    ranking_signals: {
                        dense: 0, bm25: 0, hybrid: 0, recency: 0,
                        title_boost: titleBoost * h.score,
                        denseRaw: 0,
                    },
                    lexicalOnly: true as const,
                };
            });
            await this.fillVaultSnippets(early, this.vaultLex?.bodies ?? null, cleanedQuery, signal);
            throwIfAborted();
            namePartialMs = performance.now() - t0;
            namePainted = true;
            results = early;
            if (onPartial) {
                await onPartial({
                    results: early,
                    source: 'name',
                    nameHitCount: nameHits.length,
                    cleanedQuery,
                });
                throwIfAborted();
                await cheapYield();
                throwIfAborted();
            }
        }

        const lexStart = performance.now();
        const lex = await this.ensureVaultLex(signal);
        throwIfAborted();
        let lexPainted = false;
        if (lex) {
            const { scores: bm25Scores, bound: bm25Bound } = lex.bm25.getScoresWithCoverage(cleanedQuery, {
                boosts: this.bm25FieldBoosts(),
                fuzzy: this.settings.fuzzyEnabled ? FUZZY_BY_LENGTH : false,
                prefix: this.settings.prefixLastToken ? PREFIX_LAST_TOKEN : false,
            });
            const caps = poolCaps(lex.chunks.length);
            const bm25TopIdx = topNIndices(bm25Scores, caps.bm25, null);
            const recencyTopIdx = (this.delegates?.topByRecency ?? this.topByRecency.bind(this))(lex.chunks, caps.recency, null);
            const lexUnion = new Set<number>();
            for (const i of bm25TopIdx) lexUnion.add(i);
            for (const i of recencyTopIdx) lexUnion.add(i);
            if (lexUnion.size > 0) {
                const lexIndices = Array.from(lexUnion);
                const lexChunks = lexIndices.map(i => lex.chunks[i]);
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
                const lexResults = dedupByPath(lexRanked, topK);
                if (lexResults.length > 0) {
                    await this.fillVaultSnippets(lexResults, lex.bodies, cleanedQuery, signal);
                    throwIfAborted();
                    lexPainted = true;
                    if (namePainted && results.length > 0) {
                        const seen = new Set(results.map(r => r.note_path));
                        const merged = [...results];
                        for (const r of lexResults) {
                            if (seen.has(r.note_path)) continue;
                            seen.add(r.note_path);
                            merged.push(r);
                        }
                        results = merged.slice(0, topK);
                    } else {
                        results = lexResults;
                    }
                    if (onPartial) {
                        await onPartial({ results: lexResults, source: 'lexical', cleanedQuery });
                        throwIfAborted();
                    }
                }
            }
        }
        return {
            results,
            namePainted,
            lexPainted,
            nameMatchMs,
            nameHitCount: nameHits.length,
            namePartialMs,
            lexPartialMs: performance.now() - lexStart,
        };
    }

    async vaultFilterBrowse(
        filters: QueryFilters,
        filterCtx: FilterContext,
        topK: number,
        signal?: AbortSignal,
    ): Promise<ScoredChunk[]> {
        const files = this.app.vault.getMarkdownFiles().filter(f => this.shouldIndex(f.path));
        const matcher = compileMatcher(filters, filterCtx);
        const metas = files.map(f => vaultFileToMeta(f, this.vaultFileCache(f)));
        const matched = matcher ? metas.filter(c => matcher(c)) : metas;
        const seenPaths = new Set<string>();
        const results: ScoredChunk[] = [];
        for (const c of browseOrder(matched, this.settings.recencyKey, this.settings.createdProp)) {
            if (seenPaths.has(c.note_path)) continue;
            seenPaths.add(c.note_path);
            results.push({
                ...c,
                content: '',
                score: 0,
                ranking_signals: { dense: 0, bm25: 0, hybrid: 0, recency: 0, title_boost: 0, denseRaw: 0 },
                lexicalOnly: true,
            });
            if (results.length >= topK) break;
        }
        await this.fillVaultSnippets(results, this.vaultLex?.bodies ?? null, '', signal);
        return results;
    }

    async hydrateBodies(results: ScoredChunk[]): Promise<void> {
        if (results.length === 0) return;
        const bodies = await this.store.getBodiesByIds(results.map(r => r.chunk_id));
        for (let i = 0; i < results.length; i++) results[i].content = bodies[i] ?? '';
    }

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

    async appendSearchTelemetry(entry: SearchEntry): Promise<void> {
        seekPerf.recordSearch(entry);
        await this.logger.append(entry);
    }

    emptySearchEntry(
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

    bm25FieldBoosts(): Record<string, number> {
        if (!this.settings.boostedBm25) return DEFAULT_FIELD_BOOSTS;
        return { ...DEFAULT_FIELD_BOOSTS, aliases: 9.0, tags: 2.0, headings: 4.0 };
    }

    async searchLexicalOnly(
        query: string,
        topK = 10,
        onPartial?: (partial: SearchPartial) => void | Promise<void>,
        signal?: AbortSignal,
    ): Promise<{ results: ScoredChunk[] }> {
        const throwIfAborted = (): void => {
            if (signal?.aborted) {
                throw Object.assign(new Error('Query superseded'), { name: 'AbortError', code: 'ABORTED' });
            }
        };
        throwIfAborted();
        const t0 = performance.now();
        const cleanedQuery = parseQuery(query, this.buildFilterContext()).cleanedQuery;
        if (!cleanedQuery.trim()) return { results: [] };

        const emitLadder = this.delegates?.emitVaultLadder ?? this.emitVaultLadder.bind(this);
        const vault = await emitLadder(cleanedQuery, topK, onPartial, signal, t0);
        throwIfAborted();
        return { results: vault.results };
    }

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

        const peekFrame = this.delegates?.peekResidentFrame ?? this.cacheManager.peekResidentFrame.bind(this.cacheManager);
        const emitLadder = this.delegates?.emitVaultLadder ?? this.emitVaultLadder.bind(this);
        const runVaultFilterBrowse = this.delegates?.vaultFilterBrowse ?? this.vaultFilterBrowse.bind(this);
        const runAppendSearchTelemetry = this.delegates?.appendSearchTelemetry ?? this.appendSearchTelemetry.bind(this);
        const runHydrateBodies = this.delegates?.hydrateBodies ?? this.hydrateBodies.bind(this);
        const runTopByRecency = this.delegates?.topByRecency ?? this.topByRecency.bind(this);

        let vault = {
            results: [] as ScoredChunk[],
            namePainted: false, lexPainted: false,
            nameMatchMs: 0, nameHitCount: 0, namePartialMs: 0, lexPartialMs: 0,
        };
        if (!peekFrame()) {
            if (cleanedQuery.trim()) {
                vault = await emitLadder(cleanedQuery, topK, onPartial, signal, t0);
            } else if (filters) {
                vault.results = await runVaultFilterBrowse(filters, filterCtx, topK, signal);
            }
            throwIfAborted();
            const entry = this.emptySearchEntry(
                query, cleanedQuery, filters, topK, searchId, 0, performance.now() - t0,
            );
            entry.nameMatchMs = parseFloat(vault.nameMatchMs.toFixed(2));
            entry.nameHitCount = vault.nameHitCount;
            entry.nameEarlyPainted = vault.namePainted;
            entry.namePartialMs = parseFloat(vault.namePartialMs.toFixed(2));
            entry.lexPartialFired = vault.lexPainted;
            entry.lexPartialMs = parseFloat(vault.lexPartialMs.toFixed(2));
            throwIfAborted();
            await runAppendSearchTelemetry(entry);
            return { results: vault.results, entry };
        }

        const idbStart = performance.now();
        const frameWasCached = !!(this.cacheManager.frameCache && this.cacheManager.frameCache.generation === this.coord.generation);
        const frame = peekFrame();
        const idbReadMs = performance.now() - idbStart;
        throwIfAborted();
        const binaryCacheHitFlag = frameWasCached;

        if (!frame) {
            if (vault.results.length === 0 && cleanedQuery.trim()) {
                vault = await emitLadder(cleanedQuery, topK, onPartial, signal, t0);
                throwIfAborted();
            } else if (vault.results.length === 0 && filters) {
                vault.results = await runVaultFilterBrowse(filters, filterCtx, topK, signal);
            }
            const entry: SearchEntry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
            entry.nameMatchMs = parseFloat(vault.nameMatchMs.toFixed(2));
            entry.nameHitCount = vault.nameHitCount;
            entry.nameEarlyPainted = vault.namePainted;
            entry.namePartialMs = parseFloat(vault.namePartialMs.toFixed(2));
            entry.lexPartialFired = vault.lexPainted;
            entry.lexPartialMs = parseFloat(vault.lexPartialMs.toFixed(2));
            throwIfAborted();
            await runAppendSearchTelemetry(entry);
            return { results: vault.results, entry };
        }

        const orderedChunks = frame.orderedChunks;
        const orderedIds = frame.orderedIds;
        const activePacked = frame.activePacked;
        const bytesPerVec = frame.bytesPerVec;
        const residentInt8 = frame.residentInt8;
        const residentScales = frame.residentScales;
        const embDim = frame.embDim;
        const frameGen = frame.generation;

        const liveN = orderedChunks.length - frame.tombstoneCount;
        const caps = poolCaps(liveN);

        const matcher = filters ? compileMatcher(filters, filterCtx) : null;
        let mask = buildSelectionMask(orderedChunks, frame.validRows, frame.tombstoneCount, matcher);

        if (filters?.exclude && filters.exclude.length > 0) {
            const bodyMap = await this.store.getBodiesMap(orderedIds);
            throwIfAborted();
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
            await runHydrateBodies(results);
            throwIfAborted();
            const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
            for (const r of results) r.snippet = makeSnippet(r.content, [], snippetChars);
            const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
            entry.totalChunks = orderedChunks.length;
            entry.candidateUnionSize = matchedChunks.length;
            entry.recencyCount = matchedChunks.length;
            throwIfAborted();
            await runAppendSearchTelemetry(entry);
            return { results, entry };
        }

        const qStart = performance.now();
        type EmbedOk = { ok: true; vector: Float32Array; iframeLatencyMs: number; queryEmbedMs: number; embedRoute: 'worker' | 'iframe' };
        type EmbedFail = { ok: false; reason: 'nonfinite' | 'dim'; dim: number; iframeLatencyMs: number; queryEmbedMs: number; embedRoute: 'worker' | 'iframe' };
        let binaryStart = 0;
        let binaryPromise: Promise<number[]> | null = null;
        const embedPromise: Promise<EmbedOk | EmbedFail> = this.embedder.embed(cleanDenseText(cleanedQuery), signal).then(embedded => {
            const queryEmbedMs = performance.now() - qStart;
            const queryVec = embedded.vector;
            const embedRoute = embedded.embedRoute ?? 'iframe';
            if (!queryVec.every(Number.isFinite)) {
                return { ok: false, reason: 'nonfinite' as const, dim: queryVec.length, iframeLatencyMs: embedded.iframeLatencyMs, queryEmbedMs, embedRoute };
            }
            if (bytesPerVec !== ((queryVec.length + 7) >> 3)) {
                return { ok: false, reason: 'dim' as const, dim: queryVec.length, iframeLatencyMs: embedded.iframeLatencyMs, queryEmbedMs, embedRoute };
            }
            binaryStart = performance.now();
            const worker = this.delegates?.getBinaryWorker ? this.delegates.getBinaryWorker() : this.binaryWorker;
            binaryPromise = binaryCandidatesAsync(
                worker, frameGen, queryVec, activePacked,
                orderedChunks.length, bytesPerVec, caps.binary, mask ?? null,
            );
            return { ok: true, vector: queryVec, iframeLatencyMs: embedded.iframeLatencyMs, queryEmbedMs, embedRoute: embedded.embedRoute ?? 'iframe' };
        });
        void embedPromise.catch(() => {});

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
            await runHydrateBodies(early);
            throwIfAborted();
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
            throwIfAborted();
            await cheapYield();
            throwIfAborted();
        }

        const bm25Start = performance.now();
        if (!this.cacheManager.bm25CacheValid(orderedChunks)) {
            if (!(this.cacheManager.bm25Cache && this.coord.isWriting())) {
                await this.cacheManager.tryLoadPersistedBm25(orderedChunks);
                throwIfAborted();
                if (!this.cacheManager.bm25CacheValid(orderedChunks)) {
                    await this.cacheManager.tryLoadCrossDeviceBm25(orderedChunks);
                    throwIfAborted();
                }
            }
        }
        const bm25CacheHit = await this.cacheManager.ensureBm25(orderedChunks);
        throwIfAborted();
        if (!this.cacheManager.bm25Cache) {
            const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
            throwIfAborted();
            await runAppendSearchTelemetry(entry);
            return { results: [], entry };
        }
        if (this.cacheManager.bm25Cache && !frameBm25Coherent(frame, this.cacheManager.bm25Cache)) {
            this.onCoherenceDrift?.('search');
            const entry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
            throwIfAborted();
            await runAppendSearchTelemetry(entry);
            return { results: [], entry };
        }
        const synEnabled = this.settings.synonymExpansion;
        const { scores: bm25Scores, coverage: bm25Coverage, bound: bm25Bound } = this.cacheManager.bm25Cache!.getScoresWithCoverage(cleanedQuery, {
            boosts: this.bm25FieldBoosts(),
            fuzzy: this.settings.fuzzyEnabled ? FUZZY_BY_LENGTH : false,
            prefix: this.settings.prefixLastToken ? PREFIX_LAST_TOKEN : false,
            ...(synEnabled && this.cacheManager.synonymCache && this.cacheManager.synonymCache.mates.size > 0 && {
                synonyms: { map: this.cacheManager.synonymCache.mates, weight: SYNONYM_WEIGHT },
            }),
        });
        const bm25TopIdx = topNIndices(bm25Scores, caps.bm25, mask);
        const bm25Ms = performance.now() - bm25Start;

        const recencyTopIdx = runTopByRecency(orderedChunks, caps.recency, mask);

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
                    await runHydrateBodies(lexResults);
                    throwIfAborted();
                    const snippetChars = SNIPPET_PREVIEW_LIMITS[this.settings.snippetPreview].chars;
                    const passageTerms = buildPassageTerms(cleanedQuery, () => 0);
                    for (const r of lexResults) r.snippet = makeSnippet(r.content, passageTerms, snippetChars);
                    lexPartialMsStart;
                    await onPartial({
                        results: lexResults,
                        source: 'lexical',
                        cleanedQuery,
                    });
                    throwIfAborted();
                    lexPartialFired = true;
                }
            }
        }
        const lexPartialMs = performance.now() - lexPartialMsStart;

        const embedded = await embedPromise;
        throwIfAborted();
        const queryEmbedMs = embedded.queryEmbedMs;
        const iframeEmbedMs = embedded.iframeLatencyMs;
        const embedRoute = embedded.embedRoute;
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
            throwIfAborted();
            const entry: SearchEntry = this.emptySearchEntry(query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
            entry.nameMatchMs = parseFloat(nameMatchMs.toFixed(2));
            entry.nameHitCount = nameHits.length;
            entry.nameEarlyPainted = nameEarlyPainted;
            entry.namePartialMs = parseFloat(namePartialMs.toFixed(2));
            throwIfAborted();
            await runAppendSearchTelemetry(entry);
            return { results: [], entry };
        }
        const queryVec = embedded.vector;

        const binaryTopIdx = binaryPromise ? await binaryPromise : [];
        throwIfAborted();
        const binaryMs = binaryStart > 0 ? performance.now() - binaryStart : 0;

        const unionSet = new Set<number>();
        for (const i of binaryTopIdx) unionSet.add(i);
        const binaryCount = unionSet.size;
        for (const i of bm25TopIdx) unionSet.add(i);
        const bm25Count = unionSet.size - binaryCount;
        for (const i of recencyTopIdx) unionSet.add(i);
        const recencyCount = unionSet.size - binaryCount - bm25Count;
        const candidateIndices = Array.from(unionSet);

        const fetchStart = performance.now();
        let fp32Maybe: Array<Float32Array | null>;
        if (residentInt8 && residentScales) {
            fp32Maybe = candidateIndices.map(idx =>
                dequantizeInt8(residentInt8.subarray(idx * embDim, (idx + 1) * embDim), residentScales[idx]));
        } else {
            const candidateIds = candidateIndices.map(i => orderedIds[i]);
            fp32Maybe = await this.store.getEmbeddingsByIds(candidateIds);
            throwIfAborted();
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

        const cosineStart = performance.now();
        const denseScoresCand = cosineScores(queryVec, candidateFp32);
        const cosineMs = performance.now() - cosineStart;

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

        const results = dedupByPath(rankedPool, topK);

        await runHydrateBodies(results);
        throwIfAborted();

        const bgStats = await this.cacheManager.getDenseBgStats();
        throwIfAborted();
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
            embedRoute,
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
        throwIfAborted();
        await runAppendSearchTelemetry(entry);

        void breakdown;
        return { results, entry };
    }
}
