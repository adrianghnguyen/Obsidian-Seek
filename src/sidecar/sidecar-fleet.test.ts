import { describe, it, expect } from 'vitest';
import { SIDECAR_FORMAT } from './sidecar';
import type { SidecarMeta } from './sidecar-meta';
import {
    resolveFleetRole,
    mayFullReindex,
    mayReapPeerSidecars,
    mayWriteSidecar,
    mayCompactOwnSidecar,
    shouldWaitForProducer,
    sidecarWaitCopy,
    matchingPeers,
    stalePeers,
} from './sidecar-fleet';

const EXPECT = { modelId: 'gemma', revision: 'abc', chunkerVersion: 10, dim: 768 };

function meta(over: Partial<SidecarMeta> & { deviceId: string }): SidecarMeta {
    return {
        format: SIDECAR_FORMAT,
        modelId: EXPECT.modelId,
        revision: EXPECT.revision,
        chunkerVersion: EXPECT.chunkerVersion,
        dim: EXPECT.dim,
        lastFullReindex: null,
        ...over,
    };
}

describe('resolveFleetRole', () => {
    it('honors an explicit producer or consumer setting', () => {
        expect(resolveFleetRole({
            roleSetting: 'producer', isMobile: true, ownMeta: null, peers: [], expect: EXPECT, localFileCount: 0,
        })).toBe('producer');
        expect(resolveFleetRole({
            roleSetting: 'consumer', isMobile: false, ownMeta: null, peers: [], expect: EXPECT, localFileCount: 0,
        })).toBe('consumer');
    });

    it('auto: mobile is always a consumer', () => {
        expect(resolveFleetRole({
            roleSetting: 'auto', isMobile: true, ownMeta: null, peers: [], expect: EXPECT, localFileCount: 0,
        })).toBe('consumer');
    });

    it('auto: empty desktop with no peers is a first-install producer', () => {
        expect(resolveFleetRole({
            roleSetting: 'auto', isMobile: false, ownMeta: null, peers: [], expect: EXPECT, localFileCount: 0,
        })).toBe('producer');
    });

    it('auto: a local stub with no peer files on disk is a consumer (sidecar never arrived)', () => {
        expect(resolveFleetRole({
            roleSetting: 'auto', isMobile: false, ownMeta: null, peers: [], expect: EXPECT, localFileCount: 63,
        })).toBe('consumer');
    });

    it('auto: any peer files (even a stale model) keep this device a consumer', () => {
        const granite = meta({
            deviceId: 'desktop-win',
            modelId: 'granite',
            dim: 384,
            lastFullReindex: '2026-10-01T00:00:00Z',
        });
        expect(resolveFleetRole({
            roleSetting: 'auto',
            isMobile: false,
            ownMeta: null,
            peers: [{ deviceId: 'desktop-win', meta: granite }],
            expect: EXPECT,
            localFileCount: 63,
        })).toBe('consumer');
        expect(stalePeers([{ deviceId: 'desktop-win', meta: granite }], EXPECT)).toHaveLength(1);
        expect(matchingPeers([{ deviceId: 'desktop-win', meta: granite }], EXPECT)).toHaveLength(0);
    });

    it('auto: a desktop whose full pass is newer than matching peers is the producer', () => {
        const peer = meta({ deviceId: 'desktop-old', lastFullReindex: '2026-10-01T00:00:00Z' });
        const own = meta({ deviceId: 'desktop-new', lastFullReindex: '2026-10-14T00:00:00Z' });
        expect(resolveFleetRole({
            roleSetting: 'auto',
            isMobile: false,
            ownMeta: own,
            peers: [{ deviceId: 'desktop-old', meta: peer }],
            expect: EXPECT,
            localFileCount: 3000,
        })).toBe('producer');
    });
});

describe('consumer lock gates', () => {
    it('consumers must not full-reindex or reap peer files', () => {
        expect(mayFullReindex('consumer')).toBe(false);
        expect(mayReapPeerSidecars('consumer')).toBe(false);
        expect(mayFullReindex('producer')).toBe(true);
        expect(mayReapPeerSidecars('producer')).toBe(true);
    });

    it('skips sidecar writes while waiting or when a hidden window shares a peer', () => {
        expect(mayWriteSidecar('consumer', false, true, true)).toBe(false);
        expect(mayWriteSidecar('producer', true, true, false)).toBe(false);
        expect(mayWriteSidecar('producer', false, true, false)).toBe(true);
        expect(mayWriteSidecar('consumer', false, true, false)).toBe(true);
    });

    it('consumers never compact; hidden producers with a peer skip compact', () => {
        expect(mayCompactOwnSidecar('consumer', false, true)).toBe(false);
        expect(mayCompactOwnSidecar('producer', true, true)).toBe(false);
        expect(mayCompactOwnSidecar('producer', false, true)).toBe(true);
    });
});

describe('shouldWaitForProducer', () => {
    it('waits on a consumer stub or empty index when no matching shards are ready', () => {
        expect(shouldWaitForProducer({
            role: 'consumer', matchingReady: false, incomplete: false, dataless: false,
            localFileCount: 63, indexableNotes: 3000,
        })).toBe(true);
        expect(shouldWaitForProducer({
            role: 'consumer', matchingReady: false, incomplete: false, dataless: false,
            localFileCount: 0, indexableNotes: 100,
        })).toBe(true);
    });

    it('waits when shards are dataless or still copying even if the local index is warm', () => {
        expect(shouldWaitForProducer({
            role: 'consumer', matchingReady: false, incomplete: true, dataless: false,
            localFileCount: 3000, indexableNotes: 3000,
        })).toBe(true);
        expect(shouldWaitForProducer({
            role: 'consumer', matchingReady: false, incomplete: false, dataless: true,
            localFileCount: 3000, indexableNotes: 3000,
        })).toBe(true);
    });

    it('does not wait on a producer, a ready matching peer, or a warm consumer whose sidecar is briefly gone', () => {
        expect(shouldWaitForProducer({
            role: 'producer', matchingReady: false, incomplete: false, dataless: false,
            localFileCount: 0, indexableNotes: 100,
        })).toBe(false);
        expect(shouldWaitForProducer({
            role: 'consumer', matchingReady: true, incomplete: false, dataless: false,
            localFileCount: 0, indexableNotes: 100,
        })).toBe(false);
        expect(shouldWaitForProducer({
            role: 'consumer', matchingReady: false, incomplete: false, dataless: false,
            localFileCount: 2900, indexableNotes: 3000,
        })).toBe(false);
    });
});

describe('sidecarWaitCopy', () => {
    it('names the wait without asking the consumer to reindex', () => {
        expect(sidecarWaitCopy({
            role: 'consumer', matchingReady: false, incomplete: false, dataless: false,
            matchingProducers: 0, stalePeerCount: 0,
        })).toMatch(/not on this disk yet/);
        expect(sidecarWaitCopy({
            role: 'consumer', matchingReady: false, incomplete: false, dataless: false,
            matchingProducers: 0, stalePeerCount: 1,
        })).toMatch(/will not re-embed or delete/);
        expect(sidecarWaitCopy({
            role: 'consumer', matchingReady: false, incomplete: false, dataless: true,
            matchingProducers: 1, stalePeerCount: 0,
        })).toMatch(/placeholders/);
        expect(sidecarWaitCopy({
            role: 'producer', matchingReady: false, incomplete: false, dataless: false,
            matchingProducers: 0, stalePeerCount: 0,
        })).toMatch(/writes the shared index/);
    });
});
