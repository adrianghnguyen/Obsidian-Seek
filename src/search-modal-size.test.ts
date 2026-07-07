import { describe, expect, it } from 'vitest';
import { applySearchModalSize, resolveSearchModalWidthPx } from './search-modal-size';

describe('resolveSearchModalWidthPx', () => {
    it('returns preset widths on desktop', () => {
        expect(resolveSearchModalWidthPx('default', false)).toBe(640);
        expect(resolveSearchModalWidthPx('wide', false)).toBe(800);
        expect(resolveSearchModalWidthPx('extra-wide', false)).toBe(960);
    });

    it('never goes below the tablet floor', () => {
        expect(resolveSearchModalWidthPx('default', true)).toBe(820);
        expect(resolveSearchModalWidthPx('wide', true)).toBe(820);
        expect(resolveSearchModalWidthPx('extra-wide', true)).toBe(960);
    });
});

describe('applySearchModalSize', () => {
    it('sets CSS vars on desktop', () => {
        const props = new Map<string, string>();
        const el = {
            style: {
                setProperty: (k: string, v: string) => props.set(k, v),
                getPropertyValue: (k: string) => props.get(k) ?? '',
            },
        } as unknown as HTMLElement;
        applySearchModalSize(el, 'wide', 'tall', { isPhone: false, isTablet: false });
        expect(props.get('--seek-modal-width')).toBe('800px');
        expect(props.get('--seek-modal-max-height')).toBe('82vh');
        expect(props.get('--seek-modal-margin-top')).toBe('6vh');
    });

    it('skips phones (full-width mobile shell)', () => {
        const props = new Map<string, string>();
        const el = {
            style: {
                setProperty: (k: string, v: string) => props.set(k, v),
                getPropertyValue: (k: string) => props.get(k) ?? '',
            },
        } as unknown as HTMLElement;
        applySearchModalSize(el, 'extra-wide', 'extra-tall', { isPhone: true, isTablet: false });
        expect(props.size).toBe(0);
    });
});
