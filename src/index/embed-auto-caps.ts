// Closed-loop embed pipeline caps from the last index-complete pass (or warmup bench).
// The Auto toggle lives in synced settings; last-pass telemetry is localStorage
// (device-local, not Sync).

import type { IndexCompleteEntry } from '../types/log';
import type { SeekSettings } from '../types/types';
import {
    clampEmbedInFlightMax,
    DEFAULT_EMBED_IN_FLIGHT,
    EMBED_IN_FLIGHT_MIN,
    EMBED_IN_FLIGHT_MAX,
} from './embed-pipeline';
import { clampRollingBatchMax, ROLLING_MAX } from './rolling-batch';

/** First pass (no telemetry yet) when auto in-flight is on — lab ~highWater 3 + 1. */
export const EMBED_IN_FLIGHT_COLD_SUGGEST = 4;

const TELEMETRY_KEY = 'seek:embed-pipeline-telemetry:v1';

export interface EmbedPipelineTelemetry {
    gpuBusyMs: number;
    persistWaitMs: number;
    inflightHighWater: number;
    embedInFlightMax: number;
    rollingBatchMax: number;
    longTaskMs: number;
    totalDurationMs: number;
    recordedAt: string;
}

export interface EmbedInFlightSuggestInput {
    gpuBusyMs: number;
    persistWaitMs: number;
    inflightHighWater: number;
    /** Cap configured for the pass that produced these metrics. */
    configuredCap: number;
    longTaskMs?: number;
}

/** Persist wait is negligible vs GPU time (absolute or ratio). */
export const PERSIST_NEGLIGIBLE_MS = 50;
export const PERSIST_GPU_RATIO_HEAVY = 0.05;

/**
 * Suggested prepared-embed batch cap for the next index pass.
 * - Idle queue (low high-water, disk not stalling dispatch) → highWater + 1.
 * - Disk-bound (persist wait vs GPU) → raise toward configured cap.
 * - longTaskMs does not raise queue depth (batch size is adjusted separately).
 */
export function suggestEmbedInFlightMax(input: EmbedInFlightSuggestInput): number {
    const configured = clampEmbedInFlightMax(input.configuredCap);
    const highWater = Math.max(0, Math.round(input.inflightHighWater));
    const gpuBusy = Math.max(0, input.gpuBusyMs);
    const persistWait = Math.max(0, input.persistWaitMs);

    const slack = clampEmbedInFlightMax(Math.max(EMBED_IN_FLIGHT_MIN, highWater + 1));

    const persistNegligible = persistWait < PERSIST_NEGLIGIBLE_MS
        && (gpuBusy === 0 || persistWait / gpuBusy < PERSIST_GPU_RATIO_HEAVY);
    if (persistNegligible && highWater < configured) {
        return slack;
    }

    const persistHeavy = gpuBusy > 0 && persistWait / gpuBusy >= PERSIST_GPU_RATIO_HEAVY;
    if (persistHeavy) {
        return clampEmbedInFlightMax(
            Math.max(slack, highWater + 2, Math.ceil(configured * 1.25)),
        );
    }

    return slack;
}

export interface WarmupBenchSample {
    batch: number;
    latencyMs: number;
    /** Tokens the forward pass padded to (batch × seq bucket). */
    paddedTokens: number;
}

export interface PickRollingBatchOpts {
    /** Renderer long-task threshold (ms); default 250. */
    longTaskBudgetMs?: number;
}

/**
 * Pick the largest warmed batch size with the best tok/s among samples whose
 * latency stays under the long-task budget. Used when warmup records per-shape
 * latencies; safe to call offline in tests.
 */
export function pickRollingBatchMaxFromWarmup(
    samples: WarmupBenchSample[],
    opts: PickRollingBatchOpts = {},
): number {
    const budget = opts.longTaskBudgetMs ?? 250;
    const byBatch = new Map<number, number[]>();
    const tokensByBatch = new Map<number, number>();
    for (const s of samples) {
        const b = clampRollingBatchMax(s.batch);
        if (!byBatch.has(b)) byBatch.set(b, []);
        byBatch.get(b)!.push(Math.max(0, s.latencyMs));
        const prev = tokensByBatch.get(b);
        if (prev == null || s.paddedTokens > prev) tokensByBatch.set(b, s.paddedTokens);
    }

    let bestBatch = 1;
    let bestTps = -1;
    for (let b = 1; b <= ROLLING_MAX; b++) {
        const latencies = byBatch.get(b);
        if (!latencies?.length) continue;
        latencies.sort((a, c) => a - c);
        const median = latencies[Math.floor(latencies.length / 2)];
        if (median > budget) continue;
        const tokens = tokensByBatch.get(b) ?? b * 512;
        const tps = tokens / Math.max(median, 1);
        if (tps > bestTps || (tps === bestTps && b > bestBatch)) {
            bestTps = tps;
            bestBatch = b;
        }
    }

    if (bestTps >= 0) return clampRollingBatchMax(bestBatch);

    // Every sample exceeded the budget — prefer the smallest batch with the lowest median latency.
    let fallback = 1;
    let fallbackLat = Infinity;
    for (let b = 1; b <= ROLLING_MAX; b++) {
        const latencies = byBatch.get(b);
        if (!latencies?.length) continue;
        latencies.sort((a, c) => a - c);
        const median = latencies[Math.floor(latencies.length / 2)];
        if (median < fallbackLat) {
            fallbackLat = median;
            fallback = b;
        }
    }
    return clampRollingBatchMax(fallback);
}

export function telemetryFromIndexComplete(entry: IndexCompleteEntry): EmbedPipelineTelemetry {
    return {
        gpuBusyMs: entry.gpuBusyMs ?? 0,
        persistWaitMs: entry.persistWaitMs ?? 0,
        inflightHighWater: entry.inflightHighWater ?? 0,
        embedInFlightMax: entry.embedInFlightMax ?? DEFAULT_EMBED_IN_FLIGHT,
        rollingBatchMax: entry.rollingBatchMax ?? ROLLING_MAX,
        longTaskMs: entry.longTaskMs ?? 0,
        totalDurationMs: entry.totalDurationMs,
        recordedAt: entry.timestamp,
    };
}

export function suggestEmbedInFlightFromTelemetry(t: EmbedPipelineTelemetry): number {
    return suggestEmbedInFlightMax({
        gpuBusyMs: t.gpuBusyMs,
        persistWaitMs: t.persistWaitMs,
        inflightHighWater: t.inflightHighWater,
        configuredCap: t.embedInFlightMax,
        longTaskMs: t.longTaskMs,
    });
}

export function resolveEmbedInFlightMax(
    settings: Pick<SeekSettings, 'embedInFlightMax' | 'embedInFlightAuto'>,
    telemetry: EmbedPipelineTelemetry | null = readEmbedPipelineTelemetry(),
): number {
    if (settings.embedInFlightAuto === false) {
        return clampEmbedInFlightMax(settings.embedInFlightMax);
    }
    if (telemetry) {
        return suggestEmbedInFlightFromTelemetry(telemetry);
    }
    return clampEmbedInFlightMax(EMBED_IN_FLIGHT_COLD_SUGGEST);
}

export function readEmbedPipelineTelemetry(): EmbedPipelineTelemetry | null {
    try {
        const raw = readRawTelemetry();
        if (!raw) return null;
        const parsed = JSON.parse(raw) as EmbedPipelineTelemetry;
        if (typeof parsed.inflightHighWater !== 'number') return null;
        return parsed;
    } catch {
        return null;
    }
}

export function recordEmbedPipelineTelemetry(entry: IndexCompleteEntry): void {
    try {
        writeRawTelemetry(JSON.stringify(telemetryFromIndexComplete(entry)));
    } catch { /* private mode / CSP — auto cap falls back to cold suggest */ }
}

function readRawTelemetry(): string | null {
    if (testStorage) return testStorage.get(TELEMETRY_KEY) ?? null;
    try { return storage().getItem(TELEMETRY_KEY); } catch { return null; }
}

function writeRawTelemetry(raw: string): void {
    if (testStorage) {
        testStorage.set(TELEMETRY_KEY, raw);
        return;
    }
    storage().setItem(TELEMETRY_KEY, raw);
}

/** Preview for Settings copy (auto mode). */
export function previewAutoEmbedInFlightMax(
    settings: Pick<SeekSettings, 'embedInFlightMax' | 'embedInFlightAuto'>,
): number {
    return resolveEmbedInFlightMax(settings);
}

function storage(): Storage {
    if (typeof localStorage !== 'undefined') return localStorage;
    throw new Error('no storage');
}

/** Vitest: inject an in-memory store when localStorage is unavailable. */
let testStorage: Map<string, string> | null = null;
export function _setEmbedTelemetryStorageForTests(map: Map<string, string> | null): void {
    testStorage = map;
}

export { EMBED_IN_FLIGHT_MIN, EMBED_IN_FLIGHT_MAX };
