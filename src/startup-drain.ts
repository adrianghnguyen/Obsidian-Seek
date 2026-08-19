// Desktop-only auto drain of pending startup catch-up. Independent of the
// optional "Warm caches on startup" setting — catch-up is index correctness,
// cache warm is a latency nicety.

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
