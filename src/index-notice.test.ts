import { describe, it, expect } from 'vitest';
import {
    indexBannerSpec,
    indexLoadSpec,
    resolveIndexLoadPhase,
    indexFooterStatus,
    INDEX_STALE_MSG,
    INDEX_SYNCING_MSG,
    INDEX_PEER_AHEAD_MSG,
    INDEX_HYDRATING_MSG,
    INDEX_HYDRATING_TITLE,
    INDEX_BUILDING_MSG,
    INDEX_BUILDING_TITLE,
    INDEX_STARTING_MSG,
    INDEX_STARTING_TITLE,
    INDEX_STARTING_LABEL,
    INDEX_RESTORING_LABEL,
    INDEX_SYNCING_LABEL,
    INDEX_ERROR_LABEL,
    INDEX_INDEXING_LABEL,
    INDEX_MODEL_LOADING_LABEL,
    INDEX_NO_INDEX_LABEL,
    INDEX_NO_INDEX_TITLE,
    INDEX_UP_TO_DATE_LABEL,
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
        expect(spec.kind).toBe('hydrating');
        expect(spec.title).toBe(INDEX_HYDRATING_TITLE);
        expect(spec.message).toBe(INDEX_HYDRATING_MSG);
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
            tone: 'accent',
        });
    });

    it('says Restoring while a peer sidecar is expected', () => {
        expect(indexFooterStatus({ ...idle, kind: 'hydrating' })).toMatchObject({
            kind: 'restoring',
            label: INDEX_RESTORING_LABEL,
        });
        expect(indexFooterStatus({ ...idle, waitingForSidecar: true }).kind).toBe('restoring');
    });

    it('is syncing while a peer index is on its way', () => {
        expect(indexFooterStatus({ ...idle, peerSyncPending: true }).kind).toBe('syncing');
        expect(indexFooterStatus({ ...idle, peerSyncPending: true }).label).toBe(INDEX_SYNCING_LABEL);
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

    it('is Indexing… while indexing or recovering', () => {
        expect(indexFooterStatus({ ...idle, kind: 'indexing' })).toMatchObject({
            kind: 'indexing',
            label: INDEX_INDEXING_LABEL,
            icon: 'refresh-cw',
            tone: 'accent',
        });
        expect(indexFooterStatus({ ...idle, phase: 'indexing' }).kind).toBe('indexing');
        expect(indexFooterStatus({ ...idle, health: 'recovering' }).kind).toBe('indexing');
    });

    it('is No index only when idle-empty and the model is ready', () => {
        expect(indexFooterStatus({ ...idle, kind: 'onboarding' })).toMatchObject({
            kind: 'no-index',
            label: INDEX_NO_INDEX_LABEL,
            icon: 'circle-off',
            tone: 'mid',
        });
    });

    it('priority: peer-sync > restoring > starting > error > indexing > model-loading > no-index > up-to-date', () => {
        expect(indexFooterStatus({
            ...idle, peerSyncPending: true, kind: 'hydrating', health: 'degraded', modelReady: false,
        }).kind).toBe('syncing');
        expect(indexFooterStatus({
            ...idle, kind: 'hydrating', health: 'degraded', phase: 'indexing', modelReady: false,
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
        expect(indexFooterStatus({ ...idle, kind: 'onboarding', modelReady: false }).kind).toBe('model-loading');
        expect(indexFooterStatus({ ...idle, kind: 'onboarding' }).kind).toBe('no-index');
        expect(indexFooterStatus(idle).kind).toBe('up-to-date');
    });
});
