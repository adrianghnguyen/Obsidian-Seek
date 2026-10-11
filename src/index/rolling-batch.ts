// Per-bucket rolling-buffer flush size for the index embed path.
//
// Interactive catch-up keeps a token BUDGET so a long (512) bucket flushes at
// batch 3 and the non-preemptible WebGPU forward stays short while the user
// types. A full vault reindex has no such UI constraint — the warmup grid
// already covers batch 8 on every seq rung — so it dispatches at ROLLING_MAX.

export const ROLLING_BUDGET = 1536;
export const ROLLING_MAX = 8;
export const ROLLING_BUDGET_MIN = 256;
export const ROLLING_BUDGET_MAX = 4096;

export type IndexEmbedMode = 'full' | 'incremental';

export function clampRollingBatchMax(n: number): number {
    if (!Number.isFinite(n)) return ROLLING_MAX;
    return Math.max(1, Math.min(ROLLING_MAX, Math.round(n)));
}

export function clampRollingTokenBudget(n: number): number {
    if (!Number.isFinite(n)) return ROLLING_BUDGET;
    return Math.max(ROLLING_BUDGET_MIN, Math.min(ROLLING_BUDGET_MAX, Math.round(n)));
}

export interface RollingBatchOpts {
    rollingBatchMax?: number;
    rollingTokenBudget?: number;
}

/** Chunks to take from one seq-bucket buffer for a single embedBatch. */
export function rollingBatchFor(
    bucket: number,
    mode: IndexEmbedMode,
    opts: RollingBatchOpts = {},
): number {
    const max = clampRollingBatchMax(opts.rollingBatchMax ?? ROLLING_MAX);
    const budget = clampRollingTokenBudget(opts.rollingTokenBudget ?? ROLLING_BUDGET);
    if (mode === 'full') return max;
    return Math.max(1, Math.min(max, Math.round(budget / bucket)));
}
