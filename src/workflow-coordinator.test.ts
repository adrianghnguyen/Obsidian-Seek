import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    WorkflowCoordinator,
    type WorkflowCoordinatorDeps,
    type WorkflowCoordinatorHooks,
    type BootWorkflowResult,
    type FlushWorkflowResult,
    type ReindexWorkflowResult,
    type DriftWorkflowResult,
} from './workflow-coordinator';
import type { App } from 'obsidian';
import type { IndexStore } from './index-store';
import type { IndexCoordinator } from './index-coordinator';
import type { LocalEmbedder } from './embedder';
import type { CacheManager } from './cache-manager';
import type { SearchQuery } from './search-query';
import type { SidecarCoordinator } from './sidecar-coordinator';
import type { PluginSchedulerManager } from './plugin-schedulers';
import type { DriftRecoveryCoordinator } from './drift-recovery-coordinator';
import type { SeekLogger } from './logger';
import type { Forensics } from './forensics';
import type { SearchOrchestrator } from './search';
import type { SeekSettings, ScoredChunk, SearchEntry } from './types';

describe('WorkflowCoordinator: 6 Core Workflows & Call Orders', () => {
    let mockApp: App;
    let mockStore: {
        isOpen: ReturnType<typeof vi.fn>;
        open: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        clearAllStores: ReturnType<typeof vi.fn>;
    };
    let mockCoord: {
        runExclusive: ReturnType<typeof vi.fn>;
    };
    let mockEmbedder: {
        teardown: ReturnType<typeof vi.fn>;
        dispose?: ReturnType<typeof vi.fn>;
    };
    let mockCacheManager: {
        warmCaches: ReturnType<typeof vi.fn>;
        invalidateCaches: ReturnType<typeof vi.fn>;
    };
    let mockSearchQuery: {
        search: ReturnType<typeof vi.fn>;
    };
    let mockSidecarCoordinator: {
        hydrateSidecar: ReturnType<typeof vi.fn>;
    };
    let mockLogger: {
        info: ReturnType<typeof vi.fn>;
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
    };
    let mockForensics: {
        markCleanEnd: ReturnType<typeof vi.fn>;
    };
    let mockSchedulers: {
        dispose: ReturnType<typeof vi.fn>;
        runCatchUp: ReturnType<typeof vi.fn>;
    };
    let mockDriftRecovery: {
        onPersistentDrift: ReturnType<typeof vi.fn>;
    };
    let mockOrchestrator: {
        reindexDelta: ReturnType<typeof vi.fn>;
        reindexAll: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
    };
    let mockRunCatchUp: ReturnType<typeof vi.fn>;
    let mockHooks: WorkflowCoordinatorHooks;
    let deps: WorkflowCoordinatorDeps;
    let coordinator: WorkflowCoordinator;

    beforeEach(() => {
        mockApp = {} as App;
        mockStore = {
            isOpen: vi.fn().mockReturnValue(true),
            open: vi.fn().mockResolvedValue(undefined),
            close: vi.fn(),
            clearAllStores: vi.fn().mockResolvedValue({ chunks: 0, embeddings: 0, binary: 0, files: 0 }),
        };
        mockCoord = {
            runExclusive: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
        };
        mockEmbedder = {
            teardown: vi.fn(),
        };
        mockCacheManager = {
            warmCaches: vi.fn().mockResolvedValue(undefined),
            invalidateCaches: vi.fn(),
        };
        mockSearchQuery = {
            search: vi.fn().mockResolvedValue({
                results: [{ chunk_id: 'c1', note_path: 'Note.md', score: 0.95 }] as ScoredChunk[],
                entry: { totalChunks: 10 } as SearchEntry,
            }),
        };
        mockSidecarCoordinator = {
            hydrateSidecar: vi.fn().mockResolvedValue({ hydrated: 42 }),
        };
        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        };
        mockForensics = {
            markCleanEnd: vi.fn(),
        };
        mockSchedulers = {
            dispose: vi.fn(),
            runCatchUp: vi.fn(),
        };
        mockDriftRecovery = {
            onPersistentDrift: vi.fn(),
        };
        mockOrchestrator = {
            reindexDelta: vi.fn().mockResolvedValue({
                committedPaths: ['Note.md'],
                deletedPaths: 0,
            }),
            reindexAll: vi.fn().mockResolvedValue({ pass: true }),
            dispose: vi.fn(),
        };
        mockRunCatchUp = vi.fn().mockResolvedValue(undefined);
        mockHooks = {
            isQueryInFlight: vi.fn().mockReturnValue(false),
            onHealthChange: vi.fn(),
            confirmPrompt: vi.fn().mockResolvedValue(true),
        };

        deps = {
            app: mockApp,
            store: mockStore as unknown as IndexStore,
            embedder: mockEmbedder as unknown as LocalEmbedder,
            coord: mockCoord as unknown as IndexCoordinator,
            cacheManager: mockCacheManager as unknown as CacheManager,
            searchQuery: mockSearchQuery as unknown as SearchQuery,
            sidecarCoordinator: mockSidecarCoordinator as unknown as SidecarCoordinator,
            logger: mockLogger as unknown as SeekLogger,
            settings: {} as SeekSettings,
            forensics: mockForensics as unknown as Forensics,
            schedulers: mockSchedulers as unknown as PluginSchedulerManager,
            driftRecovery: mockDriftRecovery as unknown as DriftRecoveryCoordinator,
            orchestrator: mockOrchestrator as unknown as SearchOrchestrator,
            runCatchUp: mockRunCatchUp,
            hooks: mockHooks,
        };

        coordinator = new WorkflowCoordinator(deps);
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 1: System Boot & Initialization Sequence
    // ─────────────────────────────────────────────────────────────────────────────
    describe('Workflow 1: boot', () => {
        it('opens the store if not already open', async () => {
            mockStore.isOpen.mockReturnValue(false);
            const result = await coordinator.boot();

            expect(mockStore.open).toHaveBeenCalledTimes(1);
            expect(result.ok).toBe(true);
        });

        it('does not call store.open if already open', async () => {
            mockStore.isOpen.mockReturnValue(true);
            const result = await coordinator.boot();

            expect(mockStore.open).not.toHaveBeenCalled();
            expect(result.ok).toBe(true);
        });

        it('executes in strict order: hydrateSidecar -> warmCaches -> runCatchUp', async () => {
            const callOrder: string[] = [];
            mockSidecarCoordinator.hydrateSidecar.mockImplementation(async () => {
                callOrder.push('hydrateSidecar');
                return { hydrated: 15 };
            });
            mockCacheManager.warmCaches.mockImplementation(async () => {
                callOrder.push('warmCaches');
            });
            mockRunCatchUp.mockImplementation(async () => {
                callOrder.push('runCatchUp');
            });

            const result = await coordinator.boot();

            expect(callOrder).toEqual(['hydrateSidecar', 'warmCaches', 'runCatchUp']);
            expect(result).toEqual({
                ok: true,
                hydratedChunks: 15,
                warmedCaches: true,
            });
            expect(mockHooks.onHealthChange).toHaveBeenCalledWith('healthy');
        });

        it('skips catch-up if skipCatchUp option is set', async () => {
            const result = await coordinator.boot({ skipCatchUp: true });

            expect(mockSidecarCoordinator.hydrateSidecar).toHaveBeenCalledTimes(1);
            expect(mockCacheManager.warmCaches).toHaveBeenCalledTimes(1);
            expect(mockRunCatchUp).not.toHaveBeenCalled();
            expect(result.ok).toBe(true);
        });

        it('guards against concurrent boot executions', async () => {
            let finishFirstBoot!: () => void;
            const bootBlock = new Promise<void>(res => { finishFirstBoot = res; });
            mockCacheManager.warmCaches.mockImplementation(() => bootBlock);

            const first = coordinator.boot();
            const second = coordinator.boot();

            const secondResult = await second;
            expect(secondResult.ok).toBe(false);
            expect(secondResult.error).toEqual(new Error('Boot already in flight'));

            finishFirstBoot();
            const firstResult = await first;
            expect(firstResult.ok).toBe(true);
        });

        it('catches and reports failure during boot sequence', async () => {
            const err = new Error('Database locked');
            mockStore.isOpen.mockReturnValue(false);
            mockStore.open.mockRejectedValue(err);

            const result = await coordinator.boot();

            expect(result.ok).toBe(false);
            expect(result.error).toBe(err);
            expect(mockHooks.onHealthChange).toHaveBeenCalledWith('degraded', 'Error: Database locked');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 2: Search Query Retrieval Pipeline
    // ─────────────────────────────────────────────────────────────────────────────
    describe('Workflow 2: executeSearch', () => {
        it('delegates to searchQuery.search with query, topK, and options', async () => {
            const onPartial = vi.fn();
            const abortCtrl = new AbortController();
            const recencyOverride = { epsilon: 0.1, halfLifeDays: 30 };

            const { results, entry } = await coordinator.executeSearch('test query', 5, {
                recencyOverride,
                onPartial,
                signal: abortCtrl.signal,
            });

            expect(mockSearchQuery.search).toHaveBeenCalledWith(
                'test query',
                5,
                recencyOverride,
                onPartial,
                abortCtrl.signal,
            );
            expect(results).toHaveLength(1);
            expect(results[0].chunk_id).toBe('c1');
            expect(entry.totalChunks).toBe(10);
        });

        it('uses default topK=10 and empty options when omitted', async () => {
            await coordinator.executeSearch('default query');

            expect(mockSearchQuery.search).toHaveBeenCalledWith(
                'default query',
                10,
                undefined,
                undefined,
                undefined,
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 3: Incremental File Edit & Flush Workflow
    // ─────────────────────────────────────────────────────────────────────────────
    describe('Workflow 3: flushIncrementalEdits', () => {
        it('returns early if dirtyPaths and deletedPaths are both empty', async () => {
            const result = await coordinator.flushIncrementalEdits([], []);

            expect(result).toEqual({ ok: true, filesApplied: 0 });
            expect(mockOrchestrator.reindexDelta).not.toHaveBeenCalled();
        });

        it('yields early if search query is in flight', async () => {
            mockHooks.isQueryInFlight = vi.fn().mockReturnValue(true);

            const result = await coordinator.flushIncrementalEdits(['dirty.md']);

            expect(result).toEqual({ ok: true, yielded: true, filesApplied: 0 });
            expect(mockOrchestrator.reindexDelta).not.toHaveBeenCalled();
        });

        it('calls orchestrator.reindexDelta with paths and { embed: true }', async () => {
            mockOrchestrator.reindexDelta.mockResolvedValue({
                committedPaths: ['a.md', 'b.md'],
                deletedPaths: 1,
            });

            const result = await coordinator.flushIncrementalEdits(['a.md', 'b.md'], ['del.md']);

            expect(mockOrchestrator.reindexDelta).toHaveBeenCalledWith(
                ['a.md', 'b.md'],
                ['del.md'],
                { embed: true },
            );
            expect(result).toEqual({ ok: true, filesApplied: 3 });
        });

        it('guards against concurrent flushes', async () => {
            let finishFirstFlush!: () => void;
            const flushBlock = new Promise<{ committedPaths: string[]; deletedPaths: number }>(res => {
                finishFirstFlush = () => res({ committedPaths: ['a.md'], deletedPaths: 0 });
            });
            mockOrchestrator.reindexDelta.mockImplementation(() => flushBlock);

            const first = coordinator.flushIncrementalEdits(['a.md']);
            const second = coordinator.flushIncrementalEdits(['b.md']);

            const secondResult = await second;
            expect(secondResult.ok).toBe(false);
            expect(secondResult.error).toEqual(new Error('Flush already running'));

            finishFirstFlush();
            const firstResult = await first;
            expect(firstResult.ok).toBe(true);
        });

        it('handles exceptions during reindexDelta cleanly', async () => {
            const err = new Error('Disk write failed');
            mockOrchestrator.reindexDelta.mockRejectedValue(err);

            const result = await coordinator.flushIncrementalEdits(['a.md']);

            expect(result.ok).toBe(false);
            expect(result.error).toBe(err);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 4: Full Reindex Workflow
    // ─────────────────────────────────────────────────────────────────────────────
    describe('Workflow 4: runFullReindex', () => {
        it('prompts for confirmation and cancels if user declines', async () => {
            mockHooks.confirmPrompt = vi.fn().mockResolvedValue(false);

            const result = await coordinator.runFullReindex();

            expect(mockHooks.confirmPrompt).toHaveBeenCalled();
            expect(result).toEqual({ ok: true, cancelled: true });
            expect(mockOrchestrator.reindexAll).not.toHaveBeenCalled();
        });

        it('bypasses confirmation prompt when skipConfirm: true', async () => {
            mockHooks.confirmPrompt = vi.fn().mockResolvedValue(false);

            const result = await coordinator.runFullReindex({ skipConfirm: true });

            expect(mockHooks.confirmPrompt).not.toHaveBeenCalled();
            expect(mockOrchestrator.reindexAll).toHaveBeenCalledTimes(1);
            expect(result.ok).toBe(true);
            expect(mockHooks.onHealthChange).toHaveBeenCalledWith('healthy');
        });

        it('executes fallback store clear and cache warming if orchestrator is not provided', async () => {
            const coordWithoutOrch = new WorkflowCoordinator({
                ...deps,
                orchestrator: undefined,
            });

            const result = await coordWithoutOrch.runFullReindex({ skipConfirm: true });

            expect(mockCacheManager.invalidateCaches).toHaveBeenCalledTimes(1);
            expect(mockStore.clearAllStores).toHaveBeenCalledTimes(1);
            expect(mockCacheManager.warmCaches).toHaveBeenCalledWith('full-reindex');
            expect(result.ok).toBe(true);
        });

        it('guards against concurrent reindexes', async () => {
            let finishFirstReindex!: () => void;
            const reindexBlock = new Promise<{ pass: boolean }>(res => {
                finishFirstReindex = () => res({ pass: true });
            });
            mockOrchestrator.reindexAll.mockImplementation(() => reindexBlock);

            const first = coordinator.runFullReindex({ skipConfirm: true });
            const second = coordinator.runFullReindex({ skipConfirm: true });

            const secondResult = await second;
            expect(secondResult.ok).toBe(false);
            expect(secondResult.error).toEqual(new Error('Reindex already in progress'));

            finishFirstReindex();
            const firstResult = await first;
            expect(firstResult.ok).toBe(true);
        });

        it('catches and records errors during full reindex', async () => {
            const err = new Error('Out of memory');
            mockOrchestrator.reindexAll.mockRejectedValue(err);

            const result = await coordinator.runFullReindex({ skipConfirm: true });

            expect(result.ok).toBe(false);
            expect(result.error).toBe(err);
            expect(mockHooks.onHealthChange).toHaveBeenCalledWith('degraded', 'Error: Out of memory');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 5: Embed-Free Drift Recovery State Machine
    // ─────────────────────────────────────────────────────────────────────────────
    describe('Workflow 5: recoverFromDrift', () => {
        it('delegates to driftRecovery.onPersistentDrift when available', async () => {
            const result = await coordinator.recoverFromDrift('spot-check');

            expect(mockDriftRecovery.onPersistentDrift).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ ok: true, scheduled: true, recovered: true });
        });

        it('returns unrecovered if driftRecovery is not provided', async () => {
            const coordWithoutDrift = new WorkflowCoordinator({
                ...deps,
                driftRecovery: undefined,
            });

            const result = await coordWithoutDrift.recoverFromDrift();

            expect(result).toEqual({ ok: false, scheduled: false, recovered: false });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 6: Plugin Teardown & Resource Disposal
    // ─────────────────────────────────────────────────────────────────────────────
    describe('Workflow 6: teardown', () => {
        it('disposes services in proper sequence', () => {
            const disposalOrder: string[] = [];
            mockSchedulers.dispose.mockImplementation(() => disposalOrder.push('schedulers'));
            mockOrchestrator.dispose.mockImplementation(() => disposalOrder.push('orchestrator'));
            mockEmbedder.teardown.mockImplementation(() => disposalOrder.push('embedder'));
            mockStore.close.mockImplementation(() => disposalOrder.push('store'));
            mockForensics.markCleanEnd.mockImplementation(() => disposalOrder.push('forensics'));

            coordinator.teardown();

            expect(disposalOrder).toEqual([
                'schedulers',
                'orchestrator',
                'embedder',
                'store',
                'forensics',
            ]);
        });

        it('continues teardown of subsequent subsystems even if one throws', () => {
            mockSchedulers.dispose.mockImplementation(() => { throw new Error('Timer clear failed'); });
            mockOrchestrator.dispose.mockImplementation(() => { throw new Error('Orchestrator failed'); });

            expect(() => coordinator.teardown()).not.toThrow();

            expect(mockEmbedder.teardown).toHaveBeenCalledTimes(1);
            expect(mockStore.close).toHaveBeenCalledTimes(1);
            expect(mockForensics.markCleanEnd).toHaveBeenCalledTimes(1);
        });
    });
});
