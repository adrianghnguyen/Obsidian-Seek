import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { IndexStore, STORE_NOT_OPENED, openDbWithTimeout } from './index-store';

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

    it('two concurrent ensureOpen() after close() share one open() and count() works', async () => {
        const store = await boot(`ensure-${Math.random().toString(36).slice(2)}`);
        store.close();
        const openSpy = vi.spyOn(indexedDB, 'open');
        try {
            await Promise.all([store.ensureOpen(), store.ensureOpen()]);
            expect(store.isOpen()).toBe(true);
            expect(openSpy).toHaveBeenCalledTimes(1);
            await expect(store.count()).resolves.toEqual({ files: 0, chunks: 0, embeddings: 0, binary: 0 });
        } finally {
            openSpy.mockRestore();
        }
    });

    it('openDbWithTimeout closes a connection whose onsuccess fires after timeout', async () => {
        const close = vi.fn();
        let onSuccess: (() => void) | undefined;
        const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
            const req = {
                result: { close, onversionchange: null },
                error: null,
                set onsuccess(fn: () => void) { onSuccess = fn; },
                set onerror(_fn: () => void) { /* unused */ },
                set onupgradeneeded(_fn: () => void) { /* unused */ },
            };
            return req as unknown as IDBOpenDBRequest;
        });
        try {
            const p = openDbWithTimeout('seek-test:late-success', 20);
            await expect(p).rejects.toThrow(/timed out/);
            expect(close).not.toHaveBeenCalled();
            onSuccess?.();
            expect(close).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
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
