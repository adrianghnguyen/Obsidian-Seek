import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TFile } from 'obsidian';
import {
    PluginSchedulerManager,
    type PluginSchedulerHost,
    isIndexableFile,
    IDLE_FLUSH_MS,
    STRUCT_FLUSH_MS,
    BULK_DELTA_THRESHOLD,
} from './plugin-schedulers';

describe('isIndexableFile', () => {
    it('indexes .md files regardless of indexBases', () => {
        const md = { extension: 'md' } as TFile;
        expect(isIndexableFile(md, false)).toBe(true);
        expect(isIndexableFile(md, true)).toBe(true);
    });

    it('indexes .base files only when indexBases is enabled', () => {
        const base = { extension: 'base' } as TFile;
        expect(isIndexableFile(base, false)).toBe(false);
        expect(isIndexableFile(base, true)).toBe(true);
    });

    it('rejects other extensions', () => {
        const canvas = { extension: 'canvas' } as TFile;
        const pdf = { extension: 'pdf' } as TFile;
        expect(isIndexableFile(canvas, true)).toBe(false);
        expect(isIndexableFile(pdf, true)).toBe(false);
    });
});

describe('PluginSchedulerManager', () => {
    let host: PluginSchedulerHost;
    let schedulers: PluginSchedulerManager;
    let storedFiles: Map<string, { mtimeMs: number }>;

    beforeEach(() => {
        vi.useFakeTimers();
        storedFiles = new Map();

        host = {
            app: {
                workspace: {
                    getActiveFile: vi.fn(() => null),
                    on: vi.fn(() => ({})),
                },
                vault: {
                    on: vi.fn(() => ({})),
                    getAbstractFileByPath: vi.fn((path: string) => {
                        const f = new (TFile as any)();
                        f.path = path;
                        f.stat = { mtime: 1000 };
                        return f;
                    }),
                },
            } as any,
            settings: { indexBases: false } as any,
            orchestrator: {
                computeDelta: vi.fn(async () => ({ dirty: [], deleted: [] })),
                reindexDelta: vi.fn(async () => ({ embedded: { committedFilePaths: ['a.md'], chunksIndexed: 2 }, deferredEmbed: 0 })),
                getExcludedLivePaths: vi.fn(() => ['excluded.md']),
                peerAhead: false,
            } as any,
            embedder: { loaded: true } as any,
            store: {
                getFileRecord: vi.fn(async (path: string) => storedFiles.get(path) ?? null),
            } as any,
            indexProgress: {
                updateFromProgress: vi.fn(),
                hide: vi.fn(),
                refreshIdle: vi.fn(),
            } as any,
            logger: {
                append: vi.fn(async () => {}),
            } as any,
            unloading: false,
            loadGeneration: 1,
            vaultIndexEventsReady: true,
            indexingBlocked: false,
            catchUpPending: false,
            catchUpRunning: false,
            indexBootPending: false,
            sidecarHydrating: false,
            lastModelUseAt: Date.now(),
            settingsTelemetrySink: {
                onFolderCoverageChanged: vi.fn(),
                onSessionTelemetryChanged: vi.fn(),
            },
            isSessionWorkCurrent: vi.fn(() => true),
            pushTaskContext: vi.fn(),
            popTaskContext: vi.fn(),
            ensureModelLoaded: vi.fn(async () => {}),
            beginIndexJob: vi.fn(() => 42),
            refreshIndexStatusBar: vi.fn(),
            touchIndexInventory: vi.fn(async () => {}),
            maybeUnloadEmbedder: vi.fn(),
            appendErrorIfCurrent: vi.fn(),
            runCatchUp: vi.fn(),
            scheduleStartupCatchUp: vi.fn(),
            syncWarmDeferred: vi.fn(),
            syncCatchUpJob: vi.fn(),
            periodicReconcile: vi.fn(async () => {}),
        };

        schedulers = new PluginSchedulerManager(host);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('initializes with empty queues and timers', () => {
        expect(schedulers.dirtyQueue.size).toBe(0);
        expect(schedulers.deletedQueue.size).toBe(0);
        expect(schedulers.idleTimer).toBeNull();
        expect(schedulers.structTimer).toBeNull();
        expect(schedulers.flushing).toBe(false);
        expect(schedulers.hasDeferredWork()).toBe(false);
    });

    describe('enqueueIfDirty', () => {
        it('ignores null or non-indexable files', async () => {
            await schedulers.enqueueIfDirty(null);
            expect(schedulers.dirtyQueue.size).toBe(0);

            const canvas = new (TFile as any)();
            canvas.extension = 'canvas';
            canvas.path = 'test.canvas';
            canvas.stat = { mtime: 2000 };
            await schedulers.enqueueIfDirty(canvas);
            expect(schedulers.dirtyQueue.size).toBe(0);
        });

        it('enqueues a new indexable file not yet in store and arms idle flush', async () => {
            const md = new (TFile as any)();
            md.extension = 'md';
            md.path = 'new.md';
            md.stat = { mtime: 2000 };

            await schedulers.enqueueIfDirty(md);
            expect(schedulers.dirtyQueue.has('new.md')).toBe(true);
            expect(schedulers.idleTimer).not.toBeNull();
            expect(schedulers.hasDeferredWork()).toBe(true);
        });

        it('enqueues when file stat mtime is greater than stored mtime', async () => {
            storedFiles.set('edited.md', { mtimeMs: 1000 });
            const md = new (TFile as any)();
            md.extension = 'md';
            md.path = 'edited.md';
            md.stat = { mtime: 1500 };

            await schedulers.enqueueIfDirty(md);
            expect(schedulers.dirtyQueue.has('edited.md')).toBe(true);
        });

        it('skips enqueue when file mtime has not changed', async () => {
            storedFiles.set('unchanged.md', { mtimeMs: 2000 });
            const md = new (TFile as any)();
            md.extension = 'md';
            md.path = 'unchanged.md';
            md.stat = { mtime: 2000 };

            await schedulers.enqueueIfDirty(md);
            expect(schedulers.dirtyQueue.has('unchanged.md')).toBe(false);
        });
    });

    describe('flush timers', () => {
        it('scheduleFlush debounces with IDLE_FLUSH_MS', () => {
            schedulers.scheduleFlush();
            const timer1 = schedulers.idleTimer;
            expect(timer1).not.toBeNull();

            // Reschedule resets timer
            schedulers.scheduleFlush();
            expect(schedulers.idleTimer).not.toBe(timer1);

            const flushSpy = vi.spyOn(schedulers, 'flushDirty').mockResolvedValue();
            vi.advanceTimersByTime(IDLE_FLUSH_MS);
            expect(flushSpy).toHaveBeenCalled();
            expect(schedulers.idleTimer).toBeNull();
        });

        it('flushStructuralSoon debounces with STRUCT_FLUSH_MS', () => {
            schedulers.flushStructuralSoon();
            expect(schedulers.structTimer).not.toBeNull();

            const flushSpy = vi.spyOn(schedulers, 'flushDirty').mockResolvedValue();
            vi.advanceTimersByTime(STRUCT_FLUSH_MS);
            expect(flushSpy).toHaveBeenCalled();
            expect(schedulers.structTimer).toBeNull();
        });
    });

    describe('flushDirty execution', () => {
        it('no-ops when queues are empty', async () => {
            await schedulers.flushDirty();
            expect(host.orchestrator?.reindexDelta).not.toHaveBeenCalled();
            expect(host.pushTaskContext).not.toHaveBeenCalled();
        });

        it('processes single-note delta and cleans processed items', async () => {
            schedulers.dirtyQueue.add('note1.md');
            schedulers.deletedQueue.add('old.md');

            await schedulers.flushDirty();

            expect(host.pushTaskContext).toHaveBeenCalledWith('indexing');
            expect(host.ensureModelLoaded).toHaveBeenCalled();
            expect(host.orchestrator?.reindexDelta).toHaveBeenCalledWith(
                ['note1.md'],
                ['old.md'],
                expect.any(Object),
            );
            expect(host.popTaskContext).toHaveBeenCalledWith('indexing');
            expect(schedulers.deletedQueue.has('old.md')).toBe(false);
            expect(schedulers.flushing).toBe(false);
        });

        it('handles bulk delta threshold with status bar job', async () => {
            for (let i = 0; i < BULK_DELTA_THRESHOLD + 5; i++) {
                schedulers.dirtyQueue.add(`bulk_${i}.md`);
            }

            await schedulers.flushDirty();

            expect(host.beginIndexJob).toHaveBeenCalledWith('catchup', BULK_DELTA_THRESHOLD + 5, expect.any(String));
            expect(host.indexProgress.hide).toHaveBeenCalledWith(42);
        });

        it('re-arms flush if new edits arrive while already flushing', async () => {
            schedulers.flushing = true;
            schedulers.dirtyQueue.add('inflight.md');

            const scheduleSpy = vi.spyOn(schedulers, 'scheduleFlush');
            await schedulers.flushDirty();

            expect(scheduleSpy).toHaveBeenCalled();
        });
    });

    describe('wireIncrementalIndexing', () => {
        it('registers active-leaf-change, vault events, and window blur', () => {
            const registeredEvents: any[] = [];
            const registerEvent = vi.fn((ref) => registeredEvents.push(ref));
            const registerDomEvent = vi.fn();

            schedulers.wireIncrementalIndexing(registerEvent, registerDomEvent);

            expect(host.app.workspace.on).toHaveBeenCalledWith('active-leaf-change', expect.any(Function));
            expect(host.app.vault.on).toHaveBeenCalledWith('create', expect.any(Function));
            expect(host.app.vault.on).toHaveBeenCalledWith('delete', expect.any(Function));
            expect(host.app.vault.on).toHaveBeenCalledWith('rename', expect.any(Function));
            expect(registerDomEvent).toHaveBeenCalledWith(window, 'blur', expect.any(Function));
        });
    });

    describe('exclusion polling and changes', () => {
        it('seeds baseline on first poll and ignores when no diff', () => {
            expect(schedulers.lastExcludedPaths).toBeNull();
            schedulers.pollExclusionChanges();
            expect(schedulers.lastExcludedPaths).toEqual(['excluded.md']);
            expect(schedulers.exclusionWatcherArmed).toBe(true);
            expect(schedulers.getExclusionChange()).toBeNull();
        });

        it('detects changes on subsequent polls and triggers driveExclusionBackfill', () => {
            schedulers.lastExcludedPaths = ['old-excluded.md'];
            (host.orchestrator?.getExcludedLivePaths as any).mockReturnValue(['new-excluded.md']);

            schedulers.pollExclusionChanges();

            const change = schedulers.getExclusionChange();
            expect(change).not.toBeNull();
            expect(change?.diff.newlyIncludedPaths).toContain('old-excluded.md');
            expect(change?.diff.newlyExcludedPaths).toContain('new-excluded.md');
            expect(host.settingsTelemetrySink?.onFolderCoverageChanged).toHaveBeenCalled();
        });

        it('clears exclusion change and notifies telemetry', () => {
            schedulers.exclusionChange = {
                newlyIncludedPaths: ['a'],
                newlyExcludedPaths: [],
                newlyIncludedFolders: [],
                newlyExcludedFolders: [],
            };
            schedulers.exclusionChangeDetectedAt = 12345;

            schedulers.clearExclusionChange();
            expect(schedulers.getExclusionChange()).toBeNull();
            expect(schedulers.exclusionChangeDetectedAt).toBe(0);
            expect(host.settingsTelemetrySink?.onFolderCoverageChanged).toHaveBeenCalled();
        });
    });

    describe('dispose', () => {
        it('clears timers and queues', () => {
            schedulers.dirtyQueue.add('a.md');
            schedulers.deletedQueue.add('b.md');
            schedulers.scheduleFlush();
            schedulers.flushStructuralSoon();

            expect(schedulers.idleTimer).not.toBeNull();
            expect(schedulers.structTimer).not.toBeNull();

            schedulers.dispose();

            expect(schedulers.idleTimer).toBeNull();
            expect(schedulers.structTimer).toBeNull();
            expect(schedulers.dirtyQueue.size).toBe(0);
            expect(schedulers.deletedQueue.size).toBe(0);
        });
    });
});
