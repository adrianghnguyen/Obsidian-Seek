import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', async () => {
    const actual = await import('../test-stubs/obsidian');
    class Plugin {}
    class PluginSettingTab {}
    class Setting {}
    class App {}
    return { ...actual, Plugin, PluginSettingTab, Setting, App };
});

import SeekPlugin from '../main';

function recoverHost() {
    return {
        recoverInFlight: false,
        recoverRun: null,
        dropRecoveryInFlight: false,
        fullReindexInFlight: false,
        fullReindexRun: null,
        fullReindexGen: 0,
        catchUpRunning: false,
        catchUpPending: false,
        sidecarHydrating: false,
        indexDropRecovering: false,
        indexIndexingStalled: false,
        indexBootStuck: false,
        indexStoreLocked: false,
        indexStoreWedged: false,
        unloading: false,
        orchestrator: { isWriting: () => false },
        store: { isOpen: () => true, open: vi.fn(async () => {}) },
        abortInflightSessionWork: vi.fn(),
        clearIndexingStalled: vi.fn(),
        attachOrchestrator: vi.fn(),
        resolveSidecarIndexDir: () => 'index',
        retryIndexStoreOpen: vi.fn(async () => {}),
        maybeResumeIncompleteCoverage: vi.fn(),
        scheduleStartupCatchUp: vi.fn(),
        refreshIndexStatusBar: vi.fn(),
        notifyIndexActivityChanged: vi.fn(),
    };
}

describe('recover / resume stacking', () => {
    it('double-click Recover does not start a second recovery', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const plugin = Object.create(SeekPlugin.prototype) as {
            recoverIndexFromSettings(): Promise<void>;
            recoverInFlight: boolean;
            abortInflightSessionWork: ReturnType<typeof vi.fn>;
            retryIndexStoreOpen: ReturnType<typeof vi.fn>;
        };
        Object.assign(plugin, recoverHost());
        plugin.retryIndexStoreOpen = vi.fn(() => gate);

        const first = plugin.recoverIndexFromSettings();
        const second = plugin.recoverIndexFromSettings();
        expect(plugin.recoverInFlight).toBe(true);
        expect(plugin.abortInflightSessionWork).toHaveBeenCalledTimes(1);

        release();
        await first;
        await second;
        expect(plugin.retryIndexStoreOpen).toHaveBeenCalledTimes(1);
        expect(plugin.abortInflightSessionWork).toHaveBeenCalledTimes(1);
        expect(plugin.recoverInFlight).toBe(false);
    });

    it('Resume during active indexing attaches and does not abort the pass', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as {
            reloadSeekFromSettings(): Promise<void>;
            abortInflightSessionWork: ReturnType<typeof vi.fn>;
            retryIndexStoreOpen: ReturnType<typeof vi.fn>;
            maybeResumeIncompleteCoverage: ReturnType<typeof vi.fn>;
        };
        Object.assign(plugin, recoverHost(), { fullReindexInFlight: true });

        await plugin.reloadSeekFromSettings();

        expect(plugin.abortInflightSessionWork).not.toHaveBeenCalled();
        expect(plugin.retryIndexStoreOpen).not.toHaveBeenCalled();
        expect(plugin.maybeResumeIncompleteCoverage).not.toHaveBeenCalled();
    });

    it('Resume during Recovering / Restoring attaches to that job', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as {
            reloadSeekFromSettings(): Promise<void>;
            abortInflightSessionWork: ReturnType<typeof vi.fn>;
            retryIndexStoreOpen: ReturnType<typeof vi.fn>;
        };
        Object.assign(plugin, recoverHost(), { sidecarHydrating: true });

        await plugin.reloadSeekFromSettings();

        expect(plugin.abortInflightSessionWork).not.toHaveBeenCalled();
        expect(plugin.retryIndexStoreOpen).not.toHaveBeenCalled();
    });

    it('Force reset joins a healthy recovery instead of starting a second wipe', async () => {
        const plugin = Object.create(SeekPlugin.prototype) as {
            forceResetIndexFromSettings(): Promise<void>;
            abortInflightSessionWork: ReturnType<typeof vi.fn>;
            forceResetAndReindex: ReturnType<typeof vi.fn>;
        };
        Object.assign(plugin, recoverHost(), {
            recoverInFlight: true,
            forceResetAndReindex: vi.fn(async () => {}),
        });

        await plugin.forceResetIndexFromSettings();

        expect(plugin.abortInflightSessionWork).not.toHaveBeenCalled();
        expect(plugin.forceResetAndReindex).not.toHaveBeenCalled();
    });
});
