import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    suggestEmbedInFlightMax,
    pickRollingBatchMaxFromWarmup,
    resolveEmbedInFlightMax,
    recordEmbedPipelineTelemetry,
    readEmbedPipelineTelemetry,
    EMBED_IN_FLIGHT_COLD_SUGGEST,
    _setEmbedTelemetryStorageForTests,
} from './embed-auto-caps';
import type { IndexCompleteEntry } from '../types/log';

function minimalComplete(overrides: Partial<IndexCompleteEntry>): IndexCompleteEntry {
    return {
        type: 'index-complete',
        timestamp: new Date().toISOString(),
        mode: 'full',
        dtype: 'q4',
        embeddingDim: 384,
        filesIndexed: 1,
        committedFilePaths: [],
        chunksIndexed: 1,
        vectorsWritten: 1,
        filesSkippedError: 0,
        filesSkippedQuota: 0,
        filesQuarantined: 0,
        chunksFailedEmbed: 0,
        filesDeferred: 0,
        embedRecycles: 0,
        chunkDurationMs: 0,
        embedDurationMs: 0,
        bm25DurationMs: 0,
        commitDurationMs: 0,
        totalDurationMs: 100_000,
        heapDeltaMB: null,
        storageDeltaMB: null,
        chunksPerSec: 1,
        filesPerSec: 1,
        perFileWallMs: null,
        chunksPerFile: null,
        embedBatchLatencyMs: null,
        pass: true,
        checks: [],
        ...overrides,
    };
}

describe('suggestEmbedInFlightMax', () => {
    it('lab: cap 10, high-water 3, ~0 persist → suggest 4', () => {
        expect(suggestEmbedInFlightMax({
            gpuBusyMs: 129_000,
            persistWaitMs: 0.2,
            inflightHighWater: 3,
            configuredCap: 10,
        })).toBe(4);
    });

    it('raises cap when persist wait is large vs GPU busy', () => {
        const raised = suggestEmbedInFlightMax({
            gpuBusyMs: 10_000,
            persistWaitMs: 2_000,
            inflightHighWater: 4,
            configuredCap: 8,
        });
        expect(raised).toBeGreaterThan(5);
        expect(raised).toBeLessThanOrEqual(16);
    });

    it('never below high-water + 1', () => {
        expect(suggestEmbedInFlightMax({
            gpuBusyMs: 50_000,
            persistWaitMs: 0,
            inflightHighWater: 6,
            configuredCap: 10,
        })).toBe(7);
    });
});

describe('pickRollingBatchMaxFromWarmup', () => {
    it('prefers highest tok/s under the long-task budget', () => {
        const samples = [
            { batch: 4, latencyMs: 80, paddedTokens: 4 * 512 },
            { batch: 8, latencyMs: 120, paddedTokens: 8 * 512 },
            { batch: 8, latencyMs: 130, paddedTokens: 8 * 512 },
        ];
        expect(pickRollingBatchMaxFromWarmup(samples, { longTaskBudgetMs: 250 })).toBe(8);
    });

    it('drops batch size when all latencies exceed the budget', () => {
        const samples = [
            { batch: 8, latencyMs: 400, paddedTokens: 8 * 512 },
            { batch: 4, latencyMs: 200, paddedTokens: 4 * 512 },
            { batch: 2, latencyMs: 90, paddedTokens: 2 * 512 },
        ];
        expect(pickRollingBatchMaxFromWarmup(samples, { longTaskBudgetMs: 250 })).toBe(2);
    });

    it('treats flat batch-4 vs batch-8 throughput as a tie-break toward larger batch', () => {
        const flat = [
            { batch: 4, latencyMs: 100, paddedTokens: 4 * 512 },
            { batch: 8, latencyMs: 200, paddedTokens: 8 * 512 },
        ];
        expect(pickRollingBatchMaxFromWarmup(flat)).toBe(8);
    });
});

describe('resolveEmbedInFlightMax + telemetry', () => {
    let map: Map<string, string>;

    beforeEach(() => {
        map = new Map();
        _setEmbedTelemetryStorageForTests(map);
    });

    afterEach(() => {
        _setEmbedTelemetryStorageForTests(null);
    });

    it('auto on without telemetry uses cold suggest', () => {
        expect(resolveEmbedInFlightMax({
            embedInFlightAuto: true,
            embedInFlightMax: 10,
        })).toBe(EMBED_IN_FLIGHT_COLD_SUGGEST);
    });

    it('auto off uses the slider value', () => {
        expect(resolveEmbedInFlightMax({
            embedInFlightAuto: false,
            embedInFlightMax: 10,
        })).toBe(10);
    });

    it('records index-complete and reads back for the next resolve', () => {
        recordEmbedPipelineTelemetry(minimalComplete({
            gpuBusyMs: 129_000,
            persistWaitMs: 0.2,
            inflightHighWater: 3,
            embedInFlightMax: 10,
        }));
        expect(readEmbedPipelineTelemetry()?.inflightHighWater).toBe(3);
        expect(resolveEmbedInFlightMax({
            embedInFlightAuto: true,
            embedInFlightMax: 10,
        })).toBe(4);
    });
});
