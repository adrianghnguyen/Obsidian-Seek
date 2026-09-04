import type { SeekSettings } from './types';
import type { MetaConfig } from './index-store';
import { ANALYZER_VERSION } from './bm25';
import { LEGACY_ENGLISH_MODEL_ID } from './embedder';

// Identity of a persisted MiniSearch index — what must match for a stored blob
// to be loadable instead of refit. Two classes of input:
//   - analyzerVersion: a build-time content hash of the analyzer sources
//     (bm25.ts + tokenize.ts + prop-normalize.ts + MiniSearch version). Collapses
//     EVERY code/constant input that decides the token space — tokenizer,
//     processTerm, depluralize tables, field list, boosts, bm25 params,
//     combineWith — into one string. A loaded index uses its OWN postings but the
//     CURRENT analyzer (loadJSON re-supplies it and does NOT check it matches), so
//     a changed analyzer must invalidate the blob; the hash does that automatically.
//   - the runtime values a static hash can't see: model/dim (a model swap drops
//     chunks) and the two index-shape toggles props/headings — all GATED.
//   - lastIndexedAt + chunkCount: WRITTEN for diagnostics (and a possible future
//     tighter gate) but NOT gated as of 2026-06-20 — see bm25StampMatches for why
//     a stale-but-compatible blob is safe to load (content-derived ids → drift is
//     invisibility, not error). They were the churn fields that forced the freeze.
// A GATED field differing ⇒ refit (relevance-identical). generation is NOT here: it
// resets to 0 every process, so a disk blob would never match a fresh session.
export interface Bm25PersistStamp {
    analyzerVersion: string;
    modelId: string;
    embeddingDim: number;
    lastIndexedAt: string;
    chunkCount: number;
    props: boolean;
    headings: boolean;
}

export function buildBm25Stamp(meta: MetaConfig, chunkCount: number, settings: SeekSettings): Bm25PersistStamp {
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

export function bm25StampMatches(stored: unknown, live: Bm25PersistStamp): boolean {
    if (!stored || typeof stored !== 'object') return false;
    const s = stored as Partial<Bm25PersistStamp>;
    // TOLERANT GATE (2026-06-20): compare only the five CORRECTNESS-critical fields.
    // lastIndexedAt + chunkCount are deliberately NOT compared — they change on every
    // delta/hydrate, so gating on them rejected the blob on every churn event and
    // forced a cold all-bodies refit (the 18.6 s mobile freeze). Dropping them admits
    // a stale-but-compatible blob, which is SAFE by construction: chunk_id is content-
    // derived (chunkIdFor), so an edited chunk gets a NEW id, and getScoresWithCoverage
    // skips any posting whose id isn't in the live frame (bm25.ts `if (idx===undefined)
    // continue`) while a live chunk absent from the postings keeps its 0 default. So
    // staleness = edited/new chunks briefly lexical-invisible (reconciled by the next
    // delta / catch-up), NEVER wrong text or a crash. The five retained fields are
    // orthogonal to corpus size/timestamp, so a genuinely incompatible blob (changed
    // analyzer/model/dim/index-shape) still rejects in its own field. buildBm25Stamp
    // still WRITES both churn fields (diagnostics + a future tighter gate); we just
    // stop gating on them. tryLoadPersistedBm25 keeps its `meta.lastIndexedAt` presence
    // check, so a never-completed index is still never loaded.
    return s.analyzerVersion === live.analyzerVersion
        && s.modelId === live.modelId
        && s.embeddingDim === live.embeddingDim
        && s.props === live.props
        && s.headings === live.headings;
}
