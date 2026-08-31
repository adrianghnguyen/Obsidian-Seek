// Frame utility functions extracted from search.ts.
//
// These are pure functions that operate on the ResidentFrame data structure
// (the in-memory row space shared by all query tiers) and its incremental
// maintenance — no SearchOrchestrator dependency. Extracted so they can be
// unit-tested without booting a full orchestrator.

import type { Chunk, ChunkMeta, SeekSettings } from './types';
import type { QuantVec } from './quant';

// ── Candidate alignment ───────────────────────────────────────────────────
// Stage-2 candidate alignment decision: whether `v` (this candidate's fp32
// row) is usable, and — if not — the degraded ChunkMeta to rank it with
// instead of dropping it. A missing/mismatched row degrades to the same
// lexical-only floor ranker.ts already applies to body-less title-only chunks,
// rather than silently dropping a candidate BM25 may have ranked first.

export function alignCandidate(
    ch: ChunkMeta | undefined | null,
    v: Float32Array | null | undefined,
    queryDim: number,
): { chunk: ChunkMeta; missingFp32: boolean } | null {
    if (!ch) return null;
    const missingFp32 = !v || v.length !== queryDim;
    return { chunk: missingFp32 ? { ...ch, lexicalOnly: true } : ch, missingFp32 };
}

// Build the resident int8 rerank block from the store's QuantVec map.
// Returns null when any row is missing or the corpus is empty.
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
        if (!qv || qv.q.length !== embDim) return null;
        int8.set(qv.q, j * embDim);
        scales[j] = qv.s;
    }
    return { int8, scales, embDim };
}

// ── Resident frame ────────────────────────────────────────────────────────
// The query-time row space. All tiers are aligned row-for-row.

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

// One committed chunk's data needed to append it to the live frame.
export interface DeltaAdd {
    chunk: Chunk;
    q: QuantVec;
    bin: Uint8Array;
}

// Chunk-diff: full ChunkMeta equality via JSON comparison (property-order
// stable through chunker → structured-clone round trip via IDB).
export function chunkMetaEqual(a: ChunkMeta, b: ChunkMeta): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

// Append committed chunk tiers to a change-set sink.
export function pushDeltaAdds(
    sink: DeltaAdd[],
    chunks: Chunk[],
    tiers: { q: QuantVec; bin: Uint8Array }[],
): void {
    for (let i = 0; i < chunks.length; i++) {
        sink.push({ chunk: chunks[i], q: tiers[i].q, bin: tiers[i].bin });
    }
}

// Narrow a delta's adds to those NOT already live in the frame.
export function freshDeltaAdds(
    adds: DeltaAdd[],
    isLive: (id: string) => boolean,
): DeltaAdd[] {
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

// Strip body text for the metadata-only frame.
export function frameMetaOf(c: Chunk): ChunkMeta {
    const { content, ...meta } = c;
    void content;
    return meta;
}

// Append committed chunks to a live frame IN PLACE.
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

// Mark rows as not-live without removing them from the contiguous tiers.
export function tombstoneFrameRows(frame: ResidentFrame, rows: number[]): void {
    for (const row of rows) {
        if (row >= 0 && row < frame.validRows.length && frame.validRows[row]) {
            frame.validRows[row] = false;
            frame.tombstoneCount++;
        }
    }
}

// Per-row selection mask = live rows AND the optional inline-filter matcher.
// Returns undefined only when the frame is fully live with no matcher.
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

// A frame assembled at buildGen must be discarded when the index generation
// advanced while we were reading. True => discard.
export function shouldDiscardPartialFrame(
    buildGen: number,
    currentGen: number,
): boolean {
    return currentGen !== buildGen;
}