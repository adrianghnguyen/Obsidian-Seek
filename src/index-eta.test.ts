import { describe, it, expect } from 'vitest';
import { formatRoughEta, indexPercent } from './index-eta';

describe('indexPercent', () => {
    it('rounds exact percent from done/total without claiming 100% early', () => {
        expect(indexPercent(1, 4)).toBe(25);
        expect(indexPercent(243, 4469)).toBe(5);
        expect(indexPercent(4, 4)).toBe(100);
        expect(indexPercent(3024, 3037)).toBe(99);
        expect(indexPercent(999, 1000)).toBe(99);
        expect(indexPercent(1, 1000)).toBe(1);
        expect(indexPercent(0, 1000)).toBe(0);
    });
});

describe('formatRoughEta', () => {
    it('stays hidden before warmup thresholds', () => {
        expect(formatRoughEta(10, 100, 20_000)).toBeNull();
        expect(formatRoughEta(25, 100, 10_000)).toBeNull();
    });

    it('uses coarse buckets after warmup', () => {
        expect(formatRoughEta(50, 100, 20_000)).toBe('~30s');
        expect(formatRoughEta(50, 200, 20_000)).toBe('~2 min');
        expect(formatRoughEta(50, 500, 20_000)).toBe('~5 min');
    });
});
