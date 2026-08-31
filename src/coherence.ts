// Coherence-check and drift-recovery utilities extracted from search.ts.
//
// These pure functions detect and react to frame/BM25 index misalignment
// without any SearchOrchestrator dependency. Tests in applydelta-coherence
// and drift-recovery test suites.

import type { ResidentFrame } from './frame-utils';

// Compaction fires when this fraction of rows are tombstones.
export const COMPACTION_TOMBSTONE_FRACTION = 0.25;

// Rows sampled by the drift detector's id↔row spot-check.
export const COHERENCE_SAMPLES = 8;

// Circuit breaker for coherence drift: a re-trip within this window of the
// last rebuild is treated as persistent, suppressing expensive re-warm.
export const COHERENCE_DRIFT_COOLDOWN_MS = 30_000;

// Pure decision for the drift circuit breaker. invalidate is always true
// (mis-coupled frame/BM25 must never serve). warm is allowed only once the
// cooldown since the last warm has elapsed.
export function coherenceDriftDecision(
    now: number,
    lastWarmAt: number,
    cooldownMs: number,
): { invalidate: boolean; warm: boolean } {
    return { invalidate: true, warm: now - lastWarmAt >= cooldownMs };
}

// The BM25 surface the drift detector reads. Decoupled as an interface so
// the detector is a pure, engine-free unit test target.
export interface RowSpaceProbe {
    readonly size: number;
    readonly liveCount: number;
    rowOf(id: string): number | undefined;
}

// Row-space coherence between the frame and the BM25 index. Returns false
// when the numbering has drifted, which would produce plausible-but-wrong
// search scores.
export function frameBm25Coherent(
    frame: ResidentFrame,
    probe: RowSpaceProbe,
    full = false,
): boolean {
    const n = frame.orderedChunks.length;
    if (probe.size !== n) return false;
    if (frame.orderedIds.length !== n || frame.validRows.length !== n) return false;
    if (probe.liveCount !== n - frame.tombstoneCount) return false;
    if (n === 0) return true;
    const samples = full ? n : Math.min(COHERENCE_SAMPLES, n);
    for (let s = 0; s < samples; s++) {
        const i = full ? s : Math.floor((s * (n - 1)) / Math.max(1, samples - 1));
        if (!frame.validRows[i]) continue;
        if (probe.rowOf(frame.orderedIds[i]) !== i) return false;
    }
    return true;
}

// Drift recovery decision: escalate an embed-free recovery for the current
// index state, or not. Suppressed when recovery is already running or when
// the generation hasn't changed since the last escalation.
export interface DriftRecoveryState {
    running: boolean;
    health: 'healthy' | 'recovering' | 'degraded';
    lastRecoveryGen: number;
    currentGen: number;
}

export function driftRecoveryDecision(s: DriftRecoveryState): { schedule: boolean } {
    if (s.running) return { schedule: false };
    if (s.currentGen === s.lastRecoveryGen) return { schedule: false };
    return { schedule: true };
}