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
        };
        Object.assign(plugin, {
            fullReindexInFlight: false,
            orchestrator: {
                isWriting: () => false,
                invalidateBm25Cache: () => {},
                inspectSidecarFleet: async () => null,
                reindexAll,
            },
            beginIndexJob: () => 1,
            indexableNoteCount: () => 10,
            pushTaskContext: () => {},
            popTaskContext: () => {},
            noteIndexDropped: () => {},
            ensureModelLoaded: () => loadGate,
            indexProgress: { updateFromProgress: () => {}, hide: () => {} },
            notifyIndexActivityChanged: () => {},
            emitStorageSnapshot: async () => {},
            clearIndexDelta: () => {},
            touchIndexInventory: async () => {},
        });

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
