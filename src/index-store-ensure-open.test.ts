import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { IndexStore, STORE_NOT_OPENED } from './index-store';

describe('IndexStore.ensureOpen (reload / versionchange recovery)', () => {
    const opened: IndexStore[] = [];
    afterEach(() => {
        for (const s of opened.splice(0)) s.close();
    });

    async function boot(scope: string): Promise<IndexStore> {
        const store = new IndexStore();
        await store.open(scope, 'seek-test');
        opened.push(store);
        return store;
    }

    it('isOpen is false after close()', async () => {
        const store = await boot(`ensure-${Math.random().toString(36).slice(2)}`);
        expect(store.isOpen()).toBe(true);
        store.close();
        expect(store.isOpen()).toBe(false);
    });

    it('ensureOpen reopens after close so count() succeeds (simulates post-reload reopen)', async () => {
        const store = await boot(`ensure-${Math.random().toString(36).slice(2)}`);
        store.close();
        await store.ensureOpen();
        expect(store.isOpen()).toBe(true);
        await expect(store.count()).resolves.toEqual({ files: 0, chunks: 0, embeddings: 0, binary: 0 });
    });

    it('requireDb throws STORE_NOT_OPENED after close until ensureOpen', async () => {
        const store = await boot(`ensure-${Math.random().toString(36).slice(2)}`);
        store.close();
        await expect(store.count()).rejects.toThrow(STORE_NOT_OPENED);
        await store.ensureOpen();
        await expect(store.count()).resolves.toEqual({ files: 0, chunks: 0, embeddings: 0, binary: 0 });
    });

    it('ensureOpen is a no-op when already open', async () => {
        const store = await boot(`ensure-${Math.random().toString(36).slice(2)}`);
        expect(store.isOpen()).toBe(true);
        await store.ensureOpen();
        expect(store.isOpen()).toBe(true);
    });

    it('open(scope) never calls indexedDB.deleteDatabase (legacy cleanup removed)', async () => {
        const deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase');
        const scope = `no-delete-${Math.random().toString(36).slice(2)}`;
        const store = new IndexStore();
        await store.open(scope, 'seek-test');
        opened.push(store);
        expect(deleteSpy).not.toHaveBeenCalled();
        deleteSpy.mockRestore();
    });
});
