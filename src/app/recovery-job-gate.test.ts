import { describe, expect, it } from 'vitest';
import {
    CATCHUP_ALREADY_NOTICE,
    INDEX_ALREADY_NOTICE,
    RECOVER_ALREADY_NOTICE,
    RESTORE_ALREADY_NOTICE,
    liveIndexJob,
    planIndexUserJob,
    recoveryJobIsStale,
    type RecoveryJobActivity,
} from './recovery-job-gate';

const idle: RecoveryJobActivity = {
    recoverInFlight: false,
    dropRecoveryInFlight: false,
    fullReindexInFlight: false,
    catchUpRunning: false,
    sidecarHydrating: false,
    writing: false,
    stalled: false,
    stuck: false,
    locked: false,
    wedged: false,
};

describe('liveIndexJob', () => {
    it('prefers a full reindex latch over recover / hydrate / catch-up', () => {
        expect(liveIndexJob({
            ...idle,
            fullReindexInFlight: true,
            recoverInFlight: true,
            sidecarHydrating: true,
            catchUpRunning: true,
        })).toBe('full');
    });

    it('treats orchestrator write as a full job when no other latch is set', () => {
        expect(liveIndexJob({ ...idle, writing: true })).toBe('full');
    });
});

describe('planIndexUserJob', () => {
    it('starts when nothing is in flight', () => {
        expect(planIndexUserJob('recover', idle)).toEqual({ action: 'start' });
        expect(planIndexUserJob('resume', idle)).toEqual({ action: 'start' });
        expect(planIndexUserJob('force-reset', idle)).toEqual({ action: 'start' });
        expect(planIndexUserJob('full-reindex', idle)).toEqual({ action: 'start' });
    });

    it('no-ops a second Recover while recovery is already running', () => {
        const recovering = { ...idle, recoverInFlight: true };
        expect(planIndexUserJob('recover', recovering)).toEqual({
            action: 'noop',
            notice: RECOVER_ALREADY_NOTICE,
        });
    });

    it('attaches Resume to Recovering / Indexing / Restoring / catch-up', () => {
        expect(planIndexUserJob('resume', { ...idle, recoverInFlight: true })).toEqual({
            action: 'attach',
            notice: RECOVER_ALREADY_NOTICE,
            job: 'recover',
        });
        expect(planIndexUserJob('resume', { ...idle, fullReindexInFlight: true })).toEqual({
            action: 'attach',
            notice: INDEX_ALREADY_NOTICE,
            job: 'full',
        });
        expect(planIndexUserJob('resume', { ...idle, sidecarHydrating: true })).toEqual({
            action: 'attach',
            notice: RESTORE_ALREADY_NOTICE,
            job: 'hydrate',
        });
        expect(planIndexUserJob('resume', { ...idle, catchUpRunning: true })).toEqual({
            action: 'attach',
            notice: CATCHUP_ALREADY_NOTICE,
            job: 'catchup',
        });
    });

    it('joins Full reindex / Force reset to a healthy live job instead of stacking', () => {
        expect(planIndexUserJob('full-reindex', { ...idle, fullReindexInFlight: true }).action).toBe('attach');
        expect(planIndexUserJob('force-reset', { ...idle, recoverInFlight: true }).action).toBe('attach');
        expect(planIndexUserJob('full-reindex', { ...idle, catchUpRunning: true }).action).toBe('attach');
    });

    it('takes over only when the latched job is stuck / stalled / locked / wedged', () => {
        expect(recoveryJobIsStale({ ...idle, fullReindexInFlight: true, stalled: true })).toBe(true);
        expect(planIndexUserJob('recover', { ...idle, recoverInFlight: true, stuck: true })).toEqual({
            action: 'takeover',
            reason: 'stale',
        });
        expect(planIndexUserJob('full-reindex', { ...idle, fullReindexInFlight: true, stalled: true }).action)
            .toBe('takeover');
        expect(planIndexUserJob('resume', { ...idle, catchUpRunning: true, wedged: true }).action)
            .toBe('takeover');
        expect(planIndexUserJob('force-reset', { ...idle, sidecarHydrating: true, locked: true }).action)
            .toBe('takeover');
    });
});
