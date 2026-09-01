// Regression baseline for the search pipeline.
//
// Captures the exact current behavior of SearchOrchestrator.search() so
// refactors, decomposition, and progressive-stage additions can assert
// no regression. Every test here must pass both before and after changes.
//
// Uses the Tier-2 Scenario harness (real orchestrator + real store over
// fake-indexeddb, deterministic fake embedder).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Scenario } from './test-harness/scenario';
import type { SearchPartial, ScoredChunk } from './types';

describe('search regression baseline', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    // Write 4 notes: two with topical overlap, two with aliases, so all
    // pipeline arms have a signal to score.
    const SEED_FILES: Array<[path: string, body: string, mtime: number]> = [
        ['pixel.md', 'the verge reviews the new google pixel phone camera', 1000],
        ['music.md', 'imogene heap concert setlist announcement and tour dates', 1000],
        ['work/meetings.md', '---\naliases:\n  - standup\n  - weekly sync\n---\nstandup notes with the team about quarterly planning', 1000],
        ['work/alex-1x1.md', '---\naliases:\n  - alex chen\n  - alex\n---\none on one meeting with alex about project euler progress', 1000],
    ];

    async function indexAll(s: Scenario): Promise<void> {
        for (const [path, body, mtime] of SEED_FILES) {
            s.vault.write(path, body, mtime);
        }
        await s.coldStart();
    }

    // ---- R1: Full pipeline returns correct rank-1 for topical query ----
    it('R1: topical query returns the body-matching note at rank 1', async () => {
        const s = await boot();
        await indexAll(s);

        const { results, entry } = await s.orch.search('google pixel phone camera review', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('pixel.md');
        // The query has text, not a filter-only browse
        expect(entry.cleanedQuery).not.toBe('');
    });

    // ---- R2: Full pipeline returns correct rank-1 for alias query ----
    it('R2: alias query returns the aliased note at rank 1', async () => {
        const s = await boot();
        await indexAll(s);

        const { results } = await s.orch.search('standup meeting', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('work/meetings.md');
    });

    // ---- R3: Full pipeline returns correct rank-1 for filename query ----
    it('R3: filename query returns the filename-matched note at rank 1', async () => {
        const s = await boot();
        await indexAll(s);

        const { results } = await s.orch.search('alex 1x1', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('work/alex-1x1.md');
    });

    // ---- R4: Early name paint fires, then lexical partial, then final ----
    it('R4: progressive partials fire (name -> lexical -> hybrid final)', async () => {
        const s = await boot();
        await indexAll(s);

        const partials: SearchPartial[] = [];
        const t0 = performance.now();
        void t0;

        const { results, entry } = await s.orch.search('alex 1x1', 5, undefined, (partial: SearchPartial) => {
            partials.push(partial);
        });

        // At least one partial must have fired (name or lexical or both)
        expect(partials.length).toBeGreaterThan(0);
        // The first partial should be either 'name' (if names matched) or 'lexical'
        expect(['name', 'lexical']).toContain(partials[0].source);
        // When name paint fires, it carries nameHitCount
        const namePartial = partials.find(p => p.source === 'name');
        if (namePartial) {
            expect(namePartial.nameHitCount).toBeGreaterThan(0);
        }
        // Final results must still be correct
        expect(results[0].note_path).toBe('work/alex-1x1.md');
        expect(entry.nameEarlyPainted).toBe(true);
    });

    // ---- R5: Topical query fires lexical partial, NOT name partial ----
    it('R5: topical query fires lexical partial but no name partial', async () => {
        const s = await boot();
        await indexAll(s);

        const partials: SearchPartial[] = [];
        const { results, entry } = await s.orch.search(
            'concert setlist tour announcement',
            5,
            undefined,
            p => { partials.push(p); },
        );

        // Lexical partial fires (new progressive behavior)
        expect(partials.length).toBeGreaterThan(0);
        expect(partials[0].source).toBe('lexical');
        // No name partial (no file names match this query)
        expect(partials.every(p => p.source !== 'name')).toBe(true);
        expect(entry.nameEarlyPainted).toBe(false);
        // Final results still correct
        expect(results[0]?.note_path).toBe('music.md');
    });

    // ---- R6: Filter-only query (no text) returns browse order ----
    it('R6: filter-only query returns notes in recency order', async () => {
        const s = await boot();
        await indexAll(s);

        const { results, entry } = await s.orch.search('path:work/*', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(entry.cleanedQuery).toBe('');
        const paths = results.map(r => r.note_path);
        expect(paths).toContain('work/meetings.md');
        expect(paths).toContain('work/alex-1x1.md');
    });

    // ---- R7: Superseded query is aborted before embedding ----
    it('R7: an AbortController aborted before search bails without embedding', async () => {
        const s = await boot();
        await indexAll(s);
        const spy = vi.spyOn(s.embedder, 'embed');

        const controller = new AbortController();
        controller.abort();

        await expect(s.orch.search('any query', 5, undefined, undefined, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(spy).not.toHaveBeenCalled();
    });

    // ---- R8: Empty corpus returns empty results ----
    it('R8: searching an empty (unindexed) corpus returns no results', async () => {
        const s = await boot();

        const { results, entry } = await s.orch.search('anything', 5);
        expect(results).toEqual([]);
        expect(entry.searchId).toBeDefined();
    });

    // ---- R9: Partial callback fires BEFORE final search resolution ----
    it('R9: partial callback fires before final search resolution', async () => {
        const s = await boot();
        await indexAll(s);

        const order: string[] = [];
        const { results } = await s.orch.search('alex 1x1', 5, undefined, () => {
            order.push('partial');
        });
        order.push('final');

        expect(order).toContain('partial');
        expect(results[0]?.note_path).toBe('work/alex-1x1.md');
    });

    // ---- R10: Search returns deduped results (one per note) ----
    it('R10: dedupByPath ensures at most one result per note', async () => {
        const s = await boot();
        // A long note that produces multiple chunks
        s.vault.write('long.md', Array(20).fill('iterative development process continuous improvement and feedback loops').join(' '), 1000);
        await s.coldStart();

        const { results } = await s.orch.search('iterative development process', 5);
        const paths = results.map(r => r.note_path);
        expect(new Set(paths).size).toBe(paths.length);
    });
});

describe('search progressive pipeline', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    const SEED_FILES: Array<[path: string, body: string, mtime: number]> = [
        ['pixel.md', 'the verge reviews the new google pixel phone camera', 1000],
        ['music.md', 'imogene heap concert setlist announcement and tour dates', 2000],
        ['work/meetings.md', '---\naliases:\n  - standup\n  - weekly sync\n---\nstandup notes with the team about quarterly planning', 1000],
        ['work/alex-1x1.md', '---\naliases:\n  - alex chen\n  - alex\n---\none on one meeting with alex about project euler progress', 1000],
    ];

    async function indexAll(s: Scenario): Promise<void> {
        for (const [path, body, mtime] of SEED_FILES) {
            s.vault.write(path, body, mtime);
        }
        await s.coldStart();
    }

    // ---- P1: Lexical partial fires BEFORE embed completes ----
    it('P1: lexical partial fires before the embed promise resolves', async () => {
        const s = await boot();
        await indexAll(s);

        const events: Array<{ t: number; event: string }> = [];
        const t0 = performance.now();

        // Slow down the embedder to create clear ordering
        const origEmbed = s.embedder.embed.bind(s.embedder);
        s.embedder.embed = async (text: string) => {
            await new Promise(r => setTimeout(r, 30));
            return origEmbed(text);
        };

        let firstPartialSource: string | null = null;
        const { results, entry } = await s.orch.search('concert setlist tour announcement', 5, undefined, (partial) => {
            events.push({ t: performance.now() - t0, event: `partial-${partial.source}` });
            if (!firstPartialSource) firstPartialSource = partial.source;
        });
        events.push({ t: performance.now() - t0, event: 'resolve' });

        // The lexical partial fires before the final resolve
        expect(firstPartialSource).toBe('lexical');
        const lexEvent = events.find(e => e.event === 'partial-lexical');
        const resolveEvent = events.find(e => e.event === 'resolve');
        expect(lexEvent).toBeDefined();
        expect(resolveEvent).toBeDefined();
        expect(lexEvent!.t).toBeLessThan(resolveEvent!.t);

        // Lexical telemetry recorded
        expect(entry.lexPartialFired).toBe(true);
        expect(entry.lexPartialMs).toBeGreaterThan(0);
        // Final results still correct
        expect(results[0]?.note_path).toBe('music.md');
    });

    // ---- P2: Lexical results have correct ranking without dense scores ----
    it('P2: lexical partial returns rank-1 that matches BM25 + title boost (not dense cosine)', async () => {
        const s = await boot();
        await indexAll(s);

        // "standup" appears in both body text and as an alias (Meetings.md)
        let lexResults: ScoredChunk[] = [];
        const { results } = await s.orch.search('standup', 5, undefined, (partial) => {
            if (partial.source === 'lexical') {
                lexResults = partial.results;
            }
        });

        expect(lexResults.length).toBeGreaterThan(0);
        // The results should be ScoredChunk with lexicalOnly flag
        expect(lexResults[0].lexicalOnly).toBe(true);
        // Final hybrid results should also be correct
        expect(results[0]?.note_path).toBe(lexResults[0]?.note_path);
    });

    // ---- P3: searchLexicalOnly() works without embedder ----
    it('P3: searchLexicalOnly() returns BM25 results without touching the embedder', async () => {
        const s = await boot();
        await indexAll(s);

        const spy = vi.spyOn(s.embedder, 'embed');
        const { results } = await s.orch.searchLexicalOnly('concert setlist tour', 5);

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('music.md');
        expect(spy).not.toHaveBeenCalled();
    });

    // ---- P4: searchLexicalOnly() fires name partial then lexical ----
    it('P4: searchLexicalOnly() fires name partial before lexical for known-item queries', async () => {
        const s = await boot();
        await indexAll(s);

        const partials: SearchPartial[] = [];
        await s.orch.searchLexicalOnly('alex 1x1', 5, (partial) => {
            partials.push(partial);
        });

        expect(partials.length).toBeGreaterThan(0);
        // Name partial should fire first (for a strong name match)
        expect(partials[0].source).toBe('name');
        expect(partials[0].nameHitCount).toBeGreaterThan(0);
    });

    // ---- P5: Lexical partial fires even without BM25 cache (warm) ----
    it('P5: lexical partial ranks by BM25 title+content boosts', async () => {
        const s = await boot();
        await indexAll(s);

        // "team planning" appears in standup notes content
        const partials: SearchPartial[] = [];
        const { results } = await s.orch.search('team planning', 5, undefined, (partial) => {
            partials.push(partial);
        });

        // Lexical partial must have been emitted
        expect(partials.some(p => p.source === 'lexical')).toBe(true);
        // The body text match outranks pure title for this query
        expect(results[0]?.note_path).toBe('work/meetings.md');
    });

    // ---- P6: Telemetry correctly records lexical partial presence ----
    it('P6: search entry carries lexPartialFired and lexPartialMs', async () => {
        const s = await boot();
        await indexAll(s);

        const { entry } = await s.orch.search('concert tour', 5, undefined, () => {});
        expect(entry.lexPartialFired).toBe(true);
        expect(entry.lexPartialMs).toBeGreaterThan(0);
        expect(entry.nameEarlyPainted).toBe(false); // no name match for "concert tour"
    });

    // ---- P7: Empty query for searchLexicalOnly returns empty ----
    it('P7: searchLexicalOnly with empty query returns no results', async () => {
        const s = await boot();
        await indexAll(s);

        const { results } = await s.orch.searchLexicalOnly('', 5);
        expect(results).toEqual([]);
    });

    // ---- P8: searchLexicalOnly builds its caches lazily on a cold session ----
    // The modal's warm-up fallback calls searchLexicalOnly BEFORE any
    // warmCaches pass (startup warm is deferred behind catch-up, and the old
    // hasBm25Cache() gate refused to search in exactly that window). The
    // lexical path must therefore build frame + BM25 from IndexedDB on first
    // use, never requiring a prior warm.
    it('P8: searchLexicalOnly works with no warm caches and no embedder (lazy frame + BM25 build)', async () => {
        const s = await boot();
        await indexAll(s);

        // Simulate the boot state the modal now serves through: cold caches,
        // model not loaded. searchLexicalOnly must still return BM25 results.
        expect(s.orch.hasBm25Cache()).toBe(false);
        const spy = vi.spyOn(s.embedder, 'embed');

        const partials: SearchPartial[] = [];
        const { results } = await s.orch.searchLexicalOnly('concert setlist tour', 5, p => { partials.push(p); });

        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('music.md');
        for (const r of results) expect(r.lexicalOnly).toBe(true);
        expect(spy).not.toHaveBeenCalled();
        // Name early paint still fires on the cold path when coverage exists.
        expect(partials.some(p => p.source === 'name' || p.source === 'lexical')).toBe(true);
    });
});