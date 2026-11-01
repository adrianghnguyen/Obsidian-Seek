import { describe, it, expect } from 'vitest';
import {
    IndexStatusReporter,
    resolveIndexStatusHelpForMode,
    INDEX_STATUS_COPY,
} from './index-status-report';
import { INDEX_STATUS_HELP } from './index-notice';

const baseInput = {
    booting: false,
    bootDecisionPending: false,
    hydrating: false,
    goodEnough: true,
    waitingForSidecar: false,
    peerSyncPending: false,
    health: 'healthy' as const,
    reason: null,
    indexing: false,
    catchUpPending: false,
    searchableChunks: 5000,
    inventoryFiles: 3000,
    stuck: false,
};

describe('index status help / tooltips', () => {
    it('every reporter mode exposes non-empty help', () => {
        const cases: Array<Parameters<typeof IndexStatusReporter.compute>[0]> = [
            { ...baseInput, goodEnough: false, searchableChunks: null, inventoryFiles: 0 },
            { ...baseInput, booting: true, bootDecisionPending: true },
            { ...baseInput, hydrating: true, goodEnough: false },
            { ...baseInput, indexing: true, jobKind: 'catchup', job: { done: 2, total: 15 } },
            { ...baseInput, indexing: true, jobKind: 'catchup', job: { done: 0, total: 30 } },
            { ...baseInput, indexing: true, jobKind: 'full', job: { done: 10, total: 300 } },
            { ...baseInput, stuck: true },
            { ...baseInput, health: 'degraded', reason: 'peer-ahead' },
        ];
        for (const input of cases) {
            const report = IndexStatusReporter.compute(input);
            expect(report.help.length).toBeGreaterThan(10);
            expect(report.help).not.toBe(report.compact);
        }
    });

    it('updating help includes file progress when job totals are known', () => {
        const report = IndexStatusReporter.compute({
            ...baseInput,
            indexing: true,
            jobKind: 'catchup',
            job: { done: 4, total: 30 },
        });
        expect(report.mode).toBe('updating');
        expect(report.help).toContain(INDEX_STATUS_HELP.updating.slice(0, 24));
        expect(report.help).toMatch(/4.*30/);
    });

    it('resolveIndexStatusHelpForMode covers extended modes', () => {
        expect(resolveIndexStatusHelpForMode('catching-up')).toBe(INDEX_STATUS_HELP['catching-up']);
        expect(resolveIndexStatusHelpForMode('catch-up-paused')).toBe(INDEX_STATUS_HELP['catch-up-paused']);
        expect(resolveIndexStatusHelpForMode('full-reindex')).toBe(INDEX_STATUS_HELP['full-reindex']);
        expect(resolveIndexStatusHelpForMode('verifying')).toBe(INDEX_STATUS_HELP.verifying);
        expect(resolveIndexStatusHelpForMode('ok', true)).toBe(INDEX_STATUS_HELP['quiet-catchup']);
        expect(resolveIndexStatusHelpForMode('catching-up', true)).toBe(INDEX_STATUS_HELP['quiet-catchup']);
    });

    it('quiet catch-up help is distinct from updating copy', () => {
        const quiet = IndexStatusReporter.compute({
            ...baseInput,
            indexing: true,
            jobKind: 'catchup',
            job: { done: 0, total: 15 },
        });
        expect(quiet.quietCatchUp).toBe(true);
        expect(quiet.help).toBe(INDEX_STATUS_HELP['quiet-catchup']);
        expect(quiet.compact).toBe(INDEX_STATUS_COPY.ok.compact);
    });

    it('catch-up-paused requires the reporter energySaver flag', () => {
        const off = IndexStatusReporter.compute({
            ...baseInput,
            energySaver: false,
            catchUpPending: true,
            catchUpRunning: false,
            dirtyQueueSize: 4,
        });
        expect(off.mode).not.toBe('catch-up-paused');
        expect(off.energySaver).toBe(false);
    });

    it('energy saver holding catch-up is paused, not Catching up', () => {
        const report = IndexStatusReporter.compute({
            ...baseInput,
            energySaver: true,
            catchUpPending: true,
            catchUpRunning: false,
            dirtyQueueSize: 4,
        });
        expect(report.mode).toBe('catch-up-paused');
        expect(report.health).toBe('ok');
        expect(report.compact).toBe(INDEX_STATUS_COPY['catch-up-paused'].compact);
        expect(report.label).toBe(INDEX_STATUS_COPY['catch-up-paused'].label);
        expect(report.progress.phase).toBe('catch-up-paused');
        expect(report.progress.units).toBeNull();
        expect(report.quietCatchUp).toBeFalsy();
        expect(report.help).toContain('Energy saver is holding background catch-up');
        expect(report.help).toMatch(/4 notes waiting/);
        expect(report.help).not.toMatch(/orange badge/);
    });

    it('energy saver does not hide a live catch-up embed', () => {
        const report = IndexStatusReporter.compute({
            ...baseInput,
            energySaver: true,
            catchUpPending: true,
            catchUpRunning: true,
            indexing: true,
            jobKind: 'catchup',
            job: { done: 1, total: 40 },
        });
        expect(report.mode).not.toBe('catch-up-paused');
        expect(['catching-up', 'updating', 'indexing']).toContain(report.mode);
        expect(report.compact).not.toBe(INDEX_STATUS_COPY['catch-up-paused'].compact);
    });

    it('running tiny leftover with energy saver stays quiet-icon, not Catching up 4', () => {
        const report = IndexStatusReporter.compute({
            ...baseInput,
            inventoryFiles: 3000,
            searchableChunks: 800,
            energySaver: true,
            catchUpPending: true,
            catchUpRunning: true,
            indexing: true,
            jobKind: 'catchup',
            job: { done: 0, total: 4 },
        });
        expect(report.quietCatchUp).toBe(true);
        expect(report.mode).toBe('ok');
        expect(report.health).toBe('ok');
        expect(report.compact).toBe(INDEX_STATUS_COPY.ok.compact);
        expect(report.progress.units).toBeNull();
        expect(report.mode).not.toBe('catching-up');
    });

    it('held 4-file leftover with energy saver is muted pause, not an orange remaining badge', () => {
        const report = IndexStatusReporter.compute({
            ...baseInput,
            inventoryFiles: 3000,
            searchableChunks: 800,
            energySaver: true,
            catchUpPending: true,
            catchUpRunning: false,
            indexing: false,
            jobKind: 'catchup',
            job: { done: 0, total: 4 },
        });
        expect(report.mode).toBe('catch-up-paused');
        expect(report.quietCatchUp).toBeFalsy();
        expect(report.progress.units).toBeNull();
        expect(report.compact).toBe(INDEX_STATUS_COPY['catch-up-paused'].compact);
        expect(report.help).toMatch(/4 notes waiting/);
    });

    it('queued 1-file catch-up keeps reporter mode Ready (compact chrome), not Catching up', () => {
        const report = IndexStatusReporter.compute({
            ...baseInput,
            inventoryFiles: 244,
            searchableChunks: 800,
            indexing: true,
            catchUpPending: true,
            jobKind: 'catchup',
            job: { done: 0, total: 1 },
        });
        expect(report.quietCatchUp).toBe(true);
        expect(report.mode).toBe('ok');
        expect(report.health).toBe('ok');
        expect(report.compact).toBe(INDEX_STATUS_COPY.ok.compact);
        expect(report.progress.units).toBeNull();
    });

    it('1-file catch-up on a consumer-sized vault is quiet Ready, not vault fractions', () => {
        const report = IndexStatusReporter.compute({
            ...baseInput,
            inventoryFiles: 244,
            searchableChunks: 800,
            indexing: true,
            jobKind: 'catchup',
            job: { done: 0, total: 1 },
        });
        expect(report.quietCatchUp).toBe(true);
        expect(report.health).toBe('ok');
        expect(report.compact).toBe(INDEX_STATUS_COPY.ok.compact);
        expect(report.progress.units).toBeNull();
    });
});
