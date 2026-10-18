/**
 * Single in-flight index job for Recover / Resume / Full reindex / Force reset.
 *
 * A healthy live job is joined (attach), not stacked. Recover while already
 * recovering is a no-op. Takeover (cancel + replace) is only for a latched job
 * that is stuck, stalled, locked, or wedged.
 */

export type IndexUserIntent = 'recover' | 'resume' | 'force-reset' | 'full-reindex';

export type LiveIndexJob = 'recover' | 'full' | 'catchup' | 'hydrate';

export interface RecoveryJobActivity {
    recoverInFlight: boolean;
    dropRecoveryInFlight: boolean;
    fullReindexInFlight: boolean;
    catchUpRunning: boolean;
    sidecarHydrating: boolean;
    writing: boolean;
    stalled: boolean;
    stuck: boolean;
    locked: boolean;
    wedged: boolean;
}

export type RecoveryJobPlan =
    | { action: 'start' }
    | { action: 'takeover'; reason: 'stale' }
    | { action: 'noop'; notice: string }
    | { action: 'attach'; notice: string; job: LiveIndexJob };

export const RECOVER_ALREADY_NOTICE = 'Seek: recovery already in progress.';
export const INDEX_ALREADY_NOTICE = 'Seek: a reindex is already running.';
export const RESTORE_ALREADY_NOTICE = 'Seek: restore already in progress.';
export const CATCHUP_ALREADY_NOTICE = 'Seek: indexing already in progress.';

export function liveIndexJob(activity: RecoveryJobActivity): LiveIndexJob | null {
    if (activity.fullReindexInFlight) return 'full';
    if (activity.recoverInFlight || activity.dropRecoveryInFlight) return 'recover';
    if (activity.sidecarHydrating) return 'hydrate';
    if (activity.catchUpRunning) return 'catchup';
    if (activity.writing) return 'full';
    return null;
}

export function recoveryJobIsStale(activity: RecoveryJobActivity): boolean {
    return activity.stalled || activity.stuck || activity.locked || activity.wedged;
}

export function attachNoticeForJob(job: LiveIndexJob): string {
    if (job === 'recover') return RECOVER_ALREADY_NOTICE;
    if (job === 'hydrate') return RESTORE_ALREADY_NOTICE;
    if (job === 'catchup') return CATCHUP_ALREADY_NOTICE;
    return INDEX_ALREADY_NOTICE;
}

export function planIndexUserJob(intent: IndexUserIntent, activity: RecoveryJobActivity): RecoveryJobPlan {
    const live = liveIndexJob(activity);
    if (!live) return { action: 'start' };
    if (recoveryJobIsStale(activity)) return { action: 'takeover', reason: 'stale' };
    if (intent === 'recover' && live === 'recover') {
        return { action: 'noop', notice: RECOVER_ALREADY_NOTICE };
    }
    return { action: 'attach', notice: attachNoticeForJob(live), job: live };
}
