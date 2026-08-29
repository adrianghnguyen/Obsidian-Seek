import { describe, it, expect } from 'vitest';
import {
    isKnownEmptyIndexWithNotes,
    shouldAutoDrainStartupCatchUp,
    resolveIndexBuildMode,
    clampCatchUpBurstMaxFiles,
    catchUpBurstLimits,
    COLD_BUILD_DIRTY_THRESHOLD,
    CATCHUP_BURST_MAX_FILES_MIN,
    CATCHUP_BURST_MAX_FILES_MAX,
    DEFAULT_CATCHUP_BURST_MAX_FILES,
} from './startup-drain';

describe('shouldAutoDrainStartupCatchUp', () => {
    it('loads and drains pending work on desktop', () => {
        expect(shouldAutoDrainStartupCatchUp({ mobile: false, catchUpPending: true })).toBe(true);
    });

    it('does not load on desktop when nothing is pending', () => {
        expect(shouldAutoDrainStartupCatchUp({ mobile: false, catchUpPending: false })).toBe(false);
    });

    it('keeps mobile lazy even when work is pending', () => {
        expect(shouldAutoDrainStartupCatchUp({ mobile: true, catchUpPending: true })).toBe(false);
    });

    it('drains an empty desktop index when the vault has notes', () => {
        expect(shouldAutoDrainStartupCatchUp({
            mobile: false, catchUpPending: false, emptyIndexWithNotes: true,
        })).toBe(true);
        expect(shouldAutoDrainStartupCatchUp({
            mobile: true, catchUpPending: false, emptyIndexWithNotes: true,
        })).toBe(false);
    });
});

describe('isKnownEmptyIndexWithNotes', () => {
    it('is true only for a probed-empty store', () => {
        expect(isKnownEmptyIndexWithNotes(0, 10)).toBe(true);
        expect(isKnownEmptyIndexWithNotes(null, 10)).toBe(false);
        expect(isKnownEmptyIndexWithNotes(400, 10)).toBe(false);
        expect(isKnownEmptyIndexWithNotes(0, 0)).toBe(false);
    });
});

describe('resolveIndexBuildMode', () => {
    it('returns idle when nothing is dirty', () => {
        expect(resolveIndexBuildMode({
            inventoryChunks: 0, noteCount: 100, dirtyCount: 0, storedFiles: 0,
        })).toBe('idle');
    });

    it('returns cold for probed-empty index with notes', () => {
        expect(resolveIndexBuildMode({
            inventoryChunks: 0, noteCount: 500, dirtyCount: 500, storedFiles: 0,
        })).toBe('cold');
    });

    it('returns cold when file records are empty and dirty exceeds threshold', () => {
        expect(resolveIndexBuildMode({
            inventoryChunks: null, noteCount: 200, dirtyCount: COLD_BUILD_DIRTY_THRESHOLD + 1, storedFiles: 0,
        })).toBe('cold');
    });

    it('returns catchup for partial backlog', () => {
        expect(resolveIndexBuildMode({
            inventoryChunks: 4000, noteCount: 500, dirtyCount: 12, storedFiles: 480,
        })).toBe('catchup');
    });

    it('does not treat unknown inventory as cold', () => {
        expect(resolveIndexBuildMode({
            inventoryChunks: null, noteCount: 10, dirtyCount: 10, storedFiles: 0,
        })).toBe('catchup');
    });
});

describe('clampCatchUpBurstMaxFiles', () => {
    it('defaults invalid values to 30', () => {
        expect(clampCatchUpBurstMaxFiles(NaN)).toBe(DEFAULT_CATCHUP_BURST_MAX_FILES);
    });

    it('clamps to 1–40', () => {
        expect(clampCatchUpBurstMaxFiles(0)).toBe(CATCHUP_BURST_MAX_FILES_MIN);
        expect(clampCatchUpBurstMaxFiles(100)).toBe(CATCHUP_BURST_MAX_FILES_MAX);
        expect(clampCatchUpBurstMaxFiles(30)).toBe(30);
    });
});

describe('catchUpBurstLimits', () => {
    it('uses mobile caps on mobile', () => {
        expect(catchUpBurstLimits({ mobile: true, burstMaxFiles: 30 })).toEqual({
            maxFiles: 3,
            budgetMs: 8000,
        });
    });

    it('uses clamped setting on desktop', () => {
        expect(catchUpBurstLimits({ mobile: false, burstMaxFiles: 8 })).toEqual({
            maxFiles: 8,
            budgetMs: 4000,
        });
    });
});
