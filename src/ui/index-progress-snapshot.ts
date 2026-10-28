// One live progress snapshot for every chrome consumer: status bar, Settings
// Index card / embed diagnostics / reindex row, and folder-coverage headlines.
// File counts prefer FileRecords ∩ vault (the folder-coverage consumer). GPU
// files-started live on `speed` only. Surfaces must not mix those independently.

import {
    formatRoughEta,
    indexChunksPerSec,
    indexFilesPerSec,
    indexPercent,
    indexTokensPerSec,
} from './index-eta';
import { effectiveBatchSize, gpuOccupancyPct } from '../index/embed-pipeline';
import type {
    IndexJobKind,
    IndexJobSpeedView,
    IndexStatusHealth,
    IndexStatusJob,
    IndexStatusMode,
} from './index-status-card';
import {
    IDLE_PROGRESS,
    normalizeHydrateProgress,
    type IndexHydrateProgress,
    type IndexStatusReport,
} from './index-status-report';
import { shouldPreferPassCountsOverCoverage } from './catch-up-presentation';
import type { IndexProgressIndicator } from './index-progress-indicator';

export type IndexProgressPhase =
    | 'idle'
    | 'starting'
    | 'hydrate'
    | 'verify'
    | 'embed'
    | 'error'
    | 'locked'
    | 'stuck';

export type IndexProgressKind = IndexJobKind | 'hydrate' | 'verify';

export type CoverageHeadlineCaption = 'in the index' | 'this pass' | 'this restore' | 'this check';

/** Optional idle overlay from folder coverage (FileRecords ∩ live vault). */
export interface IndexProgressCoverageOverlay {
    covered: number;
    total: number;
}

export interface IndexProgressRates {
    chunksPerSec: number;
    filesPerSec: number;
    tokensPerSec: number;
}

export interface IndexProgressCoverageHeadline {
    done: number;
    total: number;
    caption: CoverageHeadlineCaption;
    live: boolean;
    percent: number;
}

export type IndexProgressEmbedPill = 'live' | 'paused' | 'last pass';

export interface IndexProgressEmbedDerived {
    pill: IndexProgressEmbedPill | null;
    liveRates: IndexProgressRates | null;
    lastRates: IndexProgressRates | null;
    gpuOccupancyPct: number | null;
    effectiveBatch: number | null;
}

/** Logger fields the snapshot needs to precompute embed-diag rates / occupancy. */
export interface IndexProgressLastComplete {
    chunksPerSec: number;
    filesPerSec: number;
    tokensPerSec?: number;
    paddedTokens?: number;
    totalDurationMs: number;
    gpuBusyMs?: number | null;
    vectorsWritten: number;
    embedBatchLatencyMs?: { n: number } | null;
}

export interface IndexProgressSnapshot {
    phase: IndexProgressPhase;
    health: IndexStatusHealth;
    mode: IndexStatusMode;
    /** Green Ready + glow while a tiny catch-up pass runs in the background. */
    quietCatchUp?: boolean;
    kind: IndexProgressKind | null;
    filesDone: number;
    filesTotal: number;
    /** Integer 0–100 for the live job/hydrate walk; 0 when idle. */
    percent: number;
    /** Notes still outstanding on the display walk; null when there is no total. */
    remaining: number | null;
    chunksDone: number;
    tokensDone: number;
    elapsedMs: number;
    /** Rough remaining-time bucket, or null when throughput is unknown. */
    eta: string | null;
    paused: boolean;
    aligningExclusions: boolean;
    report: IndexStatusReport;
    /** Display job — hydrate counts win over a leftover catch-up job. */
    job: IndexStatusJob | null;
    /** Embed-pass speed; null during hydrate / idle. */
    speed: IndexJobSpeedView | null;
    hydrate: IndexHydrateProgress | null;
    indicator: IndexProgressIndicator;
    rates: IndexProgressRates | null;
    embed: IndexProgressEmbedDerived;
    coverageHeadline: IndexProgressCoverageHeadline;
}

export interface IndexProgressSnapshotInput {
    report: IndexStatusReport;
    job: IndexStatusJob | null;
    speed: IndexJobSpeedView | null;
    inventoryFiles?: number | null;
    inventoryChunks?: number | null;
    /** Live vault notes — idle inventory must not paint 123/123 as 100%. */
    indexableNotes?: number | null;
    coverage?: IndexProgressCoverageOverlay | null;
    lastComplete?: IndexProgressLastComplete | null;
}

export function resolveIndexProgressPhase(input: {
    health: IndexStatusHealth;
    hydrate: { done: number; total: number } | null;
    job: IndexStatusJob | null;
    indicator?: IndexProgressIndicator | null;
    quietCatchUp?: boolean;
}): IndexProgressPhase {
    const { health, hydrate, job, indicator, quietCatchUp } = input;
    if (quietCatchUp && health === 'ok') return 'idle';
    if (health === 'error' || indicator?.phase === 'error') return 'error';
    if (health === 'locked' || indicator?.phase === 'locked') return 'locked';
    if (health === 'stuck' || indicator?.phase === 'stuck') return 'stuck';
    if (indicator?.phase === 'verifying') return 'verify';
    if (indicator?.phase === 'hydrating' || indicator?.phase === 'restoring' || indicator?.phase === 'recovering') {
        return 'hydrate';
    }
    if (hydrate && hydrate.total > 0) return 'hydrate';
    if (indicator?.phase === 'starting' || health === 'starting') return 'starting';
    if (health === 'restoring') return 'hydrate';
    if (indicator?.phase === 'catching-up' || indicator?.phase === 'indexing') return 'embed';
    if (job && job.total > 0 && (health === 'indexing' || job.done < job.total)) return 'embed';
    if (health === 'indexing') return 'embed';
    return 'idle';
}

function clampCount(n: number): number {
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
}

/** Notes still outstanding — snapshot field, not a Settings/card helper. */
export function remainingFromCounts(done: number, total: number): number | null {
    if (total <= 0) return null;
    return Math.max(0, total - done);
}

function coverageIndexFiles(
    coverage: IndexProgressCoverageOverlay,
): { filesDone: number; filesTotal: number } {
    return {
        filesDone: clampCount(coverage.covered),
        filesTotal: clampCount(coverage.total),
    };
}

/**
 * Canonical files/chunks/tokens/phase for status bar, Settings Index, and
 * folder-coverage headlines. Hydrate uses the sidecar file-walk. Every other
 * phase prefers FileRecords ∩ vault (coverage), then IDB inventory, then the
 * live embed pass. GPU files-started stay on `speed` for Settings embed diag.
 */
export function buildIndexProgressSnapshot(input: IndexProgressSnapshotInput): IndexProgressSnapshot {
    const report = input.report;
    const indicator = report.progress ?? IDLE_PROGRESS;
    const hydrate = indicator.phase === 'hydrating' || indicator.phase === 'restoring' || indicator.phase === 'recovering'
        ? (indicator.units && indicator.units.total > 0
            ? { done: indicator.units.done, total: indicator.units.total, percent: indicator.units.percent }
            : normalizeHydrateProgress(report.hydrateProgress))
        : normalizeHydrateProgress(report.hydrateProgress);
    const rawJob = input.job && input.job.total > 0 ? input.job : null;
    const speed = input.speed;
    const quietCatchUp = !!report.quietCatchUp;
    const phase = resolveIndexProgressPhase({
        health: report.health,
        hydrate,
        job: rawJob,
        indicator,
        quietCatchUp,
    });

    const inventoryFiles = clampCount(input.inventoryFiles ?? 0);
    const inventoryChunks = clampCount(input.inventoryChunks ?? 0);
    const coverage = input.coverage && input.coverage.total > 0 ? input.coverage : null;
    const coverageFiles = coverage ? coverageIndexFiles(coverage) : null;

    let filesDone = 0;
    let filesTotal = 0;
    let chunksDone = 0;
    let tokensDone = 0;
    let elapsedMs = 0;
    let paused = false;
    let aligningExclusions = false;
    let kind: IndexProgressKind | null = null;
    let job: IndexStatusJob | null = null;
    let speedOut: IndexJobSpeedView | null = null;

    if ((phase === 'hydrate' || phase === 'verify') && (indicator.units || hydrate)) {
        const units = indicator.units;
        filesDone = clampCount(units?.done ?? hydrate?.done ?? 0);
        filesTotal = clampCount(units?.total ?? hydrate?.total ?? 0);
        chunksDone = inventoryChunks;
        kind = phase === 'verify' ? 'verify' : 'hydrate';
        job = {
            done: filesDone,
            total: filesTotal,
            paused: false,
            kind: rawJob?.kind,
            id: rawJob?.id,
        };
    } else if (phase === 'embed' && (rawJob || (speed && speed.total > 0) || indicator.units)) {
        const passDone = clampCount(speed?.done ?? rawJob?.done ?? 0);
        const passTotal = clampCount(speed?.total ?? rawJob?.total ?? 0);
        const passKind = rawJob?.kind ?? speed?.kind ?? null;
        const preferPass = shouldPreferPassCountsOverCoverage({
            jobKind: passKind,
            quietCatchUp,
            passTotal,
            inventoryFiles,
        });
        if (preferPass && passTotal > 0) {
            filesDone = passTotal > 0 ? Math.min(passTotal, passDone) : passDone;
            filesTotal = passTotal;
        } else if (coverageFiles && coverageFiles.filesTotal > 0) {
            filesDone = coverageFiles.filesDone;
            filesTotal = coverageFiles.filesTotal;
        } else if (inventoryFiles > 0) {
            filesTotal = Math.max(inventoryFiles, passTotal);
            filesDone = Math.min(filesTotal, inventoryFiles);
        } else {
            filesTotal = passTotal;
            filesDone = filesTotal > 0 ? Math.min(filesTotal, passDone) : passDone;
        }
        chunksDone = clampCount(speed?.chunksDone ?? inventoryChunks);
        tokensDone = clampCount(speed?.tokensDone ?? 0);
        elapsedMs = Math.max(0, speed?.elapsedMs ?? 0);
        paused = !!(speed?.paused ?? rawJob?.paused);
        aligningExclusions = !!rawJob?.aligningExclusions;
        kind = rawJob?.kind ?? speed?.kind ?? null;
        job = {
            id: rawJob?.id,
            kind: rawJob?.kind ?? speed?.kind,
            done: filesDone,
            total: filesTotal,
            paused,
            aligningExclusions: aligningExclusions || undefined,
        };
        speedOut = {
            chunksDone,
            tokensDone,
            done: passTotal > 0 ? Math.min(passTotal, passDone) : passDone,
            total: passTotal,
            elapsedMs,
            paused,
            kind: job.kind,
        };
    } else if (coverageFiles && coverageFiles.filesTotal > 0) {
        filesDone = coverageFiles.filesDone;
        filesTotal = coverageFiles.filesTotal;
        chunksDone = inventoryChunks;
    } else if (inventoryFiles > 0 || inventoryChunks > 0) {
        filesDone = inventoryFiles;
        filesTotal = Math.max(inventoryFiles, clampCount(input.indexableNotes ?? 0));
        chunksDone = inventoryChunks;
    }

    if (phase === 'embed' && indicator.units && filesTotal <= 0) {
        filesDone = indicator.units.done;
        filesTotal = indicator.units.total;
    }

    const percent = indicator.units && !indicator.units.determinate
        ? 0
        : filesTotal > 0
            ? (phase === 'hydrate' && hydrate ? hydrate.percent : (indicator.units?.percent ?? indexPercent(filesDone, filesTotal)))
            : 0;
    const remaining = remainingFromCounts(filesDone, filesTotal);
    const eta = formatRoughEta(filesDone, filesTotal, elapsedMs);
    const embed = embedDerivedFromInputs(speedOut, input.lastComplete ?? null);
    const liveRates = embed.liveRates;
    const coverageHeadline = buildCoverageHeadline({
        phase,
        filesDone,
        filesTotal,
        percent,
        coverage,
    });

    return {
        phase,
        health: report.health,
        mode: report.mode,
        quietCatchUp: quietCatchUp || undefined,
        kind,
        filesDone,
        filesTotal,
        percent,
        remaining,
        chunksDone,
        tokensDone,
        elapsedMs,
        eta,
        paused,
        aligningExclusions,
        report,
        job,
        speed: speedOut,
        hydrate,
        indicator,
        rates: liveRates ?? embed.lastRates,
        embed,
        coverageHeadline,
    };
}

export function embedDerivedFromInputs(
    speed: IndexJobSpeedView | null,
    lastComplete: IndexProgressLastComplete | null,
): IndexProgressEmbedDerived {
    const liveRates = speed
        ? {
            chunksPerSec: indexChunksPerSec(speed.chunksDone, speed.elapsedMs),
            filesPerSec: indexFilesPerSec(speed.done, speed.elapsedMs),
            tokensPerSec: indexTokensPerSec(speed.tokensDone, speed.elapsedMs),
        }
        : null;
    const lastRates = lastPassRates(lastComplete);
    const dispatches = lastComplete?.embedBatchLatencyMs?.n ?? 0;
    return {
        pill: speed ? (speed.paused ? 'paused' : 'live') : (lastRates ? 'last pass' : null),
        liveRates,
        lastRates,
        gpuOccupancyPct: lastComplete && lastComplete.gpuBusyMs != null
            ? gpuOccupancyPct(lastComplete.gpuBusyMs, lastComplete.totalDurationMs)
            : null,
        effectiveBatch: lastComplete && dispatches > 0
            ? effectiveBatchSize(lastComplete.vectorsWritten, dispatches)
            : null,
    };
}

function lastPassRates(complete: IndexProgressLastComplete | null): IndexProgressRates | null {
    if (!complete) return null;
    const tokensPerSec = complete.tokensPerSec
        ?? ((complete.paddedTokens ?? 0) > 0 && complete.totalDurationMs > 0
            ? (complete.paddedTokens! / (complete.totalDurationMs / 1000))
            : 0);
    return {
        chunksPerSec: complete.chunksPerSec,
        filesPerSec: complete.filesPerSec,
        tokensPerSec,
    };
}

function buildCoverageHeadline(input: {
    phase: IndexProgressPhase;
    filesDone: number;
    filesTotal: number;
    percent: number;
    coverage: IndexProgressCoverageOverlay | null;
}): IndexProgressCoverageHeadline {
    if ((input.phase === 'hydrate' || input.phase === 'verify') && input.filesTotal > 0) {
        return {
            done: input.filesDone,
            total: input.filesTotal,
            caption: input.phase === 'verify' ? 'this check' : 'this restore',
            live: true,
            percent: input.percent,
        };
    }
    if (input.filesTotal > 0) {
        return {
            done: input.filesDone,
            total: input.filesTotal,
            caption: 'in the index',
            live: false,
            percent: input.percent,
        };
    }
    const total = input.coverage?.total ?? 0;
    const done = input.coverage?.covered ?? 0;
    return {
        done,
        total,
        caption: 'in the index',
        live: false,
        percent: 0,
    };
}

/** Thin reader — Settings must not recompute percent. */
export function coverageHeadlineFromProgress(
    progress: Pick<IndexProgressSnapshot, 'coverageHeadline'> | IndexProgressCoverageHeadline,
): IndexProgressCoverageHeadline {
    if ('coverageHeadline' in progress) return progress.coverageHeadline;
    return progress;
}
