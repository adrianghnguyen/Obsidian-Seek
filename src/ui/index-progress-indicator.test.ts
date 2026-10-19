import { describe, it, expect } from 'vitest';
import { IndexStatusReporter, INDEX_STATUS_COPY, type IndexStatusReporterInput } from './index-status-report';
import {
    computeIndexProgressIndicator,
    isVerifyOnlyWalk,
    unitsFromCounts,
} from './index-progress-indicator';
import { visibleProgressText } from './index-progress-format';

const idle: IndexStatusReporterInput = {
    booting: false,
    hydrating: false,
    waitingForSidecar: false,
    peerSyncPending: false,
    health: 'healthy',
    reason: null,
    indexing: false,
    job: null,
    searchableChunks: 3854,
    inventoryFiles: 3854,
};

describe('isVerifyOnlyWalk', () => {
    it('is true when needed is 0 and IDB already covers the vault', () => {
        expect(isVerifyOnlyWalk({
            needed: 0,
            inventoryFiles: 3854,
            indexableNotes: 3854,
        })).toBe(true);
    });

    it('is false while waiting or recovering', () => {
        expect(isVerifyOnlyWalk({
            needed: 0,
            inventoryFiles: 3854,
            indexableNotes: 3854,
            waitingForSidecar: true,
        })).toBe(false);
        expect(isVerifyOnlyWalk({
            needed: 0,
            inventoryFiles: 3854,
            indexableNotes: 3854,
            dropRecovering: true,
        })).toBe(false);
    });
});

describe('unitsFromCounts', () => {
    it('returns null for {0,0}', () => {
        expect(unitsFromCounts(0, 0)).toBeNull();
    });

    it('does not freeze {1,1} at 1% when determinate', () => {
        expect(unitsFromCounts(1, 1, { determinate: true })?.percent).toBe(100);
    });
});

describe('IndexStatusReporter acceptance', () => {
    it('verify-only {0,total} + needed 0 + full coverage is Verifying, not Restoring 0%', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            booting: true,
            mayFullReindex: false,
            indexableNotes: 3854,
            hydrateProgress: { done: 0, total: 3854, needed: 0, hydrated: 0 },
        });
        expect(report.mode).toBe('verifying');
        expect(visibleProgressText(report.compact)).not.toMatch(/Restoring/);
        expect(visibleProgressText(report.compact)).not.toMatch(/0%/);
        expect(report.progress.phase).toBe('verifying');
    });

    it('live restore with moving counts is Restoring, not 0% fake', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            searchableChunks: 12,
            inventoryFiles: 12,
            indexableNotes: 80,
            hydrateProgress: { done: 21, total: 80, needed: 40 },
        });
        expect(report.mode).toBe('restoring');
        expect(visibleProgressText(report.compact)).toMatch(/21\/80/);
        expect(visibleProgressText(report.compact)).not.toMatch(/0%/);
        expect(report.progress.units?.determinate).toBe(true);
    });

    it('catchUpPending on a populated store is Catching up, not Ready', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            catchUpPending: true,
        });
        expect(report.mode).toBe('catching-up');
        expect(report.compact).toBe(INDEX_STATUS_COPY['catching-up'].compact);
        expect(report.mode).not.toBe('ok');
    });

    it('Recovering outranks Starting after Force reset latch', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            dropRecovering: true,
            searchableChunks: 0,
            inventoryFiles: 0,
            indexableNotes: 80,
        });
        expect(report.mode).toBe('recovering');
        expect(report.compact.startsWith(INDEX_STATUS_COPY.recovering.compact)).toBe(true);
        expect(visibleProgressText(report.compact)).not.toMatch(/0%/);
    });

    it('stuck outranks restore counts', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            stuck: true,
            hydrating: true,
            hydrateProgress: { done: 4, total: 40 },
        });
        expect(report.mode).toBe('stuck');
        expect(report.progress.units).toBeNull();
        expect(report.compact).toBe(INDEX_STATUS_COPY.stuck.compact);
    });

    it('catchUpPending on a populated vault shows indexed notes percent', () => {
        const indicator = computeIndexProgressIndicator({
            mode: 'catching-up',
            hydrating: false,
            waitingForSidecar: false,
            dropRecovering: false,
            booting: false,
            goodEnough: true,
            catchUpPending: true,
            walk: null,
            job: null,
            inventoryFiles: 200,
            indexableNotes: 400,
        });
        expect(indicator.phase).toBe('catching-up');
        expect(indicator.units?.done).toBe(200);
        expect(indicator.units?.total).toBe(400);
        expect(indicator.units?.determinate).toBe(true);
    });

    it('Starting with inventory is a named phase with units, not empty Starting up', () => {
        const indicator = computeIndexProgressIndicator({
            mode: 'starting',
            hydrating: false,
            waitingForSidecar: false,
            dropRecovering: false,
            booting: true,
            goodEnough: false,
            walk: null,
            job: null,
            inventoryFiles: 12,
            indexableNotes: 80,
        });
        expect(indicator.phase).toBe('starting');
        expect(indicator.units?.done).toBe(12);
        expect(indicator.units?.total).toBe(80);
    });
});
