import { describe, expect, it } from 'vitest';
import {
    applySearchModalWidthPresetSlot,
    cycleSearchModalWidthPx,
    DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX,
    normalizeSearchModalWidthPresetsPx,
    searchModalWidthPresetCycleLabel,
    searchModalWidthPresetIndexForPx,
} from './search-modal-width-presets';

describe('search modal width presets', () => {
    it('normalizes missing or short arrays to three clamped widths', () => {
        expect(normalizeSearchModalWidthPresetsPx(undefined)).toEqual([640, 800, 960]);
        expect(normalizeSearchModalWidthPresetsPx([500])).toEqual([500, 800, 960]);
        expect(normalizeSearchModalWidthPresetsPx([10, 20, 30])).toEqual([400, 400, 400]);
    });

    it('cycles Compact → Default → Wide using settings values, not live preview share', () => {
        const presets: [number, number, number] = [500, 700, 1100];
        expect(cycleSearchModalWidthPx(500, presets)).toEqual({ nextPx: 700, nextIndex: 1 });
        expect(cycleSearchModalWidthPx(700, presets)).toEqual({ nextPx: 1100, nextIndex: 2 });
        expect(cycleSearchModalWidthPx(1100, presets)).toEqual({ nextPx: 500, nextIndex: 0 });
    });

    it('starts at Compact when current width is not a preset', () => {
        expect(cycleSearchModalWidthPx(555, DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX)).toEqual({
            nextPx: 640,
            nextIndex: 0,
        });
        expect(searchModalWidthPresetIndexForPx(555, DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX)).toBeNull();
        expect(searchModalWidthPresetCycleLabel(555, DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX)).toBe(
            'Width · Custom (555)',
        );
    });

    it('labels a matching preset without consulting telescope layout', () => {
        expect(searchModalWidthPresetCycleLabel(800, DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX)).toBe(
            'Width · Default (800)',
        );
    });

    it('updates live width only when editing the active preset slot', () => {
        expect(applySearchModalWidthPresetSlot(0, 500, 640, DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX)).toEqual({
            presets: [500, 800, 960],
            currentWidthPx: 500,
        });
        expect(applySearchModalWidthPresetSlot(2, 1200, 640, DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX)).toEqual({
            presets: [640, 800, 1200],
            currentWidthPx: 640,
        });
        expect(applySearchModalWidthPresetSlot(1, 700, 555, DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX)).toEqual({
            presets: [640, 700, 960],
            currentWidthPx: 555,
        });
    });
});
