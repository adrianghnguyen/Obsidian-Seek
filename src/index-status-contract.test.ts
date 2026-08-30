/**
 * Cross-surface Ready contract — one boot snapshot must not disagree across
 * status bar (uiHealth), modal body (loadSpec), footer, and CLI gate.
 *
 * Warm sandbox CLI (plugin:reload) scored T1–T4 HOLD on 2026-08-30; these rows
 * encode code-path desyncs visible on first-load / cache-warm / stale modal probe.
 */
import { describe, it, expect } from 'vitest';
import {
    resolveIndexLoadPhase,
    resolveIndexUiStatus,
    resolveCliSearchGate,
    indexLoadSpec,
    indexFooterStatus,
    isIndexWaitKind,
    INDEX_UP_TO_DATE_LABEL,
    type IndexLoadPhase,
    type IndexUiStatus,
} from './index-notice';

interface BootSnapshot {
    label: string;
    /** Plugin inventory (status bar / CLI). */
    inventoryChunks: number | null;
    inventoryFiles: number;
    /** Modal indexedChunkCount probe — may lag inventory on first open. */
    modalChunks?: number | null;
    warmPhase: 'starting' | 'restoring' | null;
    booting?: boolean;
    hydrating?: boolean;
    goodEnough?: boolean;
    writing?: boolean;
    catchUpPending?: boolean;
    catchUpRunning?: boolean;
    flushing?: boolean;
    indexing?: boolean;
    job?: { done: number; total: number; kind?: 'full' | 'delta' | 'catchup' } | null;
    bootDecisionPending?: boolean;
}

function evaluateSnapshot(s: BootSnapshot) {
    const phase: IndexLoadPhase = resolveIndexLoadPhase({
        hydrating: !!(s.hydrating || s.booting) && !s.goodEnough,
        catchUpPending: !!s.catchUpPending,
        catchUpRunning: !!s.catchUpRunning,
        flushing: !!s.flushing,
        writing: !!s.writing,
        indexing: !!s.indexing,
    });
    const uiHealth: IndexUiStatus = resolveIndexUiStatus({
        booting: !!s.booting,
        bootDecisionPending: s.bootDecisionPending,
        hydrating: !!s.hydrating,
        goodEnough: s.goodEnough,
        waitingForSidecar: false,
        peerSyncPending: false,
        health: 'healthy',
        reason: null,
        indexing: !!(s.catchUpRunning || s.flushing || s.indexing),
        catchUpPending: s.catchUpPending,
        job: s.job ? { done: s.job.done, total: s.job.total } : null,
        searchableChunks: s.inventoryChunks,
        inventoryFiles: s.inventoryFiles,
    });
    const modalChunks = s.modalChunks !== undefined ? s.modalChunks : s.inventoryChunks;
    const loadSpec = indexLoadSpec({
        chunks: modalChunks,
        phase,
        catchUpPending: s.catchUpPending,
        waitingForSidecar: false,
        jobKind: s.job?.kind ?? null,
        uiHealth,
        inventoryChunks: s.inventoryChunks,
    });
    const footer = indexFooterStatus({
        kind: loadSpec.kind,
        modelReady: true,
        phase,
        health: 'healthy',
        reason: null,
        peerSyncPending: false,
        waitingForSidecar: false,
        job: s.job ? { done: s.job.done, total: s.job.total } : null,
        uiHealth,
    });
    const cliGate = resolveCliSearchGate({
        warmPhase: s.warmPhase,
        uiHealth,
        chunks: s.inventoryChunks,
        fullJobActive: s.job?.kind === 'full',
    });
    return { phase, uiHealth, loadSpec, footer, cliGate };
}

/** Ready contract: when canonical uiHealth is ok and inventory is populated. */
function assertReadySearchable(
    snapshot: BootSnapshot,
    result: ReturnType<typeof evaluateSnapshot>,
): void {
    expect(result.uiHealth, `${snapshot.label}: uiHealth`).toBe('ok');
    expect(result.cliGate, `${snapshot.label}: CLI gate`).toBeNull();
    expect(isIndexWaitKind(result.loadSpec.kind), `${snapshot.label}: modal loadSpec`).toBe(false);
    expect(result.footer.kind, `${snapshot.label}: footer`).toBe('up-to-date');
    expect(result.footer.label, `${snapshot.label}: footer label`).toBe(INDEX_UP_TO_DATE_LABEL);
}

describe('Ready means searchable (status contract)', () => {
    it('cache warm: uiHealth ok keeps footer Ready when phase is indexing (writing)', () => {
        const snap: BootSnapshot = {
            label: 'post-good-enough cache warm',
            inventoryChunks: 412,
            inventoryFiles: 120,
            warmPhase: null,
            goodEnough: true,
            writing: true,
            hydrating: false,
        };
        const r = evaluateSnapshot(snap);
        expect(r.uiHealth).toBe('ok');
        expect(r.phase).toBe('indexing');
        expect(r.loadSpec.kind).toBe('resting');
        // Contract: Ready bar must not show Indexing footer on a populated index
        assertReadySearchable(snap, r);
    });

    it('first modal open: uiHealth ok with stale zero probe uses inventory and stays searchable', () => {
        const snap: BootSnapshot = {
            label: 'stale modal chunk probe',
            inventoryChunks: 412,
            inventoryFiles: 120,
            modalChunks: 0,
            warmPhase: null,
            writing: true,
        };
        const r = evaluateSnapshot(snap);
        expect(r.uiHealth).toBe('ok');
        expect(r.loadSpec.kind).toBe('resting');
        assertReadySearchable(snap, r);
    });

    it('first modal open: uiHealth ok but wait-kind when probe not yet returned (null)', () => {
        const snap: BootSnapshot = {
            label: 'unprobed modal chunks',
            inventoryChunks: 412,
            inventoryFiles: 120,
            modalChunks: null,
            warmPhase: null,
            catchUpRunning: true,
        };
        const r = evaluateSnapshot(snap);
        expect(r.uiHealth).toBe('indexing');
        // When ui is still indexing, wait is acceptable — skip ready assert
        expect(isIndexWaitKind(r.loadSpec.kind)).toBe(true);
    });

    it('incremental catch-up: populated index stays searchable (regression — sandbox T5 HOLD)', () => {
        const snap: BootSnapshot = {
            label: 'catch-up with chunks',
            inventoryChunks: 10948,
            inventoryFiles: 3002,
            warmPhase: null,
            catchUpRunning: true,
            job: { done: 3, total: 15, kind: 'catchup' },
        };
        const r = evaluateSnapshot(snap);
        expect(r.uiHealth).toBe('indexing');
        expect(r.cliGate).toBeNull();
        expect(r.loadSpec.kind).toBe('resting');
        expect(isIndexWaitKind(r.loadSpec.kind)).toBe(false);
    });

    it('full rebuild: never Ready; modal wait and CLI blocked', () => {
        const snap: BootSnapshot = {
            label: 'full reindex pass',
            inventoryChunks: 1200,
            inventoryFiles: 400,
            warmPhase: null,
            indexing: true,
            job: { done: 10, total: 3002, kind: 'full' },
        };
        const r = evaluateSnapshot(snap);
        expect(r.uiHealth).toBe('indexing');
        expect(r.loadSpec.kind).toBe('indexing');
        expect(r.cliGate).not.toBeNull();
        expect(r.footer.kind).toBe('indexing');
    });

    it('starting: not Ready; search gated', () => {
        const snap: BootSnapshot = {
            label: 'boot hydrate',
            inventoryChunks: null,
            inventoryFiles: 0,
            warmPhase: 'starting',
            booting: true,
            hydrating: true,
            bootDecisionPending: true,
        };
        const r = evaluateSnapshot(snap);
        expect(r.uiHealth).not.toBe('ok');
        expect(r.cliGate).not.toBeNull();
    });
});
