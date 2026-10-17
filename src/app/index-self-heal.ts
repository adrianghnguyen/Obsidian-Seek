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

/**
 * Stretch a hydrate file-walk against the live vault. A 1/1 sidecar walk must not
 * paint 100% when thousands of notes remain.
 */
export function hydrateProgressAgainstVault(
    progress: { done: number; total: number } | null | undefined,
    indexableNotes: number,
): { done: number; total: number } | null {
    if (!progress) return null;
    const vault = Math.max(0, Math.floor(indexableNotes) || 0);
    const reportedTotal = Math.floor(progress.total);
    if (!Number.isFinite(reportedTotal) || reportedTotal <= 0) return null;
    const total = Math.max(reportedTotal, vault);
    const done = Math.min(total, Math.max(0, Math.floor(progress.done) || 0));
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
