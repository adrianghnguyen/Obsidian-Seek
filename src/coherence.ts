/**
 * @file coherence.ts
 * @module Coherence
 *
 * ## Responsibilities
 * Pure decision functions and invariants for memory cache coherence and drift recovery:
 * - Frame compaction trigger (`COMPACTION_TOMBSTONE_FRACTION = 0.25`): governs when
 *   accumulated tombstones warrant an O(N) re-indexing pass to reclaim holes.
 * - Cache drift circuit breaker (`coherenceDriftDecision`): throttles UI toasts and
 *   expensive re-warms if drift re-trips within `COHERENCE_DRIFT_COOLDOWN_MS` (30s).
 * - Partial frame discard predicate (`shouldDiscardPartialFrame`): guards against race
 *   conditions where the index generation advanced while a frame was being assembled.
 * - Spot-check verification (`frameBm25Coherent`): tests random row samples to verify
 *   that resident frame chunk IDs and BM25 document IDs are in exact 1:1 alignment.
 * - Drift recovery scheduling (`driftRecoveryDecision`): guards embed-free background
 *   drift recovery from concurrent or redundant execution.
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: Pure foundation layer. Depends only on `ResidentFrame` type definition.
 * - **Call-order prerequisite**: Evaluated during `CacheManager.ensureFrame()` immediately
 *   after frame assembly and during `SearchOrchestrator` delta index updates.
 * - **Concurrency Invariants**:
 *   - Frame assembly MUST verify `shouldDiscardPartialFrame` before publishing the frame.
 *   - Drift detection ALWAYS invalidates caches immediately (`invalidate: true`), but
 *     warm/notify actions are deferred if the cooldown has not elapsed.
 */

import type { ResidentFrame } from './frame-utils';

// Compaction fires when this fraction of rows are tombstones — the amortized O(N)
// renumber that keeps the frame from growing unbounded with holes (a full rebuild
// produces a dense, fully-live frame).
export const COMPACTION_TOMBSTONE_FRACTION = 0.25;
// Rows sampled by the drift detector's id↔row spot-check (the warm-build verify path checks all).
export const COHERENCE_SAMPLES = 8;
// Circuit breaker for onCoherenceDrift: a drift that re-trips within this window of
// the last rebuild is treated as PERSISTENT (not a one-off), so the expensive
// re-warm + the user Notice are suppressed to break the thrash. The cache is still
// invalidated every trip (correctness), so the next search rebuilds it lazily once.
// Without this, one bad delta drove an unbounded toast+rebuild loop (2026-06-18).
export const COHERENCE_DRIFT_COOLDOWN_MS = 30_000;

// Pure decision for that circuit breaker, extracted so it's unit-testable without a
// live SearchOrchestrator (onCoherenceDrift is a private method with heavy deps).
// invalidate is ALWAYS true — a mis-coupled frame/BM25 must never serve, and the
// drop is cheap. warm (the O(N) rebuild + the user Notice) is allowed only once the
// cooldown since the last warm has elapsed, so a re-trip inside the window degrades
// to a lazy cold rebuild instead of a toast+rebuild storm.
export function coherenceDriftDecision(
    now: number, lastWarmAt: number, cooldownMs: number,
): { invalidate: boolean; warm: boolean } {
    return { invalidate: true, warm: now - lastWarmAt >= cooldownMs };
}

// F2 guard, extracted so ensureFrame's "don't cache a partial frame as fresh"
// invariant has a named, directly-tested home. A frame assembled at buildGen must
// be discarded (rebuilt) when the index generation advanced while we were reading:
// a full reindex completing mid-assembly would otherwise let the stale-partial
// frame be cached under the NEW generation and served as fresh. True ⇒ discard
// (the call sites re-enter ensureFrame, which converges in one extra pass).
export function shouldDiscardPartialFrame(buildGen: number, currentGen: number): boolean {
    return currentGen !== buildGen;
}

// Pure decision for the plugin's drift-recovery scheduler: escalate an embed-free
// recovery for THIS index state, or not. The suppression is generation-keyed — a
// degraded index re-trips drift on every keystroke, but currentGen only advances on
// a real index mutation, so once we've escalated for a generation we don't escalate
// again until something actually changes (a later delta/reindex/invalidate/hydrate
// bumps the generation, re-arming recovery for the new state). running short-circuits
// so a recovery already in flight is never double-scheduled. health is carried for the
// caller's UI/state but is deliberately NOT consulted here — the gen key alone decides.
export interface DriftRecoveryState {
    running: boolean;
    health: 'healthy' | 'recovering' | 'degraded';
    lastRecoveryGen: number;   // generation we last escalated for; -1 = never
    currentGen: number;
}
export function driftRecoveryDecision(s: DriftRecoveryState): { schedule: boolean } {
    if (s.running) return { schedule: false };
    if (s.currentGen === s.lastRecoveryGen) return { schedule: false };
    return { schedule: true };
}

// The BM25 surface the drift detector reads — MultiFieldBM25 satisfies it
// structurally (get size / get liveCount / rowOf). Decoupled as an interface so
// the detector is a pure, engine-free unit test target.
export interface RowSpaceProbe {
    readonly size: number;       // R: rows incl tombstones (== frame.orderedChunks.length)
    readonly liveCount: number;  // live (non-tombstoned) rows
    rowOf(id: string): number | undefined;
}

// Row-space coherence between the frame and the BM25 index — THE fragile invariant
// of the incremental path. At query time a single `idx` indexes orderedChunks[idx]
// / activePacked[idx] / residentInt8[idx] / bm25Scores[idx] together, so if their
// numbering ever drifts, search returns plausible-but-wrong scores: silent,
// in-bounds, relevance-degrading. This makes drift LOUD. O(1) structural checks
// always; a sampled (full only on the warm-build verify path) idToIdx[orderedIds[i]]===i spot-check on
// top. A false return is the trip — the caller logs + drops to a full rebuild,
// converting silent drift into a visible "rebuilt from scratch" event.
export function frameBm25Coherent(frame: ResidentFrame, probe: RowSpaceProbe, full = false): boolean {
    const n = frame.orderedChunks.length;
    // O(1): row counts + live counts must agree across both structures.
    if (probe.size !== n) return false;
    if (frame.orderedIds.length !== n || frame.validRows.length !== n) return false;
    if (probe.liveCount !== n - frame.tombstoneCount) return false;
    if (n === 0) return true;
    // id↔row spot-check over LIVE rows (tombstone holes carry no BM25 entry).
    const samples = full ? n : Math.min(COHERENCE_SAMPLES, n);
    for (let s = 0; s < samples; s++) {
        const i = full ? s : Math.floor((s * (n - 1)) / Math.max(1, samples - 1));
        if (!frame.validRows[i]) continue;
        if (probe.rowOf(frame.orderedIds[i]) !== i) return false;
    }
    return true;
}
