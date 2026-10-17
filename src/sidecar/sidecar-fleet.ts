/**
 * Cross-device sidecar fleet roles. Vectors are a portable byte layout; the
 * live IndexedDB is not. Auto picks a lead (newest matching full reindex).
 * Other desktops contribute new notes; phones hydrate only. Pure so unit
 * tests do not boot Obsidian.
 */

import { metaAccepts, fullReindexEpoch, type MetaExpectation, type SidecarMeta } from './sidecar-meta';

export type SidecarIndexRole = 'auto' | 'producer' | 'consumer';
export type ResolvedSidecarRole = 'producer' | 'contributor' | 'consumer';

export interface FleetPeer {
    deviceId: string;
    meta: SidecarMeta | null;
}

export interface ResolveFleetRoleInput {
    roleSetting: SidecarIndexRole;
    isMobile: boolean;
    ownMeta: SidecarMeta | null;
    peers: FleetPeer[];
    expect: MetaExpectation;
    /** IndexedDB file-record count on this device (0 = empty / unknown). */
    localFileCount: number;
}

export function matchingPeers(peers: FleetPeer[], expect: MetaExpectation): FleetPeer[] {
    return peers.filter(p => metaAccepts(p.meta, expect));
}

export function stalePeers(peers: FleetPeer[], expect: MetaExpectation): FleetPeer[] {
    return peers.filter(p => p.meta != null && !metaAccepts(p.meta, expect));
}

/**
 * Auto: phones hydrate only. A desktop whose matching full-reindex stamp is
 * newer than every peer is the lead (producer). Any other desktop that can
 * see peer sidecar files is a contributor: it may encode new/changed notes
 * into its own shards, but must not full-reindex or delete a peer's files.
 * A non-empty local stub with no peer files on disk stays a consumer — the
 * laptop whose Sync/Drive copy never arrived must not re-embed the vault.
 */
export function resolveFleetRole(input: ResolveFleetRoleInput): ResolvedSidecarRole {
    if (input.roleSetting === 'producer') return 'producer';
    if (input.roleSetting === 'consumer') return 'consumer';
    if (input.isMobile) return 'consumer';
    const matching = matchingPeers(input.peers, input.expect);
    const ownEpoch = fullReindexEpoch(input.ownMeta);
    const peerMax = matching.reduce((m, p) => Math.max(m, fullReindexEpoch(p.meta)), -Infinity);
    if (matching.length > 0 && ownEpoch > peerMax) return 'producer';
    if (input.peers.length > 0) return 'contributor';
    if (ownEpoch > -Infinity) return 'producer';
    if (input.localFileCount > 0) return 'consumer';
    return 'producer';
}

export function mayFullReindex(role: ResolvedSidecarRole): boolean {
    return role === 'producer';
}

export function mayReapPeerSidecars(role: ResolvedSidecarRole): boolean {
    return role === 'producer';
}

/** GPU catch-up / incremental sidecar append. Phones stay hydrate-only. */
export function mayEmbedCatchUp(role: ResolvedSidecarRole): boolean {
    return role === 'producer' || role === 'contributor';
}

/** Dual-open: a hidden window with a peer present must not write or compact. */
export function mayWriteSidecar(
    role: ResolvedSidecarRole,
    isHidden: boolean,
    anyPeerPresent: boolean,
    waitingForProducer: boolean,
): boolean {
    if (waitingForProducer) return false;
    if (isHidden && anyPeerPresent) return false;
    void role;
    return true;
}

export function mayCompactOwnSidecar(
    role: ResolvedSidecarRole,
    isHidden: boolean,
    anyPeerPresent: boolean,
): boolean {
    if (role === 'consumer') return false;
    if (isHidden && anyPeerPresent) return false;
    return true;
}

export interface WaitForProducerInput {
    role: ResolvedSidecarRole;
    matchingReady: boolean;
    incomplete: boolean;
    dataless: boolean;
    localFileCount: number;
    indexableNotes: number;
}

/**
 * Non-lead devices wait instead of catch-up-embedding when the lead shards are
 * missing, dataless, or still copying. A warm device whose local IDB already
 * covers most notes keeps serving search if the folder is temporarily gone.
 */
export function shouldWaitForProducer(input: WaitForProducerInput): boolean {
    if (input.role === 'producer') return false;
    if (input.matchingReady) return false;
    if (input.incomplete || input.dataless) return true;
    if (input.indexableNotes <= 0) return false;
    if (input.localFileCount === 0) return true;
    return input.localFileCount < input.indexableNotes * 0.5;
}

export interface SidecarWaitCopyInput {
    role: ResolvedSidecarRole;
    matchingReady: boolean;
    incomplete: boolean;
    dataless: boolean;
    matchingProducers: number;
    stalePeerCount: number;
    /** True when catch-up/full reindex are parked for missing shards. */
    waiting?: boolean;
}

/** One-sentence Settings / toast copy. */
export function sidecarWaitCopy(input: SidecarWaitCopyInput): string {
    if (input.role === 'producer') {
        return 'This computer is the lead index. It can rebuild everything; other computers add new notes and copy from it.';
    }
    if (input.matchingReady && input.role === 'contributor') {
        return 'This computer adds new and changed notes to the shared index. A full rebuild stays on the lead computer.';
    }
    if (input.matchingReady) {
        return 'Copying the shared index from the lead computer. This device will not run a full reindex.';
    }
    if (input.dataless) {
        return 'Shared index files are still placeholders (empty or not downloaded). Waiting until the real files are on this disk.';
    }
    if (input.incomplete) {
        return 'Shared index files are still copying. Waiting until every shard is fully local.';
    }
    if (input.matchingProducers === 0 && input.stalePeerCount > 0) {
        return 'Another device’s index does not match this embedding model yet. Waiting for matching files — this device will not re-embed or delete those shards.';
    }
    if (input.waiting === false) {
        return 'No producer sidecar on this disk. Search uses this device’s local index. This device will not run a full reindex.';
    }
    return 'Producer index files are not on this disk yet — waiting. Search will hydrate without re-embedding once they arrive.';
}
