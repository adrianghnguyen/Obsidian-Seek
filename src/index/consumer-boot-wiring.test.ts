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
import { setEnergySaver } from '../embedding/platform';

type PluginHarness = Record<string, unknown> & {
    maybeCompleteConsumerHydrateBoot(): Promise<void>;
    recoverAfterFailedDrop(reason: string, opts?: { allowColdBuild?: boolean }): Promise<void>;
    applyPostBootIndexScheduling(): void;
    applySidecarWait(result: {
        hydrated: number;
        skippedPartialNotes: number;
        acceptedProducers: number;
        waitingForProducer?: boolean;
        incompleteFolder?: boolean;
        datalessShards?: number;
    } | null): void;
    refreshSidecarFleet(): Promise<void>;
    scheduleColdBuild(): Promise<void>;
    executeFullReindexBody(gen: number, opts?: { skipConfirm?: boolean }): Promise<boolean>;
    executeRecoverFromSettings(): Promise<void>;
    syncWarmDeferred(): void;
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
    mayEmbedCatchUp: false,
    copy: 'Hydrating from the producer index.',
};

const contributorFleet = {
    role: 'contributor' as const,
    waitingForProducer: false,
    matchingReady: true,
    mayFullReindex: false,
    mayEmbedCatchUp: true,
    localFileCount: 4005,
    indexableNotes: 4005,
    copy: 'This computer adds new and changed notes to the shared index. A full rebuild stays on the lead computer.',
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
            lastMayEmbedCatchUp: false,
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
            lastMayEmbedCatchUp: false,
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
            indexProgress: { refreshIdle: vi.fn(), update: vi.fn(), pauseElapsed: vi.fn(), resumeElapsed: vi.fn() },
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

    it('refreshSidecarFleet clears stale peerSyncPending on a ready contributor without version mismatch', async () => {
        const setWarmDeferred = vi.fn();
        const refreshIndexStatusBar = vi.fn();
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            settings: { sidecarEnabled: true },
            orchestrator: {
                inspectSidecarFleet: async () => contributorFleet,
                setWarmDeferred,
            },
            indexableNoteCount: () => 4005,
            indexProgressWalk: { publish: vi.fn() },
            waitingForSidecar: false,
            peerSyncPending: true,
            degradedReason: null,
            catchUpPending: false,
            catchUpRunning: false,
            refreshIndexStatusBar,
        });

        await plugin.refreshSidecarFleet();

        expect(plugin.waitingForSidecar).toBe(false);
        expect(plugin.peerSyncPending).toBe(false);
        expect(refreshIndexStatusBar).toHaveBeenCalledTimes(1);
    });

    it('refreshSidecarFleet preserves peerSyncPending when degradedReason is version', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            settings: { sidecarEnabled: true },
            orchestrator: {
                inspectSidecarFleet: async () => contributorFleet,
                setWarmDeferred: vi.fn(),
            },
            indexableNoteCount: () => 4005,
            indexProgressWalk: { publish: vi.fn() },
            waitingForSidecar: true,
            peerSyncPending: true,
            degradedReason: 'version',
            catchUpPending: false,
            catchUpRunning: false,
            refreshIndexStatusBar: vi.fn(),
        });

        await plugin.refreshSidecarFleet();

        expect(plugin.waitingForSidecar).toBe(false);
        expect(plugin.peerSyncPending).toBe(true);
    });

    it('applySidecarWait clears peerSyncPending when hydrate no longer waits on sidecar', () => {
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            indexInventoryChunks: 16114,
            sidecarSkippedPartialNotes: 0,
            waitingForSidecar: true,
            peerSyncPending: true,
            degradedReason: null,
            catchUpPending: false,
            catchUpRunning: false,
            orchestrator: { setWarmDeferred: vi.fn() },
            touchIndexInventory: vi.fn(async () => {}),
            refreshIndexStatusBar: vi.fn(),
        });

        plugin.applySidecarWait({ hydrated: 0, skippedPartialNotes: 0, acceptedProducers: 1 });

        expect(plugin.waitingForSidecar).toBe(false);
        expect(plugin.peerSyncPending).toBe(false);
    });

    it('maybeCompleteConsumerHydrateBoot clears peerSyncPending on a ready contributor after hydrate ends', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            unloading: false,
            sidecarHydrating: false,
            settings: { sidecarEnabled: true },
            orchestrator: {
                inspectSidecarFleet: async () => contributorFleet,
                setWarmDeferred: vi.fn(),
            },
            indexInventoryFiles: 4005,
            waitingForSidecar: false,
            peerSyncPending: true,
            degradedReason: null,
            catchUpPending: false,
            catchUpRunning: false,
            refreshIndexStatusBar: vi.fn(),
        });

        await plugin.maybeCompleteConsumerHydrateBoot();

        expect(plugin.waitingForSidecar).toBe(false);
        expect(plugin.peerSyncPending).toBe(false);
    });

    it('scheduleColdBuild and executeFullReindexBody do not latch peerSyncPending on a ready contributor', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            unloading: false,
            loadGeneration: 1,
            fullReindexGen: 1,
            coldBuildScheduled: true,
            orchestrator: {
                inspectSidecarFleet: async () => contributorFleet,
                setWarmDeferred: vi.fn(),
            },
            waitingForSidecar: false,
            peerSyncPending: false,
            degradedReason: null,
            catchUpPending: false,
            catchUpRunning: false,
            refreshIndexStatusBar: vi.fn(),
        });

        await plugin.scheduleColdBuild();
        expect(plugin.peerSyncPending).toBe(false);
        expect(plugin.waitingForSidecar).toBe(false);

        const ran = await plugin.executeFullReindexBody(1, { skipConfirm: true });
        expect(ran).toBe(false);
        expect(plugin.peerSyncPending).toBe(false);
        expect(plugin.waitingForSidecar).toBe(false);
    });

    it('executeRecoverFromSettings resets stale peerSyncPending before resuming boot', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
        Object.assign(plugin, {
            catchUpRunning: false,
            catchUpPending: false,
            fullReindexRun: null,
            indexDropRecovering: false,
            waitingForSidecar: true,
            peerSyncPending: true,
            store: { isOpen: () => true, open: vi.fn(async () => {}) },
            orchestrator: { setWarmDeferred: vi.fn() },
            abortInflightSessionWork: vi.fn(),
            clearIndexingStalled: vi.fn(),
            attachOrchestrator: vi.fn(),
            resolveSidecarIndexDir: () => 'index',
            retryIndexStoreOpen: vi.fn(async () => {}),
            maybeResumeIncompleteCoverage: vi.fn(),
            scheduleStartupCatchUp: vi.fn(),
            refreshIndexStatusBar: vi.fn(),
            notifyIndexActivityChanged: vi.fn(),
        });

        await plugin.executeRecoverFromSettings();

        expect(plugin.waitingForSidecar).toBe(false);
        expect(plugin.peerSyncPending).toBe(false);
    });

    it('syncWarmDeferred does not defer cache warm when catchUpPending is parked by energy saver', () => {
        let ls: Record<string, string> = {};
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => (k in ls ? ls[k] : null),
            setItem: (k: string, v: string) => { ls[k] = String(v); },
            removeItem: (k: string) => { delete ls[k]; },
            clear: () => { ls = {}; },
        });
        setEnergySaver(true);
        try {
            const setWarmDeferred = vi.fn();
            const plugin = Object.create(SeekPlugin.prototype) as PluginHarness;
            Object.assign(plugin, {
                catchUpRunning: false,
                catchUpPending: true,
                waitingForSidecar: false,
                orchestrator: { setWarmDeferred },
            });

            plugin.syncWarmDeferred();
            expect(setWarmDeferred).toHaveBeenLastCalledWith(false);

            plugin.catchUpRunning = true;
            plugin.syncWarmDeferred();
            expect(setWarmDeferred).toHaveBeenLastCalledWith(true);
        } finally {
            setEnergySaver(false);
            vi.unstubAllGlobals();
        }
    });
});
