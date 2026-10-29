import { describe, it, expect } from 'vitest';
import {
    MINOR_CATCHUP_FRACTION,
    classifyCatchUpPresentation,
    honestIndexingRemaining,
    isSmallCatchUpPass,
    shouldPreferPassCountsOverCoverage,
} from './catch-up-presentation';

describe('isSmallCatchUpPass', () => {
    it(`uses ${MINOR_CATCHUP_FRACTION} of inventory as the boundary`, () => {
        expect(isSmallCatchUpPass(1, 244)).toBe(true);
        expect(isSmallCatchUpPass(29, 3000)).toBe(true);
        expect(isSmallCatchUpPass(30, 3000)).toBe(false);
        expect(isSmallCatchUpPass(0, 100)).toBe(false);
    });
});

describe('classifyCatchUpPresentation', () => {
    it('classifies 1-file catch-up on a populated vault as quiet', () => {
        const presentation = classifyCatchUpPresentation({
            goodEnough: true,
            inventoryFiles: 244,
            indexingActive: true,
            job: { done: 0, total: 1, kind: 'catchup' },
        });
        expect(presentation).toBe('quiet');
    });
});

describe('shouldPreferPassCountsOverCoverage', () => {
    it('prefers pass counts for catchup kind and for tiny passes without kind', () => {
        expect(shouldPreferPassCountsOverCoverage({ jobKind: 'catchup' })).toBe(true);
        expect(shouldPreferPassCountsOverCoverage({ jobKind: 'full' })).toBe(false);
        expect(shouldPreferPassCountsOverCoverage({
            jobKind: null,
            passTotal: 2,
            inventoryFiles: 244,
        })).toBe(true);
        expect(shouldPreferPassCountsOverCoverage({
            jobKind: null,
            passTotal: 500,
            inventoryFiles: 244,
        })).toBe(false);
    });
});

describe('honestIndexingRemaining', () => {
    it('replaces inventory remaining 0 with dirty-queue size', () => {
        expect(honestIndexingRemaining({
            remaining: 0,
            mode: 'indexing',
            job: null,
            dirtyQueueSize: 3,
            flushing: true,
        })).toBe(3);
    });

    it('uses ellipsis when flushing without a job or dirty queue', () => {
        expect(honestIndexingRemaining({
            remaining: 0,
            mode: 'indexing',
            job: null,
            flushing: true,
        })).toBeNull();
    });
});
