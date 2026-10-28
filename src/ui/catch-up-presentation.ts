/**
 * Single source of truth for minor/small catch-up: quiet green-dot chrome,
 * pass-scoped file counts vs vault coverage overlay, and the 1% inventory threshold.
 */

/** Pass size below this fraction of indexed files → quiet (green glow) not Updating. */
export const MINOR_CATCHUP_FRACTION = 0.01;

export type CatchUpJobKind = 'full' | 'delta' | 'catchup';

export function isCatchUpEmbedKind(kind: CatchUpJobKind | null | undefined): boolean {
    return kind === 'catchup' || kind === 'delta';
}

/** True when the embed pass is tiny relative to vault inventory (same threshold as quiet UI). */
export function isSmallCatchUpPass(passTotal: number, inventoryFiles: number): boolean {
    const pass = Math.floor(passTotal);
    const inventory = Math.floor(inventoryFiles);
    if (pass <= 0 || inventory <= 0) return false;
    return pass / inventory < MINOR_CATCHUP_FRACTION;
}

export interface CatchUpPresentationInput {
    goodEnough?: boolean;
    inventoryFiles: number | null;
    job?: { done: number; total: number; kind?: CatchUpJobKind } | null;
    /** Catch-up / flush / reindex embed activity, or an active coordinator job. */
    indexingActive: boolean;
}

export type CatchUpPresentation = 'quiet' | 'moderate';

/**
 * Classify catch-up/delta passes on a good-enough index. Full reindex and
 * non-catch-up jobs return null (callers fall through to indexing chrome).
 */
export function classifyCatchUpPresentation(input: CatchUpPresentationInput): CatchUpPresentation | null {
    if (!input.indexingActive) return null;
    const job = input.job;
    if (!job || job.total <= 0) return null;
    if (!input.goodEnough) return null;
    const inventory = input.inventoryFiles ?? 0;
    if (inventory <= 0) return null;
    if (job.kind === 'full') return null;
    if (job.kind != null && !isCatchUpEmbedKind(job.kind)) return null;
    return isSmallCatchUpPass(job.total, inventory) ? 'quiet' : 'moderate';
}

/**
 * Status chrome file counts: catch-up/delta (or tiny pass) use pass done/total,
 * not vault coverage overlay. Full reindex keeps coverage-first display.
 */
export function shouldPreferPassCountsOverCoverage(input: {
    jobKind?: CatchUpJobKind | null;
    quietCatchUp?: boolean;
    passTotal?: number;
    inventoryFiles?: number | null;
}): boolean {
    if (input.quietCatchUp) return true;
    if (isCatchUpEmbedKind(input.jobKind ?? null)) return true;
    if (input.jobKind === 'full') return false;
    return isSmallCatchUpPass(input.passTotal ?? 0, input.inventoryFiles ?? 0);
}
