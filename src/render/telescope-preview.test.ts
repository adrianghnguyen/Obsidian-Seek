import { describe, expect, it } from 'vitest';
import {
    classifyPreviewLines,
    segmentPreviewLine,
    telescopeQueryTerms,
    MAX_LINE_CHARS,
} from './telescope-preview';

const seg = (text: string, style: 'link' | 'tag' | null = null, mark = false) => ({
    text,
    style,
    mark,
});

describe('telescope-preview', () => {
    it('telescopeQueryTerms drops short tokens and dedupes', () => {
        expect(telescopeQueryTerms('Data  data  a  -skip')).toEqual(['data']);
    });

    it('classifyPreviewLines handles headings and fenced code', () => {
        const lines = ['# Title', '## Sub', '```js', '# not heading', '```', 'plain'];
        expect(classifyPreviewLines(lines)).toEqual([
            { kind: 'h1', text: 'Title' },
            { kind: 'h2', text: 'Sub' },
            { kind: 'code', text: '```js' },
            { kind: 'code', text: '# not heading' },
            { kind: 'code', text: '```' },
            { kind: 'text', text: 'plain' },
        ]);
    });

    it('segmentPreviewLine splits links, tags, and marks', () => {
        const budget = { marks: 200, styles: 2000 };
        const parts = segmentPreviewLine('See [[Note]] and #tag for data', ['data', 'tag'], budget, false);
        expect(parts[0]).toEqual(seg('See '));
        expect(parts[1]).toEqual(seg('[[Note]]', 'link'));
        expect(parts.some(p => p.style === 'tag' && p.mark && p.text === 'tag')).toBe(true);
        expect(parts.some(p => !p.style && p.mark && p.text === 'data')).toBe(true);
    });

    it('segmentPreviewLine prefers longest term and respects mark budget', () => {
        const budget = { marks: 1, styles: 2000 };
        const out = segmentPreviewLine('database base', ['data', 'database', 'base'], budget, false);
        expect(out.some(s => s.mark && s.text.toLowerCase() === 'database')).toBe(true);
        expect(budget.marks).toBe(0);
    });

    it('segmentPreviewLine truncates very long lines at MAX_LINE_CHARS', () => {
        const long = 'x'.repeat(MAX_LINE_CHARS + 10);
        const budget = { marks: 200, styles: 2000 };
        const out = segmentPreviewLine(long, [], budget, true);
        const joined = out.map(s => s.text).join('');
        expect(joined.endsWith('…')).toBe(true);
        expect(joined.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 1);
    });
});
