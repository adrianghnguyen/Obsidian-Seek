import { describe, it, expect } from 'vitest';
import {
    parseTextSearchMode,
    describeTextSearchMode,
    bodyMatchesTextMode,
} from './text-search-mode';

describe('parseTextSearchMode', () => {
    it('hybrid for plain keywords', () => {
        const { mode } = parseTextSearchMode('kubernetes deployment');
        expect(mode.kind).toBe('hybrid');
        expect(describeTextSearchMode(mode)).toBeNull();
    });

    it('exact phrase from double quotes', () => {
        const { mode } = parseTextSearchMode('"api key"');
        expect(mode.kind).toBe('exact');
        expect(mode.literals).toEqual(['api key']);
        expect(describeTextSearchMode(mode)).toBe('Exact phrase');
    });

    it('multiple literals AND', () => {
        const { mode } = parseTextSearchMode('"foo" "bar"');
        expect(mode.literals).toEqual(['foo', 'bar']);
        expect(describeTextSearchMode(mode)).toMatch(/2 literal/);
    });

    it('+word sugar', () => {
        const { mode } = parseTextSearchMode('+api +key');
        expect(mode.kind).toBe('exact');
        expect(mode.literals).toEqual(['api', 'key']);
    });

    it('phrase plus bare literal term', () => {
        const { mode } = parseTextSearchMode('"api key" rollout');
        expect(mode.literals).toEqual(['api key']);
        expect(mode.bareTerms).toEqual(['rollout']);
    });

    it('regex mode', () => {
        const { mode } = parseTextSearchMode('/error-\\d+/');
        expect(mode.kind).toBe('regex');
        expect(mode.regex).not.toBeNull();
        expect(describeTextSearchMode(mode)).toBe('Regex');
    });

    it('invalid regex', () => {
        const { mode } = parseTextSearchMode('/(/');
        expect(mode.regexInvalid).toBe(true);
        expect(describeTextSearchMode(mode)).toBe('Regex invalid');
    });

    it('case-sensitive tilde prefix', () => {
        const { mode } = parseTextSearchMode('~"Foo"');
        expect(mode.matchCase).toBe(true);
        expect(mode.literals).toEqual(['Foo']);
    });

    it('open quote does not trigger exact lane', () => {
        const { mode } = parseTextSearchMode('"open only');
        expect(mode.kind).toBe('hybrid');
    });
});

describe('bodyMatchesTextMode', () => {
    it('requires all literals', () => {
        const { mode } = parseTextSearchMode('"needle" haystack');
        expect(bodyMatchesTextMode('archive needle haystack phrase', mode)).toBe(true);
        expect(bodyMatchesTextMode('needle only', mode)).toBe(false);
    });
});
