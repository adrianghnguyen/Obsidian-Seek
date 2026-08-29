import { describe, it, expect } from 'vitest';
import { matchNamePrefix, matchTitleAlias, titleMatchBoost, NAME_PREFIX_MIN } from './fusion';
import { collectNameHits, shouldEarlyPaint, noteBasename, NAME_EARLY_MAX_HITS } from './name-match';
import type { ChunkMeta } from './types';

function chunk(note_path: string, aliases: string[] = []): ChunkMeta {
    return {
        chunk_id: note_path,
        title: noteBasename(note_path),
        note_path,
        heading_path: [],
        metadata: { tags: [], aliases, created: null, modified: null, properties: {} },
        start_line: 0,
        end_line: 0,
    };
}

describe('matchNamePrefix', () => {
    it('exact title still scores like coverage precision', () => {
        const m = matchNamePrefix('eames project', 'Eames Project', []);
        expect(m.score).toBeCloseTo(1, 10);
        expect(m.basenameScore).toBeCloseTo(1, 10);
    });

    it('query subset of a dated filename scores by precision', () => {
        const m = matchNamePrefix('alex 1x1', 'Alex 1x1 2026-05-19', []);
        expect(m.score).toBeCloseTo(2 / 5, 10);
    });

    it('last-token prefix hits an alias that exact coverage misses', () => {
        expect(matchTitleAlias('alex che', 'Alex Chen', ['Alex C']).aliasCoverage).toBe(0);
        expect(titleMatchBoost('alex che', [{ note_path: 'People/Alex Chen.md', metadata: { aliases: ['Alex C'] } }])[0]).toBe(0);

        const m = matchNamePrefix('alex che', 'Alex Chen', ['Alex C']);
        expect(m.score).toBeGreaterThan(0.4);
        expect(m.basenameScore).toBeGreaterThan(m.aliasScore);
    });

    it('two-char last token prefixes (NAME_PREFIX_MIN)', () => {
        expect(NAME_PREFIX_MIN).toBe(2);
        const m = matchNamePrefix('alex ch', 'Alex Chen', []);
        expect(m.score).toBeGreaterThan(0);
        expect(matchNamePrefix('alex c', 'Alex Chen', []).score).toBe(0);
    });

    it('exact short alias still wins', () => {
        const m = matchNamePrefix('ac', 'Creative Assistant', ['ACA', 'AC']);
        expect(m.score).toBeCloseTo(1, 10);
        expect(m.bestAlias).toBe('AC');
    });

    it('earlier tokens must all sit in the name', () => {
        expect(matchNamePrefix('pixel camera review', 'Alex Chen', []).score).toBe(0);
        expect(matchNamePrefix('alex workstreams', 'Alex 1x1 2026-05-19', []).score).toBe(0);
    });

    it('stopwords in the query do not kill a name hit', () => {
        const m = matchNamePrefix('the alex chen', 'Alex Chen', []);
        expect(m.score).toBeCloseTo(1, 10);
    });
});

describe('collectNameHits / shouldEarlyPaint', () => {
    const corpus = [
        chunk('Meetings/Alex 1x1 2026-05-19.md'),
        chunk('People/Alex Chen.md', ['Alex C', 'AC']),
        chunk('Gadgets/Pixel.md'),
        chunk('People/Alex Chen.md', ['Alex C', 'AC']), // second chunk of the same note
    ];

    it('returns one hit per note, best first', () => {
        const hits = collectNameHits(corpus, 'alex che');
        expect(hits.map(h => h.notePath)).toEqual(['People/Alex Chen.md']);
        expect(hits[0].index).toBe(1);
    });

    it('filename known-item is a hit', () => {
        const hits = collectNameHits(corpus, 'alex 1x1');
        expect(hits[0].notePath).toBe('Meetings/Alex 1x1 2026-05-19.md');
        expect(shouldEarlyPaint(hits)).toBe(true);
    });

    it('topical queries with no name coverage do not early-paint', () => {
        const hits = collectNameHits(corpus, 'pixel camera review');
        expect(hits).toEqual([]);
        expect(shouldEarlyPaint(hits)).toBe(false);
    });

    it('honors the selection mask', () => {
        const mask = [false, true, true, true];
        const hits = collectNameHits(corpus, 'alex 1x1', mask);
        expect(hits.map(h => h.notePath)).not.toContain('Meetings/Alex 1x1 2026-05-19.md');
    });

    it('skips a weak, high-cardinality prefix', () => {
        const many = Array.from({ length: NAME_EARLY_MAX_HITS + 5 }, (_, i) =>
            chunk(`Notes/Checklist ${i}.md`));
        const hits = collectNameHits(many, 'ch');
        expect(hits.length).toBeGreaterThan(NAME_EARLY_MAX_HITS);
        expect(hits[0].score).toBeLessThan(0.45);
        expect(shouldEarlyPaint(hits)).toBe(false);
    });
});
