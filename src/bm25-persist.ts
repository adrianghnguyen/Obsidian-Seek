// BM25 persist stamp utilities extracted from search.ts.
//
// Identity of a persisted MiniSearch index — what must match for a stored
// blob to be loadable instead of refit. Pure functions, no SearchOrchestrator
// dependency. Tests in bm25-persist.test.ts.

import { ANALYZER_VERSION } from './bm25';
import { LEGACY_ENGLISH_MODEL_ID } from './embedder';
import type { SeekSettings } from './types';

// Type for MetaConfig subset used by stamp construction.
interface MetaConfig {
    modelId?: string | null;
    embeddingDim: number;
    lastIndexedAt?: string | null;
}

export interface Bm25PersistStamp {
    analyzerVersion: string;
    modelId: string;
    embeddingDim: number;
    lastIndexedAt: string;
    chunkCount: number;
    props: boolean;
    headings: boolean;
}

export function buildBm25Stamp(
    meta: MetaConfig,
    chunkCount: number,
    settings: SeekSettings,
): Bm25PersistStamp {
    return {
        analyzerVersion: ANALYZER_VERSION,
        modelId: meta.modelId ?? LEGACY_ENGLISH_MODEL_ID,
        embeddingDim: meta.embeddingDim,
        lastIndexedAt: meta.lastIndexedAt ?? '',
        chunkCount,
        props: settings.searchableProperties,
        headings: settings.headingsField || settings.boostedBm25,
    };
}

export function bm25StampMatches(
    stored: unknown,
    live: Bm25PersistStamp,
): boolean {
    if (!stored || typeof stored !== 'object') return false;
    const s = stored as Partial<Bm25PersistStamp>;
    // TOLERANT GATE: compare only the five correctness-critical fields.
    // lastIndexedAt + chunkCount are deliberately NOT compared — they change
    // on every delta/hydrate, so gating on them forced a cold all-bodies refit.
    return s.analyzerVersion === live.analyzerVersion
        && s.modelId === live.modelId
        && s.embeddingDim === live.embeddingDim
        && s.props === live.props
        && s.headings === live.headings;
}