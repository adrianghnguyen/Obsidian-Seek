// One computed index-status snapshot for every high-level chrome consumer
// (status bar, Settings Index card / reindex heading, coverage health titles).
// Coarse precedence still lives in resolveIndexUiStatus; this layer adds
// full-reindex vs catch-up and the copy both UIs must share.

import {
    resolveIndexUiStatus,
    INDEX_NO_INDEX_LABEL,
    INDEX_STARTING_LABEL,
    INDEX_RESTORING_LABEL,
    INDEX_INDEXING_LABEL,
    INDEX_UP_TO_DATE_LABEL,
    INDEX_ERROR_LABEL,
    INDEX_LOCKED_LABEL,
    INDEX_STUCK_LABEL,
    type IndexUiStatus,
    type IndexUiStatusInput,
} from './index-notice';
import { indexPercent } from './index-eta';
export type IndexStatusHealth = 'none' | 'starting' | 'restoring' | 'ok' | 'indexing' | 'error' | 'locked' | 'stuck';
type ReporterJobKind = 'full' | 'delta' | 'catchup';

export const INDEX_FULL_REINDEX_LABEL = 'Reindexing';

/** High-level mode. Restoring covers drop, hydrate, and wait-for-producer. */
export type IndexStatusMode = IndexUiStatus | 'full-reindex';

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
    'full-reindex': { tone: 'accent', label: 'Reindexing…', compact: INDEX_FULL_REINDEX_LABEL },
    indexing: { tone: 'accent', label: 'Indexing…', compact: INDEX_INDEXING_LABEL },
    ok: { tone: 'good', label: 'Up to date', compact: INDEX_UP_TO_DATE_LABEL },
    error: { tone: 'bad', label: 'Index error', compact: INDEX_ERROR_LABEL },
    locked: { tone: 'bad', label: 'Index locked', compact: INDEX_LOCKED_LABEL },
    stuck: { tone: 'bad', label: 'Startup stuck', compact: INDEX_STUCK_LABEL },
};

/** Badge/dot chrome — full-reindex still uses the numbered indexing badge. */
export function indexStatusHealth(mode: IndexStatusMode): IndexStatusHealth {
    return mode === 'full-reindex' ? 'indexing' : mode;
}

export const INDEX_STATUS_HEALTH: Record<IndexStatusHealth, IndexStatusCopy> = {
    none: INDEX_STATUS_COPY.none,
    starting: INDEX_STATUS_COPY.starting,
    restoring: INDEX_STATUS_COPY.restoring,
    ok: INDEX_STATUS_COPY.ok,
    indexing: INDEX_STATUS_COPY.indexing,
    error: INDEX_STATUS_COPY.error,
    locked: INDEX_STATUS_COPY.locked,
    stuck: INDEX_STATUS_COPY.stuck,
};

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
    /** Present while hydrate/restore is the active job and a file total is known. */
    hydrateProgress: IndexHydrateProgress | null;
}

export interface IndexStatusReporterInput extends IndexUiStatusInput {
    jobKind?: ReporterJobKind | null;
    /**
     * Live sidecar hydrate (greedy files walked, needed/hydrated notes, or
     * wait-for-producer inventory vs vault files). Ignored for stuck/locked.
     */
    hydrateProgress?: { done: number; total: number; percent?: number } | null;
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

function hydrateCopyApplies(
    mode: IndexStatusMode,
    hydrating: boolean,
    waitingForSidecar: boolean,
): boolean {
    if (!(hydrating || waitingForSidecar)) return false;
    if (mode === 'starting' || mode === 'restoring') return true;
    return mode === 'indexing' && hydrating;
}

export function withHydrateProgressCopy(
    copy: IndexStatusCopy,
    progress: IndexHydrateProgress,
): IndexStatusCopy {
    const compactCounts = `${progress.done.toLocaleString()}/${progress.total.toLocaleString()} · ${progress.percent}%`;
    const labelCounts = `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} · ${progress.percent}%`;
    return {
        ...copy,
        compact: `${copy.compact} ${compactCounts}`,
        label: `${copy.label} ${labelCounts}`,
    };
}

export function indexStatusModeFromUi(
    ui: IndexUiStatus,
    jobKind?: ReporterJobKind | null,
): IndexStatusMode {
    if (ui === 'locked' || ui === 'stuck') return ui;
    // Clean-slate identity is degraded until the first FileRecords commit; a
    // live full job must still paint Reindexing, not Index error.
    if (jobKind === 'full') return 'full-reindex';
    return ui;
}

export class IndexStatusReporter {
    static compute(input: IndexStatusReporterInput): IndexStatusReport {
        const ui = resolveIndexUiStatus(input);
        const mode = indexStatusModeFromUi(ui, input.jobKind);
        const base = INDEX_STATUS_COPY[mode];
        const live = hydrateCopyApplies(mode, !!input.hydrating, !!input.waitingForSidecar)
            ? normalizeHydrateProgress(input.hydrateProgress)
            : null;
        const copy = live ? withHydrateProgressCopy(base, live) : base;
        return {
            mode,
            health: indexStatusHealth(mode),
            label: copy.label,
            compact: copy.compact,
            tone: copy.tone,
            hydrateProgress: live,
        };
    }
}
