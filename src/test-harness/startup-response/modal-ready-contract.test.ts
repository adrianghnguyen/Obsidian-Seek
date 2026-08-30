import { describe, it, expect } from 'vitest';
import { ModalReadyContractHarness } from './modal-ready-contract-harness';
import { isIndexWaitKind } from '../../index-notice';

/**
 * Modal wiring contract — canonical uiHealth ok must win over a stale 0-chunk
 * probe. Warm sandbox CLI scored T2–T4 HOLD; these fail on the code path.
 */
describe('modal Ready contract (harness)', () => {
    it('uiHealth ok + stale 0-chunk probe + indexing phase → loadKind not wait-kind', async () => {
        const h = new ModalReadyContractHarness();
        h.setLoadState({ phase: 'indexing', uiHealth: 'ok', inventoryChunks: 412 });
        h.setModalChunks(0);
        await h.poll();
        expect(isIndexWaitKind(h.loadKind)).toBe(false);
    });

    it('uiHealth ok + typed query + empty results → does not paint indexing wait', async () => {
        const h = new ModalReadyContractHarness();
        h.setLoadState({ phase: 'indexing', uiHealth: 'ok', inventoryChunks: 412 });
        h.setModalChunks(0);
        h.primeQuery('note');
        await h.poll();
        expect(h.waitRenders).toBe(0);
    });

    it('uiHealth indexing + catch-up job + chunks → resting body, not full-rebuild wait', async () => {
        const h = new ModalReadyContractHarness();
        h.setLoadState({
            phase: 'indexing',
            uiHealth: 'indexing',
            job: { done: 3, total: 15, kind: 'catchup' },
        });
        h.setModalChunks(500);
        await h.poll();
        expect(h.loadKind).toBe('resting');
        expect(isIndexWaitKind(h.loadKind)).toBe(false);
    });
});
