/**
 * Overlapping drop / hydrate / catch-up must resolve to one status-bar mode.
 * Precedence: hydrate/restore > empty-after-drop > catch-up job.
 */
import { describe, it, expect } from 'vitest';
import {
    resolveIndexUiStatus,
    resolveSidecarWait,
    sidecarHydrateHealedIndex,
    type IndexUiStatusInput,
} from './index-notice';

const base: IndexUiStatusInput = {
    booting: false,
    hydrating: false,
    waitingForSidecar: false,
    peerSyncPending: false,
    health: 'healthy',
    reason: null,
    indexing: false,
    job: null,
    searchableChunks: 400,
    inventoryFiles: 80,
};

describe('index status races (drop × hydrate × catch-up)', () => {
    it('hydrating after a full drop beats leftover catch-up job and empty None', () => {
        const overlapping: IndexUiStatusInput = {
            ...base,
            hydrating: true,
            goodEnough: true,
            indexing: true,
            catchUpPending: true,
            job: { done: 0, total: 80 },
            searchableChunks: 0,
            inventoryFiles: 0,
        };
        expect(resolveIndexUiStatus(overlapping)).toBe('restoring');
    });

    it('consumer wait beats hydrating leftover, catch-up, and empty', () => {
        expect(resolveIndexUiStatus({
            ...base,
            waitingForSidecar: true,
            hydrating: true,
            indexing: true,
            job: { done: 0, total: 12 },
            searchableChunks: 0,
            inventoryFiles: 0,
        })).toBe('restoring');
    });

    it('empty-after-drop without hydrate or wait is None, not Indexing', () => {
        expect(resolveIndexUiStatus({
            ...base,
            goodEnough: false,
            searchableChunks: 0,
            inventoryFiles: 0,
        })).toBe('none');
    });

    it('catch-up on a populated index still paints Indexing once hydrate is done', () => {
        expect(resolveIndexUiStatus({
            ...base,
            indexing: true,
            job: { done: 3, total: 12 },
        })).toBe('indexing');
    });

    it('blocked rebuild after drop is wait, not a healed Ready', () => {
        const blocked = {
            hydrated: 0,
            skippedPartialNotes: 0,
            acceptedProducers: 2,
            waitingForProducer: true,
            incompleteFolder: true,
        };
        expect(sidecarHydrateHealedIndex(blocked)).toBe(false);
        expect(resolveSidecarWait(blocked, 0)).toBe(true);
        expect(resolveIndexUiStatus({
            ...base,
            waitingForSidecar: resolveSidecarWait(blocked, 0),
            searchableChunks: 0,
            inventoryFiles: 0,
        })).toBe('restoring');
    });

    it('status transitions drop → restore → catch-up in order', () => {
        const dropped = resolveIndexUiStatus({
            ...base, hydrating: true, goodEnough: true,
            searchableChunks: 0, inventoryFiles: 0,
        });
        expect(dropped).toBe('restoring');
        const restored = resolveIndexUiStatus({
            ...base, hydrating: false, waitingForSidecar: false, goodEnough: true,
            searchableChunks: 400, inventoryFiles: 80,
        });
        expect(restored).toBe('ok');
        const catchingUp = resolveIndexUiStatus({
            ...base, indexing: true, job: { done: 1, total: 4 },
        });
        expect(catchingUp).toBe('indexing');
    });
});
