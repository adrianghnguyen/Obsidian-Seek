import { describe, it, expect } from 'vitest';
import { assessIndexScaling, summarizeScalingHistory } from './scaling-health';
import type { DeltaApplyEntry, IndexCompleteEntry } from '../types/log';

function makeIndex(overrides: Partial<IndexCompleteEntry> = {}): IndexCompleteEntry {
    return {
        type: 'index-complete',
        timestamp: '2026-11-27T04:00:00.000Z',
        mode: 'incremental',
        dtype: 'q4',
        embeddingDim: 768,
        filesIndexed: 20,
        committedFilePaths: [],
        chunksIndexed: 80,
        vectorsWritten: 80,
        filesSkippedError: 0,
        embedRecycles: 0,
        chunkDurationMs: 1_000,
        diffDurationMs: 200,
        embedDurationMs: 8_000,
        bm25DurationMs: 0,
        commitDurationMs: 500,
        totalDurationMs: 10_000,
        heapDeltaMB: null,
        storageDeltaMB: null,
        chunksPerSec: 8,
        filesPerSec: 2,
        perFileWallMs: null,
        chunksPerFile: null,
        embedBatchLatencyMs: { n: 12, min: 100, max: 350, mean: 250, p50: 250, p95: 340 },
        paceWaitMs: 10,
        gpuBusyMs: 7_500,
        persistWaitMs: 0,
        inflightHighWater: 4,
        embedInFlightMax: 10,
        pass: true,
        checks: [],
        ...overrides,
    };
}

function makeColdDelta(mutexHoldMs = 180_000): DeltaApplyEntry {
    return {
        type: 'delta-apply',
        timestamp: '2026-11-27T04:00:01.000Z',
        appliedIncrementally: false,
        fallbackReason: 'cold caches',
        removed: 2,
        added: 4,
        metaPatches: 0,
        mutexHoldMs,
    };
}

describe('assessIndexScaling', () => {
    it('classifies healthy GPU-fed passes', () => {
        const res = assessIndexScaling(makeIndex(), { configuredInFlightCap: 10 });
        expect(res.regime).toBe('healthy');
        expect(res.label).toBe('Healthy');
        expect(res.gpuOccupancyPct).toBeCloseTo(75, 1);
    });

    it('detects cold-cache-thrash when consecutive cold-cache fallbacks hold the mutex', () => {
        const entry = makeIndex({
            filesIndexed: 1,
            filesDeferred: 29,
            chunksIndexed: 4,
            commitDurationMs: 92_000,
            totalDurationMs: 176_000,
            gpuBusyMs: 280,
        });
        const res = assessIndexScaling(entry, {
            recentDeltas: [makeColdDelta(180_000), makeColdDelta(190_000), makeColdDelta(182_000)],
        });
        expect(res.regime).toBe('cold-cache-thrash');
        expect(res.label).toBe('Cold-cache thrash');
    });

    it('detects idb-contention when commit + diff dominate or budget blows on <=2 files', () => {
        const res = assessIndexScaling(makeIndex({
            filesIndexed: 1,
            filesDeferred: 29,
            chunksIndexed: 4,
            diffDurationMs: 85_000,
            commitDurationMs: 92_000,
            embedDurationMs: 300,
            totalDurationMs: 178_000,
            gpuBusyMs: 280,
        }));
        expect(res.regime).toBe('idb-contention');
        expect(res.idbSharePct).toBeGreaterThan(95);
    });

    it('detects pre-embed unaccounted IDB stalls', () => {
        const res = assessIndexScaling(makeIndex({
            filesIndexed: 5,
            filesDeferred: 0,
            chunksIndexed: 10,
            chunkDurationMs: 100,
            diffDurationMs: 0,
            embedDurationMs: 500,
            commitDurationMs: 200,
            totalDurationMs: 90_000,
            gpuBusyMs: 450,
        }));
        expect(res.regime).toBe('idb-contention');
        expect(res.unaccountedMs).toBeGreaterThan(80_000);
    });

    it('detects cap-clamped when auto cap sits at <=2 despite configured >=4', () => {
        const res = assessIndexScaling(makeIndex({
            embedInFlightMax: 2,
            chunksIndexed: 64,
        }), { configuredInFlightCap: 10 });
        expect(res.regime).toBe('cap-clamped');
        expect(res.label).toBe('Cap clamped');
    });

    it('detects tokenization-bound when chunking exceeds 30% and GPU busy < 50%', () => {
        const res = assessIndexScaling(makeIndex({
            chunksIndexed: 60,
            chunkDurationMs: 5_000,
            embedDurationMs: 4_000,
            commitDurationMs: 500,
            totalDurationMs: 10_000,
            gpuBusyMs: 3_500,
        }), { configuredInFlightCap: 10 });
        expect(res.regime).toBe('tokenization-bound');
        expect(res.label).toBe('Tokenization-bound');
    });

    it('marks 0-chunk passes as idle', () => {
        const res = assessIndexScaling(makeIndex({ chunksIndexed: 0, totalDurationMs: 500, gpuBusyMs: 0 }));
        expect(res.regime).toBe('idle');
    });
});

describe('summarizeScalingHistory', () => {
    it('aggregates regimes, median GPU busy, worst IDB share, and cold streak', () => {
        const summary = summarizeScalingHistory(
            [
                makeIndex({ gpuBusyMs: 8_000, totalDurationMs: 10_000 }),
                makeIndex({
                    filesIndexed: 1,
                    filesDeferred: 29,
                    chunksIndexed: 4,
                    commitDurationMs: 92_000,
                    totalDurationMs: 180_000,
                    gpuBusyMs: 300,
                }),
            ],
            [makeColdDelta(), makeColdDelta(), makeColdDelta()],
            10,
        );
        expect(summary.assessedPasses).toBe(2);
        expect(summary.latest?.regime).toBe('cold-cache-thrash');
        expect(summary.coldFallbackStreak).toBe(3);
        expect(summary.worstIdbSharePct).toBeGreaterThan(50);
    });
});
