import { describe, expect, it } from 'vitest';
import {
    FULL_REINDEX_STALL_TIMEOUT_MS,
    INDEXING_STALL_TIMEOUT_MS,
    indexingProgressKey,
    indexingStallDetected,
    indexingWorkActive,
    stallTimeoutMs,
    type IndexingStallSnapshot,
} from './indexing-stall-guard';

const idle: IndexingStallSnapshot = {
    catchUpRunning: false,
    flushing: false,
    indexing: false,
    writing: false,
    jobDone: null,
    jobTotal: null,
};

describe('indexing-stall-guard', () => {
    it('treats catch-up and writers as active work', () => {
        expect(indexingWorkActive(idle)).toBe(false);
        expect(indexingWorkActive({ ...idle, catchUpRunning: true })).toBe(true);
        expect(indexingWorkActive({ ...idle, writing: true })).toBe(true);
    });

    it('fires when progress heartbeats stop while work flags stay on', () => {
        const active = { ...idle, catchUpRunning: true, jobDone: 0, jobTotal: 43 };
        const t0 = 1_000;
        expect(indexingStallDetected(t0, t0 + INDEXING_STALL_TIMEOUT_MS - 1, INDEXING_STALL_TIMEOUT_MS, active)).toBe(false);
        expect(indexingStallDetected(t0, t0 + INDEXING_STALL_TIMEOUT_MS, INDEXING_STALL_TIMEOUT_MS, active)).toBe(true);
    });

    it('does not fire when idle', () => {
        expect(indexingStallDetected(0, INDEXING_STALL_TIMEOUT_MS * 2, INDEXING_STALL_TIMEOUT_MS, idle)).toBe(false);
    });

    it('progress key changes when job counters move', () => {
        const a = indexingProgressKey({ ...idle, catchUpRunning: true, jobDone: 0, jobTotal: 10 });
        const b = indexingProgressKey({ ...idle, catchUpRunning: true, jobDone: 1, jobTotal: 10 });
        expect(a).not.toBe(b);
    });

    it('progress key changes when chunks move with files unchanged', () => {
        const a = indexingProgressKey({ ...idle, writing: true, jobDone: 60, jobTotal: 3646, jobChunks: 100 });
        const b = indexingProgressKey({ ...idle, writing: true, jobDone: 60, jobTotal: 3646, jobChunks: 108 });
        expect(a).not.toBe(b);
    });

    it('uses a longer stall timeout for a full reindex job', () => {
        expect(stallTimeoutMs({ ...idle, jobKind: 'full' })).toBe(FULL_REINDEX_STALL_TIMEOUT_MS);
        expect(stallTimeoutMs({ ...idle, jobKind: 'catchup' })).toBe(INDEXING_STALL_TIMEOUT_MS);
        expect(stallTimeoutMs(idle)).toBe(INDEXING_STALL_TIMEOUT_MS);
    });

    it('treats a large catch-up like a full pass for stall timeout', () => {
        expect(stallTimeoutMs({ ...idle, jobKind: 'catchup', jobTotal: 3853 })).toBe(FULL_REINDEX_STALL_TIMEOUT_MS);
    });

    it('progress key changes when committed inventory moves with job.done frozen', () => {
        const a = indexingProgressKey({
            ...idle, catchUpRunning: true, jobDone: 30, jobTotal: 3730, inventoryFiles: 123,
        });
        const b = indexingProgressKey({
            ...idle, catchUpRunning: true, jobDone: 30, jobTotal: 3730, inventoryFiles: 200,
        });
        expect(a).not.toBe(b);
    });
});
