// One computed index-status snapshot for every high-level chrome consumer
// (status bar, Settings Index card / reindex heading, coverage health titles).
// Coarse precedence still lives in resolveIndexUiStatus; this layer adds
// full-reindex vs catch-up and the copy both UIs must share.
// Progress units live in index-progress-indicator — the only producer chrome reads.

import {
    classifyCatchUpPresentation,
    resolveIndexUiStatus,
    INDEX_NO_INDEX_LABEL,
    INDEX_STARTING_LABEL,
    INDEX_RESTORING_LABEL,
    INDEX_INDEXING_LABEL,
    INDEX_UPDATING_LABEL,
    INDEX_UP_TO_DATE_LABEL,
    INDEX_ERROR_LABEL,
    INDEX_LOCKED_LABEL,
    INDEX_STUCK_LABEL,
    type IndexUiStatus,
    type IndexUiStatusInput,
} from './index-notice';
import { indexPercent } from './index-eta';
import { formatStableCompactProgress, formatStableFileFraction, formatStableFileFractionSpaced, formatStableLabelProgress } from './index-progress-format';
import {
    computeIndexProgressIndicator,
    isVerifyOnlyWalk,
    type IndexProgressIndicator,
    type IndexProgressUnits,
    type IndexProgressWalkState,
} from './index-progress-indicator';

export type IndexStatusHealth = 'none' | 'starting' | 'restoring' | 'ok' | 'updating' | 'indexing' | 'error' | 'locked' | 'stuck';
type ReporterJobKind = 'full' | 'delta' | 'catchup';

export const INDEX_FULL_REINDEX_LABEL = 'Reindexing';
export const INDEX_CATCHING_UP_LABEL = 'Catching up';
export const INDEX_VERIFYING_LABEL = 'Verifying';
export const INDEX_RECOVERING_LABEL = 'Recovering';

/** High-level mode. Restoring covers drop, hydrate, and wait-for-producer. */
export type IndexStatusMode =
    | IndexUiStatus
    | 'full-reindex'
    | 'catching-up'
    | 'recovering'
    | 'verifying';

export interface IndexStatusCopy {
    tone: string;
    /** Settings card heading, coverage health title, reindex progress row. */
    label: string;
    /** Status-bar tooltip / aria, search-modal footer. */
    compact: string;
}

export const INDEX_STATUS_COPY: Record<IndexStatusMode, IndexStatusCopy> = {
    none: { tone: 'mid', label: 'No index', compact: INDEX_NO_INDEX_LABEL },
    starting: { tone: 'pending', label: 'Starting up…', compact: INDEX_STARTING_LABEL },
    restoring: { tone: 'info', label: 'Restoring…', compact: INDEX_RESTORING_LABEL },
    verifying: { tone: 'pending', label: 'Verifying sidecar…', compact: INDEX_VERIFYING_LABEL },
    recovering: { tone: 'info', label: 'Recovering…', compact: INDEX_RECOVERING_LABEL },
    'full-reindex': { tone: 'accent', label: 'Reindexing…', compact: INDEX_FULL_REINDEX_LABEL },
    'catching-up': { tone: 'accent', label: 'Catching up…', compact: INDEX_CATCHING_UP_LABEL },
    indexing: { tone: 'accent', label: 'Indexing…', compact: INDEX_INDEXING_LABEL },
    updating: { tone: 'warn', label: 'Updating…', compact: INDEX_UPDATING_LABEL },
    ok: { tone: 'good', label: 'Up to date', compact: INDEX_UP_TO_DATE_LABEL },
    error: { tone: 'bad', label: 'Index error', compact: INDEX_ERROR_LABEL },
    locked: { tone: 'bad', label: 'Index locked', compact: INDEX_LOCKED_LABEL },
    stuck: { tone: 'bad', label: 'Startup stuck', compact: INDEX_STUCK_LABEL },
};

/** Badge/dot chrome — full-reindex still uses the numbered indexing badge. */
export function indexStatusHealth(mode: IndexStatusMode): IndexStatusHealth {
    if (mode === 'updating') return 'updating';
    if (mode === 'full-reindex' || mode === 'catching-up') return 'indexing';
    if (mode === 'recovering') return 'restoring';
    if (mode === 'verifying') return 'starting';
    return mode;
}

export const INDEX_STATUS_HEALTH: Record<IndexStatusHealth, IndexStatusCopy> = {
    none: INDEX_STATUS_COPY.none,
    starting: INDEX_STATUS_COPY.starting,
    restoring: INDEX_STATUS_COPY.restoring,
    ok: INDEX_STATUS_COPY.ok,
    updating: INDEX_STATUS_COPY.updating,
    indexing: INDEX_STATUS_COPY.indexing,
    error: INDEX_STATUS_COPY.error,
    locked: INDEX_STATUS_COPY.locked,
    stuck: INDEX_STATUS_COPY.stuck,
};

export const IDLE_PROGRESS: IndexProgressIndicator = { phase: 'ready', units: null };

/** Sidecar hydrate / wait-for-producer file progress — not an embed catch-up job. */
export interface IndexHydrateProgress {
    done: number;
    total: number;
    /** Integer 0–100 from `indexPercent` — consumers must not recompute. */
    percent: number;
}

export interface IndexStatusReport {
    mode: IndexStatusMode;
    health: IndexStatusHealth;
    label: string;
    compact: string;
    tone: string;
    /** Small catch-up on a hydrated vault — green Ready dot with glow, not Updating. */
    quietCatchUp?: boolean;
    /** Present while hydrate/restore is the active job and a file total is known. */
    hydrateProgress: IndexHydrateProgress | null;
    /** Sole progress snapshot for status chrome. */
    progress: IndexProgressIndicator;
}

export interface IndexStatusReporterInput extends IndexUiStatusInput {
    jobKind?: ReporterJobKind | null;
    /**
     * Live sidecar hydrate (greedy files walked, needed/hydrated notes, or
     * wait-for-producer inventory vs vault files). Ignored for stuck/locked.
     */
    hydrateProgress?: IndexProgressWalkState | null;
    indexableNotes?: number;
    coverage?: { covered: number; total: number } | null;
    stuckWhy?: 'startup' | 'indexing';
}

export function normalizeHydrateProgress(
    progress: { done: number; total: number; percent?: number } | null | undefined,
): IndexHydrateProgress | null {
    if (!progress) return null;
    const total = Math.floor(progress.total);
    if (!Number.isFinite(total) || total <= 0) return null;
    const done = Math.min(total, Math.max(0, Math.floor(progress.done) || 0));
    return { done, total, percent: indexPercent(done, total) };
}

export function withHydrateProgressCopy(
    copy: IndexStatusCopy,
    progress: IndexHydrateProgress,
): IndexStatusCopy {
    const compactCounts = formatStableCompactProgress(progress.done, progress.total, progress.percent);
    const labelCounts = formatStableLabelProgress(progress.done, progress.total, progress.percent);
    return {
        ...copy,
        compact: `${copy.compact} ${compactCounts}`,
        label: `${copy.label} ${labelCounts}`,
    };
}

export function withIndicatorCopy(copy: IndexStatusCopy, units: IndexProgressUnits): IndexStatusCopy {
    if (!units.determinate) {
        return {
            ...copy,
            compact: `${copy.compact} ${formatStableFileFraction(units.done, units.total)}`,
            label: `${copy.label} ${formatStableFileFractionSpaced(units.done, units.total)}`,
        };
    }
    return withHydrateProgressCopy(copy, units);
}

export function indexStatusModeFromUi(
    ui: IndexUiStatus,
    jobKind?: ReporterJobKind | null,
    extras?: {
        dropRecovering?: boolean;
        verifying?: boolean;
        catchUpPending?: boolean;
        hydrating?: boolean;
    },
): IndexStatusMode {
    if (ui === 'locked' || ui === 'stuck' || ui === 'updating') return ui;
    if (extras?.verifying) return 'verifying';
    if (extras?.dropRecovering && (ui === 'restoring' || ui === 'starting')) return 'recovering';
    if (jobKind === 'full') return 'full-reindex';
    if (ui === 'indexing' && jobKind === 'catchup' && !extras?.hydrating) return 'catching-up';
    if (ui === 'ok' && extras?.catchUpPending) return 'catching-up';
    return ui;
}

function hydrateLegacyFromProgress(
    progress: IndexProgressIndicator,
    hydrating: boolean,
    mode: IndexStatusMode,
): IndexHydrateProgress | null {
    const units = progress.units;
    if (!units?.determinate) return null;
    const restoreLike = progress.phase === 'hydrating'
        || progress.phase === 'restoring'
        || progress.phase === 'recovering'
        || (mode === 'indexing' && hydrating);
    if (!restoreLike) return null;
    return { done: units.done, total: units.total, percent: units.percent };
}

export class IndexStatusReporter {
    static compute(input: IndexStatusReporterInput): IndexStatusReport {
        const ui = resolveIndexUiStatus(input);
        const jobActive = input.indexing || (input.job != null && input.job.total > 0);
        const quietCatchUp = classifyCatchUpPresentation({
            goodEnough: input.goodEnough,
            inventoryFiles: input.inventoryFiles,
            job: input.job,
            indexingActive: jobActive,
        }) === 'quiet';
        const notes = Math.max(0, Math.floor(input.indexableNotes ?? 0) || 0);
        const verifyOnly = isVerifyOnlyWalk({
            needed: input.hydrateProgress?.needed,
            inventoryFiles: input.inventoryFiles ?? null,
            indexableNotes: notes,
            waitingForSidecar: !!input.waitingForSidecar,
            dropRecovering: !!input.dropRecovering,
        });
        let mode = indexStatusModeFromUi(ui, input.jobKind, {
            dropRecovering: !!input.dropRecovering,
            verifying: verifyOnly && (ui === 'restoring' || ui === 'starting' || (!!input.hydrating && !input.goodEnough)),
            catchUpPending: !!input.catchUpPending,
            hydrating: !!input.hydrating,
        });
        const progress = computeIndexProgressIndicator({
            mode,
            hydrating: !!input.hydrating,
            waitingForSidecar: !!input.waitingForSidecar,
            dropRecovering: !!input.dropRecovering,
            booting: !!input.booting,
            goodEnough: !!input.goodEnough,
            catchUpPending: !!input.catchUpPending,
            mayFullReindex: input.mayFullReindex,
            walk: input.hydrateProgress ?? null,
            job: input.job ?? null,
            jobKind: input.jobKind ?? null,
            inventoryFiles: input.inventoryFiles ?? null,
            indexableNotes: notes,
            coverage: input.coverage ?? null,
        });
        if (progress.phase === 'verifying') mode = 'verifying';
        if (!quietCatchUp && progress.phase === 'catching-up' && (mode === 'ok' || mode === 'starting')) {
            mode = 'catching-up';
        }
        if (progress.phase === 'recovering' && (mode === 'restoring' || mode === 'starting')) mode = 'recovering';
        const health = indexStatusHealth(mode);
        let copy = INDEX_STATUS_COPY[mode];
        if (mode === 'stuck' && input.stuckWhy === 'indexing') {
            copy = { ...copy, label: 'Indexing stuck' };
        }
        const blocked = mode === 'stuck' || mode === 'locked' || mode === 'error' || mode === 'ok' || mode === 'updating' || mode === 'none';
        const units = blocked ? null : progress.units;
        if (units) copy = withIndicatorCopy(copy, units);
        return {
            mode,
            health,
            label: copy.label,
            compact: copy.compact,
            tone: copy.tone,
            quietCatchUp,
            hydrateProgress: hydrateLegacyFromProgress({ ...progress, units }, !!input.hydrating, mode),
            progress: { phase: progress.phase, units: blocked ? null : progress.units },
        };
    }
}
