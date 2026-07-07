// Pure decision for the proactive embedder unload (see main.ts maybeUnloadEmbedder).
// Tearing the iframe down is the only way to release its WebAssembly.Memory,
// which only grows within a page — a long mobile session otherwise ratchets the
// heap to the OOM ceiling. Extracted here, framework-free, so the idle-vs-
// background asymmetry is unit-tested in isolation.

export interface UnloadGateState {
    // The model is actually loaded — nothing to free otherwise.
    loaded: boolean;
    // A compute task (search / indexing / reindex) is mid-flight:
    // currentTaskContext !== 'idle'. Tearing down now would DISPOSE its embed.
    busy: boolean;
    // The live-query window: searchActive || queryInFlight (indexingBlocked).
    queryActive: boolean;
    // An embed/recovery is RUNNING and holds the write mutex:
    // flushing || catchUpRunning || driftRecoveryRunning.
    running: boolean;
    // Work is merely PENDING (not yet running): a deferred catch-up, a queued
    // dirty/deleted edit, an armed flush timer, or a queued drift escalation.
    // It will reload the model when it runs, so an idle unload here is pure churn.
    pending: boolean;
}

// Decide whether to tear the embedder down. Both reasons refuse to interrupt
// in-flight work (busy/queryActive/running) — a DISPOSE there is recoverable via
// the catch-up drain but wasteful, and can fight the write mutex. They diverge on
// PENDING work:
//   - 'idle':       stand down. A flush/catch-up is scheduled and would just
//                   reload the model we'd unload — unloading is needless churn.
//   - 'background': unload anyway. We're leaving (the WebView may be jetsam-
//                   killed); the pending embeds are re-found by computeDelta and
//                   reloaded on the next foreground, since every embed path calls
//                   ensureModelLoaded first. Freeing the heap now is the win.
export function shouldUnloadEmbedder(reason: 'idle' | 'background', s: UnloadGateState): boolean {
    if (!s.loaded) return false;
    if (s.busy || s.queryActive || s.running) return false;
    if (reason === 'idle' && s.pending) return false;
    return true;
}

// Pure decision for proactively loading the model shortly after boot, so the first
// search doesn't pay the full cold model load (the dominant cold-start cost). Kept
// framework-free + exported so the safety gates are unit-tested in isolation.
export interface PrewarmGateState {
    // settings.prewarmModelOnStart — the user opt-out.
    enabled: boolean;
    // isMobilePlatform() — mobile is EXCLUDED: loading ~250 MB on boot risks a jetsam
    // kill, and the mobile idle-unload timer would tear it back down within minutes
    // (pure churn). Cold start stays intentionally lazy on mobile.
    mobile: boolean;
    // The model bytes are ALREADY cached (Cache API / loaded / last-delivery log).
    // The gate refuses to prewarm otherwise, so boot never triggers a ~100 MB CDN
    // fetch on a metered/first-run connection — only the bounded WASM/GPU init.
    modelDownloaded: boolean;
    // There is something to search (chunks > 0). A brand-new/empty vault will load
    // the model on its first reindex anyway; prewarming it here would be wasted RAM.
    indexNonEmpty: boolean;
    // The model is already loaded, or a load is in flight (modelLoadPromise set) —
    // e.g. reconcileOnLoad started one. ensureModelLoaded is memoized so a prewarm
    // would coalesce harmlessly, but skipping keeps the intent explicit.
    alreadyLoadedOrLoading: boolean;
}

export function shouldPrewarmModelOnStart(s: PrewarmGateState): boolean {
    if (!s.enabled) return false;
    if (s.mobile) return false;
    if (!s.modelDownloaded) return false;
    if (!s.indexNonEmpty) return false;
    if (s.alreadyLoadedOrLoading) return false;
    return true;
}
