/**
 * @file drift-recovery-coordinator.ts
 * @module DriftRecoveryCoordinator
 *
 * ## Responsibilities
 * Embed-free drift recovery state machine for self-healing the search index:
 * - Detects persistent index drift between memory caches (`frameCache`, `bm25Cache`) and IndexedDB.
 * - Executes an embed-free recovery pass by hydrating existing embeddings from sidecar shards
 *   without burning battery or CPU re-running the embedding model.
 * - Re-warms in-memory caches, verifies row-space coherence, and transitions index health
 *   state (`healthy` -> `recovering` -> `healthy` or `degraded`).
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: Host Lifecycle & Health Recovery Layer. Instantiated in `SeekPlugin.onload()`.
 * - **Triggering**: Triggered by `SearchOrchestrator.onCoherenceDrift()` when row alignment
 *   checks fail repeatedly beyond the circuit-breaker cooldown window.
 * - **Concurrency & Recovery Invariants**:
 *   - **Single-Flight Coalescing**: `running` and `pending` state flags coalesce multiple rapid drift
 *     triggers into a single recovery pass.
 *   - **Generation Gating**: Recovery is suppressed if a pass has already executed on the current
 *     index generation (`lastRecoveryGen === currentGen`) to prevent recursive recovery loops.
 *   - **Window Backgrounding Awareness**: If Obsidian is hidden in the background (`document.hidden`),
 *     execution is deferred until the app gains focus to prevent mobile process freezes.
 */

import type { SearchOrchestrator } from './search';
import { driftRecoveryDecision } from './coherence';

export type DriftIndexHealth = 'healthy' | 'recovering' | 'degraded';

export interface DriftRecoveryDeps {
    getOrchestrator: () => SearchOrchestrator | null;
    getIndexHealth: () => DriftIndexHealth;
    setIndexHealth: (health: DriftIndexHealth) => void;
    setDegradedReason: (reason: 'version' | 'drift' | null) => void;
    isIndexingBlocked: () => boolean;
    isSessionWorkCurrent: (gen: number) => boolean;
    getLoadGeneration: () => number;
    appendErrorIfCurrent: (context: string, e: unknown, gen: number) => void;
    withSidecarHydrate: <T>(fn: () => Promise<T>) => Promise<T>;
    isDocumentHidden?: () => boolean;
}

export class DriftRecoveryCoordinator {
    running = false;
    pending = false;
    lastRecoveryGen = -1;

    constructor(private readonly deps: DriftRecoveryDeps) {}

    onPersistentDrift(): void {
        const orchestrator = this.deps.getOrchestrator();
        if (!orchestrator) return;
        const currentGen = orchestrator.currentGeneration();
        const { schedule } = driftRecoveryDecision({
            running: this.running,
            health: this.deps.getIndexHealth(),
            lastRecoveryGen: this.lastRecoveryGen,
            currentGen,
        });
        if (!schedule) return;
        this.lastRecoveryGen = currentGen;
        this.pending = true;
        this.runDriftRecovery();
    }

    runDriftRecovery(): void {
        const orchestrator = this.deps.getOrchestrator();
        if (!this.pending || this.running || !orchestrator) return;
        const isHidden = this.deps.isDocumentHidden ? this.deps.isDocumentHidden() : (typeof activeDocument !== 'undefined' && activeDocument.hidden);
        if (isHidden || this.deps.isIndexingBlocked()) return;

        this.running = true;
        this.deps.setIndexHealth('recovering');
        const workGen = this.deps.getLoadGeneration();

        void (async () => {
            if (!this.deps.isSessionWorkCurrent(workGen)) {
                this.running = false;
                return;
            }

            let verifiedGen = -1;
            try {
                await this.deps.withSidecarHydrate(() => orchestrator.hydrateSidecar());
                await orchestrator.warmCaches('drift-recovery');
                verifiedGen = orchestrator.currentGeneration();
                const ok = await orchestrator.verifyCoherent();

                if (orchestrator.currentGeneration() !== verifiedGen) {
                    // Concurrent mutation landed during verify and owns the outcome.
                } else {
                    this.commitDriftHealth(ok ? 'healthy' : 'degraded', verifiedGen);
                    if (!ok) {
                        console.error('[seek] drift auto-recovery exhausted (embed-free warm + sidecar reconcile did not re-couple the frame/BM25 row space) — indexHealth=degraded; a full reindex recovers it');
                    }
                }
            } catch (e) {
                if (!this.deps.isSessionWorkCurrent(workGen)) {
                    // torn-down session — defer without logging
                } else if (verifiedGen < 0) {
                    this.commitDriftHealth('degraded', orchestrator.currentGeneration());
                    this.deps.appendErrorIfCurrent('runDriftRecovery', e, workGen);
                } else if (orchestrator.currentGeneration() === verifiedGen) {
                    this.commitDriftHealth('degraded', verifiedGen);
                    this.deps.appendErrorIfCurrent('runDriftRecovery', e, workGen);
                }
            } finally {
                if (this.deps.isSessionWorkCurrent(workGen)) {
                    this.pending = false;
                    this.running = false;
                } else {
                    this.running = false;
                }
            }
        })();
    }

    commitDriftHealth(health: 'healthy' | 'degraded', gen: number): void {
        this.deps.setIndexHealth(health);
        this.deps.setDegradedReason(health === 'degraded' ? 'drift' : null);
        this.lastRecoveryGen = gen;
    }
}
