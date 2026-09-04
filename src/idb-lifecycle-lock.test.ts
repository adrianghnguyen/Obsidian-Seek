import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { App, DataAdapter, PluginManifest } from 'obsidian';
import SeekPlugin from './main';
import { IndexStore, STORE_NOT_OPENED } from './index-store';
import { SearchOrchestrator } from './search';
import { LocalEmbedder } from './embedder';
import { FakeVault, fakeEmbedder } from './test-harness/scenario';
import { DEFAULT_SETTINGS, type Chunk, type InitEntry } from './types';

// In-memory DataAdapter fake for SeekLogger / StartupBootHistory in tests
class FakeAdapter {
    files = new Map<string, string>();

    async exists(p: string): Promise<boolean> {
        return this.files.has(p);
    }
    async mkdir(_p: string): Promise<void> {}
    async read(p: string): Promise<string> {
        const v = this.files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
    }
    async write(p: string, data: string): Promise<void> {
        this.files.set(p, data);
    }
    async append(p: string, data: string): Promise<void> {
        const prev = this.files.get(p);
        this.files.set(p, (prev ?? '') + data);
    }
    async remove(p: string): Promise<void> {
        this.files.delete(p);
    }
    async rename(from: string, to: string): Promise<void> {
        const v = this.files.get(from);
        if (v === undefined) throw new Error(`ENOENT: ${from}`);
        this.files.set(to, v);
        this.files.delete(from);
    }
    async stat(p: string): Promise<{ size: number; type: 'file' } | null> {
        const v = this.files.get(p);
        return v === undefined ? null : { size: v.length, type: 'file' };
    }
    async list(dir: string): Promise<{ folders: string[]; files: string[] }> {
        const prefix = dir.endsWith('/') || dir === '' ? dir : dir + '/';
        const files = [...this.files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
        return { folders: [], files };
    }
}

function installMemoryLocalStorage(): Map<string, string> {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => { storage.set(k, String(v)); },
        removeItem: (k: string) => { storage.delete(k); },
        clear: () => { storage.clear(); },
    });
    return storage;
}

function ensureWindowAndDocumentStubs(): void {
    const w = window as unknown as Record<string, unknown>;
    if (typeof w.addEventListener !== 'function') w.addEventListener = vi.fn();
    if (typeof w.removeEventListener !== 'function') w.removeEventListener = vi.fn();

    const g = globalThis as unknown as { activeDocument?: Record<string, unknown> };
    if (!g.activeDocument) {
        g.activeDocument = {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            visibilityState: 'visible',
            hidden: false,
        };
    } else {
        if (typeof g.activeDocument.addEventListener !== 'function') g.activeDocument.addEventListener = vi.fn();
        if (typeof g.activeDocument.removeEventListener !== 'function') g.activeDocument.removeEventListener = vi.fn();
    }
}

function createSampleChunk(id = 'c1', path = 'note.md'): Chunk {
    return {
        chunk_id: id,
        note_path: path,
        title: 'Sample Note',
        heading_path: [],
        metadata: {
            tags: [],
            aliases: [],
            created: null,
            modified: null,
            properties: {},
        },
        start_line: 1,
        end_line: 10,
        content: 'This is sample note content for lifecycle testing.',
    };
}

describe('IndexedDB Lifecycle & Lock Safety (src/idb-lifecycle-lock.test.ts)', () => {
    const openedStores: IndexStore[] = [];

    beforeEach(() => {
        installMemoryLocalStorage();
        ensureWindowAndDocumentStubs();
    });

    afterEach(() => {
        for (const s of openedStores.splice(0)) {
            s.close();
        }
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    // =========================================================================
    // 1. No Lock on Start
    // =========================================================================
    describe('1. No Lock on Start', () => {
        it('during SeekPlugin.onload(), indexedDB.open is called 0 times (configured but not opened until layout ready + buffer)', async () => {
            const openSpy = vi.spyOn(indexedDB, 'open');
            vi.spyOn(LocalEmbedder.prototype, 'init').mockResolvedValue({
                type: 'init',
                timestamp: new Date().toISOString(),
                schemaVersion: 1,
                buildTimestamp: 'test-build',
                transformersVersion: '4.2.0',
                cdnUrl: 'https://test-cdn',
                iframeReady: true,
                initMs: 1,
                pluginVersion: '1.4.0',
                error: null,
            } as InitEntry);

            const adapter = new FakeAdapter();
            const onLayoutReady = vi.fn();
            const fakeApp = {
                vault: {
                    adapter: adapter as unknown as DataAdapter,
                    getName: () => 'vault-zero-lock',
                    on: vi.fn().mockReturnValue({}),
                },
                workspace: {
                    onLayoutReady,
                    getActiveFile: vi.fn().mockReturnValue(null),
                    on: vi.fn().mockReturnValue({}),
                },
                metadataCache: {
                    isUserIgnored: vi.fn().mockReturnValue(false),
                    on: vi.fn().mockReturnValue({}),
                },
                appId: 'test-app-id',
            } as unknown as App;

            const manifest: PluginManifest = {
                id: 'seek',
                name: 'Seek',
                version: '1.4.0',
                minAppVersion: '1.4.0',
                description: 'Seek search',
                author: 'Test Author',
            };

            const plugin = new SeekPlugin(fakeApp, manifest);

            await plugin.onload();

            // Store is configured with the scoped vault DB name
            const store = (plugin as unknown as { store: IndexStore }).store;
            expect(store.dbName).toBe('seek-index:test-app-id');

            // Store must NOT be open yet
            expect(store.isOpen()).toBe(false);

            // indexedDB.open must NOT have been called during onload
            expect(openSpy).toHaveBeenCalledTimes(0);

            // Workspace layout ready callback was registered but not triggered yet
            expect(onLayoutReady).toHaveBeenCalledTimes(1);

            plugin.onunload();
        });

        it('concurrent ensureOpen() calls during startup coalesce into a single indexedDB.open request', async () => {
            const store = new IndexStore();
            openedStores.push(store);
            store.configure(`coalesce-${Math.random().toString(36).slice(2)}`, 'seek-test');
            expect(store.isOpen()).toBe(false);

            const openSpy = vi.spyOn(indexedDB, 'open');

            // Multiple components (e.g. status bar, search trigger, background sync) request store readiness concurrently
            await Promise.all([store.ensureOpen(), store.ensureOpen(), store.ensureOpen()]);

            expect(store.isOpen()).toBe(true);
            expect(openSpy).toHaveBeenCalledTimes(1);

            // Verification that database operations work as expected on the single coalesced handle
            await expect(store.count()).resolves.toEqual({ files: 0, chunks: 0, embeddings: 0, binary: 0 });
        });

        it('if another window/process fires a versionchange event, opened.onversionchange immediately calls close() and nulls this.db', async () => {
            const store = new IndexStore();
            openedStores.push(store);
            await store.open(`versionchange-${Math.random().toString(36).slice(2)}`, 'seek-test');
            expect(store.isOpen()).toBe(true);

            const internalDb = (store as unknown as { db: IDBDatabase }).db;
            expect(internalDb).not.toBeNull();
            const closeSpy = vi.spyOn(internalDb, 'close');

            // Simulate another window triggering a schema change / versionchange event
            const versionChangeEvent = new Event('versionchange') as IDBVersionChangeEvent;
            internalDb.onversionchange?.(versionChangeEvent);

            // Verify connection was dropped immediately to prevent deadlocking or blocking migrations
            expect(closeSpy).toHaveBeenCalledTimes(1);
            expect(store.isOpen()).toBe(false);
            expect((store as unknown as { db: IDBDatabase | null }).db).toBeNull();

            // Attempting operations now fails cleanly with STORE_NOT_OPENED rather than InvalidStateError
            await expect(store.count()).rejects.toThrow(STORE_NOT_OPENED);
        });

        it('open() never calls indexedDB.deleteDatabase() on startup (preventing LevelDB lock wedges)', async () => {
            const deleteSpy = vi.spyOn(indexedDB, 'deleteDatabase');
            const store = new IndexStore();
            openedStores.push(store);

            const scope = `no-delete-startup-${Math.random().toString(36).slice(2)}`;
            await store.open(scope, 'seek-test');

            expect(deleteSpy).not.toHaveBeenCalled();
            expect(store.isOpen()).toBe(true);
        });
    });

    // =========================================================================
    // 2. Clean Drop on Quit (No Lock Retained)
    // =========================================================================
    describe('2. Clean Drop on Quit (No Lock Retained)', () => {
        it('boot IndexStore, put sample chunks, close, and verify window.indexedDB.deleteDatabase succeeds with onsuccess and no onblocked', async () => {
            const store = new IndexStore();
            const scope = `clean-drop-${Math.random().toString(36).slice(2)}`;
            await store.open(scope, 'seek-test');
            expect(store.isOpen()).toBe(true);

            const chunk = createSampleChunk('c1', 'notes/sample.md');
            const vec = new Float32Array(384);
            vec[0] = 0.5;
            vec[1] = -0.5;
            await store.putBatch([chunk], [vec]);

            const counts = await store.count();
            expect(counts.chunks).toBe(1);

            const targetDbName = store.dbName;

            // Simulate plugin onunload / app quit
            store.close();
            expect(store.isOpen()).toBe(false);

            // Attempt to delete database: if any handle or connection remained open or locked,
            // onblocked would fire. Clean drop guarantees onsuccess fires without onblocked.
            let onBlockedFired = false;
            let onSuccessFired = false;

            await new Promise<void>((resolve, reject) => {
                const req = window.indexedDB.deleteDatabase(targetDbName);
                req.onsuccess = () => {
                    onSuccessFired = true;
                    resolve();
                };
                req.onerror = () => {
                    reject(req.error ?? new Error(`deleteDatabase(${targetDbName}) failed`));
                };
                req.onblocked = () => {
                    onBlockedFired = true;
                };
            });

            expect(onSuccessFired).toBe(true);
            expect(onBlockedFired).toBe(false);
        });
    });

    // =========================================================================
    // 3. In-Flight Open Racing Quit
    // =========================================================================
    describe('3. In-Flight Open Racing Quit', () => {
        it('detects openGeneration !== gen when delayed open resolves after close() and immediately calls close() on newly opened handle', async () => {
            const store = new IndexStore();
            openedStores.push(store);
            store.configure(`race-quit-${Math.random().toString(36).slice(2)}`, 'seek-test');

            const handleCloseSpy = vi.fn();
            let triggerSuccess: (() => void) | null = null;

            const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
                const fakeDb = {
                    close: handleCloseSpy,
                    onversionchange: null,
                };
                const req = {
                    result: fakeDb,
                    error: null,
                    set onsuccess(fn: () => void) { triggerSuccess = fn; },
                    set onerror(_fn: () => void) {},
                    set onupgradeneeded(_fn: () => void) {},
                };
                return req as unknown as IDBOpenDBRequest;
            });

            // Start open() - openDb is awaiting resolution
            const openPromise = store.open();
            expect(triggerSuccess).toBeTypeOf('function');
            expect(handleCloseSpy).not.toHaveBeenCalled();

            // While open is pending, close() is called (simulating user unload/quit racing slow disk open)
            // This increments this.openGeneration and sets this.db = null
            store.close();
            expect(store.isOpen()).toBe(false);

            // Now the delayed openDb succeeds
            triggerSuccess!();
            await openPromise;

            // IndexStore must detect openGeneration mismatch and immediately close the opened handle
            expect(handleCloseSpy).toHaveBeenCalledTimes(1);
            expect(store.isOpen()).toBe(false);
            expect((store as unknown as { db: IDBDatabase | null }).db).toBeNull();

            openSpy.mockRestore();
        });
    });

    // =========================================================================
    // 4. Post-Unload Protection
    // =========================================================================
    describe('4. Post-Unload Protection', () => {
        it('operations attempted on IndexStore after close() reject immediately with STORE_NOT_OPENED rather than reopening or holding locks', async () => {
            const store = new IndexStore();
            await store.open(`post-unload-${Math.random().toString(36).slice(2)}`, 'seek-test');

            const chunk = createSampleChunk('c1');
            const vec = new Float32Array(384);
            await store.putBatch([chunk], [vec]);

            // Unload / close the store
            store.close();
            expect(store.isOpen()).toBe(false);

            const openSpy = vi.spyOn(indexedDB, 'open');

            // Verify all key store operations throw STORE_NOT_OPENED immediately
            await expect(store.count()).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.getMeta()).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.listAllMeta()).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.getAllChunkIds()).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.getChunkMetasByIds(['c1'])).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.getEmbeddingsByIds(['c1'])).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.getBodiesByIds(['c1'])).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.getFileRecord('note.md')).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.putBatch([chunk], [vec])).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.deleteChunksByIds(['c1'])).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.putBm25('{"index":true}', 'stamp')).rejects.toThrow(STORE_NOT_OPENED);
            await expect(store.getBm25()).rejects.toThrow(STORE_NOT_OPENED);

            // None of the post-unload operations attempted to reopen or acquire locks on IndexedDB
            expect(openSpy).not.toHaveBeenCalled();
            expect(store.isOpen()).toBe(false);
        });

        it('SearchOrchestrator.dispose() cancels pendingPersistIdle so no asynchronous BM25 persist or IDB writes fire against a closed store', async () => {
            const store = new IndexStore();
            await store.open(`orch-dispose-${Math.random().toString(36).slice(2)}`, 'seek-test');
            openedStores.push(store);

            const cancelIdleSpy = vi.fn();
            vi.stubGlobal('cancelIdleCallback', cancelIdleSpy);

            const fakeVault = new FakeVault();
            const app = {
                vault: fakeVault,
                metadataCache: { isUserIgnored: () => false },
            } as unknown as App;

            const logger = {
                deviceId: 'test-device',
                append: async () => {},
                appendError: async () => {},
            } as never;

            const orch = new SearchOrchestrator(
                app,
                store,
                fakeEmbedder(),
                logger,
                structuredClone(DEFAULT_SETTINGS),
            );

            // Simulate a pending BM25 persist deferred to requestIdleCallback
            const IDLE_HANDLE = 8848;
            (orch as unknown as { pendingPersistIdle: number | null }).pendingPersistIdle = IDLE_HANDLE;

            const putBm25Spy = vi.spyOn(store, 'putBm25');

            // Dispose orchestrator (simulating plugin onunload)
            orch.dispose();

            // cancelIdleCallback must be invoked with the pending idle handle
            expect(cancelIdleSpy).toHaveBeenCalledTimes(1);
            expect(cancelIdleSpy).toHaveBeenCalledWith(IDLE_HANDLE);

            // pendingPersistIdle must be cleared to null
            expect((orch as unknown as { pendingPersistIdle: number | null }).pendingPersistIdle).toBeNull();
            expect((orch as unknown as { disposed: boolean }).disposed).toBe(true);

            // Store must NOT have been written to
            expect(putBm25Spy).not.toHaveBeenCalled();

            // Furthermore, even if an asynchronous callback races and executes, orchestrator.disposed guards it
            store.close();
            expect(store.isOpen()).toBe(false);
            expect(putBm25Spy).not.toHaveBeenCalled();
        });
    });
});
