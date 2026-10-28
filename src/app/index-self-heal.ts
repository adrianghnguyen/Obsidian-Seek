/**
 * Resume indexing after a stuck boot or aborted full reindex without treating a
 * leftover 1/1 hydrate walk as "the vault is done".
 */

export function coverageGap(indexedFiles: number | null, indexableNotes: number): number {
    const indexed = Math.max(0, indexedFiles ?? 0);
    const notes = Math.max(0, indexableNotes);
    return Math.max(0, notes - indexed);
}

/** True when FileRecords cover fewer notes than the live vault still wants indexed. */
export function vaultCoverageIncomplete(indexedFiles: number | null, indexableNotes: number): boolean {
    return coverageGap(indexedFiles, indexableNotes) > 0;
}

export interface SidecarHydrateWalk {
    done: number;
    total: number;
    needed?: number;
    hydrated?: number;
}

/**
 * Keep a vault-scale hydrate walk. A batch-local total (1/1, N-notes-in-this-call)
 * must not be stretched onto the vault denominator — that paints 1/3132 · 1%.
 * Drop the event so the caller can fall back to inventory coverage.
 * A verify-only walk (`needed === 0`) keeps its own file total (3-day tier).
 */
export function hydrateProgressAgainstVault(
    progress: SidecarHydrateWalk | null | undefined,
    indexableNotes: number,
    needed?: number,
): SidecarHydrateWalk | null {
    if (!progress) return null;
    const vault = Math.max(0, Math.floor(indexableNotes) || 0);
    const reportedTotal = Math.floor(progress.total);
    if (!Number.isFinite(reportedTotal) || reportedTotal <= 0) return null;
    const walkNeeded = needed ?? progress.needed;
    if (walkNeeded !== 0 && vault > 0 && reportedTotal < vault) return null;
    const done = Math.min(reportedTotal, Math.max(0, Math.floor(progress.done) || 0));
    return {
        done,
        total: reportedTotal,
        needed: walkNeeded,
        hydrated: progress.hydrated,
    };
}

/**
 * In-flight restore: never replace a larger vault total with a smaller batch total.
 * A verify-only update (`needed === 0`) may shrink vault-wide 0/N to the 3-day tier.
 */
export function applySidecarHydrateProgressUpdate(
    current: SidecarHydrateWalk | null,
    incoming: SidecarHydrateWalk,
    inFlight: boolean,
): SidecarHydrateWalk | null {
    const total = Math.floor(incoming.total);
    if (!Number.isFinite(total) || total <= 0) return current;
    const next: SidecarHydrateWalk = {
        done: Math.max(0, Math.floor(incoming.done) || 0),
        total,
    };
    if (incoming.needed !== undefined) next.needed = incoming.needed;
    if (incoming.hydrated !== undefined) next.hydrated = incoming.hydrated;
    if (inFlight && current && current.total > 0 && total < current.total) {
        if ((incoming.needed ?? -1) === 0) return next;
        return current;
    }
    return next;
}

export function resolveSidecarHydrateProgress(input: {
    walk: SidecarHydrateWalk | null;
    hydrating: boolean;
    waitingForSidecar: boolean;
    dropRecovering: boolean;
    bootPending: boolean;
    goodEnough: boolean;
    inventoryFiles: number | null;
    indexableNotes: number;
}): SidecarHydrateWalk | null {
    const notes = Math.max(0, Math.floor(input.indexableNotes) || 0);
    const liveWalk = input.hydrating || input.waitingForSidecar || input.dropRecovering;
    if (liveWalk && input.walk && input.walk.total > 0) {
        const fromWalk = hydrateProgressAgainstVault(input.walk, notes, input.walk.needed);
        if (fromWalk) {
            const indexed = Math.max(0, input.inventoryFiles ?? 0);
            if (
                input.walk.needed === 0
                && notes > 0
                && indexed < notes
                && fromWalk.total >= notes
            ) {
                return null;
            }
            return fromWalk;
        }
    }
    if (!(
        input.waitingForSidecar
        || input.hydrating
        || input.dropRecovering
        || (input.bootPending && !input.goodEnough)
    )) return null;
    const done = Math.max(0, input.inventoryFiles ?? 0);
    const total = Math.max(done, notes);
    if (total <= 0) return null;
    if (input.walk?.needed === 0 && done < notes) return null;
    return { done, total };
}

export interface ResumeIndexingInput {
    indexableNotes: number;
    indexedFiles: number | null;
    indexing: boolean;
    hydrating: boolean;
    waitingForProducer: boolean;
}

/** Catch-up (not a wipe) when the vault still has unindexed notes and nothing is running. */
export function shouldResumeIndexing(input: ResumeIndexingInput): boolean {
    if (input.hydrating || input.waitingForProducer || input.indexing) return false;
    return vaultCoverageIncomplete(input.indexedFiles, input.indexableNotes);
}

/**
 * A hydrate walk that already reports done/total while the vault is larger is
 * leftover sidecar progress, not a live restore of the vault.
 */
export function staleCompleteHydrateWalk(
    progress: { done: number; total: number } | null | undefined,
    indexableNotes: number,
): boolean {
    if (!progress) return false;
    const notes = Math.max(0, Math.floor(indexableNotes) || 0);
    const total = Math.floor(progress.total);
    const done = Math.floor(progress.done);
    if (!Number.isFinite(total) || total <= 0) return false;
    if (!Number.isFinite(done) || done < total) return false;
    return notes > total;
}
