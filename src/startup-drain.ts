// Desktop-only auto drain of pending startup catch-up. Independent of the
// optional "Warm caches on startup" setting — catch-up is index correctness,
// cache warm is a latency nicety.

import {
    CATCHUP_BURST_BUDGET_MS,
    CATCHUP_MAX_FILES_PER_BURST,
    DESKTOP_CATCHUP_BURST_BUDGET_MS,
    DESKTOP_CATCHUP_MAX_FILES_PER_BURST,
} from './catchup';

export function shouldAutoDrainStartupCatchUp(opts: {
    mobile: boolean;
    catchUpPending: boolean;
    emptyIndexWithNotes?: boolean;
}): boolean {
    if (opts.mobile) return false;
    return opts.catchUpPending || !!opts.emptyIndexWithNotes;
}

/** True only for a probed-empty store. `null` inventory is unknown — never treat as empty. */
export function isKnownEmptyIndexWithNotes(inventoryChunks: number | null, noteCount: number): boolean {
    return inventoryChunks === 0 && noteCount > 0;
}

/** Whole-vault dirty count above which an empty file-record store is treated as cold build. */
export const COLD_BUILD_DIRTY_THRESHOLD = 50;

export type IndexBuildMode = 'cold' | 'catchup' | 'idle';

export const CATCHUP_BURST_MAX_FILES_MIN = 1;
export const CATCHUP_BURST_MAX_FILES_MAX = 40;
export const DEFAULT_CATCHUP_BURST_MAX_FILES = DESKTOP_CATCHUP_MAX_FILES_PER_BURST;

export function clampCatchUpBurstMaxFiles(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_CATCHUP_BURST_MAX_FILES;
    return Math.max(CATCHUP_BURST_MAX_FILES_MIN, Math.min(CATCHUP_BURST_MAX_FILES_MAX, Math.round(n)));
}

export function catchUpBurstLimits(opts: { mobile: boolean; burstMaxFiles: number }): {
    maxFiles: number;
    budgetMs: number;
} {
    if (opts.mobile) {
        return { maxFiles: CATCHUP_MAX_FILES_PER_BURST, budgetMs: CATCHUP_BURST_BUDGET_MS };
    }
    return {
        maxFiles: clampCatchUpBurstMaxFiles(opts.burstMaxFiles),
        budgetMs: DESKTOP_CATCHUP_BURST_BUDGET_MS,
    };
}

/** Pick full reindex vs throttled catch-up vs nothing after startup reconcile. */
export function resolveIndexBuildMode(input: {
    inventoryChunks: number | null;
    noteCount: number;
    dirtyCount: number;
    storedFiles: number;
}): IndexBuildMode {
    if (input.dirtyCount <= 0) return 'idle';
    if (isKnownEmptyIndexWithNotes(input.inventoryChunks, input.noteCount)) return 'cold';
    if (input.storedFiles === 0 && input.dirtyCount > COLD_BUILD_DIRTY_THRESHOLD) return 'cold';
    return 'catchup';
}
