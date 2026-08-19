import { describe, it, expect } from 'vitest';
import {
    indexBannerSpec,
    indexLoadSpec,
    resolveIndexLoadPhase,
    resolveCliSearchGate,
    resolveIndexUiStatus,
    resolveSidecarWait,
    retainIndexInventory,
    indexFooterStatus,
    INDEX_STALE_MSG,
    INDEX_SYNCING_MSG,
    INDEX_PEER_AHEAD_MSG,
    INDEX_RESTORING_MSG,
    INDEX_RESTORING_TITLE,
    INDEX_BUILDING_MSG,
    INDEX_BUILDING_TITLE,
    INDEX_STARTING_MSG,
    INDEX_STARTING_TITLE,
    INDEX_STARTING_LABEL,
    INDEX_RESTORING_LABEL,
    INDEX_ERROR_LABEL,
    INDEX_INDEXING_LABEL,
    INDEX_MODEL_LOADING_LABEL,
    INDEX_NO_INDEX_LABEL,
    INDEX_NO_INDEX_TITLE,
    INDEX_UP_TO_DATE_LABEL,
    CLI_SEARCH_GATE_STARTING,
    CLI_SEARCH_GATE_RESTORING,
    CLI_SEARCH_GATE_INDEXING,
    CLI_SEARCH_GATE_NO_INDEX,
    isIndexWaitKind,
    type IndexFooterInput,
} from './index-notice';

describe('indexBannerSpec', () => {
    it('returns null for a healthy index', () => {
        expect(indexBannerSpec('healthy', null)).toBeNull();
    });

    it('returns null for a drift degradation — that is not a version change', () => {
        expect(indexBannerSpec('degraded', 'drift')).toBeNull();
    });

    it('returns null for a reasonless degradation (e.g. the drained heal)', () => {
        expect(indexBannerSpec('degraded', null)).toBeNull();
    });

    it('returns null while drift recovery runs with no version reason (recovering + null)', () => {
        expect(indexBannerSpec('recovering', null)).toBeNull();
    });

    it('returns the warning stale banner (with action) for a degraded version mismatch', () => {
        const spec = indexBannerSpec('degraded', 'version');
        expect(spec).not.toBeNull();
        expect(spec!.message).toBe(INDEX_STALE_MSG);
        expect(spec!.tone).toBe('warn');
        expect(spec!.showAction).toBe(true);
    });

    it('returns the calm syncing banner (no action) only when a peer index is actually on its way (peerSyncPending=true)', () => {
        const spec = indexBannerSpec('recovering', 'version', true);
        expect(spec).not.toBeNull();
        expect(spec!.message).toBe(INDEX_SYNCING_MSG);
        expect(spec!.tone).toBe('info');
        expect(spec!.showAction).toBe(false);
    });

    // Regression (relevance/UX audit 2026-06-29): the LOCAL drift-recovery ladder sets
    // indexHealth='recovering' over a version-stale index with NO peer. The banner must
    // NOT claim "syncing from another device" then — it's a single-device vault. Driving
    // the syncing banner off peerSyncPending (not health) keeps this cell silent.
    it('stays silent during local drift recovery over a version-stale index with no peer (recovering + version, peerSyncPending=false)', () => {
        expect(indexBannerSpec('recovering', 'version', false)).toBeNull();
        expect(indexBannerSpec('recovering', 'version')).toBeNull(); // default arg = no peer
    });

    it('lets the peer signal dominate health — a degraded version index with a peer still reads as syncing', () => {
        expect(indexBannerSpec('degraded', 'version', true)?.message).toBe(INDEX_SYNCING_MSG);
    });

    it('never lets the peer signal override a non-version reason (drift stays silent)', () => {
        expect(indexBannerSpec('recovering', 'drift', true)).toBeNull();
    });

    it('returns the "update Seek" warning (no reindex button) when a peer index is newer (peer-ahead)', () => {
        const spec = indexBannerSpec('degraded', 'peer-ahead');
        expect(spec).not.toBeNull();
        expect(spec!.message).toBe(INDEX_PEER_AHEAD_MSG);
        expect(spec!.tone).toBe('warn');
        expect(spec!.showAction).toBe(false);
    });

    it('peer-ahead is independent of health (the local index matches the build)', () => {
        // Set from orchestrator.peerAhead, always paired with 'degraded' in practice, but
        // the reason alone decides the banner — so it must not depend on the health value.
        expect(indexBannerSpec('healthy', 'peer-ahead')?.message).toBe(INDEX_PEER_AHEAD_MSG);
    });
});

describe('resolveIndexLoadPhase', () => {
    const idle = {
        hydrating: false,
        catchUpPending: false,
        catchUpRunning: false,
        flushing: false,
        writing: false,
    };

    it('prefers hydrating over writing/indexing flags (sidecar restore holds the mutex)', () => {
        expect(resolveIndexLoadPhase({ ...idle, hydrating: true, writing: true, catchUpPending: true })).toBe('hydrating');
    });

    it('treats catchUpPending as indexing even before an embed starts', () => {
        expect(resolveIndexLoadPhase({ ...idle, catchUpPending: true })).toBe('indexing');
    });

    it('treats an active reindex task as indexing', () => {
        expect(resolveIndexLoadPhase({ ...idle, indexing: true })).toBe('indexing');
    });

    it('is idle when boot is done and nothing is pending', () => {
        expect(resolveIndexLoadPhase(idle)).toBe('idle');
    });

    it('does not treat cache warming as note indexing', () => {
        expect(resolveIndexLoadPhase({ ...idle })).toBe('idle');
    });
});

describe('indexLoadSpec', () => {
    it('stays resting when the store cannot be read yet and boot is idle', () => {
        expect(indexLoadSpec({ chunks: null, phase: 'idle' }).kind).toBe('resting');
    });

    it('shows starting copy when the chunk probe has not returned yet but boot is still warming', () => {
        const spec = indexLoadSpec({ chunks: null, phase: 'hydrating' });
        expect(spec.kind).toBe('starting');
        expect(spec.title).toBe(INDEX_STARTING_TITLE);
        expect(spec.message).toBe(INDEX_STARTING_MSG);
        expect(spec.showAction).toBe(false);
    });

    it('does not claim an empty vault while starting up', () => {
        const spec = indexLoadSpec({ chunks: 0, phase: 'hydrating' });
        expect(spec.kind).toBe('starting');
        expect(spec.message).toBe(INDEX_STARTING_MSG);
        expect(spec.showAction).toBe(false);
    });

    it('does not claim an empty vault while indexing or while catch-up is only pending', () => {
        expect(indexLoadSpec({ chunks: 0, phase: 'indexing' }).kind).toBe('indexing');
        const pending = indexLoadSpec({ chunks: 0, phase: 'idle', catchUpPending: true });
        expect(pending.kind).toBe('indexing');
        expect(pending.title).toBe(INDEX_BUILDING_TITLE);
        expect(pending.message).toBe(INDEX_BUILDING_MSG);
        expect(pending.showAction).toBe(false);
    });

    it('shows onboarding only when idle with zero chunks', () => {
        const spec = indexLoadSpec({ chunks: 0, phase: 'idle' });
        expect(spec.kind).toBe('onboarding');
        expect(spec.title).toBe(INDEX_NO_INDEX_TITLE);
        expect(spec.showAction).toBe(true);
    });

    it('keeps restore copy when idle-empty but a peer sidecar is still expected', () => {
        const spec = indexLoadSpec({ chunks: 0, phase: 'idle', waitingForSidecar: true });
        expect(spec.kind).toBe('restoring');
        expect(spec.title).toBe(INDEX_RESTORING_TITLE);
        expect(spec.message).toBe(INDEX_RESTORING_MSG);
        expect(spec.showAction).toBe(false);
    });

    it('is resting once any chunks exist, even mid-index', () => {
        expect(indexLoadSpec({ chunks: 12, phase: 'hydrating' }).kind).toBe('resting');
        expect(indexLoadSpec({ chunks: 12, phase: 'indexing' }).kind).toBe('resting');
    });
});

describe('indexFooterStatus', () => {
    const idle: IndexFooterInput = {
        kind: 'resting',
        modelReady: true,
        phase: 'idle',
        health: 'healthy',
        reason: null,
        peerSyncPending: false,
    };

    it('is up to date when the model is ready and the index is populated and idle', () => {
        expect(indexFooterStatus(idle)).toEqual({
            kind: 'up-to-date',
            label: INDEX_UP_TO_DATE_LABEL,
            icon: 'check',
            tone: 'good',
        });
    });

    it('says Loading model on a populated index while the model is cold', () => {
        expect(indexFooterStatus({ ...idle, modelReady: false })).toEqual({
            kind: 'model-loading',
            label: INDEX_MODEL_LOADING_LABEL,
            icon: 'refresh-cw',
            tone: 'warn',
        });
    });

    it('says Starting up while local boot is hydrating, even on a populated index', () => {
        expect(indexFooterStatus({ ...idle, kind: 'starting' })).toMatchObject({
            kind: 'starting',
            label: INDEX_STARTING_LABEL,
        });
        expect(indexFooterStatus({ ...idle, phase: 'hydrating' })).toMatchObject({
            kind: 'starting',
            label: INDEX_STARTING_LABEL,
            icon: 'refresh-cw',
            tone: 'info',
        });
    });

    it('says Restoring while a peer sidecar is expected or a peer index is on its way', () => {
        expect(indexFooterStatus({ ...idle, kind: 'restoring' })).toMatchObject({
            kind: 'restoring',
            label: INDEX_RESTORING_LABEL,
        });
        expect(indexFooterStatus({ ...idle, waitingForSidecar: true }).kind).toBe('restoring');
        expect(indexFooterStatus({ ...idle, peerSyncPending: true }).kind).toBe('restoring');
    });

    it('uses a blue info tone for starting and restoring', () => {
        expect(indexFooterStatus({ ...idle, kind: 'starting' }).tone).toBe('info');
        expect(indexFooterStatus({ ...idle, kind: 'restoring' }).tone).toBe('info');
        expect(indexFooterStatus({ ...idle, peerSyncPending: true }).tone).toBe('info');
    });

    it('keeps footer labels to one word', () => {
        for (const spec of [
            indexFooterStatus(idle),
            indexFooterStatus({ ...idle, kind: 'starting' }),
            indexFooterStatus({ ...idle, kind: 'restoring' }),
            indexFooterStatus({ ...idle, kind: 'indexing' }),
            indexFooterStatus({ ...idle, kind: 'onboarding' }),
            indexFooterStatus({ ...idle, modelReady: false }),
            indexFooterStatus({ ...idle, health: 'degraded' }),
            indexFooterStatus({ ...idle, peerSyncPending: true }),
        ]) {
            expect(spec.label).not.toMatch(/\s/);
        }
    });

    it('is Index error when degraded or peer-ahead', () => {
        expect(indexFooterStatus({ ...idle, health: 'degraded' })).toMatchObject({
            kind: 'error',
            label: INDEX_ERROR_LABEL,
            icon: 'alert-triangle',
            tone: 'bad',
        });
        expect(indexFooterStatus({ ...idle, reason: 'peer-ahead' }).kind).toBe('error');
    });

    it('is Indexing… while indexing or recovering, using the status-bar badge not refresh-cw', () => {
        expect(indexFooterStatus({ ...idle, kind: 'indexing' })).toMatchObject({
            kind: 'indexing',
            label: INDEX_INDEXING_LABEL,
            icon: '',
            tone: 'accent',
            badgeCount: null,
        });
        expect(indexFooterStatus({ ...idle, kind: 'indexing', job: { done: 0, total: 15 } })).toMatchObject({
            kind: 'indexing',
            icon: '',
            badgeCount: 15,
        });
        expect(indexFooterStatus({ ...idle, kind: 'indexing' }).icon).not.toBe('refresh-cw');
        expect(indexFooterStatus({ ...idle, phase: 'indexing' }).kind).toBe('indexing');
        expect(indexFooterStatus({ ...idle, health: 'recovering' }).kind).toBe('indexing');
        expect(indexFooterStatus({ ...idle, job: { done: 0, total: 15 } })).toMatchObject({
            kind: 'indexing',
            badgeCount: 15,
            icon: '',
        });
    });

    it('is No index only when idle-empty and the model is ready', () => {
        expect(indexFooterStatus({ ...idle, kind: 'onboarding' })).toMatchObject({
            kind: 'no-index',
            label: INDEX_NO_INDEX_LABEL,
            icon: 'circle-off',
            tone: 'mid',
        });
    });

    it('priority: restoring > starting > error > indexing > model-loading > no-index > up-to-date', () => {
        expect(indexFooterStatus({
            ...idle, peerSyncPending: true, kind: 'starting', health: 'degraded', modelReady: false,
        }).kind).toBe('restoring');
        expect(indexFooterStatus({
            ...idle, kind: 'restoring', health: 'degraded', phase: 'indexing', modelReady: false,
        }).kind).toBe('restoring');
        expect(indexFooterStatus({
            ...idle, kind: 'starting', health: 'degraded', phase: 'indexing', modelReady: false,
        }).kind).toBe('starting');
        expect(indexFooterStatus({
            ...idle, phase: 'hydrating', health: 'degraded', modelReady: false,
        }).kind).toBe('starting');
        expect(indexFooterStatus({
            ...idle, health: 'degraded', phase: 'indexing', modelReady: false,
        }).kind).toBe('error');
        expect(indexFooterStatus({
            ...idle, reason: 'peer-ahead', kind: 'indexing', modelReady: false,
        }).kind).toBe('error');
        expect(indexFooterStatus({
            ...idle, phase: 'indexing', modelReady: false, kind: 'onboarding',
        }).kind).toBe('indexing');
        expect(indexFooterStatus({
            ...idle, health: 'recovering', modelReady: false, kind: 'onboarding',
        }).kind).toBe('indexing');
        expect(indexFooterStatus({
            ...idle, job: { done: 0, total: 15 }, modelReady: false, kind: 'resting',
        }).kind).toBe('indexing');
        expect(indexFooterStatus({
            ...idle, uiHealth: 'starting', job: { done: 0, total: 15 }, kind: 'resting',
        }).kind).toBe('starting');
        expect(indexFooterStatus({ ...idle, kind: 'onboarding', modelReady: false }).kind).toBe('model-loading');
        expect(indexFooterStatus({ ...idle, kind: 'onboarding' }).kind).toBe('no-index');
        expect(indexFooterStatus(idle).kind).toBe('up-to-date');
    });
});

describe('isIndexWaitKind', () => {
    it('is the Starting / Restoring / Indexing UI path', () => {
        expect(isIndexWaitKind('starting')).toBe(true);
        expect(isIndexWaitKind('restoring')).toBe(true);
        expect(isIndexWaitKind('indexing')).toBe(true);
        expect(isIndexWaitKind('resting')).toBe(false);
        expect(isIndexWaitKind('onboarding')).toBe(false);
    });
});

describe('resolveCliSearchGate', () => {
    it('blocks during hydrate / starting even when inventory is already populated', () => {
        expect(resolveCliSearchGate({ warmPhase: 'starting', uiHealth: 'starting', chunks: 10514 }))
            .toBe(CLI_SEARCH_GATE_STARTING);
    });

    it('blocks during sidecar restore even if some chunks already exist', () => {
        expect(resolveCliSearchGate({ warmPhase: 'restoring', uiHealth: 'restoring', chunks: 12 }))
            .toBe(CLI_SEARCH_GATE_RESTORING);
    });

    it('allows search on a populated index during catch-up / indexing', () => {
        expect(resolveCliSearchGate({ warmPhase: null, uiHealth: 'indexing', chunks: 120 }))
            .toBeNull();
    });

    it('blocks when inventory is empty', () => {
        expect(resolveCliSearchGate({ warmPhase: null, uiHealth: 'none', chunks: 0 }))
            .toBe(CLI_SEARCH_GATE_NO_INDEX);
        expect(resolveCliSearchGate({ warmPhase: null, uiHealth: 'ok', chunks: 0 }))
            .toBe(CLI_SEARCH_GATE_NO_INDEX);
    });

    it('allows degraded search when uiHealth is error but chunks exist', () => {
        expect(resolveCliSearchGate({ warmPhase: null, uiHealth: 'error', chunks: 50 })).toBeNull();
    });

    it('is ready when warm phase is clear, uiHealth ok, and chunks > 0', () => {
        expect(resolveCliSearchGate({ warmPhase: null, uiHealth: 'ok', chunks: 412 })).toBeNull();
    });
});

describe('resolveIndexUiStatus', () => {
    const idle = {
        booting: false,
        hydrating: false,
        waitingForSidecar: false,
        peerSyncPending: false,
        health: 'healthy' as const,
        reason: null,
        indexing: false,
        job: null as { done: number; total: number } | null,
        searchableChunks: 100,
        inventoryFiles: 40,
    };

    it('hydrating + writing + job is Starting during boot, never Indexing', () => {
        expect(resolveIndexUiStatus({
            ...idle, booting: true, hydrating: true, indexing: true, job: { done: 0, total: 15 }, searchableChunks: 0, inventoryFiles: 0,
        })).toBe('starting');
    });

    it('periodic hydrate (not booting) is Restoring, never Indexing', () => {
        expect(resolveIndexUiStatus({
            ...idle, hydrating: true, indexing: true, job: { done: 0, total: 8 },
        })).toBe('restoring');
    });

    it('startup cache warm after hydrate is Starting, not Indexing', () => {
        expect(resolveIndexUiStatus({ ...idle, booting: true })).toBe('starting');
    });

    it('non-startup cache warm with searchable chunks is Ready', () => {
        expect(resolveIndexUiStatus(idle)).toBe('ok');
    });

    it('degraded + indexing is Error', () => {
        expect(resolveIndexUiStatus({ ...idle, health: 'degraded', reason: 'version', indexing: true })).toBe('error');
    });

    it('real catch-up with a job is Indexing', () => {
        expect(resolveIndexUiStatus({ ...idle, indexing: true, job: { done: 3, total: 15 } })).toBe('indexing');
    });

    it('zero files with positive chunks is Ready, not None', () => {
        expect(resolveIndexUiStatus({ ...idle, inventoryFiles: 0, searchableChunks: 12 })).toBe('ok');
    });

    it('empty idle inventory is None', () => {
        expect(resolveIndexUiStatus({ ...idle, searchableChunks: 0, inventoryFiles: 0 })).toBe('none');
    });
});

describe('resolveSidecarWait', () => {
    it('clears waiting on a warm no-op (accepted producer, nothing hydrated)', () => {
        expect(resolveSidecarWait({ hydrated: 0, skippedPartialNotes: 0 }, 16570)).toBe(false);
    });

    it('sets waiting only when the local index is empty and notes arrived partial', () => {
        expect(resolveSidecarWait({ hydrated: 0, skippedPartialNotes: 3 }, 0)).toBe(true);
        expect(resolveSidecarWait({ hydrated: 0, skippedPartialNotes: 3 }, 400)).toBe(false);
    });

    it('clears waiting once any chunks hydrated', () => {
        expect(resolveSidecarWait({ hydrated: 12, skippedPartialNotes: 2 }, 0)).toBe(false);
    });
});

describe('retainIndexInventory', () => {
    it('ignores a 0/0 snapshot after a populated inventory', () => {
        expect(retainIndexInventory({ files: 2774, chunks: 10514 }, { files: 0, chunks: 0 }))
            .toEqual({ files: 2774, chunks: 10514 });
    });

    it('accepts a real empty vault when nothing was known yet', () => {
        expect(retainIndexInventory({ files: null, chunks: null }, { files: 0, chunks: 0 }))
            .toEqual({ files: 0, chunks: 0 });
    });

    it('allows a forced 0/0 after a full nuke', () => {
        expect(retainIndexInventory({ files: 12, chunks: 40 }, { files: 0, chunks: 0 }, true))
            .toEqual({ files: 0, chunks: 0 });
    });
});
