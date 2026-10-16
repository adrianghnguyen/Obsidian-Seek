import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async () => {
    const actual = await import('../test-stubs/obsidian');
    class Plugin {}
    class PluginSettingTab {}
    class Setting {}
    class App {}
    return { ...actual, Plugin, PluginSettingTab, Setting, App };
});

import { Platform } from 'obsidian';
import SeekPlugin from '../main';

type PluginHarness = Record<string, unknown> & {
    maybeCompleteConsumerHydrateBoot(): Promise<void>;
    recoverAfterFailedDrop(reason: string, opts?: { allowColdBuild?: boolean }): Promise<void>;
    applyPostBootIndexScheduling(): void;
    scheduleStartupCatchUp(): void;
    runCatchUp(): void;
    clearBootWatchdog?(): void;
    markBootStuckResolved?(): void;
};

const consumerFleet = {
    role: 'consumer' as const,
    waitingForProducer: false,
    matchingReady: true,
    mayFullReindex: false,
    copy: 'Hydrating from the producer index.',
};

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 16; i++) await Promise.resolve();
}

afterEach(() => {
    Platform.isMobile = false;
    Platform.isDesktop = true;
    vi.restoreAllMocks();
});

describe('SeekPlugin consumer hydrate boot wiring', () => {
    it('clears stuck latches and marks good-enough after consumer hydrate releases the gate', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        const markIndexGoodEnough = vi.fn(function (this: PluginHarness) {
            this.indexGoodEnough = true;
            this.indexBootPending = false;
            this.indexDropRecovering = false;
            this.clearBootWatchdog?.();
            this.markBootStuckResolved?.();
        });
        const clearIndexingStalled = vi.fn();
        const markBootStuckResolved = vi.fn();
        const clearBootWatchdog = vi.fn();
        Object.assign(plugin, {
            unloading: false,
            sidecarHydrating: false,
            settings: { sidecarEnabled: true },
            orchestrator: { inspectSidecarFleet: async () => consumerFleet },
            waitingForSidecar: true,
            peerSyncPending: true,
            indexDropRecovering: true,
            indexGoodEnough: false,
            indexBootPending: true,
            indexBootStuck: true,
            indexIndexingStalled: true,
            markIndexGoodEnough,
            clearIndexingStalled,
            markBootStuckResolved,
            clearBootWatchdog,
            refreshIndexStatusBar: vi.fn(),
        });

        await plugin.maybeCompleteConsumerHydrateBoot();

        expect(markIndexGoodEnough).toHaveBeenCalledTimes(1);
        expect(clearIndexingStalled).toHaveBeenCalledTimes(1);
        expect(plugin.waitingForSidecar).toBe(false);
        expect(plugin.peerSyncPending).toBe(false);
        expect(plugin.indexGoodEnough).toBe(true);
        expect(plugin.indexBootPending).toBe(false);
    });

    it('does not load the embedder for consumer catch-up when mayFullReindex is false', async () => {
        Platform.isMobile = false;
        Platform.isDesktop = true;
        const ensureModelLoaded = vi.fn(async () => {
            throw new Error('consumer must not load the GPU embedder');
        });
        const runCatchUp = vi.fn();
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            waitingForSidecar: false,
            catchUpPending: true,
            loadGeneration: 1,
            unloading: false,
            isSessionWorkCurrent: () => true,
            orchestrator: { inspectSidecarFleet: async () => consumerFleet },
            settings: { sidecarEnabled: true },
            ensureModelLoaded,
            runCatchUp,
            lastMayFullReindex: false,
        });

        plugin.scheduleStartupCatchUp();
        await flushMicrotasks();

        expect(ensureModelLoaded).not.toHaveBeenCalled();
        expect(runCatchUp).toHaveBeenCalledTimes(1);
    });

    it('runs catch-up with embed:false on a consumer without a loaded model', async () => {
        Platform.isMobile = false;
        Platform.isDesktop = true;
        const reindexDelta = vi.fn(async () => ({
            embedded: null,
            deferredEmbed: 0,
            committedPaths: [],
        }));
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            waitingForSidecar: false,
            catchUpPending: true,
            catchUpRunning: false,
            persistCacheRestoredThisBoot: true,
            catchUpJob: null,
            loadGeneration: 1,
            lastMayFullReindex: false,
            settings: { catchUpBurstMaxFiles: 30 },
            embedder: { loaded: false },
            orchestrator: {
                computeDelta: async () => ({ dirty: ['note.md'], deleted: [] }),
                reindexDelta,
                peerAhead: false,
            },
            isSessionWorkCurrent: () => true,
            pushTaskContext: vi.fn(),
            popTaskContext: vi.fn(),
            syncWarmDeferred: vi.fn(),
            syncCatchUpJob: vi.fn(),
            appendErrorIfCurrent: vi.fn(),
            finishCatchUpJob: vi.fn(),
            clearExclusionChange: vi.fn(),
            runStartupWarm: vi.fn(),
            indexProgress: { refreshIdle: vi.fn(), update: vi.fn() },
            bumpIndexingProgressHeartbeat: vi.fn(),
            notifyIndexActivityChanged: vi.fn(),
            noteIndexDeltaFromCompute: vi.fn(),
            noteIndexDeltaCommitted: vi.fn(),
            touchIndexInventory: async () => {},
            indexDelta: { snapshot: () => ({ pendingPaths: [] }) },
            _schedulers: { isExclusionAligning: () => false },
            queryInFlightCount: 0,
            searchActiveTimestamp: null,
            scheduleStartupCatchUp: vi.fn(),
        });
        (globalThis as unknown as { activeDocument: { hidden: boolean } }).activeDocument = { hidden: false };

        plugin.runCatchUp();
        await flushMicrotasks();

        expect(plugin.scheduleStartupCatchUp).not.toHaveBeenCalled();
        expect(reindexDelta).toHaveBeenCalled();
        const firstCall = reindexDelta.mock.calls[0] as unknown as [string[], string[], { embed: boolean }];
        expect(firstCall[2].embed).toBe(false);
        delete (globalThis as unknown as { activeDocument?: unknown }).activeDocument;
    });

    it('does not start a second hydrate from post-boot recovery after boot continuation', async () => {
        const hydrateSidecar = vi.fn(async () => ({ hydrated: 12, acceptedProducers: 1 }));
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            unloading: false,
            dropRecoveryInFlight: false,
            bootContinuationDone: true,
            store: { isOpen: () => true, open: async () => {} },
            settings: { sidecarEnabled: true },
            orchestrator: {
                inspectSidecarFleet: async () => consumerFleet,
                hydrateSidecar,
            },
            withSidecarHydrate: (fn: () => Promise<unknown>) => fn(),
            applySidecarWait: vi.fn(),
            touchIndexInventory: async () => {},
            indexInventoryChunks: 2000,
            markIndexGoodEnough: vi.fn(),
            refreshIndexStatusBar: vi.fn(),
            logger: { appendError: async () => {} },
            scheduleColdBuild: vi.fn(),
            indexDropRecovering: false,
            indexGoodEnough: false,
            waitingForSidecar: false,
            peerSyncPending: false,
        });

        await plugin.recoverAfterFailedDrop('post-boot', { allowColdBuild: true });

        expect(hydrateSidecar).not.toHaveBeenCalled();
    });

    it('applyPostBootIndexScheduling does not re-enter drop recovery after boot continuation', () => {
        const recoverAfterFailedDrop = vi.fn();
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            unloading: false,
            waitingForSidecar: false,
            sidecarHydrating: false,
            indexDropRecovering: true,
            settings: { sidecarEnabled: true },
            indexInventoryChunks: 0,
            indexableNoteCount: () => 10,
            bootContinuationDone: true,
            recoverAfterFailedDrop,
            catchUpPending: false,
            indexBootDecisionPending: false,
            refreshIndexStatusBar: vi.fn(),
        });

        plugin.applyPostBootIndexScheduling();

        expect(recoverAfterFailedDrop).not.toHaveBeenCalled();
    });
});
