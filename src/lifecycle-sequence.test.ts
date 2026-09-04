import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import SeekPlugin from './main';
import { IndexStore } from './index-store';
import { SearchOrchestrator } from './search';
import { LocalEmbedder } from './embedder';
import { SeekLogger } from './logger';
import { Forensics } from './forensics';
import * as typesModule from './types';
import { scheduleAfterLayoutReadyBuffered } from './layout-ready';
import { App } from 'obsidian';

async function flushPromises(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

function makeMockStorage(): Storage {
    const map = new Map<string, string>();
    return {
        getItem: vi.fn((k: string) => map.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => { map.set(k, String(v)); }),
        removeItem: vi.fn((k: string) => { map.delete(k); }),
        clear: vi.fn(() => { map.clear(); }),
        key: vi.fn((i: number) => Array.from(map.keys())[i] ?? null),
        get length() { return map.size; },
    } as unknown as Storage;
}

interface TestHarness {
    plugin: SeekPlugin;
    app: App;
    mockVault: {
        adapter: Record<string, unknown>;
        getName: ReturnType<typeof vi.fn>;
        getMarkdownFiles: ReturnType<typeof vi.fn>;
        getFiles: ReturnType<typeof vi.fn>;
        getAbstractFileByPath: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
    };
    mockWorkspace: {
        getActiveFile: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        onLayoutReady: ReturnType<typeof vi.fn>;
    };
    mockDoc: {
        addEventListener: ReturnType<typeof vi.fn>;
        removeEventListener: ReturnType<typeof vi.fn>;
        visibilityState: string;
    };
    triggerLayoutReady: () => void;
}

function createHarness(): TestHarness {
    const layoutReadyCallbacks: Array<() => void> = [];
    let layoutIsReady = false;

    const mockAdapter = {
        list: vi.fn(async () => ({ files: [], folders: [] })),
        exists: vi.fn(async () => false),
        read: vi.fn(async () => ''),
        write: vi.fn(async () => {}),
        append: vi.fn(async () => {}),
        rename: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        stat: vi.fn(async () => null),
        mkdir: vi.fn(async () => {}),
    };

    const mockVault = {
        adapter: mockAdapter,
        getName: vi.fn().mockReturnValue('test-vault'),
        getMarkdownFiles: vi.fn().mockReturnValue([]),
        getFiles: vi.fn().mockReturnValue([]),
        getAbstractFileByPath: vi.fn().mockReturnValue(null),
        on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => ({ event, callback })),
    };

    const mockWorkspace = {
        getActiveFile: vi.fn().mockReturnValue(null),
        on: vi.fn((event: string, callback: (...args: unknown[]) => unknown) => ({ event, callback })),
        onLayoutReady: vi.fn((cb: () => void) => {
            if (layoutIsReady) {
                cb();
            } else {
                layoutReadyCallbacks.push(cb);
            }
        }),
    };

    const mockMetadataCache = {
        isUserIgnored: vi.fn().mockReturnValue(false),
        getFileCache: vi.fn().mockReturnValue(null),
    };

    const app = new App();
    Object.assign(app, {
        vault: mockVault,
        workspace: mockWorkspace,
        metadataCache: mockMetadataCache,
        appId: 'test-app-id',
    });

    const mockDoc = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        visibilityState: 'visible',
    };
    (globalThis as unknown as { activeDocument: unknown }).activeDocument = mockDoc;

    const manifest = {
        id: 'seek',
        name: 'Seek',
        version: '1.4.0',
        minAppVersion: '1.0.0',
        author: 'Seek Team',
        description: 'Hybrid search',
        dir: '.obsidian/plugins/seek',
    };
    const plugin = new SeekPlugin(app, manifest as unknown as import('obsidian').PluginManifest);

    return {
        plugin,
        app,
        mockVault,
        mockWorkspace,
        mockDoc,
        triggerLayoutReady: () => {
            layoutIsReady = true;
            while (layoutReadyCallbacks.length > 0) {
                const cb = layoutReadyCallbacks.shift();
                cb?.();
            }
        },
    };
}

describe('Lifecycle Sequence & Ordering Verification', () => {
    let mockStorage: Storage;
    let windowAddEventListenerSpy: ReturnType<typeof vi.spyOn>;
    let windowRemoveEventListenerSpy: ReturnType<typeof vi.spyOn>;
    let mockObserverDisconnect: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        (globalThis as unknown as { __BUILD_TS__: string }).__BUILD_TS__ = '2026-09-03T00:00:00Z';

        mockStorage = makeMockStorage();
        vi.stubGlobal('localStorage', mockStorage);
        (window as unknown as { localStorage: Storage }).localStorage = mockStorage;

        mockObserverDisconnect = vi.fn();
        class MockPerformanceObserver {
            observe = vi.fn();
            disconnect = mockObserverDisconnect;
        }
        (window as unknown as { PerformanceObserver: unknown }).PerformanceObserver = MockPerformanceObserver;

        const addListener = vi.fn();
        const removeListener = vi.fn();
        (window as unknown as { addEventListener: unknown }).addEventListener = addListener;
        (window as unknown as { removeEventListener: unknown }).removeEventListener = removeListener;
        windowAddEventListenerSpy = vi.spyOn(window, 'addEventListener');
        windowRemoveEventListenerSpy = vi.spyOn(window, 'removeEventListener');

        (navigator as unknown as { storage?: unknown }).storage = {
            estimate: vi.fn().mockResolvedValue({ usage: 1000, quota: 10000 }),
            persisted: vi.fn().mockResolvedValue(true),
            persist: vi.fn().mockResolvedValue(true),
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    describe('Phase 1: Startup (onload)', () => {
        it('initializes SeekLogger and executes maintenance tasks', async () => {
            const h = createHarness();
            const migrateRootFilesSpy = vi.spyOn(SeekLogger.prototype, 'migrateRootFiles');
            const rotateIfOversizeSpy = vi.spyOn(SeekLogger.prototype, 'rotateIfOversize');
            const pruneOrphanLogsSpy = vi.spyOn(SeekLogger.prototype, 'pruneOrphanLogs');

            await h.plugin.onload();
            await flushPromises();

            expect(h.plugin['logger']).toBeInstanceOf(SeekLogger);
            expect(migrateRootFilesSpy).toHaveBeenCalledTimes(1);
            expect(rotateIfOversizeSpy).toHaveBeenCalledTimes(1);
            expect(pruneOrphanLogsSpy).toHaveBeenCalledTimes(1);
        });

        it('loads and migrates persisted settings', async () => {
            const h = createHarness();
            const rawSettings = { settingsRev: 1, denseWeight: 0.8 };
            vi.spyOn(h.plugin, 'loadData').mockResolvedValue(rawSettings);
            const saveDataSpy = vi.spyOn(h.plugin, 'saveData');
            const migrateSettingsSpy = vi.spyOn(typesModule, 'migrateSettings');

            await h.plugin.onload();

            expect(h.plugin.loadData).toHaveBeenCalledTimes(1);
            expect(migrateSettingsSpy).toHaveBeenCalledWith(rawSettings);
            // After migrateSettings, settingsRev is bumped to >= 5
            expect(h.plugin.settings.settingsRev).toBeGreaterThanOrEqual(5);
            expect(saveDataSpy).toHaveBeenCalledWith(h.plugin.settings);
        });

        it('configures IndexStore with appId, but NEVER opens IndexStore during onload', async () => {
            const h = createHarness();
            const configureSpy = vi.spyOn(IndexStore.prototype, 'configure');
            const storeOpenSpy = vi.spyOn(IndexStore.prototype, 'open');
            const idbOpenSpy = vi.spyOn(window.indexedDB, 'open');

            await h.plugin.onload();

            // IndexStore.configure(appId, 'seek-index') is called
            expect(configureSpy).toHaveBeenCalledTimes(1);
            expect(configureSpy).toHaveBeenCalledWith('test-app-id', 'seek-index');

            // CRITICAL INVARIANT: store.open() and indexedDB.open are NEVER called during onload
            expect(storeOpenSpy).toHaveBeenCalledTimes(0);
            expect(idbOpenSpy).toHaveBeenCalledTimes(0);
            expect(h.plugin['store'].isOpen()).toBe(false);
        });

        it('instantiates SearchOrchestrator with store and settings references', async () => {
            const h = createHarness();
            await h.plugin.onload();

            const orchestrator = h.plugin['orchestrator'];
            expect(orchestrator).toBeInstanceOf(SearchOrchestrator);
            // SearchOrchestrator references the same IndexStore and SeekSettings instances
            expect(orchestrator['store']).toBe(h.plugin['store']);
            expect(orchestrator['settings']).toBe(h.plugin.settings);
        });

        it('registers command palette, protocol handler, and file change/vault events', async () => {
            const h = createHarness();
            const addCommandSpy = vi.spyOn(h.plugin, 'addCommand');
            const registerProtocolSpy = vi.spyOn(h.plugin, 'registerObsidianProtocolHandler');

            await h.plugin.onload();

            // Command palette: seek:search (internal id: 'search')
            const commandIds = addCommandSpy.mock.calls.map(c => (c[0] as { id: string }).id);
            expect(commandIds).toContain('search');

            // Protocol handler: obsidian://seek
            expect(registerProtocolSpy).toHaveBeenCalledWith('seek', expect.any(Function));

            // Vault events: create, delete, rename registered
            const vaultEvents = h.mockVault.on.mock.calls.map(c => c[0]);
            expect(vaultEvents).toContain('create');
            expect(vaultEvents).toContain('delete');
            expect(vaultEvents).toContain('rename');

            // Workspace active-leaf-change registered for file navigation & debounced modification detection
            const workspaceEvents = h.mockWorkspace.on.mock.calls.map(c => c[0]);
            expect(workspaceEvents).toContain('active-leaf-change');
        });

        it('invokes LocalEmbedder.init() asynchronously without blocking onload completion', async () => {
            const h = createHarness();
            let resolveInit!: (val: { iframeReady: boolean }) => void;
            const initPromise = new Promise<{ iframeReady: boolean }>((resolve) => {
                resolveInit = resolve;
            });

            const initSpy = vi.spyOn(LocalEmbedder.prototype, 'init').mockReturnValue(initPromise as never);

            let onloadFinished = false;
            const onloadPromise = h.plugin.onload().then(() => {
                onloadFinished = true;
            });

            // Awaiting microtasks: onload() should complete even though initPromise is still pending
            await onloadPromise;
            expect(onloadFinished).toBe(true);
            expect(initSpy).toHaveBeenCalledTimes(1);

            // Clean up by resolving the pending embedder init promise
            resolveInit({ iframeReady: true });
            await Promise.resolve();
        });
    });

    describe('Phase 2: Layout Ready Gate (onLayoutReady)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('waits for boot buffer delay before touching IndexedDB, then opens store and reconciles', async () => {
            const h = createHarness();
            const storeOpenSpy = vi.spyOn(IndexStore.prototype, 'open');
            const ensureModelLoadedSpy = vi.spyOn(h.plugin as unknown as { ensureModelLoaded: () => Promise<void> }, 'ensureModelLoaded');
            const reconcileSpy = vi.spyOn(h.plugin as unknown as { reconcileOnLoad: () => Promise<boolean> }, 'reconcileOnLoad');

            await h.plugin.onload();

            // At this point onLayoutReady callback is registered, but layout has not fired
            expect(storeOpenSpy).toHaveBeenCalledTimes(0);
            expect(h.plugin['store'].isOpen()).toBe(false);

            // app.workspace.onLayoutReady() fires
            h.triggerLayoutReady();

            // During the boot buffer delay (e.g. at 1000ms / 1500ms): store.open() MUST NOT be called yet
            vi.advanceTimersByTime(1500);
            expect(storeOpenSpy).toHaveBeenCalledTimes(0);
            expect(h.plugin['store'].isOpen()).toBe(false);

            // Once the full POST_LAYOUT_BOOT_BUFFER_MS (3500ms) expires:
            // advance by remaining time past buffer (2500ms more -> 4000ms total)
            await vi.advanceTimersByTimeAsync(2500);
            await flushPromises();

            // Now store.open() should have been called and store is open
            expect(storeOpenSpy).toHaveBeenCalled();
            expect(h.plugin['store'].isOpen()).toBe(true);

            // reconcileOnLoad executes to inspect peer sidecars and verify index identity
            expect(reconcileSpy).toHaveBeenCalled();

            // CRUCIAL INVARIANT: ensureModelLoaded() is NEVER called during boot (lazy model loading guarantee)
            expect(ensureModelLoadedSpy).toHaveBeenCalledTimes(0);
        });

        it('arms periodic reconcile interval during startup', async () => {
            const h = createHarness();
            const registerIntervalSpy = vi.spyOn(h.plugin, 'registerInterval');
            const setIntervalSpy = vi.spyOn(window, 'setInterval');

            await h.plugin.onload();

            // Periodic reconcile timer is armed for 5 minutes (300,000ms)
            expect(registerIntervalSpy).toHaveBeenCalled();
            expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
        });

        it('allows bypassing the layout ready boot buffer immediately via search trigger', async () => {
            const h = createHarness();
            const storeOpenSpy = vi.spyOn(IndexStore.prototype, 'open');

            await h.plugin.onload();
            h.triggerLayoutReady();

            expect(storeOpenSpy).toHaveBeenCalledTimes(0);

            // User triggers search immediately -> bootBuffer.bypass() is invoked
            const buffer = h.plugin['bootBuffer'];
            expect(buffer).not.toBeNull();
            buffer?.bypass();

            await vi.advanceTimersByTimeAsync(50);
            await flushPromises();

            expect(storeOpenSpy).toHaveBeenCalled();
            expect(h.plugin['store'].isOpen()).toBe(true);
        });
    });

    describe('Phase 3: Teardown (onunload)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('executes teardown sequence in strict order of operations', async () => {
            const h = createHarness();
            await h.plugin.onload();
            h.triggerLayoutReady();
            await vi.advanceTimersByTimeAsync(4000);
            await flushPromises();

            const executionOrder: string[] = [];

            // 1 & 2: loadGeneration++ and unloading = true, then bootBuffer.cancel()
            const initialGen = h.plugin['loadGeneration'];
            const mockBuffer = {
                cancel: vi.fn(() => {
                    expect(h.plugin['unloading']).toBe(true);
                    expect(h.plugin['loadGeneration']).toBe(initialGen + 1);
                    executionOrder.push('bootBuffer.cancel');
                }),
                bypass: vi.fn(),
            };
            h.plugin['bootBuffer'] = mockBuffer;

            // 3: forensics.markCleanEnd()
            const forensics = h.plugin['forensics'];
            expect(forensics).not.toBeNull();
            vi.spyOn(forensics!, 'markCleanEnd').mockImplementation(() => {
                executionOrder.push('forensics.markCleanEnd');
            });

            // 4: embedder.teardown()
            const embedder = h.plugin['embedder'];
            vi.spyOn(embedder, 'teardown').mockImplementation(() => {
                executionOrder.push('embedder.teardown');
            });

            // 5: orchestrator.dispose()
            const orchestrator = h.plugin['orchestrator'];
            expect(orchestrator).not.toBeNull();
            vi.spyOn(orchestrator, 'dispose').mockImplementation(() => {
                executionOrder.push('orchestrator.dispose');
            });

            // 6: store.close()
            const store = h.plugin['store'];
            vi.spyOn(store, 'close').mockImplementation(() => {
                executionOrder.push('store.close');
            });

            // 7: observers and window/DOM listeners disconnect
            mockObserverDisconnect.mockImplementation(() => {
                executionOrder.push('observer.disconnect');
            });
            windowRemoveEventListenerSpy.mockImplementation((event: string) => {
                executionOrder.push(`window.removeEventListener:${event}`);
            });

            // Trigger onunload
            h.plugin.onunload();

            expect(executionOrder).toEqual([
                'bootBuffer.cancel',
                'forensics.markCleanEnd',
                'embedder.teardown',
                'orchestrator.dispose',
                'store.close',
                'observer.disconnect',
                'window.removeEventListener:error',
                'window.removeEventListener:unhandledrejection',
                'window.removeEventListener:pagehide',
            ]);

            // Final state assertions
            expect(h.plugin['unloading']).toBe(true);
            expect(h.plugin['bootBuffer']).toBeNull();
            expect(h.plugin['longTaskObserver']).toBeNull();
        });

        it('cancels pending boot buffer if onunload is called before layout ready expires', async () => {
            const h = createHarness();
            await h.plugin.onload();

            const storeOpenSpy = vi.spyOn(IndexStore.prototype, 'open');
            const bootBuffer = h.plugin['bootBuffer'];
            expect(bootBuffer).not.toBeNull();
            const cancelSpy = vi.spyOn(bootBuffer!, 'cancel');

            // Onunload called early while boot buffer is still pending
            h.plugin.onunload();

            expect(cancelSpy).toHaveBeenCalledTimes(1);
            expect(h.plugin['unloading']).toBe(true);

            // Advancing timers should NOT trigger startPostLayoutBoot or open store
            h.triggerLayoutReady();
            await vi.advanceTimersByTimeAsync(10000);
            await flushPromises();

            expect(storeOpenSpy).toHaveBeenCalledTimes(0);
            expect(h.plugin['store'].isOpen()).toBe(false);
        });
    });

    describe('Layout Buffer Unit Contract (scheduleAfterLayoutReadyBuffered)', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('delays execution by delayMs after onLayoutReady fires', () => {
            const callbacks: Array<() => void> = [];
            const workspace = {
                onLayoutReady: (cb: () => void) => { callbacks.push(cb); },
            };
            const work = vi.fn();

            scheduleAfterLayoutReadyBuffered(workspace, work, 1500);

            expect(work).not.toHaveBeenCalled();

            // Layout ready fires
            callbacks.forEach(cb => cb());
            expect(work).not.toHaveBeenCalled();

            // Advance by 1499ms
            vi.advanceTimersByTime(1499);
            expect(work).not.toHaveBeenCalled();

            // At 1500ms
            vi.advanceTimersByTime(1);
            expect(work).toHaveBeenCalledTimes(1);
        });

        it('cancel() prevents work from firing even after layout ready and timer advance', () => {
            const callbacks: Array<() => void> = [];
            const workspace = {
                onLayoutReady: (cb: () => void) => { callbacks.push(cb); },
            };
            const work = vi.fn();

            const handle = scheduleAfterLayoutReadyBuffered(workspace, work, 1500);
            callbacks.forEach(cb => cb());

            handle.cancel();
            vi.advanceTimersByTime(5000);

            expect(work).not.toHaveBeenCalled();
        });

        it('bypass() skips remaining delay once layout is ready', () => {
            const callbacks: Array<() => void> = [];
            const workspace = {
                onLayoutReady: (cb: () => void) => { callbacks.push(cb); },
            };
            const work = vi.fn();

            const handle = scheduleAfterLayoutReadyBuffered(workspace, work, 1500);
            callbacks.forEach(cb => cb());

            expect(work).not.toHaveBeenCalled();
            handle.bypass();

            expect(work).toHaveBeenCalledTimes(1);
        });
    });
});
