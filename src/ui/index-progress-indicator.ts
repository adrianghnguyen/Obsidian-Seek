// Progress submodule bound to IndexStatusReporter. Owns work phase + units.
// Status bar, Settings Index, and the search-modal footer read this snapshot —
// they must not keep a second sidecarHydrateProgress object.

import { indexPercent } from './index-eta';
import {
    applySidecarHydrateProgressUpdate,
    hydrateProgressAgainstVault,
    resolveSidecarHydrateProgress,
} from '../app/index-self-heal';

export type IndexProgressWorkPhase =
    | 'ready'
    | 'starting'
    | 'restoring'
    | 'hydrating'
    | 'verifying'
    | 'indexing'
    | 'catching-up'
    | 'recovering'
    | 'stuck'
    | 'locked'
    | 'error'
    | 'none';

export interface IndexProgressUnits {
    done: number;
    total: number;
    percent: number;
    /** False when total is unknown or a verify walk has not checked a file yet. */
    determinate: boolean;
}

export interface IndexProgressWalkState {
    done: number;
    total: number;
    needed?: number;
    hydrated?: number;
}

export interface IndexProgressIndicator {
    phase: IndexProgressWorkPhase;
    units: IndexProgressUnits | null;
}

export function isVerifyOnlyWalk(input: {
    needed?: number | null;
    inventoryFiles: number | null;
    indexableNotes: number;
    waitingForSidecar?: boolean;
    dropRecovering?: boolean;
}): boolean {
    if (input.waitingForSidecar || input.dropRecovering) return false;
    if (input.needed !== 0) return false;
    const notes = Math.max(0, Math.floor(input.indexableNotes) || 0);
    const indexed = Math.max(0, input.inventoryFiles ?? 0);
    return notes > 0 && indexed >= notes;
}

/** Live sidecar / verify walk. Writers publish here instead of a plugin field. */
export class IndexProgressWalk {
    private state: IndexProgressWalkState | null = null;

    publish(incoming: IndexProgressWalkState, inFlight: boolean): boolean {
        const next = applySidecarHydrateProgressUpdate(this.state, incoming, inFlight);
        if (next === this.state) return false;
        this.state = next;
        return true;
    }

    clear(): void {
        this.state = null;
    }

    snapshot(): IndexProgressWalkState | null {
        return this.state;
    }
}

export function unitsFromCounts(
    done: number,
    total: number,
    opts?: { determinate?: boolean },
): IndexProgressUnits | null {
    const t = Math.floor(total);
    if (!Number.isFinite(t) || t <= 0) return null;
    const d = Math.min(t, Math.max(0, Math.floor(done) || 0));
    const determinate = opts?.determinate ?? d > 0;
    return {
        done: d,
        total: t,
        percent: determinate ? indexPercent(d, t) : 0,
        determinate,
    };
}

export type IndexProgressModeHint =
    | IndexProgressWorkPhase
    | 'ok'
    | 'full-reindex';

export function workPhaseFromMode(mode: IndexProgressModeHint): IndexProgressWorkPhase {
    if (mode === 'ok') return 'ready';
    if (mode === 'full-reindex') return 'indexing';
    return mode;
}

export interface IndexProgressIndicatorInput {
    mode: IndexProgressModeHint;
    hydrating: boolean;
    waitingForSidecar: boolean;
    dropRecovering: boolean;
    booting: boolean;
    goodEnough: boolean;
    catchUpPending?: boolean;
    mayFullReindex?: boolean | null;
    walk: IndexProgressWalkState | null;
    job: { done: number; total: number } | null;
    jobKind?: 'full' | 'delta' | 'catchup' | null;
    inventoryFiles: number | null;
    indexableNotes: number;
    coverage?: { covered: number; total: number } | null;
}

function coverageComplete(inventoryFiles: number | null, indexableNotes: number): boolean {
    const notes = Math.max(0, Math.floor(indexableNotes) || 0);
    const indexed = Math.max(0, inventoryFiles ?? 0);
    return notes > 0 && indexed >= notes;
}

function embedUnits(input: IndexProgressIndicatorInput): IndexProgressUnits | null {
    const coverage = input.coverage && input.coverage.total > 0 ? input.coverage : null;
    if (coverage) return unitsFromCounts(coverage.covered, coverage.total, { determinate: coverage.covered > 0 });
    const job = input.job;
    if (job && job.total > 0) return unitsFromCounts(job.done, job.total, { determinate: job.done > 0 });
    return null;
}

/**
 * Sole progress resolver for chrome. `{0,0}` / `{1,1}` never freeze at 0% or 1%
 * when inventory coverage exists. A needed=0 walk on a full index is Verifying,
 * never Restoring 0%. catchUpPending is Catching up, never Ready.
 */
export function computeIndexProgressIndicator(input: IndexProgressIndicatorInput): IndexProgressIndicator {
    const notes = Math.max(0, Math.floor(input.indexableNotes) || 0);
    const needed = input.walk?.needed;
    const verifyOnly = isVerifyOnlyWalk({
        needed,
        inventoryFiles: input.inventoryFiles,
        indexableNotes: notes,
        waitingForSidecar: input.waitingForSidecar,
        dropRecovering: input.dropRecovering,
    });

    if (input.mode === 'stuck' || input.mode === 'locked' || input.mode === 'error' || input.mode === 'none') {
        return { phase: workPhaseFromMode(input.mode), units: null };
    }

    if (verifyOnly && (input.hydrating || input.booting || input.mode === 'restoring' || input.mode === 'starting' || input.mode === 'verifying')) {
        const walk = input.walk;
        const walkTotal = walk && walk.total > 0 ? walk.total : 0;
        const walkDone = walk ? Math.max(0, Math.floor(walk.done) || 0) : 0;
        const tierWalk = walkTotal > 0 && (walkTotal < notes || walkDone > 0);
        if (tierWalk) {
            return {
                phase: 'verifying',
                units: unitsFromCounts(walkDone, walkTotal, { determinate: walkDone > 0 }),
            };
        }
        return { phase: 'verifying', units: null };
    }

    const liveRestore = input.hydrating
        || input.waitingForSidecar
        || input.dropRecovering
        || (input.booting && input.mayFullReindex === false && !input.goodEnough);

    if (liveRestore && input.mode !== 'ok' && (input.hydrating || input.mode !== 'catching-up')) {
        const resolved = resolveSidecarHydrateProgress({
            walk: input.walk,
            hydrating: input.hydrating,
            waitingForSidecar: input.waitingForSidecar,
            dropRecovering: input.dropRecovering,
            bootPending: input.booting,
            goodEnough: input.goodEnough,
            inventoryFiles: input.inventoryFiles,
            indexableNotes: notes,
        });
        const fromWalk = input.walk
            ? hydrateProgressAgainstVault(input.walk, notes, input.walk.needed)
            : null;
        const raw = fromWalk ?? resolved;
        const units = raw
            ? unitsFromCounts(raw.done, raw.total, {
                determinate: input.dropRecovering ? raw.done > 0 : raw.total > 0,
            })
            : null;
        const phase: IndexProgressWorkPhase = input.dropRecovering
            ? 'recovering'
            : (input.hydrating ? 'hydrating' : 'restoring');
        return { phase, units };
    }

    if (input.mode === 'full-reindex' || input.mode === 'indexing' || input.mode === 'catching-up') {
        const phase: IndexProgressWorkPhase = input.mode === 'catching-up'
            ? 'catching-up'
            : (input.mode === 'full-reindex' ? 'indexing' : (input.jobKind === 'catchup' ? 'catching-up' : 'indexing'));
        return { phase, units: embedUnits(input) };
    }

    if (input.catchUpPending && (input.mode === 'ok' || input.mode === 'ready' || input.mode === 'starting')) {
        return { phase: 'catching-up', units: embedUnits(input) };
    }

    if (input.mode === 'starting') {
        const indexed = Math.max(0, input.inventoryFiles ?? 0);
        const units = notes > 0 && indexed > 0
            ? unitsFromCounts(indexed, Math.max(indexed, notes), { determinate: indexed > 0 })
            : null;
        return { phase: 'starting', units };
    }

    return { phase: workPhaseFromMode(input.mode), units: null };
}
