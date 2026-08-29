// Sidecar hydrate/reconcile: rebuild the IndexedDB index from the vault-file
// sidecar WITHOUT re-embedding. This is what restores search after iOS evicts
// the IDB, and what lets a fresh device pick up another device's index.
//
// The algorithm is a pure function over injectable dependencies (HydrateDeps) so
// it can be unit-tested against fakes with no IndexedDB / vault. SearchOrchestrator
// supplies the real deps (re-chunk the live vault, read/write the store) and runs
// it under its write mutex; main.ts schedules it (load + idle + command).
//
// Liveness oracle: a chunk_id is a deterministic path-salted content hash, so the
// consumer reproduces the producer's ids by re-chunking its own copy of the vault
// and keeping only the intersection. A deleted note's ids match nothing and are
// ignored — cross-device deletes need no protocol.
//
// All-or-nothing per note: a note is hydrated only when EVERY one of its live
// chunks is available in the sidecar (present + bytes synced). A partially-synced
// note is left for a model-backed embed (computeDelta will flag it) rather than
// writing a file record that would make computeDelta think it's fully indexed.
//
// chunk_id reproduction (FIXED 2026-06-14): the oracle (reChunkLive /
// dedupViaSidecar in search.ts) runs the FULL producer pipeline — chunkContent
// THEN enforceTokenBudget — so split chunk_ids match exactly. The earlier v1
// omitted the token-budget re-split (it needs the tokenizer), which silently
// missed every note long enough to be split: on a long-note vault that was
// ~the whole corpus → hydrated:0 → full on-device re-embed → iPhone jetsam.
// The hydrate now loads the TOKENIZER ONLY (embedder.ensureTokenizer, a few MB,
// no ~250 MB model) to stay mobile-safe while reproducing ids.

import type { DataAdapter } from 'obsidian';
import type { Chunk } from './types';
import type { QuantVec } from './quant';
import {
    decodeRecord,
    deviceIdFromJsonlPath,
    isOffsetInRange,
    listDeviceJsonls,
    scanJsonl,
    shardPathFor,
    type ResolvedEntry,
} from './sidecar';
import { metaAccepts, readDeviceMeta, type MetaExpectation, type SidecarMeta } from './sidecar-meta';

// One live note re-chunked locally: the liveness oracle's unit.
export interface ReChunkedNote {
    notePath: string;
    mtimeMs: number;
    chunks: Chunk[]; // each carries chunk_id
    contentHash?: string; // cyrb53 of the raw bytes — persisted so computeDelta can skip mtime-only re-stamps
}

export interface HydrateFileRef {
    path: string;
    mtimeMs: number;
}

export interface HydrateTierCompleteDetail {
    tier: string;
    filesWalked: number;
    chunksProduced: number;
    needed: number;
    hydrated: number;
    freshIdsRemaining: number;
    durationMs: number;
    gateReleased: boolean;
}

export const HYDRATE_TIERS = [
    { id: 'hydrate-tier-3d', days: 3 },
    { id: 'hydrate-tier-7d', days: 7 },
    { id: 'hydrate-tier-14d', days: 14 },
    { id: 'hydrate-tier-30d', days: 30 },
    { id: 'hydrate-tier-90d', days: 90 },
    { id: 'hydrate-tier-full', days: null as number | null },
] as const;

export interface HydrateDeps {
    adapter: DataAdapter;
    indexDir: string;
    expect: MetaExpectation; // {modelId, chunkerVersion, dim} this consumer can reproduce
    reChunk: () => Promise<ReChunkedNote[]>; // live vault → re-chunked notes (legacy full walk)
    /** Greedy hydrate: re-chunk only the given files (mtime-desc within tier). */
    reChunkSubset?: (files: HydrateFileRef[], shouldStop?: () => boolean) => Promise<ReChunkedNote[]>;
    /** Greedy hydrate: indexable files sorted mtime descending. */
    listHydrateFiles?: () => Promise<HydrateFileRef[]>;
    /** Greedy hydrate: three-day tier committed — release search gate (P1). */
    onGoodEnough?: () => void;
    /** Greedy hydrate: warm tokenizer in parallel with file-list wait. */
    ensureTokenizer?: () => Promise<void>;
    onTierComplete?: (detail: HydrateTierCompleteDetail) => void;
    /** When true and reChunkSubset + listHydrateFiles are set, use tiered greedy hydrate. */
    greedyHydrate?: boolean;
    existingIds: () => Promise<Set<string>>; // chunk_ids already in IDB (skip — idempotent)
    putQuantized: (chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[]) => Promise<void>;
    putFileRecord: (rec: { note_path: string; mtimeMs: number; chunk_ids: string[]; contentHash?: string }) => Promise<void>;
    // Version-gate refusal. Carries the producer meta (null = missing/unreadable)
    // and this consumer's expectation so the consumer can log WHAT is stale
    // (e.g. "chunker v3≠v4") and throttle to once per device+reason — a chunker
    // bump otherwise refuses the same producer on every reconcile / delta flush.
    onRefusedProducer?: (deviceId: string, meta: SidecarMeta | null, expect: MetaExpectation) => void;
    log?: (msg: string, detail: unknown) => void;
    batchSize?: number; // putQuantized batch size (default 500)
}

export interface HydrateResult {
    scanned: number; // sidecar live records across accepted producers
    needed: number; // live ∩ sidecar, minus already-in-IDB (chunks)
    hydrated: number; // chunks actually written
    skippedPartialNotes: number; // notes skipped because a chunk's bytes weren't synced yet
    refusedProducers: number; // producers excluded by the version gate
    acceptedProducers: number;
    // A refused producer is at a HIGHER chunkerVersion than this build can read — i.e.
    // another device holds a newer index this plugin is too old to use. Distinct from
    // refusedProducers (which also counts merely-different/older/torn producers): this is
    // specifically "I'm behind, the user should update Seek". Drives the peer-ahead banner
    // and the mobile grind-stop (skip the futile local re-embed).
    peerAhead: boolean;
    hydratedNotePaths: string[]; // notes fully hydrated (a file record was written) — drives delta dedup
    // Corpus dense-cosine background inherited from the freshest accepted producer
    // (newest lastFullReindex) — the orchestrator writes it into local meta so a
    // hydrate-only device gets display calibration. Undefined if no producer
    // carried stats.
    bgMean?: number;
    bgStd?: number;
}

// Epoch (ms) of a producer's last full reindex, for "freshest" selection. A
// null / absent / unparseable timestamp yields -Infinity so it sorts below every
// real one — the choice of which producer's calibration to inherit is then a
// well-defined max, never dependent on file-scan order.
function fullReindexEpoch(m: SidecarMeta | null): number {
    const t = m?.lastFullReindex ? Date.parse(m.lastFullReindex) : NaN;
    return Number.isNaN(t) ? -Infinity : t;
}

// Rank the version-COMPATIBLE producers freshest-first (newest full reindex). Used
// by the cross-device BM25 load (Phase 3): the consumer tries each in turn until one
// has a loadable BM25 .gz artifact — a single "freshest" pick is NOT enough because a
// producer can be the freshest reindexer yet have NO gz (mobile writes meta+jsonl but
// not the artifact — emit is desktop-only), or a torn/missing/corrupt gz. metaAccepts
// is the same gate hydrateFromSidecar uses, so a producer whose ids this device can't
// reproduce (chunker/model/dim/format mismatch) is never trusted. SELF is eligible:
// after an iOS eviction this device's OWN sidecar (which survives in the vault) is a
// valid source. Freshest-by-epoch is well-defined regardless of file-scan order (a
// null/absent timestamp sorts below every real one). Empty when the sidecar is empty
// / all refused.
export async function rankAcceptedProducers(
    adapter: DataAdapter,
    indexDir: string,
    expect: MetaExpectation,
): Promise<string[]> {
    const jsonls = await listDeviceJsonls(adapter, indexDir);
    const accepted: { dev: string; epoch: number }[] = [];
    for (const jsonl of jsonls) {
        const dev = deviceIdFromJsonlPath(jsonl);
        if (!dev) continue;
        const meta = await readDeviceMeta(adapter, indexDir, dev);
        if (!metaAccepts(meta, expect)) continue;
        accepted.push({ dev, epoch: fullReindexEpoch(meta) });
    }
    // Freshest first; listDeviceJsonls already sorted, so equal epochs stay stable.
    accepted.sort((a, b) => b.epoch - a.epoch);
    return accepted.map(a => a.dev);
}

// Cheap, hydrate-independent peer-ahead probe: scans ONLY the producer device metas
// (no jsonl content scan, no whole-vault reChunk) to answer "does a peer hold an index
// at a newer chunkerVersion than this build can read?". This is the SAME predicate
// hydrateFromSidecar computes inline (a metaAccepts-refused producer whose chunkerVersion
// exceeds ours), factored out so the two can't drift. Why it exists: reconcileSidecarIfChanged
// skips the expensive hydrate whenever the sidecar-dir signature is unchanged (the routine
// app-relaunch case), and the orchestrator's _peerAhead resets to false on every new boot —
// so without a hydrate-free way to recover the bit, the peer-ahead banner and the mobile
// grind-stop would silently stop engaging after the first relaunch (and falsely read
// "healthy"). An older-or-equal refused producer means WE are ahead, not peer-ahead; an
// unreadable meta (null) is no evidence of a newer peer. Short-circuits on the first hit.
export async function probePeerAhead(
    adapter: DataAdapter,
    indexDir: string,
    expect: MetaExpectation,
): Promise<boolean> {
    const jsonls = await listDeviceJsonls(adapter, indexDir);
    for (const jsonl of jsonls) {
        const dev = deviceIdFromJsonlPath(jsonl);
        if (!dev) continue;
        const meta = await readDeviceMeta(adapter, indexDir, dev);
        if (!metaAccepts(meta, expect) && meta && meta.chunkerVersion > expect.chunkerVersion) return true;
    }
    return false;
}

interface Candidate {
    note: ReChunkedNote;
    entries: ResolvedEntry[]; // aligned with note.chunks
}

interface TierHydrateResult {
    needed: number;
    hydrated: number;
    skippedPartialNotes: number;
    hydratedNotePaths: string[];
    hydratedIds: string[];
}

function selectCandidates(
    live: ReChunkedNote[],
    scan: { map: Map<string, ResolvedEntry> },
    existing: Set<string>,
    freshIdsRemaining: Set<string>,
): { candidates: Candidate[]; needed: number } {
    const candidates: Candidate[] = [];
    let needed = 0;
    for (const note of live) {
        if (note.chunks.length === 0) continue;
        if (note.chunks.every(c => existing.has(c.chunk_id))) continue; // already indexed
        if (!note.chunks.some(c => freshIdsRemaining.has(c.chunk_id))) continue;
        const entries: ResolvedEntry[] = [];
        let coverable = true;
        for (const c of note.chunks) {
            const e = scan.map.get(c.chunk_id);
            if (!e) {
                coverable = false;
                break;
            }
            entries.push(e);
        }
        if (!coverable) continue;
        candidates.push({ note, entries });
        needed += entries.length;
    }
    return { candidates, needed };
}

async function hydrateCandidates(
    deps: HydrateDeps,
    candidates: Candidate[],
): Promise<TierHydrateResult> {
    if (candidates.length === 0) {
        return { needed: 0, hydrated: 0, skippedPartialNotes: 0, hydratedNotePaths: [], hydratedIds: [] };
    }
    const { adapter, indexDir } = deps;
    const byShard = new Map<string, ResolvedEntry[]>();
    for (const cand of candidates) {
        for (const e of cand.entries) {
            const key = `${e.shard}.${e.seq}`;
            const arr = byShard.get(key);
            if (arr) arr.push(e);
            else byShard.set(key, [e]);
        }
    }
    const tierCache = new Map<string, ReturnType<typeof decodeRecord> | null>();
    const entryKey = (e: ResolvedEntry): string => `${e.shard}.${e.seq}.${e.off}`;
    for (const [, entries] of byShard) {
        const first = entries[0];
        const buf = await adapter.readBinary(shardPathFor(indexDir, first.shard, first.seq)).catch(() => null);
        for (const e of entries) {
            if (buf && isOffsetInRange(buf.byteLength, e.off)) {
                try { tierCache.set(entryKey(e), decodeRecord(buf, e.off, e.dim)); }
                catch { tierCache.set(entryKey(e), null); }
            } else tierCache.set(entryKey(e), null);
        }
    }
    const batchSize = deps.batchSize ?? 500;
    let pendingChunks: Chunk[] = [];
    let pendingTiers: { q: QuantVec; bin: Uint8Array }[] = [];
    const flush = async (): Promise<void> => {
        if (pendingChunks.length === 0) return;
        await deps.putQuantized(pendingChunks, pendingTiers);
        pendingChunks = [];
        pendingTiers = [];
    };
    let hydrated = 0;
    let skippedPartialNotes = 0;
    const hydratedIds: string[] = [];
    const fileRecords: Array<{ note_path: string; mtimeMs: number; chunk_ids: string[]; contentHash?: string }> = [];
    for (const cand of candidates) {
        const tiers = cand.entries.map(e => tierCache.get(entryKey(e)) ?? null);
        if (tiers.some(t => t === null)) {
            skippedPartialNotes++;
            continue;
        }
        for (let i = 0; i < cand.note.chunks.length; i++) {
            const t = tiers[i]!;
            pendingChunks.push(cand.note.chunks[i]);
            pendingTiers.push({ q: { q: t.q, s: t.s }, bin: t.sign });
            hydratedIds.push(cand.note.chunks[i].chunk_id);
            hydrated++;
            if (pendingChunks.length >= batchSize) await flush();
        }
        fileRecords.push({
            note_path: cand.note.notePath,
            mtimeMs: cand.note.mtimeMs,
            chunk_ids: cand.note.chunks.map(c => c.chunk_id),
            contentHash: cand.note.contentHash,
        });
    }
    await flush();
    for (const rec of fileRecords) await deps.putFileRecord(rec);
    return {
        needed: candidates.reduce((n, c) => n + c.entries.length, 0),
        hydrated,
        skippedPartialNotes,
        hydratedNotePaths: fileRecords.map(r => r.note_path),
        hydratedIds,
    };
}

async function hydrateFromSidecarGreedy(
    deps: HydrateDeps,
    scan: { map: Map<string, ResolvedEntry> },
    existing: Set<string>,
    freshIds: Set<string>,
    accepted: string[],
    refused: number,
    peerAhead: boolean,
    bg: { bgMean?: number; bgStd?: number },
): Promise<HydrateResult> {
    const empty: HydrateResult = {
        scanned: scan.map.size,
        needed: 0,
        hydrated: 0,
        skippedPartialNotes: 0,
        refusedProducers: refused,
        acceptedProducers: accepted.length,
        peerAhead,
        hydratedNotePaths: [],
        ...bg,
    };
    const hydrateStartMs = Date.now();
    const tokenizerReady = deps.ensureTokenizer?.() ?? Promise.resolve();
    const allFilesPromise = deps.listHydrateFiles!();
    const [allFiles] = await Promise.all([allFilesPromise, tokenizerReady]);
    if (allFiles.length === 0 && freshIds.size > 0) {
        deps.log?.('sidecar-hydrate-greedy-no-files', { freshIdsRemaining: freshIds.size });
    }
    let freshIdsRemaining = new Set(freshIds);
    const processedPaths = new Set<string>();
    let tiersRun = 0;
    let stoppedEarly = false;
    let stopReason: string | null = null;
    let goodEnoughReleased = false;
    let firstGoodMs: number | null = null;
    const greedyStart = performance.now();
    let totalNeeded = 0;
    let totalHydrated = 0;
    let totalSkippedPartial = 0;
    const allHydratedPaths: string[] = [];

    for (const tier of HYDRATE_TIERS) {
        if (freshIdsRemaining.size === 0) {
            stoppedEarly = true;
            stopReason = 'freshIds-empty';
            break;
        }
        const tierStart = performance.now();
        let tierFiles: HydrateFileRef[];
        if (tier.days == null) {
            tierFiles = allFiles.filter(f => !processedPaths.has(f.path));
        } else {
            const cutoffMs = hydrateStartMs - tier.days * 86_400_000;
            tierFiles = allFiles.filter(f => f.mtimeMs >= cutoffMs && !processedPaths.has(f.path));
        }
        for (const f of tierFiles) processedPaths.add(f.path);
        if (tierFiles.length === 0) continue;

        let tierFilesWalked = 0;
        let tierChunksProduced = 0;
        let tierNeeded = 0;
        let tierHydrated = 0;
        let tierSkippedPartial = 0;
        const tierHydratedPaths: string[] = [];
        const tierHydratedIds: string[] = [];

        const processRechunked = async (live: ReChunkedNote[]) => {
            tierChunksProduced += live.reduce((n, note) => n + note.chunks.length, 0);
            const { candidates, needed } = selectCandidates(live, scan, existing, freshIdsRemaining);
            tierNeeded += needed;
            const result = await hydrateCandidates(deps, candidates);
            for (const id of result.hydratedIds) existing.add(id);
            for (const id of result.hydratedIds) freshIdsRemaining.delete(id);
            tierHydrated += result.hydrated;
            tierSkippedPartial += result.skippedPartialNotes;
            tierHydratedPaths.push(...result.hydratedNotePaths);
            tierHydratedIds.push(...result.hydratedIds);
            return result;
        };

        if (tier.id === 'hydrate-tier-3d') {
            // Walk the complete three-day tier in mtime order before declaring the
            // startup index good enough. Each file commits independently, so the
            // modal can surface early results as soon as its chunk-count poll sees
            // them; the gate itself means every coverable recent file is now present.
            for (const ref of tierFiles) {
                if (freshIdsRemaining.size === 0) break;
                tierFilesWalked++;
                const live = await deps.reChunkSubset!([ref], () => freshIdsRemaining.size === 0);
                await processRechunked(live);
            }
        } else {
            tierFilesWalked = tierFiles.length;
            const live = await deps.reChunkSubset!(tierFiles, () => freshIdsRemaining.size === 0);
            await processRechunked(live);
        }

        totalNeeded += tierNeeded;
        totalHydrated += tierHydrated;
        totalSkippedPartial += tierSkippedPartial;
        allHydratedPaths.push(...tierHydratedPaths);
        tiersRun++;

        const gateReleased = goodEnoughReleased
            || ((tier.id === 'hydrate-tier-3d' || freshIdsRemaining.size === 0)
            && (tierHydrated > 0 || freshIdsRemaining.size === 0));
        if (gateReleased && !goodEnoughReleased) {
            deps.onGoodEnough?.();
            goodEnoughReleased = true;
            if (firstGoodMs == null) firstGoodMs = Math.round(performance.now() - greedyStart);
        }

        const tierDetail: HydrateTierCompleteDetail = {
            tier: tier.id,
            filesWalked: tierFilesWalked,
            chunksProduced: tierChunksProduced,
            needed: tierNeeded,
            hydrated: tierHydrated,
            freshIdsRemaining: freshIdsRemaining.size,
            durationMs: Math.round(performance.now() - tierStart),
            gateReleased,
        };
        deps.onTierComplete?.(tierDetail);
        deps.log?.('sidecar-hydrate-tier', tierDetail);

        if (goodEnoughReleased && tier.id === 'hydrate-tier-3d') {
            stoppedEarly = true;
            stopReason = 'gate-released';
            break;
        }
        if (freshIdsRemaining.size === 0) {
            stoppedEarly = true;
            stopReason = 'freshIds-empty';
            break;
        }
    }

    deps.log?.('sidecar-hydrate-greedy', {
        tiersRun,
        stoppedEarly,
        reason: stopReason,
        T_first_good_ms: firstGoodMs,
        T_hydrate_total_ms: Math.round(performance.now() - greedyStart),
    });

    const result: HydrateResult = {
        ...bg,
        scanned: scan.map.size,
        needed: totalNeeded,
        hydrated: totalHydrated,
        skippedPartialNotes: totalSkippedPartial,
        refusedProducers: refused,
        acceptedProducers: accepted.length,
        peerAhead,
        hydratedNotePaths: allHydratedPaths,
    };
    deps.log?.('sidecar-hydrate', result);
    return result;
}

export async function hydrateFromSidecar(deps: HydrateDeps): Promise<HydrateResult> {
    const { adapter, indexDir, expect } = deps;
    const empty: HydrateResult = { scanned: 0, needed: 0, hydrated: 0, skippedPartialNotes: 0, refusedProducers: 0, acceptedProducers: 0, peerAhead: false, hydratedNotePaths: [] };

    // 1. Version gate: keep only producers this consumer can reproduce.
    const allJsonls = await listDeviceJsonls(adapter, indexDir);
    // Early producer-file probe: producerFilesFound:0 means NO other device's
    // sidecar has reached this device's index dir yet (the iCloud-delivery gap
    // that strands an iPhone into a local re-embed). Logged before the version
    // gate so "0 files synced" is distinguishable from "files present but refused".
    deps.log?.('sidecar-hydrate-scan', {
        producerFilesFound: allJsonls.length,
        devices: allJsonls.map(j => deviceIdFromJsonlPath(j) ?? '?').join(',') || 'none',
    });
    const accepted: string[] = [];
    let refused = 0;
    // A refused producer whose chunkerVersion is HIGHER than ours = a newer index we're
    // too old to read (the user should update Seek). Tracked across the whole scan so a
    // single ahead peer is reported even when other producers are accepted.
    let peerAhead = false;
    // Inherit display-calibration stats from the freshest accepted producer (the
    // one whose last full reindex is newest = most representative of the corpus).
    // Compare by parsed epoch, NOT lexicographically: a missing/malformed/null
    // timestamp sorts below all real ones (a stats-bearing producer with a real
    // timestamp always wins, never just jsonl-iteration order), and mixed-width
    // ISO strings (with/without millis) can't compare backwards.
    let bgSource: SidecarMeta | null = null;
    for (const jsonl of allJsonls) {
        const dev = deviceIdFromJsonlPath(jsonl);
        if (!dev) continue;
        const meta = await readDeviceMeta(adapter, indexDir, dev);
        if (metaAccepts(meta, expect)) {
            accepted.push(jsonl);
            if (meta && meta.bgMean != null && meta.bgStd != null &&
                (bgSource == null || fullReindexEpoch(meta) > fullReindexEpoch(bgSource))) {
                bgSource = meta;
            }
        } else {
            refused++;
            if (meta && meta.chunkerVersion > expect.chunkerVersion) peerAhead = true;
            deps.onRefusedProducer?.(dev, meta, expect);
        }
    }
    const bg = { bgMean: bgSource?.bgMean, bgStd: bgSource?.bgStd };
    if (accepted.length === 0) {
        deps.log?.('sidecar-hydrate', { ...empty, refusedProducers: refused, peerAhead });
        return { ...empty, refusedProducers: refused, peerAhead };
    }

    // 2. Scan accepted producers → resolved id → location map.
    const scan = await scanJsonl(adapter, accepted);

    // 3. Cheap pre-gate — skip the whole-vault re-chunk when the scan surfaced no
    //    sidecar id this device is missing. chunk_id is a content hash, so an id
    //    already in IDB already holds the exact right vector (same id ⇒ same
    //    content ⇒ same deterministic embedding) — nothing to hydrate for it. And
    //    step 5 only ever admits a candidate note that has a chunk in scan.map AND
    //    NOT in `existing`, so "no id is fresh to us" PROVES "zero candidates": the
    //    re-chunk would do whole-vault work (read + tokenize every note, on the
    //    mobile main thread) to hydrate nothing. This collapses the common no-op
    //    syncs — a peer re-embedding SHARED notes, a peer compacting its sidecar,
    //    an mtime-churn re-append — all of which flip sidecarDirSignature yet add
    //    no id new to THIS device, from a full re-chunk into a scan + a membership
    //    test. `existing` is fetched here (before reChunk) so the gate runs first;
    //    the candidate loop reuses it. NOTE: the empty-store eviction case never
    //    reaches here as a no-op — an empty IDB has nothing in `existing`, so every
    //    synced id is fresh and the full re-chunk runs (mandatory recovery).
    const existing = await deps.existingIds();
    let hasFreshId = false;
    for (const id of scan.map.keys()) {
        if (!existing.has(id)) { hasFreshId = true; break; }
    }
    if (!hasFreshId) {
        const r: HydrateResult = { ...empty, ...bg, scanned: scan.map.size, refusedProducers: refused, acceptedProducers: accepted.length, peerAhead };
        deps.log?.('sidecar-hydrate-skip-rechunk', { scanned: scan.map.size, reason: 'no-fresh-ids' });
        deps.log?.('sidecar-hydrate', r);
        return r;
    }

    const freshIds = new Set<string>();
    for (const id of scan.map.keys()) {
        if (!existing.has(id)) freshIds.add(id);
    }
    const useGreedy = deps.greedyHydrate !== false
        && deps.reChunkSubset != null
        && deps.listHydrateFiles != null;
    if (useGreedy) {
        return hydrateFromSidecarGreedy(deps, scan, existing, freshIds, accepted, refused, peerAhead, bg);
    }

    // 4. Re-chunk the live vault (the liveness oracle). `existing` already fetched above.
    const live = await deps.reChunk();

    // 5–8. Select candidates and hydrate.
    const { candidates, needed } = selectCandidates(live, scan, existing, freshIds);
    if (candidates.length === 0) {
        const r: HydrateResult = { ...empty, ...bg, scanned: scan.map.size, refusedProducers: refused, acceptedProducers: accepted.length, peerAhead };
        deps.log?.('sidecar-hydrate', r);
        return r;
    }

    const { hydrated, skippedPartialNotes, hydratedNotePaths } = await hydrateCandidates(deps, candidates);

    const result: HydrateResult = {
        ...bg,
        scanned: scan.map.size,
        needed,
        hydrated,
        skippedPartialNotes,
        refusedProducers: refused,
        acceptedProducers: accepted.length,
        peerAhead,
        hydratedNotePaths,
    };
    deps.log?.('sidecar-hydrate', result);
    return result;
}
