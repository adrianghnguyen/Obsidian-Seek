import { describe, expect, it } from 'vitest';
import {
    applySearchModalSizePx,
    resolveSearchModalWidthPx,
    resolveSearchModalWidthPxFromEnum,
} from './search-modal-size';

describe('resolveSearchModalWidthPx', () => {
    it('returns px widths on desktop', () => {
        expect(resolveSearchModalWidthPx(640, false)).toBe(640);
        expect(resolveSearchModalWidthPx(800, false)).toBe(800);
        expect(resolveSearchModalWidthPx(960, false)).toBe(960);
        expect(resolveSearchModalWidthPx(500, false)).toBe(500);
    });

    it('never goes below the tablet floor', () => {
        expect(resolveSearchModalWidthPx(640, true)).toBe(820);
        expect(resolveSearchModalWidthPx(800, true)).toBe(820);
        expect(resolveSearchModalWidthPx(960, true)).toBe(960);
    });

    it('legacy enum helper matches px', () => {
        expect(resolveSearchModalWidthPxFromEnum('wide', false)).toBe(800);
    });
});

describe('applySearchModalSizePx', () => {
    it('sets CSS vars on desktop', () => {
        const props = new Map<string, string>();
        const el = {
            style: {
                setProperty: (k: string, v: string) => props.set(k, v),
                getPropertyValue: (k: string) => props.get(k) ?? '',
                width: '',
                maxWidth: '',
                maxHeight: '',
                marginTop: '',
            },
            querySelector: () => null,
        } as unknown as HTMLElement;
        applySearchModalSizePx(el, 800, 'tall', { isPhone: false, isTablet: false });
        expect(props.get('--seek-modal-width')).toBe('800px');
        expect(props.get('--seek-modal-max-height')).toBe('82vh');
        expect(props.get('--seek-modal-margin-top')).toBe('6vh');
        expect(el.style.width).toBe('800px');
        expect(el.style.maxHeight).toBe('82vh');
    });

    it('skips phones (full-width mobile shell)', () => {
        const props = new Map<string, string>();
        const el = {
            style: {
                setProperty: (k: string, v: string) => props.set(k, v),
                getPropertyValue: (k: string) => props.get(k) ?? '',
                width: '',
                maxWidth: '',
                maxHeight: '',
                marginTop: '',
            },
            querySelector: () => null,
        } as unknown as HTMLElement;
        applySearchModalSizePx(el, 960, 'extra-tall', { isPhone: true, isTablet: false });
        expect(props.size).toBe(0);
    });
});
