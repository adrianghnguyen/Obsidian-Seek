import { describe, expect, it } from 'vitest';
import { dedupeAliasesAgainstBasename, sliceResultAliases } from './result-aliases';

describe('dedupeAliasesAgainstBasename', () => {
    it('drops aliases equal to basename (case-insensitive)', () => {
        expect(dedupeAliasesAgainstBasename(['Note', 'Alias'], 'note')).toEqual(['Alias']);
    });

    it('dedupes duplicate aliases', () => {
        expect(dedupeAliasesAgainstBasename(['A', 'a', 'B'], 'Title')).toEqual(['A', 'B']);
    });
});

describe('sliceResultAliases', () => {
    const aliases = ['A1', 'A2', 'A3', 'A4', 'A5'];

    it('shows all when limit is 0 (unlimited)', () => {
        const s = sliceResultAliases(aliases, 'Note', 0, false, null);
        expect(s.visible).toEqual(aliases);
        expect(s.hiddenCount).toBe(0);
    });

    it('truncates to limit with hidden count', () => {
        const s = sliceResultAliases(aliases, 'Note', 3, false, null);
        expect(s.visible).toEqual(['A1', 'A2', 'A3']);
        expect(s.hiddenCount).toBe(2);
    });

    it('shows all when expanded', () => {
        const s = sliceResultAliases(aliases, 'Note', 3, true, null);
        expect(s.visible).toEqual(aliases);
        expect(s.hiddenCount).toBe(0);
    });

    it('promotes matched alias into collapsed slice', () => {
        const s = sliceResultAliases(aliases, 'Note', 3, false, 'A5');
        expect(s.visible).toContain('A5');
        expect(s.visible).toHaveLength(3);
        expect(s.hiddenCount).toBe(2);
    });

    it('returns empty slice for no aliases', () => {
        const s = sliceResultAliases([], 'Note', 3, false, null);
        expect(s.visible).toEqual([]);
        expect(s.hiddenCount).toBe(0);
    });
});
