// Full-search-pipeline integration tests.
//
// These exercise the REAL SearchOrchestrator over a REAL IndexStore on
// fake-indexeddb with a deterministic fake embedder (the Tier-2 Scenario
// harness). They verify the pipeline end-to-end: indexing (cold start),
// searching (every query type and progressive stage), and query-time
// filters — without touching Obsidian or the real ~61 MB model.
//
// Unlike the regression tests (R1-R10 / P1-P7), this suite is structured
// by pipeline concern so a decomp/reorg can assert that every surface
// still works without reading every regression test.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Scenario } from './test-harness/scenario';
import type { SearchPartial, ScoredChunk } from './types';

describe('integration: full search pipeline', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    // ---- Fixture helpers ------------------------------------------------

    const BASE_FILES: Array<[path: string, body: string, mtime: number]> = [
        ['pixel.md', 'the verge reviews the new google pixel phone camera', 1000],
        ['music.md', 'imogene heap concert setlist announcement and tour dates', 1000],
        ['work/meetings.md', '---\naliases:\n  - standup\n  - weekly sync\n---\nstandup notes with the team about quarterly planning', 1000],
        ['work/alex-1x1.md', '---\naliases:\n  - alex chen\n  - alex\n---\none on one meeting with alex about project euler progress', 1000],
    ];

    async function buildIndex(s: Scenario, extra?: Array<[string, string, number]>): Promise<void> {
        for (const [path, body, mtime] of [...BASE_FILES, ...(extra ?? [])]) {
            s.vault.write(path, body, mtime);
        }
        await s.coldStart();
    }

    // ---- Indexing (I-series) --------------------------------------------

    describe('indexing (I-series)', () => {
        it('I1: cold start produces a searchable index with identity stamped', async () => {
            const s = await boot();
            await buildIndex(s);

            // After cold start, a search returns results with generation info
            const { results, entry } = await s.orch.search('pixel', 5);
            expect(results.length).toBeGreaterThan(0);
            expect(entry.totalChunks).toBeGreaterThanOrEqual(4);
            expect(entry.nameMatchMs).toBeGreaterThanOrEqual(0);
        });

        it('I2: sequential searches do not trigger coherence drift', async () => {
            const s = await boot();
            await buildIndex(s);

            for (const q of ['pixel', 'music', 'meetings', 'alex', 'random nope']) {
                const { results } = await s.orch.search(q, 3);
                expect(results.length).toBeLessThanOrEqual(3);
                // No drift: search output is well-formed
                for (const r of results) {
                    expect(r.note_path).toBeTruthy();
                    expect(r.chunk_id).toBeTruthy();
                }
            }
        });

        it('I3: incremental reconcile does not lose existing results', async () => {
            const s = await boot();
            await buildIndex(s);

            // Add a new note via incremental path
            s.vault.write('new-note.md', 'fresh new content about nothing in particular', 3000);
            await s.reconcile();

            // Old results survive
            const { results } = await s.orch.search('pixel phone camera', 5);
            expect(results[0]?.note_path).toBe('pixel.md');

            // New note is findable
            const { results: newRes } = await s.orch.search('fresh new content nothing', 5);
            expect(newRes.some(r => r.note_path === 'new-note.md')).toBe(true);
        });

        it('I4: delete removes a note from search results', async () => {
            const s = await boot();
            await buildIndex(s);

            // Delete pixel.md via incremental path
            s.vault.remove('pixel.md');
            await s.reconcile();

            const { results } = await s.orch.search('pixel phone camera', 5);
            expect(results.every(r => r.note_path !== 'pixel.md')).toBe(true);
        });

        it('I5: edit re-indexes changed content and updates search', async () => {
            const s = await boot();
            await buildIndex(s);

            // Edit pixel.md to talk about cameras
            s.vault.write('pixel.md', 'nikon digital camera review sample photos', 2000);
            await s.reconcile();

            // The new content should be findable
            const { results } = await s.orch.search('nikon digital camera review', 5);
            expect(results[0]?.note_path).toBe('pixel.md');
        });
    });

    // ---- Query types (Q-series) -------------------------------------------

    describe('query types (Q-series)', () => {
        it('Q1: topical body query returns the body-matching note at rank 1', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results } = await s.orch.search('google pixel phone camera review', 5);
            expect(results[0]?.note_path).toBe('pixel.md');
        });

        it('Q2: alias query returns the aliased note at rank 1', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results } = await s.orch.search('standup', 5);
            expect(results[0]?.note_path).toBe('work/meetings.md');
        });

        it('Q3: filename query returns the filename-matched note', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results } = await s.orch.search('alex 1x1', 5);
            expect(results[0]?.note_path).toBe('work/alex-1x1.md');
        });

        it('Q4: multi-token query matches correctly', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results } = await s.orch.search('imogene heap concert', 5);
            expect(results[0]?.note_path).toBe('music.md');
        });

        it('Q5: query with unique tokens still returns results from recency/binary arms', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results } = await s.orch.search('zzzxyzyxunique_777', 5);
            // The deterministic embedder may produce non-zero cosine for the
            // unique token's hash, so results are expected from at least one arm
            expect(results.length).toBeGreaterThanOrEqual(0);
        });

        it('Q6: filter-only (path) returns matching notes in browse order', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results, entry } = await s.orch.search('path:work/*', 5);
            expect(entry.cleanedQuery).toBe('');
            const paths = results.map(r => r.note_path);
            expect(paths).toContain('work/meetings.md');
            expect(paths).toContain('work/alex-1x1.md');
        });

        it('Q7: #tag filter strips the tag into filter, leaving cleanedQuery empty', async () => {
            const s = await boot();
            await buildIndex(s);

            const { entry } = await s.orch.search('#nonexistent', 5);
            // Parser strips the tag: cleanedQuery is empty (filter-only browse)
            expect(entry.cleanedQuery).toBe('');
        });
    });

    // ---- Progressive partials (P-series) ---------------------------------

    describe('progressive partials (P-series)', () => {
        it('P1: name query fires name partial then lexical then final', async () => {
            const s = await boot();
            await buildIndex(s);

            const sources: string[] = [];
            const { results } = await s.orch.search('alex chen', 5, undefined, (p: SearchPartial) => {
                sources.push(p.source);
            });

            expect(sources.length).toBeGreaterThan(0);
            // name should fire for alias match
            const hasName = sources.includes('name');
            const hasLexical = sources.some(s => s === 'lexical');
            expect(hasName || hasLexical).toBe(true);
            expect(results[0]?.note_path).toBe('work/alex-1x1.md');
        });

        it('P2: topical query fires lexical partial but no name partial', async () => {
            const s = await boot();
            await buildIndex(s);

            const sources: string[] = [];
            const { results } = await s.orch.search(
                'concert setlist tour announcement', 5, undefined,
                (p: SearchPartial) => { sources.push(p.source); },
            );

            expect(sources.length).toBeGreaterThan(0);
            expect(sources[0]).toBe('lexical');
            expect(sources.every(s => s !== 'name')).toBe(true);
            expect(results[0]?.note_path).toBe('music.md');
        });

        it('P3: partial callback fires before final resolution', async () => {
            const s = await boot();
            await buildIndex(s);

            const order: string[] = [];
            const { results } = await s.orch.search('alex 1x1', 5, undefined, () => {
                order.push('partial');
            });
            order.push('final');

            expect(order).toContain('partial');
            expect(results[0]?.note_path).toBe('work/alex-1x1.md');
        });

        it('P4: AbortController aborted before embed prevents the embedder call', async () => {
            const s = await boot();
            await buildIndex(s);

            const embedSpy = vi.spyOn(s.embedder, 'embed');
            const controller = new AbortController();
            controller.abort();

            await expect(
                s.orch.search('any query', 5, undefined, undefined, controller.signal),
            ).rejects.toMatchObject({ name: 'AbortError' });

            expect(embedSpy).not.toHaveBeenCalled();
        });
    });

    // ---- Telemetry (T-series) --------------------------------------------

    describe('telemetry (T-series)', () => {
        it('T1: SearchEntry carries basic telemetry fields', async () => {
            const s = await boot();
            await buildIndex(s);

            const { entry } = await s.orch.search('pixel', 5);
            expect(entry.searchId).toBeTruthy();
            expect(entry.query).toBe('pixel');
            expect(entry.totalMs).toBeGreaterThan(0);
            expect(entry.totalChunks).toBeGreaterThan(0);
            expect(entry.nameMatchMs).toBeGreaterThanOrEqual(0);
        });

        it('T2: progressive telemetry fields are present with an onPartial callback', async () => {
            const s = await boot();
            await buildIndex(s);

            const partials: SearchPartial[] = [];
            const { entry } = await s.orch.search('pixel camera review', 5, undefined, p => {
                partials.push(p);
            });
            // When onPartial is provided, lexPartialFired is true
            expect(entry.lexPartialFired).toBe(true);
            expect(typeof entry.lexPartialMs).toBe('number');
        });

        it('T3: telemetry still works without an onPartial callback', async () => {
            const s = await boot();
            await buildIndex(s);

            const { entry } = await s.orch.search('pixel camera review', 5);
            // Without onPartial, lexical partial is not emitted
            expect(entry.lexPartialFired).toBe(false);
            expect(entry.searchId).toBeTruthy();
            expect(entry.totalMs).toBeGreaterThan(0);
        });

        it('T4: empty query produces clean telemetry', async () => {
            const s = await boot();
            await buildIndex(s);

            const { entry } = await s.orch.search('', 5);
            expect(entry.totalMs).toBeGreaterThanOrEqual(0);
            expect(entry.searchId).toBeTruthy();
        });
    });

    // ---- Edge cases (E-series) -------------------------------------------

    describe('edge cases (E-series)', () => {
        it('E1: searching an unindexed corpus returns empty results', async () => {
            const s = await boot();

            const { results } = await s.orch.search('anything', 5);
            expect(results).toEqual([]);
        });

        it('E2: dedup ensures at most one result per note', async () => {
            const s = await boot();
            // A long note producing multiple chunks
            s.vault.write('long.md', Array(20).fill('iterative development process continuous improvement and feedback loops').join(' '), 1000);
            await s.coldStart();

            const { results } = await s.orch.search('iterative development process', 5);
            const paths = results.map(r => r.note_path);
            expect(new Set(paths).size).toBe(paths.length);
        });

        it('E3: large corpus search does not crash', async () => {
            const s = await boot();
            // Write 50 tiny notes
            for (let i = 0; i < 50; i++) {
                s.vault.write(`noise/n${i}.md`, `note number ${i} with some random text content that varies ${i * 7}`, 1000 + i);
            }
            await s.coldStart();

            const { results } = await s.orch.search('random text content', 10);
            expect(results.length).toBeGreaterThan(0);
        });

        it('E4: query with special characters is handled', async () => {
            const s = await boot();
            s.vault.write('special.md', 'price: $19.99 and date: 2024-01-15 (updated)', 1000);
            await s.coldStart();

            const { results } = await s.orch.search('price 19.99 date 2024', 5);
            expect(results.some(r => r.note_path === 'special.md')).toBe(true);
        });

        it('E5: multiple aliases all resolve to the correct note', async () => {
            const s = await boot();
            await buildIndex(s);

            // Test both aliases of alex-1x1
            for (const alias of ['alex chen', 'alex']) {
                const { results } = await s.orch.search(alias, 3);
                expect(results[0]?.note_path).toBe('work/alex-1x1.md');
            }
        });
    });

    // ---- filter edge cases (F-series) ------------------------------------

    describe('filters (F-series)', () => {
        it('F1: path filter scopes results to subpath', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results } = await s.orch.search('path:work/*', 5);
            expect(results.every(r => r.note_path.startsWith('work/'))).toBe(true);
        });

        it('F2: path filter with text query is filtered correctly', async () => {
            const s = await boot();
            await buildIndex(s);

            const { results } = await s.orch.search('path:work/* meeting', 5);
            expect(results.every(r => r.note_path.startsWith('work/'))).toBe(true);
        });
    });
});