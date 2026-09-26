/**
 * Stamp + shape checks for the persisted packed sign frame.
 *
 * The blob is one IndexedDB record (ids + concatenated sign bytes), the same
 * idea as the BM25 blob: a cold boot loads it with a single get instead of
 * cursor-walking every `binary` row. It is a cache. A miss falls back to
 * listAllBinary() and rewrites the blob.
 *
 * Gated fields are model id and embedding dim. Chunk count is written for
 * diagnostics only. Corpus identity is NOT a stamp field — chunk ids are
 * content-derived, so the caller checks that every live chunk id is present
 * in the blob. A missing id means a new or edited chunk and forces the walk.
 * Same ids imply the same sign bits (the id is the embedded text).
 */

import type { MetaConfig } from './index-store';
import { LEGACY_ENGLISH_MODEL_ID } from './embedder';

export interface SignFramePersistStamp {
    modelId: string;
    embeddingDim: number;
    /** Diagnostic only — not compared by signFrameStampMatches. */
    chunkCount: number;
}

export function buildSignFrameStamp(meta: MetaConfig, chunkCount: number): SignFramePersistStamp {
    return {
        modelId: meta.modelId ?? LEGACY_ENGLISH_MODEL_ID,
        embeddingDim: meta.embeddingDim,
        chunkCount,
    };
}

export function signFrameStampMatches(stored: unknown, live: SignFramePersistStamp): boolean {
    if (!stored || typeof stored !== 'object') return false;
    const s = stored as Partial<SignFramePersistStamp>;
    return s.modelId === live.modelId && s.embeddingDim === live.embeddingDim;
}

export function signFramePackedShapeOk(
    ids: readonly string[],
    packed: Uint8Array,
    bytesPerVec: number,
): boolean {
    return ids.length > 0
        && bytesPerVec > 0
        && packed.byteLength === ids.length * bytesPerVec;
}

/** True when every live chunk id is in the blob. Extra blob ids (orphans) are fine. */
export function signFrameCoversChunks(
    ids: readonly string[],
    chunks: readonly { chunk_id: string }[],
): boolean {
    if (chunks.length === 0) return false;
    const have = new Set(ids);
    for (const c of chunks) {
        if (!have.has(c.chunk_id)) return false;
    }
    return true;
}

export function asSignPacked(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return null;
}
