import { describe, it, expect } from 'vitest';
import { DEFAULT_FIELD_BOOSTS } from './bm25';
import {
    BOOSTED_BM25_OVERRIDES,
    BM25_FIELD_BOOST_MAX,
    BM25_FIELD_BOOST_MIN,
    clampBm25FieldBoost,
    clearBm25FieldBoostOverrides,
    resolveBm25FieldBoosts,
    setBm25FieldBoostOverride,
} from './bm25-boosts';
import { DEFAULT_SETTINGS, type SeekSettings } from './types';

function settings(partial: Partial<SeekSettings> = {}): SeekSettings {
    return { ...structuredClone(DEFAULT_SETTINGS), ...partial };
}

describe('resolveBm25FieldBoosts', () => {
    it('returns DEFAULT_FIELD_BOOSTS with no overrides', () => {
        expect(resolveBm25FieldBoosts(settings())).toEqual({
            title: DEFAULT_FIELD_BOOSTS.title,
            aliases: DEFAULT_FIELD_BOOSTS.aliases,
            tags: DEFAULT_FIELD_BOOSTS.tags,
            content: DEFAULT_FIELD_BOOSTS.content,
            properties: DEFAULT_FIELD_BOOSTS.properties,
            headings: DEFAULT_FIELD_BOOSTS.headings,
        });
    });

    it('applies boostedBm25 preset when there are no overrides', () => {
        expect(resolveBm25FieldBoosts(settings({ boostedBm25: true }))).toEqual({
            title: DEFAULT_FIELD_BOOSTS.title,
            aliases: BOOSTED_BM25_OVERRIDES.aliases,
            tags: BOOSTED_BM25_OVERRIDES.tags,
            content: DEFAULT_FIELD_BOOSTS.content,
            properties: DEFAULT_FIELD_BOOSTS.properties,
            headings: BOOSTED_BM25_OVERRIDES.headings,
        });
    });

    it('merges a partial override over defaults', () => {
        const out = resolveBm25FieldBoosts(settings({
            bm25FieldBoostOverrides: { headings: 5 },
        }));
        expect(out.headings).toBe(5);
        expect(out.title).toBe(DEFAULT_FIELD_BOOSTS.title);
        expect(out.content).toBe(DEFAULT_FIELD_BOOSTS.content);
    });

    it('supersedes boostedBm25 when any override is set', () => {
        const out = resolveBm25FieldBoosts(settings({
            boostedBm25: true,
            bm25FieldBoostOverrides: { headings: 5 },
        }));
        // Custom headings wins; aliases/tags stay at DEFAULT, not the boosted preset
        expect(out.headings).toBe(5);
        expect(out.aliases).toBe(DEFAULT_FIELD_BOOSTS.aliases);
        expect(out.tags).toBe(DEFAULT_FIELD_BOOSTS.tags);
    });

    it('clamps out-of-range and rejects NaN', () => {
        const out = resolveBm25FieldBoosts(settings({
            bm25FieldBoostOverrides: {
                title: 100,
                content: 0,
                headings: Number.NaN,
            },
        }));
        expect(out.title).toBe(BM25_FIELD_BOOST_MAX);
        expect(out.content).toBe(BM25_FIELD_BOOST_MIN);
        expect(out.headings).toBe(DEFAULT_FIELD_BOOSTS.headings);
    });
});

describe('clampBm25FieldBoost', () => {
    it('snaps to 0.5 steps within bounds', () => {
        expect(clampBm25FieldBoost(5.2, 3)).toBe(5);
        expect(clampBm25FieldBoost(5.3, 3)).toBe(5.5);
        expect(clampBm25FieldBoost(-1, 3)).toBe(BM25_FIELD_BOOST_MIN);
    });
});

describe('setBm25FieldBoostOverride / clear', () => {
    it('stores a non-default value and clears when restored to recommended', () => {
        const s = settings();
        setBm25FieldBoostOverride(s, 'headings', 5);
        expect(s.bm25FieldBoostOverrides).toEqual({ headings: 5 });
        setBm25FieldBoostOverride(s, 'headings', DEFAULT_FIELD_BOOSTS.headings);
        expect(s.bm25FieldBoostOverrides).toBeUndefined();
    });

    it('clearBm25FieldBoostOverrides wipes all custom weights', () => {
        const s = settings({ bm25FieldBoostOverrides: { title: 12, headings: 5 } });
        clearBm25FieldBoostOverrides(s);
        expect(s.bm25FieldBoostOverrides).toBeUndefined();
        expect(resolveBm25FieldBoosts(s).headings).toBe(DEFAULT_FIELD_BOOSTS.headings);
    });
});
