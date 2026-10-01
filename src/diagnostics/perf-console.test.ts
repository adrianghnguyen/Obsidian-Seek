import { describe, expect, it, vi } from 'vitest';
import {
    SEEK_PERF_PREFIX,
    SEEK_PERF_RING_SIZE,
    SeekPerfConsole,
    formatPerfLine,
} from './perf-console';

describe('SeekPerfConsole', () => {
    it('formats a single-line info payload (greppable for dev:console)', () => {
        const line = formatPerfLine({ type: 'startup-span', span: 'boot-ifi', phase: 'start' });
        expect(line.startsWith(`${SEEK_PERF_PREFIX} `)).toBe(true);
        const json = line.slice(SEEK_PERF_PREFIX.length + 1);
        expect(JSON.parse(json)).toEqual({ type: 'startup-span', span: 'boot-ifi', phase: 'start' });
        expect(line.includes('[object Object]')).toBe(false);
    });

    it('record pushes to ring and calls console.info once with one string arg', () => {
        const info = vi.fn();
        const perf = new SeekPerfConsole(5, info);
        perf.record({ type: 'startup-gate', event: 'released', elapsedMs: 12 });
        expect(info).toHaveBeenCalledTimes(1);
        const arg = info.mock.calls[0][0];
        expect(typeof arg).toBe('string');
        expect(arg).toMatch(/^\[seek:perf\] \{/);
        expect(perf.snapshot()).toHaveLength(1);
        expect(perf.snapshot()[0]).toBe(arg);
    });

    it('evicts oldest entries when ring exceeds maxSize', () => {
        const info = vi.fn();
        const perf = new SeekPerfConsole(3, info);
        for (let i = 0; i < 5; i++) perf.record({ type: 'search', totalMs: i });
        expect(perf.snapshot()).toHaveLength(3);
        const totals = perf.snapshot().map(line => JSON.parse(line.slice(SEEK_PERF_PREFIX.length + 1)).totalMs);
        expect(totals).toEqual([2, 3, 4]);
    });

    it('dump replays every ring line and returns count', () => {
        const info = vi.fn();
        const perf = new SeekPerfConsole(10, info);
        perf.record({ type: 'load', coldStartMs: 1 });
        perf.record({ type: 'load', coldStartMs: 2 });
        info.mockClear();
        const n = perf.dump();
        expect(n).toBe(2);
        expect(info).toHaveBeenCalledTimes(2);
        expect(info.mock.calls[0][0]).toContain('"coldStartMs":1');
        expect(info.mock.calls[1][0]).toContain('"coldStartMs":2');
    });

    it('clear empties the ring but dump of empty returns 0', () => {
        const info = vi.fn();
        const perf = new SeekPerfConsole(10, info);
        perf.record({ type: 'long-task', durationMs: 300 });
        perf.clear();
        expect(perf.snapshot()).toHaveLength(0);
        info.mockClear();
        expect(perf.dump()).toBe(0);
        expect(info).not.toHaveBeenCalled();
    });

    it('default ring size matches SEEK_PERF_RING_SIZE', () => {
        const info = vi.fn();
        const perf = new SeekPerfConsole(undefined, info);
        for (let i = 0; i < SEEK_PERF_RING_SIZE + 5; i++) {
            perf.record({ type: 'startup-span', n: i });
        }
        expect(perf.snapshot()).toHaveLength(SEEK_PERF_RING_SIZE);
    });

    it('recordSearch omits ranking traces', () => {
        const info = vi.fn();
        const perf = new SeekPerfConsole(10, info);
        perf.recordSearch({
            type: 'search',
            timestamp: 't',
            query: 'secret note',
            topK: 10,
            cleanedQuery: 'secret note',
            filters: null,
            idbReadMs: 1,
            binaryMs: 2,
            selectFetchMs: 3,
            alignMs: 4,
            queryEmbedMs: 5,
            iframeEmbedMs: 6,
            cosineMs: 7,
            bm25Ms: 8,
            bm25CacheHit: true,
            fusionMs: 9,
            snippetMs: 10,
            totalMs: 55,
            totalChunks: 100,
            binaryTopN: 1,
            bm25TopM: 1,
            recencyTopK: 1,
            binaryCount: 1,
            bm25Count: 1,
            recencyCount: 1,
            candidateUnionSize: 3,
            binaryCacheHit: true,
            rawDenseTop5: [{ chunk_id: 'x', score: 1 }],
            rawBm25Top5: [],
            fusedTop50: [{ chunk_id: 'x', note_path: 'a.md', rank: 1, score: 1, dense: 1, denseRaw: 1, bm25: 1, recency: 0, title_boost: 0, title: 't' }],
            alpha: 0.5,
            recencyWeight: 0,
            recencyKey: 'modified',
            bm25Coverage: true,
            prefixLastToken: false,
            synonymExpansion: false,
            searchableProperties: false,
            headingsField: false,
            bm25Bound: 1,
            searchId: 'sid',
        });
        const line = info.mock.calls[0][0] as string;
        expect(line).not.toContain('secret note');
        expect(line).not.toContain('fusedTop50');
        expect(line).toContain('"totalMs":55');
        expect(line).toContain('"searchId":"sid"');
    });
});
