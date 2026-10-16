import { describe, it, expect, vi } from 'vitest';
import { continueAfterStoreWipe, planFailedDropRecovery } from './failed-drop-recovery';
import {
    resolveIndexUiStatus,
    indexFooterStatus,
    type IndexUiStatusInput,
} from '../ui/index-notice';
import { IndexStatusReporter, INDEX_STATUS_COPY } from '../ui/index-status-report';

const emptyIdle: IndexUiStatusInput = {
    booting: false,
    hydrating: false,
    waitingForSidecar: false,
    peerSyncPending: false,
    health: 'healthy',
    reason: null,
    indexing: false,
    job: null,
    searchableChunks: 0,
    inventoryFiles: 0,
};

describe('planFailedDropRecovery', () => {
    it('hydrates from sidecar when the store is still open', () => {
        expect(planFailedDropRecovery({
            sidecarEnabled: true, storeOpen: true, mayFullReindex: true, mobile: false,
        })).toEqual({
            dropRecovering: true, waitingForSidecar: true, action: 'hydrate',
        });
    });

    it('reopens then restores when the wipe closed or wedged the store', () => {
        expect(planFailedDropRecovery({
            sidecarEnabled: true, storeOpen: false, mayFullReindex: false, mobile: false,
        })).toEqual({
            dropRecovering: true, waitingForSidecar: true, action: 'reopen',
        });
    });

    it('cold-builds on desktop when sidecar is off', () => {
        expect(planFailedDropRecovery({
            sidecarEnabled: false, storeOpen: true, mayFullReindex: true, mobile: false,
        })).toEqual({
            dropRecovering: true, waitingForSidecar: false, action: 'cold-build',
        });
    });

    it('never plans a silent idle None', () => {
        for (const plan of [
            planFailedDropRecovery({ sidecarEnabled: true, storeOpen: true, mayFullReindex: false, mobile: true }),
            planFailedDropRecovery({ sidecarEnabled: false, storeOpen: false, mayFullReindex: true, mobile: true }),
        ]) {
            expect(plan.dropRecovering).toBe(true);
            expect(plan.action).not.toBe('idle' as never);
        }
    });
});

describe('continueAfterStoreWipe', () => {
    it('still hydrates after clearAllStores throws (torn wipe)', async () => {
        const onDropped = vi.fn();
        const hydrate = vi.fn().mockResolvedValue({ hydrated: 12 });
        const result = await continueAfterStoreWipe({
            wipe: async () => {
                throw new Error('clearAllStores timed out');
            },
            onDropped,
            hydrate,
        });
        expect(onDropped).toHaveBeenCalledTimes(1);
        expect(hydrate).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ hydrated: 12 });
    });

    it('notifies drop after a successful wipe then hydrates', async () => {
        const onDropped = vi.fn();
        const wipe = vi.fn().mockResolvedValue({ chunks: 4 });
        const result = await continueAfterStoreWipe({
            wipe,
            onDropped,
            hydrate: async () => 'ok',
        });
        expect(wipe).toHaveBeenCalledTimes(1);
        expect(onDropped).toHaveBeenCalledTimes(1);
        expect(result).toBe('ok');
    });

    it('rethrows the wipe error when hydrate also fails', async () => {
        await expect(continueAfterStoreWipe({
            wipe: async () => {
                throw new Error('clearAllStores timed out');
            },
            hydrate: async () => {
                throw new Error('IndexStore not opened');
            },
        })).rejects.toThrow(/clearAllStores timed out/);
    });
});

describe('failed-drop status: Restoring not wedged None/error', () => {
    it('empty inventory while dropRecovering is Restoring on bar, Settings, and footer', () => {
        const input: IndexUiStatusInput = { ...emptyIdle, dropRecovering: true };
        expect(resolveIndexUiStatus(input)).toBe('restoring');
        const report = IndexStatusReporter.compute(input);
        expect(report.mode).toBe('restoring');
        expect(report.compact).toBe(INDEX_STATUS_COPY.restoring.compact);
        expect(report.label).toBe(INDEX_STATUS_COPY.restoring.label);
        const footer = indexFooterStatus({
            kind: 'onboarding',
            modelReady: true,
            phase: 'idle',
            health: 'healthy',
            uiHealth: 'none',
            statusReport: report,
        });
        expect(footer.kind).toBe('restoring');
        expect(footer.label).toBe(report.compact);
        expect(footer.label).toBe('Restoring');
    });

    it('empty after a finished drop with no recovery in flight stays None, never ok', () => {
        expect(resolveIndexUiStatus(emptyIdle)).toBe('none');
        expect(IndexStatusReporter.compute(emptyIdle).mode).not.toBe('ok');
    });

    it('degraded health during drop recovery does not pin Error over Restoring', () => {
        const report = IndexStatusReporter.compute({
            ...emptyIdle,
            dropRecovering: true,
            health: 'degraded',
            reason: 'drift',
        });
        expect(report.mode).toBe('restoring');
        expect(report.mode).not.toBe('error');
    });
});
