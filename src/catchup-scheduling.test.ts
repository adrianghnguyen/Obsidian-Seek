import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async () => {
    const actual = await import('./test-stubs/obsidian');
    class Plugin {}
    class PluginSettingTab {}
    class Setting {}
    class App {}
    return { ...actual, Plugin, PluginSettingTab, Setting, App };
});

import { Platform } from 'obsidian';
import SeekPlugin from './main';

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
        embedder: { loaded: true },
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
        appendErrorIfCurrent: vi.fn(),
        finishCatchUpJob: vi.fn(),
        clearExclusionChange: vi.fn(),
        runStartupWarm: vi.fn(),
        indexProgress: { refreshIdle: vi.fn() },
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
    };
}

afterEach(() => {
    delete (globalThis as unknown as { activeDocument?: unknown }).activeDocument;
    delete (activeWindow as unknown as SchedulerWindow).scheduler;
    Platform.isMobile = false;
    Platform.isDesktop = true;
    vi.restoreAllMocks();
});

describe('runCatchUp pending-work scheduling', () => {
    it('waits for an external trigger after a no-progress drain', async () => {
        const h = makeHarness(false);
        h.plugin.runCatchUp();
        await flushMicrotasks();

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

        expect(h.computeCalls()).toBe(1);
        expect(h.reindexCalls()).toBe(1);
        expect(h.inventoryCalls()).toBe(1);
    });
});
