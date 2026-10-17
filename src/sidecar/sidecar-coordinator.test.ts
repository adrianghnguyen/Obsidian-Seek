import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TFile, type App } from 'obsidian';
import { IndexStore } from '../index/index-store';
import { LocalEmbedder } from '../embedding/embedder';
import { SeekLogger } from '../diagnostics/logger';
import { DEFAULT_SETTINGS } from '../types/types';
import { IndexCoordinator } from '../index/index-coordinator';
import { CacheManager } from '../search/cache-manager';
import { SidecarCoordinator } from './sidecar-coordinator';
import { SearchOrchestrator } from '../search/search';
import { FakeVault, fakeEmbedder } from '../test-harness/scenario';
import { SIDECAR_FORMAT } from './sidecar';
import { writeDeviceMeta, expectationFor } from './sidecar-meta';
import { setSidecarIndexRole } from '../embedding/platform';

const EXPECT = expectationFor();

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
    // Atomic meta writes (writeTextAtomic) rename a temp file over the target.
    async stat(p: string): Promise<{ size: number; type: 'file' } | null> {
        if (this.bins.has(p)) return { size: this.bins.get(p)!.byteLength, type: 'file' };
        if (this.files.has(p)) return { size: this.files.get(p)!.length, type: 'file' };
        return null;
    }
    async rename(from: string, to: string): Promise<void> {
        const v = this.files.get(from);
        if (v !== undefined) {
            this.files.set(to, v);
            this.files.delete(from);
            return;
        }
        const b = this.bins.get(from);
        if (b !== undefined) {
            this.bins.set(to, b);
            this.bins.delete(from);
            return;
        }
        throw new Error(`ENOENT: ${from}`);
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
        const mem: Record<string, string> = {};
        (window as unknown as { localStorage: Storage }).localStorage = {
            getItem: (k: string) => (k in mem ? mem[k] : null),
            setItem: (k: string, v: string) => { mem[k] = String(v); },
            removeItem: (k: string) => { delete mem[k]; },
            clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
            get length() { return Object.keys(mem).length; },
            key: (i: number) => Object.keys(mem)[i] ?? null,
        };
        setSidecarIndexRole('auto');
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

        it('peerSidecarPresent only counts a peer this build can ingest (stale peer is not "on its way")', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            settings.sidecarEnabled = true;
            const indexDir = '.seek-test-index';
            const coord = new IndexCoordinator(indexDir, settings);
            const cacheManager = new CacheManager({ app, store, coord, embedder, settings, logger });
            const coordinator = new SidecarCoordinator({
                app, store, coord, embedder, logger, settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [],
                shouldIndex: () => true,
            });

            // A STALE peer (different modelId) can never hydrate a current-identity index.
            // Counting it as "syncing" stranded the device on Restoring forever.
            await writeDeviceMeta(adapter as never, indexDir, {
                format: SIDECAR_FORMAT,
                modelId: 'hotchpotch/bekko-embedding-v1-a8m',
                revision: null,
                chunkerVersion: EXPECT.chunkerVersion,
                dim: EXPECT.dim,
                deviceId: 'desktop-stale',
                lastFullReindex: null,
            });
            expect(await coordinator.peerSidecarPresent()).toBe(false);

            // A CURRENT-identity peer IS a real heal in progress.
            await writeDeviceMeta(adapter as never, indexDir, {
                format: SIDECAR_FORMAT,
                modelId: EXPECT.modelId,
                revision: EXPECT.revision,
                chunkerVersion: EXPECT.chunkerVersion,
                dim: EXPECT.dim,
                deviceId: 'desktop-current',
                lastFullReindex: null,
            });
            expect(await coordinator.peerSidecarPresent()).toBe(true);
        });

        it('inspectFleet locks a desktop with a stale peer as contributor (no reap, no full reindex)', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            settings.sidecarEnabled = true;
            const indexDir = '.seek-test-index';
            const coord = new IndexCoordinator(indexDir, settings);
            const cacheManager = new CacheManager({ app, store, coord, embedder, settings, logger });
            const coordinator = new SidecarCoordinator({
                app, store, coord, embedder, logger, settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [{ path: 'note.md' } as TFile],
                shouldIndex: () => true,
            });

            await writeDeviceMeta(adapter as never, indexDir, {
                format: SIDECAR_FORMAT,
                modelId: 'hotchpotch/bekko-embedding-v1-a8m',
                revision: null,
                chunkerVersion: EXPECT.chunkerVersion,
                dim: EXPECT.dim,
                deviceId: 'desktop-stale',
                lastFullReindex: '2026-10-01T00:00:00Z',
            });

            const fleet = await coordinator.inspectFleet();
            expect(fleet?.role).toBe('contributor');
            expect(fleet?.mayFullReindex).toBe(false);
            expect(fleet?.mayEmbedCatchUp).toBe(true);
            expect(fleet?.mayReapPeers).toBe(false);
            expect(fleet?.waitingForProducer).toBe(true);
            expect(fleet?.copy).toMatch(/will not re-embed or delete/);
        });

        it('does not reap a stale peer when this device is a consumer', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            settings.sidecarEnabled = true;
            const indexDir = '.seek-test-index';
            const coord = new IndexCoordinator(indexDir, settings);
            const cacheManager = new CacheManager({ app, store, coord, embedder, settings, logger });
            const coordinator = new SidecarCoordinator({
                app, store, coord, embedder, logger, settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [],
                shouldIndex: () => true,
            });

            await writeDeviceMeta(adapter as never, indexDir, {
                format: SIDECAR_FORMAT,
                modelId: 'hotchpotch/bekko-embedding-v1-a8m',
                revision: null,
                chunkerVersion: EXPECT.chunkerVersion,
                dim: EXPECT.dim,
                deviceId: 'desktop-stale',
                lastFullReindex: '2026-10-01T00:00:00Z',
            });
            adapter.files.set(`${indexDir}/index.desktop-stale.jsonl`, '{"id":"x"}\n');

            setSidecarIndexRole('consumer');
            const reaped = await coordinator.reapDeadIdentitySidecars();
            expect(reaped).toBe(0);
            expect(adapter.files.has(`${indexDir}/meta.desktop-stale.json`)).toBe(true);
            setSidecarIndexRole('auto');
        });

        it('producer still reaps a stale peer sidecar', async () => {
            const settings = structuredClone(DEFAULT_SETTINGS);
            settings.sidecarEnabled = true;
            const indexDir = '.seek-test-index';
            const coord = new IndexCoordinator(indexDir, settings);
            const cacheManager = new CacheManager({ app, store, coord, embedder, settings, logger });
            const coordinator = new SidecarCoordinator({
                app, store, coord, embedder, logger, settings,
                cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [],
                shouldIndex: () => true,
            });

            await writeDeviceMeta(adapter as never, indexDir, {
                format: SIDECAR_FORMAT,
                modelId: 'hotchpotch/bekko-embedding-v1-a8m',
                revision: null,
                chunkerVersion: EXPECT.chunkerVersion,
                dim: EXPECT.dim,
                deviceId: 'desktop-stale',
                lastFullReindex: '2026-10-01T00:00:00Z',
            });
            adapter.files.set(`${indexDir}/index.desktop-stale.jsonl`, '{"id":"x"}\n');

            setSidecarIndexRole('producer');
            const reaped = await coordinator.reapDeadIdentitySidecars();
            expect(reaped).toBe(1);
            expect(adapter.files.has(`${indexDir}/meta.desktop-stale.json`)).toBe(false);
            setSidecarIndexRole('auto');
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

    describe('rebuildFromSidecar drop vs hydrate', () => {
        function coordinatorFor(indexDir: string): SidecarCoordinator {
            const settings = structuredClone(DEFAULT_SETTINGS);
            settings.sidecarEnabled = true;
            const coord = new IndexCoordinator(indexDir, settings);
            const cacheManager = new CacheManager({ app, store, coord, embedder, settings, logger });
            return new SidecarCoordinator({
                app, store, coord, embedder, logger, settings, cacheManager,
                chunksFor: () => [],
                indexableFiles: () => [{ path: 'note.md' } as TFile],
                shouldIndex: () => true,
            });
        }

        it('does not wipe IDB when the producer sidecar is incomplete', async () => {
            const indexDir = '.seek-test-index';
            await store.putBatchQuantized(
                [{
                    chunk_id: 'keep-1', title: 'Keep', content: 'body', note_path: 'keep.md',
                    heading_path: [], metadata: { tags: [], aliases: [], created: null, modified: null, properties: {} },
                    start_line: 0, end_line: 0,
                }],
                [{ q: { q: new Int8Array([1, 2]), s: 0.5 }, bin: new Uint8Array([1]) }],
                { note_path: 'keep.md', mtimeMs: 1, chunk_ids: ['keep-1'], contentHash: 'h' },
            );
            expect((await store.count()).chunks).toBe(1);

            await writeDeviceMeta(adapter as never, indexDir, {
                format: SIDECAR_FORMAT,
                modelId: EXPECT.modelId,
                revision: EXPECT.revision,
                chunkerVersion: EXPECT.chunkerVersion,
                dim: EXPECT.dim,
                deviceId: 'peer-desktop',
                lastFullReindex: '2026-10-01T00:00:00Z',
            });

            const coordinator = coordinatorFor(indexDir);
            const result = await coordinator.rebuildFromSidecar();
            expect(result?.waitingForProducer || result?.acceptedProducers === 0).toBe(true);
            expect((await store.count()).chunks).toBe(1);
            expect(await store.getFileRecord('keep.md')).toBeTruthy();
        });
    });
});
