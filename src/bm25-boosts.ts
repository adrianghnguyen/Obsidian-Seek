// Per-search BM25 field-weight resolution.
//
// DEFAULT_FIELD_BOOSTS (bm25.ts) are the eval-tuned shipped defaults. Users can
// override individual fields via SeekSettings.bm25FieldBoostOverrides (Settings →
// Relevance → Advanced). Overrides are score-time only — they flow into
// getScoresWithCoverage({ boosts }) and never trigger an embedding reindex or
// BM25 index-shape refit.
//
// Legacy boostedBm25 preset (aliases 9 / tags 2 / headings 4) still applies when
// there are no overrides; any custom override supersedes that preset.

import { DEFAULT_FIELD_BOOSTS } from './bm25';
import type { SeekSettings } from './types';

export const BM25_FIELD_KEYS = [
    'title',
    'aliases',
    'tags',
    'content',
    'properties',
    'headings',
] as const;

export type Bm25FieldKey = (typeof BM25_FIELD_KEYS)[number];
export type Bm25FieldBoosts = Record<Bm25FieldKey, number>;

/** Min/max for UI sliders and clamp on resolve — wide enough to experiment, bounded for fusion. */
export const BM25_FIELD_BOOST_MIN = 0.5;
export const BM25_FIELD_BOOST_MAX = 20;
export const BM25_FIELD_BOOST_STEP = 0.5;

/** Hidden boostedBm25 preset — kept for backward compat with persisted data.json. */
export const BOOSTED_BM25_OVERRIDES: Pick<Bm25FieldBoosts, 'aliases' | 'tags' | 'headings'> = {
    aliases: 9.0,
    tags: 2.0,
    headings: 4.0,
};

export function clampBm25FieldBoost(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    const stepped = Math.round(value / BM25_FIELD_BOOST_STEP) * BM25_FIELD_BOOST_STEP;
    return Math.min(BM25_FIELD_BOOST_MAX, Math.max(BM25_FIELD_BOOST_MIN, stepped));
}

function hasAnyOverride(overrides: Partial<Bm25FieldBoosts> | undefined): boolean {
    if (!overrides) return false;
    for (const key of BM25_FIELD_KEYS) {
        if (overrides[key] !== undefined) return true;
    }
    return false;
}

/**
 * Effective field boosts for the next search.
 * - No overrides + boostedBm25 → DEFAULT + BOOSTED_BM25_OVERRIDES
 * - Any override present → DEFAULT merged with clamped overrides (boostedBm25 ignored)
 * - Otherwise → DEFAULT_FIELD_BOOSTS
 */
export function resolveBm25FieldBoosts(settings: Pick<SeekSettings, 'boostedBm25' | 'bm25FieldBoostOverrides'>): Bm25FieldBoosts {
    const base: Bm25FieldBoosts = {
        title: DEFAULT_FIELD_BOOSTS.title,
        aliases: DEFAULT_FIELD_BOOSTS.aliases,
        tags: DEFAULT_FIELD_BOOSTS.tags,
        content: DEFAULT_FIELD_BOOSTS.content,
        properties: DEFAULT_FIELD_BOOSTS.properties,
        headings: DEFAULT_FIELD_BOOSTS.headings,
    };

    const overrides = settings.bm25FieldBoostOverrides;
    if (hasAnyOverride(overrides)) {
        const out = { ...base };
        for (const key of BM25_FIELD_KEYS) {
            const raw = overrides![key];
            if (raw === undefined) continue;
            out[key] = clampBm25FieldBoost(raw, base[key]);
        }
        return out;
    }

    if (settings.boostedBm25) {
        return { ...base, ...BOOSTED_BM25_OVERRIDES };
    }
    return base;
}

/** Persist a single field override; omit keys that match the recommended default. */
export function setBm25FieldBoostOverride(
    settings: SeekSettings,
    key: Bm25FieldKey,
    value: number,
): void {
    const recommended = DEFAULT_FIELD_BOOSTS[key];
    const clamped = clampBm25FieldBoost(value, recommended);
    const next: Partial<Bm25FieldBoosts> = { ...(settings.bm25FieldBoostOverrides ?? {}) };
    if (clamped === recommended) {
        delete next[key];
    } else {
        next[key] = clamped;
    }
    const remaining = BM25_FIELD_KEYS.some(k => next[k] !== undefined);
    settings.bm25FieldBoostOverrides = remaining ? next : undefined;
}

/** Clear all custom field weights (restore recommended defaults). */
export function clearBm25FieldBoostOverrides(settings: SeekSettings): void {
    settings.bm25FieldBoostOverrides = undefined;
}
