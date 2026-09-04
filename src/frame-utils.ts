/**
 * @file frame-utils.ts
 * @module FrameUtils
 *
 * ## Responsibilities
 * Stateless low-level operations for Seek's in-memory query row space (`ResidentFrame`):
 * - Flat memory layout for 1-bit packed sign vectors (`activePacked`), resident int8
 *   quantized vectors (`residentInt8`), row scale factors (`residentScales`), and row
 *   validity bitsets (`validRows`).
 * - In-place row mutations: appending new chunk rows (`appendFrameRows`) and marking
 *   deleted/updated chunks as tombstones (`tombstoneFrameRows`) without reallocating arrays.
 * - Quantized vector block assembly (`buildResidentRerankBlock`) and candidate alignment
 *   (`alignCandidate`) for Stage 2 reranking.
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: Pure foundation layer. Has ZERO dependencies on `SearchOrchestrator`,
 *   `IndexStore`, or Obsidian runtime values. Can be tested and loaded in isolation.
 * - **Call-order prerequisite**: Frame mutations (`appendFrameRows`, `tombstoneFrameRows`)
 *   MUST be executed in lockstep with lexical index mutations (`MultiFieldBM25.add`,
 *   `MultiFieldBM25.remove`) under `IndexCoordinator.runExclusive`.
 * - **Coherence Invariant**: Row index `i` in `orderedChunks[i]`, `orderedIds[i]`,
 *   `activePacked[i * bytesPerVec...]`, and `residentInt8[i * embDim...]` MUST correspond 1:1
 *   with the BM25 internal doc index `idToIdx.get(id)`. Any divergence constitutes drift
 *   and triggers cache invalidation via `coherence.ts`.
 */

import type { Chunk, ChunkMeta } from './types';
import type { QuantVec } from './quant';

export function alignCandidate(
    ch: ChunkMeta | undefined | null,
    v: Float32Array | null | undefined,
    queryDim: number,
): { chunk: ChunkMeta; missingFp32: boolean } | null {
    if (!ch) return null;
    const missingFp32 = !v || v.length !== queryDim;
    return { chunk: missingFp32 ? { ...ch, lexicalOnly: true } : ch, missingFp32 };
}

export function buildResidentRerankBlock(
    orderedIds: string[],
    embById: Map<string, QuantVec>,
): { int8: Int8Array; scales: Float64Array; embDim: number } | null {
    const n = orderedIds.length;
    if (n === 0) return null;
    const first = embById.get(orderedIds[0]);
    const embDim = first ? first.q.length : 0;
    if (embDim === 0) return null;
    const int8 = new Int8Array(n * embDim);
    const scales = new Float64Array(n);
    for (let j = 0; j < n; j++) {
        const qv = embById.get(orderedIds[j]);
        if (!qv || qv.q.length !== embDim) return null;   // all-or-nothing
        int8.set(qv.q, j * embDim);
        scales[j] = qv.s;
    }
    return { int8, scales, embDim };
}

// ── Resident frame (Seek scaling A1) ─────────────────────────────────────────
// The query-time row space. All tiers are aligned row-for-row: row i is
// orderedChunks[i] / orderedIds[i] / activePacked[i*bytesPerVec…] /
// residentInt8[i*embDim…] (scale residentScales[i]) / validRows[i], and the BM25
// idToIdx maps that same id→i. A single `idx` joins all of them at search time,
// so the numbering MUST stay coherent — appendFrameRows/tombstoneFrameRows below
// mutate it in lockstep with MultiFieldBM25.add/remove, and a runtime drift
// detector (applyDelta) re-checks the coupling and falls back to a full rebuild
// if it ever diverges. tombstoneCount tracks rows whose validRows flag is false
// (deleted/edited-away, awaiting compaction).
export interface ResidentFrame {
    orderedChunks: ChunkMeta[];
    orderedIds: string[];
    activePacked: Uint8Array;
    bytesPerVec: number;
    residentInt8: Int8Array | null;
    residentScales: Float64Array | null;
    embDim: number;
    validRows: boolean[];
    tombstoneCount: number;
    generation: number;
}

// One committed chunk's data needed to append it to the live frame + BM25 index.
// reindexDelta already holds exactly this at commit time (commitFile derives
// {q, bin} from the fp32 vector; fs.chunks still carry content): the change-set
// it currently discards at invalidateBm25Cache().
export interface DeltaAdd {
    chunk: Chunk;       // full chunk: content feeds BM25's body, the rest is frame meta
    q: QuantVec;        // int8 rerank tier (resident block row)
    bin: Uint8Array;    // sign-bit binary tier (activePacked row)
}

// Append committed chunks + their derived tiers to a change-set sink. Shared by
// BOTH commit paths so they surface identically into applyDelta: commitFile
// (model-embedded, derived = quantizeInt8/packSignBits) and the sidecar hydrate
// (bytes copied from a peer's shard, tiers = {q, bin}). chunks[i] aligns with
// tiers[i].
// Chunk-diff commit (issue #5): full ChunkMeta equality — the "untouched" gate.
// JSON compare is sound here because both sides come off the same construction
// pipeline (the chunker for the new side; the chunker → structured-clone round
// trip through IDB for the old side), which preserves property insertion order.
// A false "changed" only costs a cheap meta-patch, never a wrong index.
export function chunkMetaEqual(a: ChunkMeta, b: ChunkMeta): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function pushDeltaAdds(sink: DeltaAdd[], chunks: Chunk[], tiers: { q: QuantVec; bin: Uint8Array }[]): void {
    for (let i = 0; i < chunks.length; i++) {
        sink.push({ chunk: chunks[i], q: tiers[i].q, bin: tiers[i].bin });
    }
}

// Narrow a delta's adds to those NOT already live in the BM25 row space, and drop
// any within-batch duplicate ids. THE guard for the 2026-06-18 mobile meltdown:
// hydrate-sourced adds (scaling A1) can carry a chunk_id that is already live in
// the in-memory `bm`. hydrateFromSidecar's candidate selector skips a note only
// when EVERY chunk is in IDB (existingIds reads IDB, NOT the in-memory cache), so
// after an IDB↔cache divergence (a crash / partial commit) a note re-surfaces ids
// `bm` already holds as PURE adds — with no matching remove, because the
// IDB-driven deleteFile produced none for an id IDB never had. The unguarded
// loop then called bm.add() on a live id, which MiniSearch THROWS on ("duplicate
// ID"); the throw aborted applyDelta mid-patch, left frame/BM25 mis-coupled, and
// every reconcile re-tripped it → toast + rebuild loop → thermal crash.
//
// Safe to skip because chunk_id is content-addressed (cyrb53 of path+title+body):
// a live id ⟹ a byte-identical chunk ⟹ the re-add is a pure no-op (the IDB write
// already landed in putQuantized). Caller MUST run this AFTER dropping removedIds
// from `bm`, so an edit that re-commits the same content-hash id is NOT filtered
// (its id is no longer live by then) — only genuine already-live duplicates are.
// Apply the SAME filtered list to bm.add AND appendFrameRows so the two row
// spaces stay aligned (a guard on bm.add alone would desync the frame and re-trip
// the very drift detector this prevents).
export function freshDeltaAdds(adds: DeltaAdd[], isLive: (id: string) => boolean): DeltaAdd[] {
    const out: DeltaAdd[] = [];
    const seen = new Set<string>();
    for (const a of adds) {
        const id = a.chunk.chunk_id;
        if (seen.has(id) || isLive(id)) continue;
        seen.add(id);
        out.push(a);
    }
    return out;
}

// Strip body text for the metadata-only frame (mirrors index-store.stripContent).
export function frameMetaOf(c: Chunk): ChunkMeta {
    const { content, ...meta } = c;
    void content;
    return meta;
}

// Append committed chunks to a live frame IN PLACE. One realloc of the contiguous
// tiers per BURST (not per chunk): a ~R-byte copy, negligible beside the O(N)
// BM25 fit() the incremental path eliminates. The binary + metadata tiers grow
// UNCONDITIONALLY — skipping them on the resident-disabled (mobile) path would
// skew the binary scan's row space from the frame's. The int8 rerank tier grows
// only when it's live (desktop/in-budget); on mobile it stays null and stage-2
// falls back to the per-id IDB read. The block may drift slightly over the byte
// budget here — the next cold rebuild / compaction re-gates it via
// residentInt8Enabled. New rows are assigned ids in array order, matching
// MultiFieldBM25.add (row = chunkCount), so frame row === bm25 idToIdx row.
export function appendFrameRows(frame: ResidentFrame, adds: DeltaAdd[]): void {
    if (adds.length === 0) return;
    const oldRows = frame.orderedIds.length;
    const k = adds.length;
    const bpv = frame.bytesPerVec;

    const newPacked = new Uint8Array((oldRows + k) * bpv);
    newPacked.set(frame.activePacked.subarray(0, oldRows * bpv), 0);
    for (let j = 0; j < k; j++) newPacked.set(adds[j].bin, (oldRows + j) * bpv);
    frame.activePacked = newPacked;

    if (frame.residentInt8 && frame.residentScales) {
        const d = frame.embDim;
        const newInt8 = new Int8Array((oldRows + k) * d);
        newInt8.set(frame.residentInt8.subarray(0, oldRows * d), 0);
        const newScales = new Float64Array(oldRows + k);
        newScales.set(frame.residentScales.subarray(0, oldRows), 0);
        for (let j = 0; j < k; j++) {
            newInt8.set(adds[j].q.q, (oldRows + j) * d);
            newScales[oldRows + j] = adds[j].q.s;
        }
        frame.residentInt8 = newInt8;
        frame.residentScales = newScales;
    }

    for (let j = 0; j < k; j++) {
        frame.orderedChunks.push(frameMetaOf(adds[j].chunk));
        frame.orderedIds.push(adds[j].chunk.chunk_id);
        frame.validRows.push(true);
    }
}

// Tombstone rows (mark not-live). The contiguous tiers keep their bytes (holes);
// validRows masks them out at selection, browse, and recency. Idempotent and
// bounds-guarded so a stale/duplicate row can't drive tombstoneCount negative.
export function tombstoneFrameRows(frame: ResidentFrame, rows: number[]): void {
    for (const row of rows) {
        if (row >= 0 && row < frame.validRows.length && frame.validRows[row]) {
            frame.validRows[row] = false;
            frame.tombstoneCount++;
        }
    }
}

// Per-row selection mask = live rows (validRows) AND the optional inline-filter
// matcher. Returns undefined ONLY when the frame is fully live AND there's no
// matcher — the byte-identical no-filter fast path. Otherwise a defined mask,
// even with no filter, so tombstones are excluded from the filter-only browse
// path (its `!mask ||` short-circuit would otherwise admit every row, including
// holes). && short-circuits so a tombstoned row's stale ChunkMeta is never read.
export function buildSelectionMask(
    orderedChunks: ChunkMeta[],
    validRows: boolean[],
    tombstoneCount: number,
    matcher: ((c: ChunkMeta) => boolean) | null,
): boolean[] | undefined {
    if (!matcher && tombstoneCount === 0) return undefined;
    const n = orderedChunks.length;
    const mask = new Array<boolean>(n);
    for (let i = 0; i < n; i++) {
        mask[i] = validRows[i] && (matcher ? matcher(orderedChunks[i]) : true);
    }
    return mask;
}
