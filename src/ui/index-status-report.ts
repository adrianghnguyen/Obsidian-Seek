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

export interface IndexStatusReport {
    mode: IndexStatusMode;
    health: IndexStatusHealth;
    label: string;
    compact: string;
    tone: string;
}

export interface IndexStatusReporterInput extends IndexUiStatusInput {
    jobKind?: ReporterJobKind | null;
}

export function indexStatusModeFromUi(
    ui: IndexUiStatus,
    jobKind?: ReporterJobKind | null,
): IndexStatusMode {
    if (ui === 'indexing' && jobKind === 'full') return 'full-reindex';
    return ui;
}

export class IndexStatusReporter {
    static compute(input: IndexStatusReporterInput): IndexStatusReport {
        const ui = resolveIndexUiStatus(input);
        const mode = indexStatusModeFromUi(ui, input.jobKind);
        const copy = INDEX_STATUS_COPY[mode];
        return {
            mode,
            health: indexStatusHealth(mode),
            label: copy.label,
            compact: copy.compact,
            tone: copy.tone,
        };
    }
}
