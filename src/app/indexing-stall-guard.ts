/**
 * Detect indexing work that holds the UI in "indexing" without making progress
 * (e.g. catchUpRunning stuck on an unbounded IndexedDB read). Pure helpers
 * for unit tests; main.ts owns timers and recovery actions.
 */

export const INDEXING_STALL_TIMEOUT_MS = 90_000;

export interface IndexingStallSnapshot {
    catchUpRunning: boolean;
    flushing: boolean;
    indexing: boolean;
    writing: boolean;
    /** Files done in the active job, or null when no job row yet. */
    jobDone: number | null;
    jobTotal: number | null;
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

/** Progress signature used to bump the heartbeat when job counters move. */
export function indexingProgressKey(s: IndexingStallSnapshot): string {
    return [
        s.catchUpRunning ? '1' : '0',
        s.flushing ? '1' : '0',
        s.indexing ? '1' : '0',
        s.writing ? '1' : '0',
        s.jobDone ?? 'n',
        s.jobTotal ?? 'n',
    ].join(':');
}
