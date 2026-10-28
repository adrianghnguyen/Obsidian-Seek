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
