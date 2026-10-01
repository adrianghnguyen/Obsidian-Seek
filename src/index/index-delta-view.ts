/**
 * Cheap pending-path snapshot for Settings coverage + embed diagnostics.
 * Updated from indexing hooks (dirtyQueue, computeDelta, committedPaths) —
 * never by calling computeDelta from the Settings paint path.
 */

export interface IndexDeltaSnapshot {
    /** Paths known to need embed: dirtyQueue ∪ last computeDelta dirty − committed. */
    pendingPaths: readonly string[];
    /** When the snapshot was last updated (Date.now()). */
    at: number;
    /** Paths committed in the most recent burst, if any. */
    lastCommitted?: readonly string[];
}

export function emptyIndexDeltaSnapshot(at = 0): IndexDeltaSnapshot {
    return { pendingPaths: [], at };
}

/** Union dirty-from-delta with the live dirty queue (sorted for stable UI). */
export function mergePendingPaths(
    dirtyFromDelta: Iterable<string>,
    dirtyQueue: Iterable<string>,
): string[] {
    const set = new Set<string>();
    for (const p of dirtyFromDelta) set.add(p);
    for (const p of dirtyQueue) set.add(p);
    return [...set].sort();
}

/** Drop committed paths from a pending set. */
export function removeCommittedPaths(
    pending: Iterable<string>,
    committed: Iterable<string>,
): string[] {
    const drop = new Set(committed);
    if (drop.size === 0) return [...pending].sort();
    return [...pending].filter(p => !drop.has(p)).sort();
}

/**
 * In-memory tracker owned by SeekPlugin. Callers mutate via the typed
 * methods; Settings reads via snapshot().
 */
export class IndexDeltaTracker {
    private pending = new Set<string>();
    private lastCommitted: string[] = [];
    private at = 0;

    /** Add paths from dirtyQueue enqueue / structural create. */
    addPending(paths: Iterable<string>): void {
        let changed = false;
        for (const p of paths) {
            if (!this.pending.has(p)) {
                this.pending.add(p);
                changed = true;
            }
        }
        if (changed) this.at = Date.now();
    }

    /** Remove a path that left the queue (delete / rename-away). */
    removePending(paths: Iterable<string>): void {
        let changed = false;
        for (const p of paths) {
            if (this.pending.delete(p)) changed = true;
        }
        if (changed) this.at = Date.now();
    }

    /**
     * Replace pending with the union of a fresh computeDelta dirty list and
     * whatever is still in the live dirty queue.
     */
    setFromDelta(dirty: readonly string[], dirtyQueue: Iterable<string>): void {
        this.pending = new Set(mergePendingPaths(dirty, dirtyQueue));
        this.at = Date.now();
    }

    /** After a reindexDelta burst: drop committed paths and remember them. */
    applyCommitted(committed: readonly string[]): void {
        if (committed.length === 0) return;
        this.lastCommitted = [...committed];
        for (const p of committed) this.pending.delete(p);
        this.at = Date.now();
    }

    /** Pass finished with nothing left to drain. */
    clear(): void {
        this.pending.clear();
        this.lastCommitted = [];
        this.at = Date.now();
    }

    snapshot(): IndexDeltaSnapshot {
        return {
            pendingPaths: [...this.pending].sort(),
            at: this.at,
            lastCommitted: this.lastCommitted.length > 0 ? [...this.lastCommitted] : undefined,
        };
    }
}
