import { describe, expect, it } from 'vitest';
import {
    INDEXING_STALL_TIMEOUT_MS,
    indexingProgressKey,
    indexingStallDetected,
    indexingWorkActive,
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
});
