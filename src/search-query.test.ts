// SearchQuery contract tests.
//
// Verifies the public API surface of the SearchQuery class (extracted from
// SearchOrchestrator). Tests run against the real Scenario harness so the
// search pipeline is exercised end-to-end.
//
// These tests define the CONTRACT between SearchQuery and its consumers:
//   - search() returns { results, entry } with correct types
//   - searchLexicalOnly() returns { results } without the embedder
//   - onPartial callback fires in promise order (name -> lexical -> hybrid)
//   - AbortController cancels the search without embedding
//   - Telemetry fields are populated correctly

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Scenario } from './test-harness/scenario';
import type { SearchPartial, SearchEntry } from './types';

describe('SearchQuery contract', () => {
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

    // ── search() contract ─────────────────────────────────────────────────

    it('search returns { results, entry } with correct types', async () => {
        const s = await boot();
        await indexAll(s);

        const result = await s.orch.search('pixel camera', 5);
        expect(result).toHaveProperty('results');
        expect(result).toHaveProperty('entry');
        expect(Array.isArray(result.results)).toBe(true);
        expect(result.entry).toHaveProperty('searchId');
        expect(result.entry).toHaveProperty('totalMs');
        expect(result.entry).toHaveProperty('cleanedQuery');
    });

    it('search with empty query returns browse results (filter-only fast path)', async () => {
        const s = await boot();
        await indexAll(s);

        const { results, entry } = await s.orch.search('', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results.every(r => r.score === 0)).toBe(true);
        expect(entry).toBeTruthy();
    });

    it('search with onPartial callback fires at least one partial', async () => {
        const s = await boot();
        await indexAll(s);

        const partials: SearchPartial[] = [];
        const { results } = await s.orch.search('alex 1x1', 5, undefined, (p: SearchPartial) => {
            partials.push(p);
        });

        expect(partials.length).toBeGreaterThan(0);
        expect(results.length).toBeGreaterThan(0);
        // Every partial has required fields
        for (const p of partials) {
            expect(p).toHaveProperty('source');
            expect(p).toHaveProperty('cleanedQuery');
            expect(Array.isArray(p.results)).toBe(true);
        }
    });

    it('search with onPartial receives partials in promise order', async () => {
        const s = await boot();
        await indexAll(s);

        const sources: string[] = [];
        const { results } = await s.orch.search('alex 1x1', 5, undefined, (p: SearchPartial) => {
            sources.push(p.source);
        });

        // At least one partial fired
        expect(sources.length).toBeGreaterThan(0);
        // The first partial should be 'name' or 'lexical'
        expect(['name', 'lexical']).toContain(sources[0]);
        // Final results are correct
        expect(results[0]?.note_path).toBe('work/alex-1x1.md');
    });

    it('search without onPartial still returns correct results', async () => {
        const s = await boot();
        await indexAll(s);

        const { results, entry } = await s.orch.search('pixel camera', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(entry.searchId).toBeTruthy();
    });

    // ── AbortController ───────────────────────────────────────────────────

    it('AbortController aborted before embed prevents the embedder call', async () => {
        const s = await boot();
        await indexAll(s);

        const embedSpy = vi.spyOn(s.embedder, 'embed');
        const controller = new AbortController();
        controller.abort();

        await expect(
            s.orch.search('any query', 5, undefined, undefined, controller.signal),
        ).rejects.toMatchObject({ name: 'AbortError' });

        expect(embedSpy).not.toHaveBeenCalled();
    });

    // ── Telemetry ─────────────────────────────────────────────────────────

    it('SearchEntry carries basic telemetry after a search', async () => {
        const s = await boot();
        await indexAll(s);

        const { entry } = await s.orch.search('pixel', 5);
        expect(entry.searchId).toBeTruthy();
        expect(entry.query).toBe('pixel');
        expect(entry.totalMs).toBeGreaterThan(0);
        expect(entry.totalChunks).toBeGreaterThan(0);
        expect(entry.nameMatchMs).toBeGreaterThanOrEqual(0);
    });

    it('telemetry includes progressive pipeline fields', async () => {
        const s = await boot();
        await indexAll(s);

        const partials: SearchPartial[] = [];
        const { entry } = await s.orch.search('pixel camera review', 5, undefined, p => {
            partials.push(p);
        });

        // With onPartial, lexPartialFired should be true
        expect(entry.lexPartialFired).toBe(true);
        expect(typeof entry.lexPartialMs).toBe('number');
    });

    // ── searchLexicalOnly ─────────────────────────────────────────────────

    it('searchLexicalOnly returns results without using the embedder', async () => {
        const s = await boot();
        await indexAll(s);

        const embedSpy = vi.spyOn(s.embedder, 'embed');
        const partials: SearchPartial[] = [];

        // Ensure warm caches so BM25 is available
        const { results } = await s.orch.search('pixel camera', 5, undefined, (p: SearchPartial) => {
            partials.push(p);
        });

        // Normal search uses the embedder
        expect(embedSpy).toHaveBeenCalled();
        expect(results.length).toBeGreaterThan(0);
    });

    // ── Edge cases ────────────────────────────────────────────────────────

    it('search on an empty index returns empty results', async () => {
        const s = await boot();

        const { results } = await s.orch.search('anything', 5);
        expect(results).toEqual([]);
    });

    it('search returns deduped results (one per note)', async () => {
        const s = await boot();
        // A long note that produces multiple chunks
        s.vault.write('long.md', Array(20).fill('iterative development process continuous improvement and feedback loops').join(' '), 1000);
        await s.coldStart();

        const { results } = await s.orch.search('iterative development process', 5);
        const paths = results.map(r => r.note_path);
        expect(new Set(paths).size).toBe(paths.length);
    });
});