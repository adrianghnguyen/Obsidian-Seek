/**
 * Consumer / boot chrome: hydrating vs stuck vs ready.
 * Empty "Starting up" while sidecar hydrate is in flight is the failure mode.
 */
import { describe, it, expect } from 'vitest';
import { IndexStatusReporter, INDEX_STATUS_COPY, type IndexStatusReporterInput } from './index-status-report';
import { indexFooterStatus, resolveIndexUiStatus } from './index-notice';
import { indexPercent } from './index-eta';

const populated: IndexStatusReporterInput = {
    booting: false,
    hydrating: false,
    waitingForSidecar: false,
    peerSyncPending: false,
    health: 'healthy',
    reason: null,
    indexing: false,
    job: null,
    searchableChunks: 900,
    inventoryFiles: 300,
};

describe('boot copy: hydrating vs stuck vs ready', () => {
    it('hydrating Consumer boot is Restoring with done/total · percent', () => {
        const report = IndexStatusReporter.compute({
            ...populated,
            booting: true,
            hydrating: true,
            mayFullReindex: false,
            searchableChunks: 40,
            inventoryFiles: 12,
            hydrateProgress: { done: 12, total: 63 },
        });
        expect(resolveIndexUiStatus({
            ...populated,
            booting: true,
            hydrating: true,
            mayFullReindex: false,
            searchableChunks: 40,
            inventoryFiles: 12,
        })).toBe('restoring');
        expect(report.mode).toBe('restoring');
        expect(report.health).toBe('restoring');
        expect(report.compact).toBe(`Restoring 12/63 · ${indexPercent(12, 63)}%`);
        expect(report.label).toMatch(/12 \/ 63/);
        expect(report.compact).not.toBe(INDEX_STATUS_COPY.starting.compact);
        expect(report.label).not.toBe(INDEX_STATUS_COPY.starting.label);
        const footer = indexFooterStatus({
            kind: 'starting',
            modelReady: true,
            phase: 'hydrating',
            uiHealth: report.health,
            statusReport: report,
        });
        expect(footer.kind).toBe('restoring');
        expect(footer.label).toBe(report.compact);
        expect(footer.label).toContain('12/63');
    });

    it('boot watchdog stuck says Stuck, not Starting up, even mid-hydrate', () => {
        const report = IndexStatusReporter.compute({
            ...populated,
            stuck: true,
            booting: true,
            hydrating: true,
            mayFullReindex: false,
            hydrateProgress: { done: 12, total: 63 },
        });
        expect(report.mode).toBe('stuck');
        expect(report.compact).toBe(INDEX_STATUS_COPY.stuck.compact);
        expect(report.label).toBe(INDEX_STATUS_COPY.stuck.label);
        expect(report.hydrateProgress).toBeNull();
        expect(report.compact).not.toMatch(/Starting/i);
        const footer = indexFooterStatus({
            kind: 'stuck',
            modelReady: true,
            uiHealth: 'stuck',
            statusReport: report,
        });
        expect(footer.kind).toBe('stuck');
        expect(footer.label).toBe(INDEX_STATUS_COPY.stuck.compact);
    });

    it('ready Consumer after hydrate is Ready, not Starting', () => {
        const report = IndexStatusReporter.compute({
            ...populated,
            booting: false,
            hydrating: false,
            mayFullReindex: false,
            goodEnough: true,
        });
        expect(report.mode).toBe('ok');
        expect(report.compact).toBe(INDEX_STATUS_COPY.ok.compact);
        expect(report.label).toBe(INDEX_STATUS_COPY.ok.label);
        expect(report.hydrateProgress).toBeNull();
        const footer = indexFooterStatus({
            kind: 'resting',
            modelReady: true,
            uiHealth: 'ok',
            statusReport: report,
        });
        expect(footer.kind).toBe('up-to-date');
        expect(footer.label).toBe(INDEX_STATUS_COPY.ok.compact);
    });
});
