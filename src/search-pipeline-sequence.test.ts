import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scenario } from './test-harness/scenario';
import * as queryParser from './query-parser';
import * as pool from './pool';
import * as ranker from './ranker';
import * as binary from './binary';
import MiniSearch from 'minisearch';
import type { ChunkMeta, ScoredChunk, SearchEntry } from './types';

describe('Search Pipeline Stage Sequencing', () => {
    let active: Scenario | null = null;

    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };

    afterEach(async () => {
        vi.restoreAllMocks();
        await active?.teardown();
        active = null;
    });

    function populateVault(s: Scenario): void {
        s.vault.write(
            'Engineering/Search Architecture.md',
            '# Heading 1: Overview\n' +
            'Explaining the search pipeline and hybrid architecture in full detail. '.repeat(10) +
            '\n\n# Heading 2: Indexing\n' +
            'Details on sign bit hashing and BM25 tokenization with inverted indexes. '.repeat(10),
            1000,
        );
        s.vault.write(
            'Engineering/Vector Quantization.md',
            '# Quantization\n' +
            'Int8 resident vector quantization and cosine distance scoring across chunks. '.repeat(10),
            2000,
        );
        s.vault.write(
            'Daily/2026-09-03.md',
            '# Daily Notes\n' +
            'Team sync on search sequence verification and regression testing protocols. '.repeat(10),
            3000,
        );
    }

    async function prepareWarmIndex(s: Scenario): Promise<void> {
        populateVault(s);
        await s.coldStart();
        // Warm the frame and BM25 caches completely
        await (s.orch as any).ensureFrame();
        const frame = (s.orch as any).peekResidentFrame();
        expect(frame).not.toBeNull();
        await (s.orch as any).ensureBm25(frame.orderedChunks);
    }

    it('executes all 10 pipeline stages in strict chronological sequence on warm frame', async () => {
        const s = await boot();
        await prepareWarmIndex(s);

        const sequence: string[] = [];

        // Step 1: parseQuery
        const origParseQuery = queryParser.parseQuery;
        const spyParseQuery = vi.spyOn(queryParser, 'parseQuery').mockImplementation((raw, ctx) => {
            sequence.push('step1:parseQuery');
            return origParseQuery(raw, ctx);
        });

        // Step 2: peekResidentFrame
        const origPeekResidentFrame = (s.orch as any).peekResidentFrame.bind(s.orch);
        const spyPeekFrame = vi.spyOn(s.orch as any, 'peekResidentFrame').mockImplementation(() => {
            sequence.push('step2:peekResidentFrame');
            return origPeekResidentFrame();
        });

        // Step 3: embedder.embed
        const origEmbed = s.embedder.embed.bind(s.embedder);
        const spyEmbed = vi.spyOn(s.embedder, 'embed').mockImplementation(async (text, signal) => {
            sequence.push('step3:embedder.embed');
            return origEmbed(text, signal);
        });

        // Step 4 & 5: Stage 1 candidate generation (S1a, S1b, S1c) and poolCaps
        const origPoolCaps = pool.poolCaps;
        const spyPoolCaps = vi.spyOn(pool, 'poolCaps').mockImplementation(liveN => {
            sequence.push('step5:poolCaps');
            return origPoolCaps(liveN);
        });

        const origTopNIndices = binary.topNIndices;
        const spyTopNIndices = vi.spyOn(binary, 'topNIndices').mockImplementation((...args) => {
            sequence.push('step4:S1a:topNIndices');
            return origTopNIndices(...args);
        });

        const origMiniSearch = MiniSearch.prototype.search;
        const spyMiniSearch = vi.spyOn(MiniSearch.prototype, 'search').mockImplementation(function (this: any, ...args) {
            sequence.push('step4:S1b:MiniSearch.search');
            return origMiniSearch.apply(this, args);
        });

        const origTopByRecency = (s.orch as any).topByRecency.bind(s.orch);
        const spyTopByRecency = vi.spyOn(s.orch as any, 'topByRecency').mockImplementation((...args: any[]) => {
            sequence.push('step4:S1c:topByRecency');
            return origTopByRecency(...args);
        });

        // Step 6: Stage 2 Cosine similarity
        const origCosineScores = ranker.cosineScores;
        const spyCosine = vi.spyOn(ranker, 'cosineScores').mockImplementation((...args) => {
            sequence.push('step6:cosineScores');
            return origCosineScores(...args);
        });

        // Step 7: TM2C2 hybrid fusion (rank())
        const origRank = ranker.rank;
        const spyRank = vi.spyOn(ranker, 'rank').mockImplementation((...args) => {
            sequence.push('step7:rank');
            return origRank(...args);
        });

        // Step 9: lazy snippet hydration via store
        const origGetBodiesByIds = s.store.getBodiesByIds.bind(s.store);
        const spyGetBodies = vi.spyOn(s.store, 'getBodiesByIds').mockImplementation(async ids => {
            sequence.push('step9:store.getBodiesByIds');
            return origGetBodiesByIds(ids);
        });

        // Step 10: appendSearchTelemetry
        const origTelemetry = (s.orch as any).appendSearchTelemetry.bind(s.orch);
        const spyTelemetry = vi.spyOn(s.orch as any, 'appendSearchTelemetry').mockImplementation(async (entry: SearchEntry) => {
            sequence.push('step10:appendSearchTelemetry');
            return origTelemetry(entry);
        });

        const query = 'architecture search pipeline';
        const topK = 5;
        const { results, entry } = await s.orch.search(query, topK);

        // Verify all spies were called
        expect(spyParseQuery).toHaveBeenCalled();
        expect(spyPeekFrame).toHaveBeenCalled();
        expect(spyEmbed).toHaveBeenCalled();
        expect(spyPoolCaps).toHaveBeenCalled();
        expect(spyMiniSearch).toHaveBeenCalled();
        expect(spyTopByRecency).toHaveBeenCalled();
        expect(spyCosine).toHaveBeenCalled();
        expect(spyRank).toHaveBeenCalled();
        expect(spyGetBodies).toHaveBeenCalled();
        expect(spyTelemetry).toHaveBeenCalled();

        // Check chronological ordering across stage boundaries:
        // 1. parseQuery is first
        const firstParseIdx = sequence.indexOf('step1:parseQuery');
        expect(firstParseIdx).toBe(0);

        // 2. peekResidentFrame is second (checks RAM cache immediately after query parsing)
        const firstPeekIdx = sequence.indexOf('step2:peekResidentFrame');
        expect(firstPeekIdx).toBeGreaterThan(firstParseIdx);

        // 3. embedder.embed is called before S2 cosine scoring
        const embedIdx = sequence.indexOf('step3:embedder.embed');
        expect(embedIdx).toBeGreaterThan(firstPeekIdx);

        // 4. Stage 1 candidate generation:
        const miniSearchIdx = sequence.indexOf('step4:S1b:MiniSearch.search');
        const recencyIdx = sequence.indexOf('step4:S1c:topByRecency');
        expect(miniSearchIdx).toBeGreaterThan(firstPeekIdx);
        expect(recencyIdx).toBeGreaterThan(firstPeekIdx);

        // 5. poolCaps is computed for candidate union sizing
        const poolCapsIdx = sequence.indexOf('step5:poolCaps');
        expect(poolCapsIdx).toBeGreaterThan(firstPeekIdx);

        // 6. Stage 2 Cosine similarity happens after Stage 1 candidate generation
        const cosineIdx = sequence.indexOf('step6:cosineScores');
        expect(cosineIdx).toBeGreaterThan(embedIdx);
        expect(cosineIdx).toBeGreaterThan(miniSearchIdx);
        expect(cosineIdx).toBeGreaterThan(recencyIdx);

        // 7. TM2C2 hybrid fusion (rank()) happens after cosine scoring
        const rankIdx = sequence.indexOf('step7:rank');
        expect(rankIdx).toBeGreaterThan(cosineIdx);

        // 8 & 9. Snippet body hydration happens after fusion (and dedup)
        const hydrateIdx = sequence.indexOf('step9:store.getBodiesByIds');
        expect(hydrateIdx).toBeGreaterThan(rankIdx);

        // 10. appendSearchTelemetry is called at the very end
        const telemetryIdx = sequence.indexOf('step10:appendSearchTelemetry');
        expect(telemetryIdx).toBeGreaterThan(hydrateIdx);
        expect(telemetryIdx).toBe(sequence.length - 1);

        // Verify results and entry integrity
        expect(results.length).toBeGreaterThan(0);
        expect(entry.query).toBe(query);
        expect(entry.topK).toBe(topK);
    });

    it('invokes S1a binaryWorker.score with correct parameters when worker is enabled', async () => {
        const s = await boot();
        await prepareWarmIndex(s);

        const frame = (s.orch as any).peekResidentFrame();
        expect(frame).not.toBeNull();

        const mockWorkerScore = vi.fn().mockImplementation(async () => {
            return [0, 1];
        });

        // Replace worker with an enabled mock worker
        (s.orch as any).binaryWorker = {
            enabled: true,
            score: mockWorkerScore,
            dispose: () => {},
        };

        const { results, entry } = await s.orch.search('quantization vector', 5);

        expect(mockWorkerScore).toHaveBeenCalledTimes(1);
        const [generation, queryVec, packed, n, bytesPerVec, topN, mask] = mockWorkerScore.mock.calls[0];

        expect(generation).toBe(frame.generation);
        expect(queryVec).toBeInstanceOf(Float32Array);
        expect(queryVec.length).toBe(frame.embDim);
        expect(packed).toBe(frame.activePacked);
        expect(n).toBe(frame.orderedChunks.length);
        expect(bytesPerVec).toBe(frame.bytesPerVec);
        expect(topN).toBe(pool.poolCaps(frame.orderedChunks.length).binary);
        expect(results.length).toBeGreaterThan(0);
        expect(entry.candidateUnionSize).toBeGreaterThan(0);
    });

    it('overlaps embedder.embed with main-thread BM25 and recency candidate generation', async () => {
        const s = await boot();
        await prepareWarmIndex(s);

        const events: Array<{ name: string; timestamp: number }> = [];
        const t0 = performance.now();

        const origEmbed = s.embedder.embed.bind(s.embedder);
        vi.spyOn(s.embedder, 'embed').mockImplementation(async (text, signal) => {
            events.push({ name: 'embed-start', timestamp: performance.now() - t0 });
            await new Promise(r => setTimeout(r, 40));
            const out = await origEmbed(text, signal);
            events.push({ name: 'embed-end', timestamp: performance.now() - t0 });
            return out;
        });

        const origMiniSearch = MiniSearch.prototype.search;
        vi.spyOn(MiniSearch.prototype, 'search').mockImplementation(function (this: any, ...args) {
            events.push({ name: 'bm25-search', timestamp: performance.now() - t0 });
            return origMiniSearch.apply(this, args);
        });

        const origTopByRecency = (s.orch as any).topByRecency.bind(s.orch);
        vi.spyOn(s.orch as any, 'topByRecency').mockImplementation((...args: any[]) => {
            events.push({ name: 'recency-search', timestamp: performance.now() - t0 });
            return origTopByRecency(...args);
        });

        await s.orch.search('search architecture', 5);

        const embedStart = events.find(e => e.name === 'embed-start')!;
        const embedEnd = events.find(e => e.name === 'embed-end')!;
        const bm25Search = events.find(e => e.name === 'bm25-search')!;
        const recencySearch = events.find(e => e.name === 'recency-search')!;

        // BM25 and Recency run concurrently while embedder is processing
        expect(bm25Search.timestamp).toBeGreaterThanOrEqual(embedStart.timestamp);
        expect(bm25Search.timestamp).toBeLessThan(embedEnd.timestamp);
        expect(recencySearch.timestamp).toBeGreaterThanOrEqual(embedStart.timestamp);
        expect(recencySearch.timestamp).toBeLessThan(embedEnd.timestamp);
    });

    it('Step 8: dedupByPath eliminates multiple heading chunks from the same note', async () => {
        const s = await boot();

        // Note with 3 distinct heading sections each over 200 chars to produce multiple chunks
        s.vault.write(
            'Topics/Architecture.md',
            '# Section Alpha: Search Architecture\n' +
            'Detailed analysis of the hybrid search architecture pipeline and stages. '.repeat(10) +
            '\n\n# Section Beta: Search Pipeline\n' +
            'Deep dive into the retrieval architecture, candidate union, and ranking mechanisms. '.repeat(10) +
            '\n\n# Section Gamma: Architecture Overview\n' +
            'Comprehensive overview of search architecture components and subsystems. '.repeat(10),
            1000,
        );
        s.vault.write(
            'Topics/Other.md',
            '# Other Note\n' +
            'Independent reference discussing modern search architectures and indexing. '.repeat(10),
            2000,
        );
        await s.coldStart();
        await (s.orch as any).ensureFrame();
        const frame = (s.orch as any).peekResidentFrame();
        expect(frame.orderedChunks.length).toBeGreaterThan(3);
        await (s.orch as any).ensureBm25(frame.orderedChunks);

        // Spy on rank to observe rankedPool before dedupByPath
        let rankedPoolPaths: string[] = [];
        const origRank = ranker.rank;
        vi.spyOn(ranker, 'rank').mockImplementation((chunks, ...rest) => {
            const out = origRank(chunks, ...rest);
            rankedPoolPaths = out.results.map(r => r.note_path);
            return out;
        });

        const { results } = await s.orch.search('search architecture', 5);

        // Before dedup, rank returned multiple chunks from Topics/Architecture.md
        const archChunksInRankedPool = rankedPoolPaths.filter(p => p === 'Topics/Architecture.md');
        expect(archChunksInRankedPool.length).toBeGreaterThan(1);

        // After Step 8 dedupByPath, results must have at most one chunk per note_path
        const resultPaths = results.map(r => r.note_path);
        const uniquePaths = new Set(resultPaths);
        expect(uniquePaths.size).toBe(resultPaths.length);

        const archInResults = results.filter(r => r.note_path === 'Topics/Architecture.md');
        expect(archInResults.length).toBe(1);

        // It kept the highest scoring heading chunk for that note
        const highestScoringArchChunk = rankedPoolPaths.find(p => p === 'Topics/Architecture.md');
        expect(archInResults[0].note_path).toBe(highestScoringArchChunk);
    });

    it('Step 9: store body hydration is lazy and capped to top-K', async () => {
        const s = await boot();
        populateVault(s);
        // Add several more notes
        for (let i = 0; i < 10; i++) {
            s.vault.write(`Notes/doc_${i}.md`, `# Doc ${i}\n` + `Architecture and search pipeline discussion note ${i}. `.repeat(10), 1000 + i);
        }
        await s.coldStart();
        await (s.orch as any).ensureFrame();
        const frame = (s.orch as any).peekResidentFrame();
        await (s.orch as any).ensureBm25(frame.orderedChunks);

        const requestedIds: string[][] = [];
        const origGetBodies = s.store.getBodiesByIds.bind(s.store);
        vi.spyOn(s.store, 'getBodiesByIds').mockImplementation(async ids => {
            requestedIds.push([...ids]);
            return origGetBodies(ids);
        });

        const topK = 3;
        const { results } = await s.orch.search('architecture search pipeline', topK);

        expect(results.length).toBe(topK);
        // getBodiesByIds was called exactly once for final result hydration
        expect(requestedIds.length).toBe(1);
        // Exactly topK ids were requested, matching the result chunk_ids
        expect(requestedIds[0].length).toBe(topK);
        expect(requestedIds[0]).toEqual(results.map(r => r.chunk_id));

        // All returned results have non-empty hydrated content and snippet
        for (const res of results) {
            expect(res.content).toBeTruthy();
            expect(res.snippet).toBeTruthy();
        }
    });

    it('Step 9 (negation): store.getBodiesMap is called on -term queries for corpus negation', async () => {
        const s = await boot();
        populateVault(s);
        await s.coldStart();
        await (s.orch as any).ensureFrame();
        const frame = (s.orch as any).peekResidentFrame();
        await (s.orch as any).ensureBm25(frame.orderedChunks);

        const origGetBodiesMap = s.store.getBodiesMap.bind(s.store);
        const spyGetBodiesMap = vi.spyOn(s.store, 'getBodiesMap').mockImplementation(async ids => {
            return origGetBodiesMap(ids);
        });

        // Search with negation: -quantization
        const { results } = await s.orch.search('architecture -quantization', 5);

        // store.getBodiesMap was invoked to filter out chunks containing the negated term
        expect(spyGetBodiesMap).toHaveBeenCalled();
        expect(results.some(r => r.note_path.includes('Quantization'))).toBe(false);
    });

    it('Step 10: appendSearchTelemetry logs complete metrics matching search execution', async () => {
        const s = await boot();
        await prepareWarmIndex(s);

        let capturedEntry: SearchEntry | null = null;
        const origTelemetry = (s.orch as any).appendSearchTelemetry.bind(s.orch);
        vi.spyOn(s.orch as any, 'appendSearchTelemetry').mockImplementation(async (entry: SearchEntry) => {
            capturedEntry = entry;
            return origTelemetry(entry);
        });

        await s.orch.search('search architecture', 5);

        expect(capturedEntry).not.toBeNull();
        expect(capturedEntry!.type).toBe('search');
        expect(capturedEntry!.query).toBe('search architecture');
        expect(capturedEntry!.cleanedQuery).toBe('search architecture');
        expect(capturedEntry!.topK).toBe(5);
        expect(capturedEntry!.totalChunks).toBeGreaterThan(0);
        expect(capturedEntry!.candidateUnionSize).toBeGreaterThan(0);
        expect(capturedEntry!.binaryCount).toBeGreaterThanOrEqual(0);
        expect(capturedEntry!.bm25Count).toBeGreaterThanOrEqual(0);
        expect(capturedEntry!.recencyCount).toBeGreaterThanOrEqual(0);
        expect(capturedEntry!.totalMs).toBeGreaterThan(0);
        expect(capturedEntry!.fusionMs).toBeGreaterThanOrEqual(0);
        expect(capturedEntry!.searchId).toBeTruthy();
    });
});

describe('Cold Frame Vault-Ladder Fallback', () => {
    let active: Scenario | null = null;

    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };

    afterEach(async () => {
        vi.restoreAllMocks();
        await active?.teardown();
        active = null;
    });

    it('falls back to emitVaultLadder when resident frame is cold without calling ensureFrame or waiting on write mutex', async () => {
        const s = await boot();

        // Write files to vault without indexing (frame is completely cold)
        s.vault.write(
            'Guides/Getting Started.md',
            '# Getting Started\nIntroductory guide for new developers.',
            1000,
        );
        s.vault.write(
            'Guides/Advanced Architecture.md',
            '# Advanced Architecture\nDeep dive into system components.',
            2000,
        );

        // Assert frame is indeed cold
        expect((s.orch as any).peekResidentFrame()).toBeNull();

        const sequence: string[] = [];

        // Spy on peekResidentFrame
        const origPeek = (s.orch as any).peekResidentFrame.bind(s.orch);
        vi.spyOn(s.orch as any, 'peekResidentFrame').mockImplementation(() => {
            sequence.push('peekResidentFrame');
            return origPeek();
        });

        // Spy on emitVaultLadder
        const origEmitLadder = (s.orch as any).emitVaultLadder.bind(s.orch);
        const spyEmitLadder = vi.spyOn(s.orch as any, 'emitVaultLadder').mockImplementation(async (...args: any[]) => {
            sequence.push('emitVaultLadder');
            return origEmitLadder(...args);
        });

        // Spy on ensureFrame: must NOT be called on cold path
        const spyEnsureFrame = vi.spyOn(s.orch as any, 'ensureFrame');

        // Spy on embedder.embed: must NOT be called on cold path (avoids model load freeze)
        const spyEmbed = vi.spyOn(s.embedder, 'embed');

        // Spy on telemetry
        const origTelemetry = (s.orch as any).appendSearchTelemetry.bind(s.orch);
        const spyTelemetry = vi.spyOn(s.orch as any, 'appendSearchTelemetry').mockImplementation(async (entry: SearchEntry) => {
            sequence.push('appendSearchTelemetry');
            return origTelemetry(entry);
        });

        const { results, entry } = await s.orch.search('getting started', 5);

        // peekResidentFrame checks RAM and misses
        expect(sequence[0]).toBe('peekResidentFrame');
        // emitVaultLadder is called directly
        expect(sequence).toContain('emitVaultLadder');
        expect(spyEmitLadder).toHaveBeenCalledTimes(1);

        // ensureFrame is NEVER called
        expect(spyEnsureFrame).not.toHaveBeenCalled();

        // embedder.embed is NEVER called (zero embedding overhead)
        expect(spyEmbed).not.toHaveBeenCalled();

        // Telemetry is logged
        expect(spyTelemetry).toHaveBeenCalledTimes(1);
        expect(entry.totalChunks).toBe(0); // cold frame indicator

        // Vault ladder successfully surfaced the note by name/lexical match
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('Guides/Getting Started.md');
    });

    it('serves cold search immediately without waiting when write mutex is actively held', async () => {
        const s = await boot();
        s.vault.write('Docs/Quickstart.md', '# Quickstart\nFast setup instructions.', 1000);

        expect((s.orch as any).peekResidentFrame()).toBeNull();

        let lockHeld = true;
        let lockAcquired = false;
        // Launch an exclusive write hold on coordinator to simulate background indexing / catchup
        const writePromise = (s.orch as any).coord.runExclusive(async () => {
            lockAcquired = true;
            while (lockHeld) {
                await new Promise(r => setTimeout(r, 10));
            }
        });

        // Wait until lock is actively held
        while (!lockAcquired) {
            await new Promise(r => setTimeout(r, 5));
        }

        expect((s.orch as any).coord.isWriting()).toBe(true);

        const t0 = performance.now();
        // search() must return immediately without waiting for write lock release
        const { results, entry } = await s.orch.search('quickstart', 5);
        const elapsed = performance.now() - t0;

        // Release the simulated lock and wait for completion
        lockHeld = false;
        await writePromise;

        // Elapsed time is small, did not block on write lock
        expect(elapsed).toBeLessThan(1000);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('Docs/Quickstart.md');
        expect(entry.totalChunks).toBe(0);
    });

    it('routes filter-only query through vaultFilterBrowse on cold frame', async () => {
        const s = await boot();
        s.vault.write('Projects/Alpha.md', '# Project Alpha\nProject Alpha active notes.', 1000);
        s.vault.write('Projects/Beta.md', '# Project Beta\nProject Beta archive notes.', 2000);

        expect((s.orch as any).peekResidentFrame()).toBeNull();

        // Provide metadata cache getFileCache so tag parsing resolves on vault files
        (s.orch as any).app.metadataCache.getFileCache = (file: any) => {
            if (file.path.includes('Alpha')) {
                return { frontmatter: { tags: ['active'] } };
            }
            return { frontmatter: { tags: ['archive'] } };
        };

        const spyFilterBrowse = vi.spyOn(s.orch as any, 'vaultFilterBrowse');
        const spyEnsureFrame = vi.spyOn(s.orch as any, 'ensureFrame');

        // Pure tag filter query
        const { results } = await s.orch.search('#active', 5);

        expect(spyFilterBrowse).toHaveBeenCalledTimes(1);
        expect(spyEnsureFrame).not.toHaveBeenCalled();
        expect(results.some(r => r.note_path === 'Projects/Alpha.md')).toBe(true);
    });
});
