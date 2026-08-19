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
