// One live progress snapshot for every chrome consumer: status bar, Settings
// Index card / embed diagnostics / reindex row, and folder-coverage headlines.
// File counts prefer FileRecords ∩ vault (the folder-coverage consumer). GPU
// files-started live on `speed` only. Surfaces must not mix those independently.

import { indexPercent } from './index-eta';
import type {
    IndexJobKind,
    IndexJobSpeedView,
    IndexStatusHealth,
    IndexStatusJob,
    IndexStatusMode,
} from './index-status-card';
import {
    normalizeHydrateProgress,
    type IndexHydrateProgress,
    type IndexStatusReport,
} from './index-status-report';

export type IndexProgressPhase =
    | 'idle'
    | 'starting'
    | 'hydrate'
    | 'embed'
    | 'error'
    | 'locked'
    | 'stuck';

export type IndexProgressKind = IndexJobKind | 'hydrate';

export type CoverageHeadlineCaption = 'in the index' | 'this pass' | 'this restore';

/** Optional idle overlay from folder coverage (FileRecords ∩ live vault). */
export interface IndexProgressCoverageOverlay {
    covered: number;
    total: number;
}

export interface IndexProgressSnapshot {
    phase: IndexProgressPhase;
    health: IndexStatusHealth;
    mode: IndexStatusMode;
    kind: IndexProgressKind | null;
    filesDone: number;
    filesTotal: number;
    /** Integer 0–100 for the live job/hydrate walk; 0 when idle. */
    percent: number;
    chunksDone: number;
    tokensDone: number;
    elapsedMs: number;
    paused: boolean;
    aligningExclusions: boolean;
    report: IndexStatusReport;
    /** Display job — hydrate counts win over a leftover catch-up job. */
    job: IndexStatusJob | null;
    /** Embed-pass speed; null during hydrate / idle. */
    speed: IndexJobSpeedView | null;
    hydrate: IndexHydrateProgress | null;
}

export interface IndexProgressSnapshotInput {
    report: IndexStatusReport;
    job: IndexStatusJob | null;
    speed: IndexJobSpeedView | null;
    inventoryFiles?: number | null;
    inventoryChunks?: number | null;
    coverage?: IndexProgressCoverageOverlay | null;
}

export function resolveIndexProgressPhase(input: {
    health: IndexStatusHealth;
    hydrate: { done: number; total: number } | null;
    job: IndexStatusJob | null;
}): IndexProgressPhase {
    const { health, hydrate, job } = input;
    if (health === 'error') return 'error';
    if (health === 'locked') return 'locked';
    if (health === 'stuck') return 'stuck';
    if (hydrate && hydrate.total > 0) return 'hydrate';
    if (health === 'starting') return 'starting';
    if (health === 'restoring') return 'hydrate';
    if (job && job.total > 0 && (health === 'indexing' || job.done < job.total)) return 'embed';
    if (health === 'indexing') return 'embed';
    return 'idle';
}

function clampCount(n: number): number {
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
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
    const hydrate = normalizeHydrateProgress(report.hydrateProgress);
    const rawJob = input.job && input.job.total > 0 ? input.job : null;
    const speed = input.speed;
    const phase = resolveIndexProgressPhase({
        health: report.health,
        hydrate,
        job: rawJob,
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

    if (phase === 'hydrate' && hydrate) {
        filesDone = clampCount(hydrate.done);
        filesTotal = clampCount(hydrate.total);
        chunksDone = inventoryChunks;
        kind = 'hydrate';
        job = {
            done: filesDone,
            total: filesTotal,
            paused: false,
            kind: rawJob?.kind,
            id: rawJob?.id,
        };
    } else if (phase === 'embed' && (rawJob || (speed && speed.total > 0))) {
        const passDone = clampCount(speed?.done ?? rawJob?.done ?? 0);
        const passTotal = clampCount(speed?.total ?? rawJob?.total ?? 0);
        if (coverageFiles && coverageFiles.filesTotal > 0) {
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
        filesTotal = inventoryFiles;
        chunksDone = inventoryChunks;
    }

    const percent = filesTotal > 0
        ? (phase === 'hydrate' && hydrate ? hydrate.percent : indexPercent(filesDone, filesTotal))
        : 0;

    return {
        phase,
        health: report.health,
        mode: report.mode,
        kind,
        filesDone,
        filesTotal,
        percent,
        chunksDone,
        tokensDone,
        elapsedMs,
        paused,
        aligningExclusions,
        report,
        job,
        speed: speedOut,
        hydrate,
    };
}

export function coverageHeadlineFromProgress(
    overall: { covered: number; total: number },
    progress: Pick<IndexProgressSnapshot, 'phase' | 'filesDone' | 'filesTotal' | 'percent'>,
): { done: number; total: number; caption: CoverageHeadlineCaption; live: boolean; percent: number } {
    if (progress.phase === 'hydrate' && progress.filesTotal > 0) {
        return {
            done: progress.filesDone,
            total: progress.filesTotal,
            caption: 'this restore',
            live: true,
            percent: progress.percent,
        };
    }
    const total = overall.total;
    const done = overall.covered;
    return {
        done,
        total,
        caption: 'in the index',
        live: false,
        percent: total > 0 ? indexPercent(done, total) : 0,
    };
}
