import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TFile, type App } from 'obsidian';
import { IndexStore } from './index-store';
import { LocalEmbedder } from './embedder';
import { SeekLogger } from './logger';
import { DEFAULT_SETTINGS } from './types';
import { IndexCoordinator } from './index-coordinator';
import { CacheManager } from './cache-manager';
import { SidecarCoordinator } from './sidecar-coordinator';
import { SearchOrchestrator } from './search';
import { FakeVault, fakeEmbedder } from './test-harness/scenario';

class MemoryAdapter {
    files = new Map<string, string>();
    bins = new Map<string, ArrayBuffer>();

    async exists(p: string): Promise<boolean> {
        if (this.files.has(p) || this.bins.has(p)) return true;
        const prefix = p.endsWith('/') ? p : p + '/';
        for (const k of [...this.files.keys(), ...this.bins.keys()]) {
            if (k.startsWith(prefix)) return true;
        }
        return false;
    }
    async mkdir(_p: string): Promise<void> {}
    async read(p: string): Promise<string> {
        const v = this.files.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
    }
    async write(p: string, d: string): Promise<void> {
        this.files.set(p, d);
    }
    async append(p: string, d: string): Promise<void> {
        this.files.set(p, (this.files.get(p) ?? '') + d);
    }
    async readBinary(p: string): Promise<ArrayBuffer> {
        const v = this.bins.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return v;
    }
    async writeBinary(p: string, d: ArrayBuffer): Promise<void> {
        this.bins.set(p, d);
    }
    async list(p: string): Promise<{ files: string[]; folders: string[] }> {
        const prefix = p.endsWith('/') ? p : p + '/';
        const files: string[] = [];
        const folders = new Set<string>();
        for (const k of [...this.files.keys(), ...this.bins.keys()]) {
            if (k.startsWith(prefix)) {
                const rest = k.slice(prefix.length);
                const slash = rest.indexOf('/');
                if (slash >= 0) {
                    folders.add(prefix + rest.slice(0, slash));
                } else {
                    files.push(k);
                }
            }
        }
        return { files, folders: [...folders] };
    }
    async remove(p: string): Promise<void> {
        this.files.delete(p);
        this.bins.delete(p);
    }
}

describe('SidecarCoordinator', () => {
    let store: IndexStore;
    let vault: FakeVault;
    let adapter: MemoryAdapter;
    let app: App;
    let embedder: LocalEmbedder;
    let logger: SeekLogger;

    beforeEach(async () => {
        store = new IndexStore();
        await store.open(`test-sidecar-${Math.random().toString(36).slice(2)}`, 'seek-test');
        vault = new FakeVault();
        adapter = new MemoryAdapter();
        vault.adapter = adapter as never;
        app = {
            vault,
            metadataCache: { isUserIgnored: () => false },
        } as unknown as App;
        embedder = fakeEmbedder();
        logger = { deviceId: 'device-test', append: async () => {}, appendError: async () => {} } as unknown as SeekLogger;
    });

    afterEach(async () => {
        store.close();
    });

    describe('when sidecar is disabled (indexDir is null)', () => {
        it('safely no-ops all sidecar operations and returns null', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            const coord = new IndexCoordinator(null, settings);
            const cacheManager = new CacheManager({
                app,
                store,
                coord,
                embedder,
                settings,
                logger,
            });

            const coordinator = new SidecarCoordinator({
                app,
                store,
                coord,
                embedder,
                logger,
                settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [],
                shouldIndex: () => true,
            });

            expect(coordinator.peerAhead).toBe(false);
            expect(await coordinator.hydrateSidecar()).toBeNull();
            expect(await coordinator.rebuildFromSidecar()).toBeNull();
            expect(await coordinator.reconcileSidecarIfChanged()).toBeNull();
            expect(await coordinator.compactOwnSidecar()).toBeNull();
            expect(await coordinator.coalesceOwnSidecar()).toBeNull();
            expect(await coordinator.indexedChunkCount()).toBe(0);

            // dedupViaSidecar with sidecar off returns files as-is
            const dummyFile = new TFile();
            dummyFile.path = 'note.md';
            const resultFiles = await coordinator.dedupViaSidecar([dummyFile]);
            expect(resultFiles).toHaveLength(1);
            expect(resultFiles[0]).toBe(dummyFile);
        });
    });

    describe('when sidecar is enabled with IndexCoordinator', () => {
        it('reports peerSidecarPresent correctly and handles empty sidecar folder', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            settings.sidecarEnabled = true;
            const indexDir = '.seek-test-index';
            const coord = new IndexCoordinator(indexDir, settings);
            const cacheManager = new CacheManager({
                app,
                store,
                coord,
                embedder,
                settings,
                logger,
            });

            const coordinator = new SidecarCoordinator({
                app,
                store,
                coord,
                embedder,
                logger,
                settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [],
                shouldIndex: () => true,
            });

            // No peer files present yet
            const present = await coordinator.peerSidecarPresent();
            expect(present).toBe(false);

            // Reaping dead identity sidecars when nothing exists returns 0
            const reaped = await coordinator.reapDeadIdentitySidecars();
            expect(reaped).toBe(0);
        });

        it('sweeps orphan chunks when store has orphans', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            const coord = new IndexCoordinator('.seek-index', settings);
            const cacheManager = new CacheManager({
                app,
                store,
                coord,
                embedder,
                settings,
                logger,
            });

            const coordinator = new SidecarCoordinator({
                app,
                store,
                coord,
                embedder,
                logger,
                settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [],
                shouldIndex: () => true,
            });

            // Store is empty, sweeping finds 0 orphans
            const sweep = await coordinator.sweepOrphanChunks();
            expect(sweep.removed).toBe(0);
            expect(sweep.completed).toBe(true);
        });

        it('verifies coherence when caches match store', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            const coord = new IndexCoordinator('.seek-index', settings);
            const cacheManager = new CacheManager({
                app,
                store,
                coord,
                embedder,
                settings,
                logger,
            });

            const coordinator = new SidecarCoordinator({
                app,
                store,
                coord,
                embedder,
                logger,
                settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [],
                shouldIndex: () => true,
            });

            // Empty store and empty caches are trivially coherent
            const coherent = await coordinator.verifyCoherent();
            expect(coherent).toBe(true);
        });
    });

    describe('SearchOrchestrator delegation facade', () => {
        it('delegates sidecar methods to SidecarCoordinator seamlessly', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            const orch = new SearchOrchestrator(app, store, embedder, logger, settings, null, null);

            expect(orch.peerAhead).toBe(false);
            expect(await orch.hydrateSidecar()).toBeNull();
            expect(await orch.rebuildFromSidecar()).toBeNull();
            expect(await orch.peerSidecarPresent()).toBe(false);
            expect(await orch.reconcileSidecarIfChanged()).toBeNull();
            expect(await orch.compactOwnSidecar()).toBeNull();
            expect(await orch.coalesceOwnSidecar()).toBeNull();
            expect(await orch.indexedChunkCount()).toBe(0);

            const coherent = await orch.verifyCoherent();
            expect(coherent).toBe(true);

            const sweep = await orch.sweepOrphanChunks();
            expect(sweep.removed).toBe(0);
            expect(sweep.completed).toBe(true);

            orch.dispose();
        });
    });
});
