import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { IndexDeltaTracker } from '../index/index-delta-view';

type SchedulerWindow = typeof globalThis & {
    scheduler?: { yield: () => Promise<void> };
};

interface CatchUpHarness {
    plugin: { runCatchUp(): void };
    yieldResolvers: Array<() => void>;
    computeCalls: () => number;
    reindexCalls: () => number;
    inventoryCalls: () => number;
    maxConcurrentInventory: () => number;
    appendErrorIfCurrent: ReturnType<typeof vi.fn>;
}

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

function makeHarness(hidden: boolean): CatchUpHarness {
    (globalThis as unknown as { activeDocument: { hidden: boolean } }).activeDocument = { hidden };
    const yieldResolvers: Array<() => void> = [];
    (activeWindow as unknown as SchedulerWindow).scheduler = {
        yield: () => new Promise<void>(resolve => yieldResolvers.push(resolve)),
    };

    Platform.isMobile = false;
    Platform.isDesktop = true;

    let computeCalls = 0;
    let reindexCalls = 0;
    let inventoryCalls = 0;
    let activeInventory = 0;
    let maxConcurrentInventory = 0;
    const appendErrorIfCurrent = vi.fn();

    const plugin = Object.create(SeekPlugin.prototype) as Record<string, unknown> & { runCatchUp(): void };
    Object.assign(plugin, {
        catchUpPending: true,
        catchUpRunning: false,
        searchActiveTimestamp: null,
        queryInFlightCount: 0,
        persistCacheRestoredThisBoot: true,
        catchUpJob: null,
        loadGeneration: 1,
        settings: { catchUpBurstMaxFiles: 30 },
        indexInventoryFiles: 0,
        indexableNoteCount: () => 0,
        unloading: false,
        scheduleStartupCatchUp: vi.fn(),
        embedder: { loaded: true },
        // runCatchUp's compute/reindex wrappers touch Settings delta overlay + dirtyQueue.
        // `schedulers` is a prototype getter — set the lazy backing field the getter reads.
        indexDelta: new IndexDeltaTracker(),
        _schedulers: {
            dirtyQueue: new Set<string>(),
            isExclusionAligning: () => false,
        },
        notifyIndexActivityChanged: vi.fn(),
        orchestrator: {
            computeDelta: async () => {
                computeCalls++;
                return { dirty: ['stuck.md'], deleted: [] };
            },
            reindexDelta: async () => {
                reindexCalls++;
                return { embedded: {}, deferredEmbed: 0, committedPaths: [] };
            },
        },
        isSessionWorkCurrent: () => true,
        pushTaskContext: vi.fn(),
        popTaskContext: vi.fn(),
        syncWarmDeferred: vi.fn(),
        syncCatchUpJob: vi.fn(),
        appendErrorIfCurrent,
        finishCatchUpJob: vi.fn(),
        clearExclusionChange: vi.fn(),
        runStartupWarm: vi.fn(),
        indexProgress: { refreshIdle: vi.fn(), pauseElapsed: vi.fn(), resumeElapsed: vi.fn() },
        touchIndexInventory: () => {
            inventoryCalls++;
            activeInventory++;
            maxConcurrentInventory = Math.max(maxConcurrentInventory, activeInventory);
            // Keep the read pending: a self-retry would stack another inventory read
            // on top of it, exactly as the Chromium transaction dump showed.
            return new Promise<void>(() => {});
        },
    });

    return {
        plugin,
        yieldResolvers,
        computeCalls: () => computeCalls,
        reindexCalls: () => reindexCalls,
        inventoryCalls: () => inventoryCalls,
        maxConcurrentInventory: () => maxConcurrentInventory,
        appendErrorIfCurrent,
    };
}

beforeEach(() => {
    let ls: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => (k in ls ? ls[k] : null),
        setItem: (k: string, v: string) => { ls[k] = String(v); },
        removeItem: (k: string) => { delete ls[k]; },
        clear: () => { ls = {}; },
    });
});

afterEach(() => {
    delete (globalThis as unknown as { activeDocument?: unknown }).activeDocument;
    delete (activeWindow as unknown as SchedulerWindow).scheduler;
    Platform.isMobile = false;
    Platform.isDesktop = true;
    setEnergySaver(false);
    vi.restoreAllMocks();
});

describe('runCatchUp pending-work scheduling', () => {
    it('waits for an external trigger after a no-progress drain', async () => {
        const h = makeHarness(false);
        h.plugin.runCatchUp();
        await flushMicrotasks();

        expect(h.appendErrorIfCurrent).not.toHaveBeenCalled();
        expect(h.computeCalls()).toBe(1);
        expect(h.reindexCalls()).toBe(1);
        expect(h.inventoryCalls()).toBe(1);

        // Current production queues another run through CompositorPacer. Let that
        // continuation fire if it exists; hardened code must not have queued it.
        h.yieldResolvers.shift()?.();
        await flushMicrotasks();

        expect.soft(h.computeCalls()).toBe(1);
        expect.soft(h.reindexCalls()).toBe(1);
        expect.soft(h.inventoryCalls()).toBe(1);
        expect.soft(h.maxConcurrentInventory()).toBe(1);
    });

    it('drains while desktop is hidden instead of treating visibility as a mobile pause', async () => {
        const h = makeHarness(true);
        h.plugin.runCatchUp();
        await flushMicrotasks();

        expect(h.appendErrorIfCurrent).not.toHaveBeenCalled();
        expect(h.computeCalls()).toBe(1);
        expect(h.reindexCalls()).toBe(1);
        expect(h.inventoryCalls()).toBe(1);
    });

    it('does not drain while hidden when energy saver is on', async () => {
        setEnergySaver(true);
        try {
            const h = makeHarness(true);
            h.plugin.runCatchUp();
            await flushMicrotasks();
            expect(h.computeCalls()).toBe(0);
            expect(h.reindexCalls()).toBe(0);
        } finally {
            setEnergySaver(false);
        }
    });
});

describe('applyPostBootIndexScheduling coverage resume', () => {
    function bootHarness(over: Record<string, unknown> = {}) {
        Platform.isMobile = false;
        Platform.isDesktop = true;
        const scheduleIndexBuild = vi.fn();
        const plugin = Object.create(SeekPlugin.prototype) as Record<string, unknown> & {
            applyPostBootIndexScheduling(): void;
        };
        Object.assign(plugin, {
            unloading: false,
            waitingForSidecar: false,
            sidecarHydrating: false,
            indexBootDecisionPending: false,
            indexDropRecovering: false,
            settings: { sidecarEnabled: false },
            indexInventoryChunks: 450,
            indexInventoryFiles: 123,
            catchUpPending: false,
            catchUpRunning: false,
            fullReindexInFlight: false,
            indexProgressWalk: { snapshot: () => null, clear() {} },
            indexableNoteCount: () => 4864,
            scheduleIndexBuild,
            refreshIndexStatusBar: vi.fn(),
            ...over,
        });
        Object.defineProperty(plugin, 'isIndexing', { configurable: true, get: () => false });
        return { plugin, scheduleIndexBuild };
    }

    it('schedules catch-up when FileRecords cover only a slice of the vault', () => {
        const h = bootHarness();
        h.plugin.applyPostBootIndexScheduling();
        expect(h.scheduleIndexBuild).toHaveBeenCalledWith('catchup');
    });

    it('does not stack catch-up while hydrate is still in flight', () => {
        const h = bootHarness({ sidecarHydrating: true });
        h.plugin.applyPostBootIndexScheduling();
        expect(h.scheduleIndexBuild).not.toHaveBeenCalled();
    });

    it('aborts leftover 1/1 hydrate then schedules catch-up', () => {
        const abortInflightSessionWork = vi.fn(function (this: Record<string, unknown>) {
            this.sidecarHydrating = false;
            this.indexProgressWalk = { snapshot: () => null, clear() {} };
        });
        const h = bootHarness({
            sidecarHydrating: true,
            indexProgressWalk: { snapshot: () => ({ done: 1, total: 1 }), clear() {} },
            abortInflightSessionWork,
        });
        h.plugin.applyPostBootIndexScheduling();
        expect(abortInflightSessionWork).toHaveBeenCalledWith('stale-hydrate');
        expect(h.scheduleIndexBuild).toHaveBeenCalledWith('catchup');
    });
});
