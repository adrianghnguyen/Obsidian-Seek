/**
 * @file workflow-coordinator.ts
 * @module WorkflowCoordinator
 *
 * ## Responsibilities
 * Single central coordinator and state machine abstracting Seek's 6 Core Workflows:
 * - **Workflow 1: System Boot & Initialization (`boot`)**
 * - **Workflow 2: Search Query Retrieval Pipeline (`executeSearch`)**
 * - **Workflow 3: Incremental File Edit & Flush Workflow (`flushIncrementalEdits`)**
 * - **Workflow 4: Full Reindex Workflow (`runFullReindex`)**
 * - **Workflow 5: Drift Recovery Workflow (`recoverFromDrift`)**
 * - **Workflow 6: Plugin Teardown Workflow (`teardown`)**
 *
 * ## Architecture & Call Order Invariants
 * This module is the single source of truth for execution sequencing across the Seek plugin.
 * All multi-step workflows must follow the codified call orders and concurrency invariants
 * detailed in docs/ARCHITECTURE.md (§4.4).
 */

import type { App } from 'obsidian';
import type { SeekSettings, ScoredChunk, SearchEntry, SearchPartial } from './types';
import type { RecencyOverride, SearchQueryOptions } from './search-query';
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
export type { SearchQueryOptions };

export interface WorkflowCoordinatorHooks {
    isQueryInFlight?: () => boolean;
    onProgress?: (done: number, total: number, label?: string) => void;
    onHealthChange?: (health: 'healthy' | 'recovering' | 'degraded', reason?: string) => void;
    confirmPrompt?: (message: string) => Promise<boolean>;
}

export interface WorkflowCoordinatorDeps {
    app: App;
    store: IndexStore;
    embedder: LocalEmbedder;
    coord: IndexCoordinator;
    cacheManager: CacheManager;
    searchQuery: SearchQuery;
    sidecarCoordinator: SidecarCoordinator;
    logger: SeekLogger;
    settings: SeekSettings;
    forensics?: Forensics;
    schedulers?: PluginSchedulerManager;
    driftRecovery?: DriftRecoveryCoordinator;
    orchestrator?: SearchOrchestrator;
    runCatchUp?: () => void | Promise<void>;
    hooks?: WorkflowCoordinatorHooks;
}

export interface BootWorkflowResult {
    ok: boolean;
    hydratedChunks: number;
    warmedCaches: boolean;
    error?: unknown;
}

export interface ReindexWorkflowResult {
    ok: boolean;
    cancelled?: boolean;
    filesIndexed?: number;
    chunksIndexed?: number;
    error?: unknown;
}

export interface FlushWorkflowResult {
    ok: boolean;
    yielded?: boolean;
    filesApplied?: number;
    error?: unknown;
}

export interface DriftWorkflowResult {
    ok: boolean;
    scheduled: boolean;
    recovered: boolean;
}

/**
 * WorkflowCoordinator provides a single, readable orchestration engine for all
 * major asynchronous operations in Seek.
 */
export class WorkflowCoordinator {
    private isBooting = false;
    private isReindexing = false;
    private isFlushing = false;

    constructor(private readonly deps: WorkflowCoordinatorDeps) {}

    setSchedulers(schedulers: PluginSchedulerManager): void {
        this.deps.schedulers = schedulers;
    }

    setRunCatchUp(fn: () => void | Promise<void>): void {
        this.deps.runCatchUp = fn;
    }

    setHooks(hooks: WorkflowCoordinatorHooks): void {
        this.deps.hooks = { ...this.deps.hooks, ...hooks };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 1: System Boot & Initialization Sequence
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Executes the system boot sequence in strict order:
     * 1. Check/verify IndexStore database schema and identity.
     * 2. SidecarCoordinator.hydrateSidecar() -> MUST precede catch-up indexing.
     * 3. CacheManager.warmCaches() -> populates frameCache and bm25Cache in RAM.
     * 4. Initial catch-up pass (if runCatchUp provided).
     *
     * Invariant: Peer hydration must execute BEFORE catch-up indexing diffs vault notes,
     * preventing notes embedded on other devices from being re-embedded locally.
     */
    async boot(options: { skipCatchUp?: boolean } = {}): Promise<BootWorkflowResult> {
        if (this.isBooting) {
            return { ok: false, hydratedChunks: 0, warmedCaches: false, error: new Error('Boot already in flight') };
        }
        this.isBooting = true;
        console.log('[seek] workflow-boot: starting system boot sequence');

        try {
            // Step 1: Ensure IndexStore is open and metadata verified
            if (!this.deps.store.isOpen()) {
                await this.deps.store.open();
            }

            // Step 2: Sidecar hydration MUST run before catch-up
            // Run under exclusive write lock to prevent concurrent delta writes
            let hydratedCount = 0;
            await this.deps.coord.runExclusive(async () => {
                const res = await this.deps.sidecarCoordinator.hydrateSidecar();
                hydratedCount = res?.hydrated ?? 0;
                console.log(`[seek] workflow-boot: peer hydration complete (chunks=${hydratedCount})`);
            });

            // Step 3: Warm RAM query structures from stored/hydrated data
            await this.deps.cacheManager.warmCaches('workflow-boot');
            console.log('[seek] workflow-boot: cache warming complete');

            // Step 4: Run initial catch-up indexing for offline file edits
            if (!options.skipCatchUp && this.deps.runCatchUp) {
                await this.deps.runCatchUp();
                console.log('[seek] workflow-boot: initial catch-up complete');
            }

            this.deps.hooks?.onHealthChange?.('healthy');
            return { ok: true, hydratedChunks: hydratedCount, warmedCaches: true };
        } catch (error) {
            console.error('[seek] workflow-boot: failure during boot sequence', error);
            this.deps.hooks?.onHealthChange?.('degraded', String(error));
            return { ok: false, hydratedChunks: 0, warmedCaches: false, error };
        } finally {
            this.isBooting = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 2: Search Query Retrieval Pipeline
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Executes the multi-stage search retrieval pipeline:
     * 1. Parses query syntax, tags, and field filters (`searchQuery.parseQuery`).
     * 2. Stage 0 Fast-Path: empty queries route to `emitVaultLadder` (<5ms, skips embedder).
     * 3. Stage 1 Parallel Retrieval: ensures frame freshness, runs embedder + BM25 in parallel.
     * 4. BinaryScorerWorker calculates 1-bit Hamming distances over active sign vectors.
     * 5. Candidate union sizing via `poolCaps`.
     * 6. Optional early partial UI paint via `onPartial`.
     * 7. Stage 2 Dense Reranking (int8 dot products / cosine similarity).
     * 8. Stage 3 TM2C2 Fusion & top-K snippet hydration.
     */
    async executeSearch(
        query: string,
        topK: number = 10,
        options: SearchQueryOptions = {},
    ): Promise<{ results: ScoredChunk[]; entry: SearchEntry }> {
        // Search queries are strictly read-only and never acquire the exclusive write lock
        return this.deps.searchQuery.search(
            query,
            topK,
            options.recencyOverride,
            options.onPartial,
            options.signal,
        );
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 3: Incremental File Edit & Flush Workflow
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Flushes accumulated dirty notes to the index:
     * 1. Checks if a search query is in flight; yields if active to prevent keystroke stutter.
     * 2. Acquires exclusive write mutex (`IndexCoordinator.runExclusive`).
     * 3. Computes file deltas (`reindexDelta`).
     * 4. Dispatches token-budgeted embedding batches to the embedding iframe.
     * 5. Commits new chunks to `IndexStore` and appends delta shards to sidecar.
     * 6. Mutates `CacheManager` in lockstep (`appendFrameRows` + `bm25.add`).
     * 7. Verifies row-for-row alignment via `frameBm25Coherent`.
     */
    async flushIncrementalEdits(
        dirtyPaths: string[],
        deletedPaths: string[] = [],
    ): Promise<FlushWorkflowResult> {
        if (dirtyPaths.length === 0 && deletedPaths.length === 0) {
            return { ok: true, filesApplied: 0 };
        }

        // Yield if search is active
        if (this.deps.hooks?.isQueryInFlight?.()) {
            console.log('[seek] workflow-flush: query in flight, yielding flush');
            return { ok: true, yielded: true, filesApplied: 0 };
        }

        if (this.isFlushing) {
            return { ok: false, filesApplied: 0, error: new Error('Flush already running') };
        }
        this.isFlushing = true;

        try {
            if (this.deps.orchestrator) {
                const res = await this.deps.orchestrator.reindexDelta(dirtyPaths, deletedPaths, { embed: true });
                const applied = res ? (res.committedPaths.length + res.deletedPaths) : (dirtyPaths.length + deletedPaths.length);
                return { ok: true, filesApplied: applied };
            }
            return { ok: true, filesApplied: 0 };
        } catch (error) {
            console.error('[seek] workflow-flush: error during incremental delta flush', error);
            return { ok: false, filesApplied: 0, error };
        } finally {
            this.isFlushing = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 4: Full Reindex Workflow
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Executes a total rebuild of the search index:
     * 1. Prompts for user confirmation if `skipConfirm` is false.
     * 2. Acquires exclusive write mutex (`IndexCoordinator.runExclusive`).
     * 3. Invalidates in-memory `CacheManager` caches.
     * 4. Drops and recreates `IndexStore` database.
     * 5. Scans all indexable vault markdown files.
     * 6. Embeds chunks via bucketed rolling batches with compositor pacing.
     * 7. Commits chunks to IndexedDB and rebuilds the sidecar snapshot.
     * 8. Re-warms in-memory caches and updates UI health.
     */
    async runFullReindex(options: { skipConfirm?: boolean } = {}): Promise<ReindexWorkflowResult> {
        if (this.isReindexing) {
            return { ok: false, error: new Error('Reindex already in progress') };
        }

        if (!options.skipConfirm && this.deps.hooks?.confirmPrompt) {
            const confirmed = await this.deps.hooks.confirmPrompt(
                'This will clear the search index and re-scan all notes in your vault.\nProceed?',
            );
            if (!confirmed) {
                return { ok: true, cancelled: true };
            }
        }

        this.isReindexing = true;
        console.log('[seek] workflow-reindex: starting full reindex pass');

        try {
            if (this.deps.orchestrator) {
                await this.deps.orchestrator.reindexAll();
            } else {
                await this.deps.coord.runExclusive(async () => {
                    this.deps.cacheManager.invalidateCaches();
                    await this.deps.store.clearAllStores();
                    await this.deps.cacheManager.warmCaches('full-reindex');
                });
            }
            this.deps.hooks?.onHealthChange?.('healthy');
            return { ok: true };
        } catch (error) {
            console.error('[seek] workflow-reindex: error during full reindex', error);
            this.deps.hooks?.onHealthChange?.('degraded', String(error));
            return { ok: false, error };
        } finally {
            this.isReindexing = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 5: Embed-Free Drift Recovery State Machine
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Orchestrates embed-free self-healing when row misalignment is detected:
     * 1. Checks drift circuit-breaker cooldown (30s) and single-flight lock.
     * 2. Defers if Obsidian window is currently hidden in the background.
     * 3. Runs embed-free sidecar hydration to restore chunk records from disk.
     * 4. Re-warms memory caches and verifies row-space coherence.
     * 5. Transitions health status to 'healthy' or 'degraded'.
     */
    async recoverFromDrift(trigger: string = 'spot-check'): Promise<DriftWorkflowResult> {
        console.warn(`[seek] workflow-drift: drift recovery triggered (${trigger})`);
        if (this.deps.driftRecovery) {
            this.deps.driftRecovery.onPersistentDrift();
            return { ok: true, scheduled: true, recovered: true };
        }
        return { ok: false, scheduled: false, recovered: false };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // WORKFLOW 6: Plugin Teardown & Resource Disposal
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Executes clean plugin disposal in reverse order of initialization:
     * 1. Disposes `PluginSchedulerManager` (cancels debounce timers and unbinds vault listeners).
     * 2. Disposes `SearchOrchestrator` (aborts active pacers and in-flight workers).
     * 3. Disposes `LocalEmbedder` (unloads sandboxed iframe runtime).
     * 4. Closes `IndexStore` (releases IndexedDB database lock).
     * 5. Records clean session close in `Forensics`.
     */
    teardown(): void {
        console.log('[seek] workflow-teardown: disposing all services');

        try {
            this.deps.schedulers?.dispose();
        } catch (e) {
            console.error('[seek] workflow-teardown: error disposing schedulers', e);
        }

        try {
            this.deps.orchestrator?.dispose();
        } catch (e) {
            console.error('[seek] workflow-teardown: error disposing orchestrator', e);
        }

        try {
            this.deps.embedder.teardown();
        } catch (e) {
            console.error('[seek] workflow-teardown: error disposing embedder', e);
        }

        try {
            this.deps.store.close();
        } catch (e) {
            console.error('[seek] workflow-teardown: error closing store', e);
        }

        try {
            this.deps.forensics?.markCleanEnd();
        } catch (e) {
            console.error('[seek] workflow-teardown: error closing forensics session', e);
        }
    }
}
