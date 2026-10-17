import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => {
    const actual = await import('../test-stubs/obsidian');
    class Plugin {}
    class PluginSettingTab {}
    class Setting {}
    class App {}
    return { ...actual, Plugin, PluginSettingTab, Setting, App };
});

const executeFullReindexCleanSlate = vi.fn(async () => ({
    idbNuked: true,
    idbFallbackClear: false,
    sidecarCleared: true,
}));

vi.mock('./full-reindex-clean-slate', () => ({
    executeFullReindexCleanSlate: () => executeFullReindexCleanSlate(),
}));

import SeekPlugin from '../main';

function baseFullReindexHost(reindexAll: ReturnType<typeof vi.fn>) {
    return {
        fullReindexInFlight: false,
        fullReindexGen: 0,
        fullReindexRun: null,
        settings: { sidecarEnabled: true },
        app: { vault: { adapter: {} } },
        logger: { deviceId: 'test-device', append: vi.fn(async () => {}) },
        resolveSidecarIndexDir: () => '.obsidian/plugins/seek/index',
        attachOrchestrator: vi.fn(),
        releaseEmbedder: vi.fn(),
        store: { isOpen: () => true, open: vi.fn(async () => {}) },
        clearIndexingStalled: vi.fn(),
        bumpIndexingProgressHeartbeat: vi.fn(),
        persistCacheRestoredThisBoot: false,
        catchUpPending: false,
        catchUpRunning: false,
        sidecarHydrating: false,
        orchestrator: {
            isWriting: () => false,
            invalidateBm25Cache: vi.fn(),
            inspectSidecarFleet: vi.fn(async () => null),
            reindexAll,
            dispose: vi.fn(),
        },
        beginIndexJob: () => 1,
        indexableNoteCount: () => 10,
        pushTaskContext: vi.fn(),
        popTaskContext: vi.fn(),
        noteIndexDropped: vi.fn(),
        recoverAfterFailedDrop: vi.fn(async () => {}),
        unloading: false,
        ensureModelLoaded: vi.fn(async () => {}),
        indexProgress: { updateFromProgress: vi.fn(), hide: vi.fn() },
        notifyIndexActivityChanged: vi.fn(),
        emitStorageSnapshot: vi.fn(async () => {}),
        clearIndexDelta: vi.fn(),
        touchIndexInventory: vi.fn(async () => {}),
        abortInflightSessionWork: vi.fn(),
    };
}

function wireSchedulersStub(plugin: object, clearDeferred = vi.fn()): void {
    Object.defineProperty(plugin, 'schedulers', {
        get: () => ({ clearDeferredIndexingWork: clearDeferred }),
        configurable: true,
    });
}

beforeEach(() => {
    executeFullReindexCleanSlate.mockClear();
});

// Model load is not isWriting(). A second full reindex in that gap used to
// begin another status-bar job and queue a wipe behind the pass that was running.
describe('runFullReindex stacking', () => {
    it('refuses a second full reindex while the first is still loading the model', async () => {
        let releaseLoad!: () => void;
        const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
        const reindexAll = vi.fn(async () => ({
            pass: true,
            filesIndexed: 1,
            chunksIndexed: 1,
            totalDurationMs: 1000,
            chunksPerSec: 1,
        }));
        const plugin = Object.create(SeekPlugin.prototype) as {
            runFullReindex(opts?: { skipConfirm?: boolean }): Promise<boolean>;
            fullReindexInFlight: boolean;
            ensureModelLoaded: () => Promise<void>;
        };
        Object.assign(plugin, baseFullReindexHost(reindexAll));
        wireSchedulersStub(plugin);
        plugin.ensureModelLoaded = () => loadGate;

        const first = plugin.runFullReindex({ skipConfirm: true });
        const second = await plugin.runFullReindex({ skipConfirm: true });
        expect(second).toBe(false);
        expect(reindexAll).not.toHaveBeenCalled();
        expect(plugin.fullReindexInFlight).toBe(true);

        releaseLoad();
        await expect(first).resolves.toBe(true);
        expect(reindexAll).toHaveBeenCalledTimes(1);
        expect(plugin.fullReindexInFlight).toBe(false);
    });
});

describe('runFullReindex takeover', () => {
    it('aborts catch-up and runs clean slate before reindexAll', async () => {
        const reindexAll = vi.fn(async () => ({
            pass: true,
            filesIndexed: 2,
            chunksIndexed: 4,
            totalDurationMs: 500,
            chunksPerSec: 8,
        }));
        const plugin = Object.create(SeekPlugin.prototype) as {
            runFullReindex(opts?: { skipConfirm?: boolean }): Promise<boolean>;
            abortInflightSessionWork: ReturnType<typeof vi.fn>;
        };
        const host = baseFullReindexHost(reindexAll);
        host.catchUpRunning = true;
        host.orchestrator.isWriting = () => true;
        Object.assign(plugin, host);
        wireSchedulersStub(plugin);

        const ok = await plugin.runFullReindex({ skipConfirm: true });
        expect(ok).toBe(true);
        expect(plugin.abortInflightSessionWork).toHaveBeenCalledWith(
            'full-reindex-takeover',
            { keepFullReindexLatch: true, releaseIndexHold: true },
        );
        expect(executeFullReindexCleanSlate).toHaveBeenCalledTimes(1);
        expect(reindexAll).toHaveBeenCalledWith(
            expect.any(Function),
            { storeAlreadyReset: true },
        );
    });

    it('a user takeover aborts the in-flight full reindex and starts a clean pass', async () => {
        let releaseLoad!: () => void;
        const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
        const reindexAll = vi.fn(async () => ({
            pass: true,
            filesIndexed: 3,
            chunksIndexed: 6,
            totalDurationMs: 800,
            chunksPerSec: 8,
        }));
        const plugin = Object.create(SeekPlugin.prototype) as {
            runFullReindex(opts?: { skipConfirm?: boolean; takeover?: boolean }): Promise<boolean>;
            fullReindexInFlight: boolean;
            ensureModelLoaded: () => Promise<void>;
            abortInflightSessionWork: ReturnType<typeof vi.fn>;
        };
        const host = baseFullReindexHost(reindexAll);
        host.abortInflightSessionWork = vi.fn(() => { releaseLoad(); });
        Object.assign(plugin, host);
        wireSchedulersStub(plugin);
        plugin.ensureModelLoaded = () => loadGate;

        const first = plugin.runFullReindex({ skipConfirm: true });
        const second = plugin.runFullReindex({ skipConfirm: true, takeover: true });
        const secondOk = await second;
        const firstOk = await first;

        expect(firstOk).toBe(false);
        expect(secondOk).toBe(true);
        expect(plugin.abortInflightSessionWork).toHaveBeenCalledWith(
            'full-reindex-takeover',
            { keepFullReindexLatch: true, releaseIndexHold: true },
        );
        expect(reindexAll).toHaveBeenCalledTimes(1);
        expect(plugin.fullReindexInFlight).toBe(false);
    });
});
