/**
 * Detect indexing work that holds the UI in "indexing" without making progress
 * (e.g. catchUpRunning stuck on an unbounded IndexedDB read). Pure helpers
 * for unit tests; main.ts owns timers and recovery actions.
 */

export const INDEXING_STALL_TIMEOUT_MS = 90_000;
/** Full reindex GPU+IDB overlap can sit >90s between file commits on a large vault. */
export const FULL_REINDEX_STALL_TIMEOUT_MS = 300_000;

export interface IndexingStallSnapshot {
    catchUpRunning: boolean;
    flushing: boolean;
    indexing: boolean;
    writing: boolean;
    /** Files done in the active job, or null when no job row yet. */
    jobDone: number | null;
    jobTotal: number | null;
    /** Chunks painted on the live job (GPU progress can move while files stall). */
    jobChunks?: number | null;
    jobKind?: 'full' | 'delta' | 'catchup' | null;
}

export function indexingWorkActive(s: IndexingStallSnapshot): boolean {
    return s.catchUpRunning || s.flushing || s.indexing || s.writing;
}

/** True when work appears active but progress heartbeat has been silent too long. */
export function indexingStallDetected(
    lastProgressAt: number,
    now: number,
    timeoutMs: number,
    s: IndexingStallSnapshot,
): boolean {
    if (!indexingWorkActive(s)) return false;
    return now - lastProgressAt >= timeoutMs;
}

export function stallTimeoutMs(s: IndexingStallSnapshot): number {
    return s.jobKind === 'full' ? FULL_REINDEX_STALL_TIMEOUT_MS : INDEXING_STALL_TIMEOUT_MS;
}

/** Progress signature used to bump the heartbeat when job counters move. */
export function indexingProgressKey(s: IndexingStallSnapshot): string {
    return [
        s.catchUpRunning ? '1' : '0',
        s.flushing ? '1' : '0',
        s.indexing ? '1' : '0',
        s.writing ? '1' : '0',
        s.jobDone ?? 'n',
        s.jobTotal ?? 'n',
        s.jobChunks ?? 'n',
        s.jobKind ?? 'n',
    ].join(':');
}
