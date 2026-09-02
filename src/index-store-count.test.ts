import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexStore } from './index-store';

describe('IndexStore.count single-flight inventory reads', () => {
    const opened: IndexStore[] = [];

    afterEach(() => {
        for (const store of opened.splice(0)) store.close();
        vi.restoreAllMocks();
    });

    it('shares one four-store transaction concurrently, then starts a fresh transaction after settlement', async () => {
        const store = new IndexStore();
        await store.open(`count-single-flight-${Math.random().toString(36).slice(2)}`, 'seek-test');
        opened.push(store);

        const db = (store as unknown as { db: IDBDatabase | null }).db;
        if (!db) throw new Error('test setup failed to open IndexedDB');
        const transactionSpy = vi.spyOn(db, 'transaction');

        const concurrent = await Promise.all([
            store.count(),
            store.count(),
            store.count(),
        ]);
        const later = await store.count();

        expect(concurrent).toEqual([
            { chunks: 0, embeddings: 0, binary: 0, files: 0 },
            { chunks: 0, embeddings: 0, binary: 0, files: 0 },
            { chunks: 0, embeddings: 0, binary: 0, files: 0 },
        ]);
        expect(later).toEqual({ chunks: 0, embeddings: 0, binary: 0, files: 0 });
        expect(transactionSpy).toHaveBeenCalledTimes(2);
        for (const [stores, mode] of transactionSpy.mock.calls) {
            expect(stores).toEqual(['chunk_meta', 'embeddings', 'binary', 'files']);
            expect(mode).toBe('readonly');
        }
    });
});
