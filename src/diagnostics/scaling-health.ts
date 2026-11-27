import type { DeltaApplyEntry, IndexCompleteEntry } from '../types/log';
import { gpuOccupancyPct } from '../index/embed-pipeline';

export type ScalingRegime =
    | 'healthy'
    | 'idb-contention'
    | 'cold-cache-thrash'
    | 'tokenization-bound'
    | 'cap-clamped'
    | 'idle';

export interface ScalingAssessment {
    regime: ScalingRegime;
    label: string;
    detail: string;
    idbSharePct: number;
    gpuOccupancyPct: number;
    unaccountedMs: number;
}

export interface ScalingIndexInput {
    mode?: 'full' | 'incremental';
    filesIndexed?: number;
    filesDeferred?: number;
    chunksIndexed?: number;
    chunkDurationMs?: number;
    diffDurationMs?: number;
    embedDurationMs?: number;
    commitDurationMs?: number;
    paceWaitMs?: number;
    gpuBusyMs?: number | null;
    persistWaitMs?: number;
    embedInFlightMax?: number;
    totalDurationMs: number;
}

export interface AssessScalingOpts {
    configuredInFlightCap?: number;
    recentDeltas?: DeltaApplyEntry[];
}

const REGIME_LABELS: Record<ScalingRegime, string> = {
    healthy: 'Healthy',
    'idb-contention': 'IDB contention',
    'cold-cache-thrash': 'Cold-cache thrash',
    'tokenization-bound': 'Tokenization-bound',
    'cap-clamped': 'Cap clamped',
    idle: 'Idle',
};

function pct(part: number, total: number): number {
    if (!(total > 0) || !(part >= 0)) return 0;
    return Math.min(100, (part / total) * 100);
}

/**
 * Classify a finished index pass into its dominant scaling regime.
 * Single source of truth consumed by IndexCompleteEntry.checks, seek-report.md,
 * and Settings → Seek → Index (via IndexProgressSnapshot).
 */
export function assessIndexScaling(
    entry: ScalingIndexInput,
    opts: AssessScalingOpts = {},
): ScalingAssessment {
    const totalMs = Math.max(0, entry.totalDurationMs);
    const chunkMs = Math.max(0, entry.chunkDurationMs ?? 0);
    const diffMs = Math.max(0, entry.diffDurationMs ?? 0);
    const embedMs = Math.max(0, entry.embedDurationMs ?? 0);
    const commitMs = Math.max(0, entry.commitDurationMs ?? 0);
    const paceMs = Math.max(0, entry.paceWaitMs ?? 0);
    const gpuBusyMs = Math.max(0, entry.gpuBusyMs ?? 0);
    const idbMs = commitMs + diffMs;
    const idbSharePct = pct(idbMs, totalMs);
    const gpuOcc = entry.gpuBusyMs != null ? gpuOccupancyPct(gpuBusyMs, totalMs) : 0;
    const accountedMs = chunkMs + diffMs + embedMs + commitMs + paceMs;
    const unaccountedMs = Math.max(0, totalMs - accountedMs);

    const recentDeltas = opts.recentDeltas ?? [];
    const recentWindow = recentDeltas.slice(-5);
    const coldFallbacks = recentWindow.filter(
        d => !d.appliedIncrementally && d.fallbackReason === 'cold caches',
    );
    const maxHoldMs = coldFallbacks.reduce((m, d) => Math.max(m, d.mutexHoldMs ?? 0), 0);
    if (
        coldFallbacks.length >= 3
        && (maxHoldMs >= 30_000 || (commitMs >= 10_000 && (entry.filesDeferred ?? 0) > 0))
    ) {
        return {
            regime: 'cold-cache-thrash',
            label: REGIME_LABELS['cold-cache-thrash'],
            detail: `${coldFallbacks.length} consecutive cold-cache delta fallbacks (max mutex hold ${(maxHoldMs / 1000).toFixed(1)}s, IDB ${idbSharePct.toFixed(0)}% of wall)`,
            idbSharePct,
            gpuOccupancyPct: gpuOcc,
            unaccountedMs,
        };
    }

    const filesIndexed = entry.filesIndexed ?? 0;
    const filesDeferred = entry.filesDeferred ?? 0;
    const idbDominated = totalMs > 0 && idbMs / totalMs >= 0.5 && idbMs >= 5_000;
    const budgetBlownTiny = filesDeferred > 0 && filesIndexed <= 2 && totalMs >= 15_000;
    const preEmbedStall = totalMs >= 15_000 && unaccountedMs / totalMs >= 0.5;
    if (idbDominated || budgetBlownTiny || preEmbedStall) {
        const parts: string[] = [];
        if (diffMs >= 1_000) parts.push(`diff ${(diffMs / 1000).toFixed(1)}s`);
        if (commitMs >= 1_000) parts.push(`commit ${(commitMs / 1000).toFixed(1)}s`);
        if (unaccountedMs >= 5_000 && diffMs < 1_000) parts.push(`unaccounted IDB/wait ${(unaccountedMs / 1000).toFixed(1)}s`);
        if (filesDeferred > 0) parts.push(`${filesIndexed} done / ${filesDeferred} deferred`);
        return {
            regime: 'idb-contention',
            label: REGIME_LABELS['idb-contention'],
            detail: `${parts.join(', ') || `IDB ${idbSharePct.toFixed(0)}% of wall`} (${gpuOcc.toFixed(0)}% GPU busy)`,
            idbSharePct,
            gpuOccupancyPct: gpuOcc,
            unaccountedMs,
        };
    }

    const cap = entry.embedInFlightMax ?? 0;
    const configuredCap = opts.configuredInFlightCap ?? 0;
    const chunks = entry.chunksIndexed ?? 0;
    if (
        cap > 0
        && cap <= 2
        && configuredCap >= 4
        && (entry.mode === 'full' || chunks >= 32)
    ) {
        return {
            regime: 'cap-clamped',
            label: REGIME_LABELS['cap-clamped'],
            detail: `in-flight cap ${cap} below configured ${configuredCap} on ${chunks} chunks (${gpuOcc.toFixed(0)}% GPU busy)`,
            idbSharePct,
            gpuOccupancyPct: gpuOcc,
            unaccountedMs,
        };
    }

    if (chunks >= 16 && entry.gpuBusyMs != null && gpuOcc < 50 && totalMs > 0 && chunkMs / totalMs >= 0.3) {
        const chunkPct = pct(chunkMs, totalMs);
        return {
            regime: 'tokenization-bound',
            label: REGIME_LABELS['tokenization-bound'],
            detail: `chunk/tokenization ${chunkPct.toFixed(0)}% of wall (${(chunkMs / 1000).toFixed(1)}s) while GPU busy ${gpuOcc.toFixed(0)}%`,
            idbSharePct,
            gpuOccupancyPct: gpuOcc,
            unaccountedMs,
        };
    }

    if (chunks === 0 || totalMs < 200) {
        return {
            regime: 'idle',
            label: REGIME_LABELS.idle,
            detail: chunks === 0 ? 'metadata-only pass (0 chunks embedded)' : `short pass (${Math.round(totalMs)}ms)`,
            idbSharePct,
            gpuOccupancyPct: gpuOcc,
            unaccountedMs,
        };
    }

    return {
        regime: 'healthy',
        label: REGIME_LABELS.healthy,
        detail: `${gpuOcc.toFixed(0)}% GPU busy, ${idbSharePct.toFixed(0)}% IDB share`,
        idbSharePct,
        gpuOccupancyPct: gpuOcc,
        unaccountedMs,
    };
}

export interface ScalingHistorySummary {
    assessedPasses: number;
    latest: ScalingAssessment | null;
    regimeCounts: Partial<Record<ScalingRegime, number>>;
    medianGpuOccupancyPct: number | null;
    worstIdbSharePct: number;
    coldFallbackStreak: number;
}

export function summarizeScalingHistory(
    indexes: IndexCompleteEntry[],
    deltas: DeltaApplyEntry[],
    configuredInFlightCap?: number,
): ScalingHistorySummary {
    const regimeCounts: Partial<Record<ScalingRegime, number>> = {};
    const occs: number[] = [];
    let worstIdbSharePct = 0;
    let latest: ScalingAssessment | null = null;

    for (let i = 0; i < indexes.length; i++) {
        const idx = indexes[i];
        // For the latest pass, pass trailing deltas so cold-cache thrash is visible.
        const recentDeltas = i === indexes.length - 1 ? deltas : undefined;
        const a = assessIndexScaling(idx, { configuredInFlightCap, recentDeltas });
        latest = a;
        regimeCounts[a.regime] = (regimeCounts[a.regime] ?? 0) + 1;
        if (idx.gpuBusyMs != null && idx.chunksIndexed > 0) occs.push(a.gpuOccupancyPct);
        if (a.idbSharePct > worstIdbSharePct) worstIdbSharePct = a.idbSharePct;
    }

    occs.sort((a, b) => a - b);
    const medianGpuOccupancyPct = occs.length > 0 ? occs[Math.floor(occs.length / 2)] : null;

    let coldFallbackStreak = 0;
    for (let i = deltas.length - 1; i >= 0; i--) {
        const d = deltas[i];
        if (!d.appliedIncrementally && d.fallbackReason === 'cold caches') coldFallbackStreak++;
        else break;
    }

    return {
        assessedPasses: indexes.length,
        latest,
        regimeCounts,
        medianGpuOccupancyPct,
        worstIdbSharePct,
        coldFallbackStreak,
    };
}
