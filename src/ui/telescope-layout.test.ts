import { describe, expect, it } from 'vitest';
import {
    clampSearchModalWidthPx,
    clampTelescopePreviewColumnPct,
    searchModalWidthSliderMaxPx,
    nextTelescopeLayoutIndex,
    snapSearchModalWidthPx,
    snapTelescopePreviewColumnPct,
    TELESCOPE_LAYOUT_PRESETS,
    telescopeLayoutCycleIndexForSettings,
    telescopeLayoutCycleLabel,
    telescopeLayoutPreset,
    telescopeLayoutPresetById,
    telescopePreviewLayoutToColumnPct,
    searchModalWidthEnumToPx,
} from './telescope-layout';

describe('search modal width px', () => {
    it('clamps only the floor, not 960', () => {
        expect(clampSearchModalWidthPx(200)).toBe(400);
        expect(clampSearchModalWidthPx(2000)).toBe(2000);
        expect(clampSearchModalWidthPx(960)).toBe(960);
    });

    it('snaps near legacy width notches', () => {
        expect(snapSearchModalWidthPx(638)).toBe(640);
        expect(snapSearchModalWidthPx(805)).toBe(800);
        expect(snapSearchModalWidthPx(955)).toBe(960);
        expect(snapSearchModalWidthPx(500)).toBe(500);
    });

    it('mimics a drag across Default/Wide/Extra-wide then past 960', () => {
        const path = [500, 628, 640, 788, 800, 948, 960, 1100, 1400];
        expect(path.map(snapSearchModalWidthPx)).toEqual([
            500, 640, 640, 800, 800, 960, 960, 1100, 1400,
        ]);
    });

    it('maps legacy enum widths', () => {
        expect(searchModalWidthEnumToPx('default')).toBe(640);
        expect(searchModalWidthEnumToPx('extra-wide')).toBe(960);
    });

    it('slider max follows the window, not 960', () => {
        const prev = window.innerWidth;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        expect(searchModalWidthSliderMaxPx()).toBe(1600);
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: prev });
    });
});

describe('telescope preview column pct', () => {
    it('clamps and snaps layout notches', () => {
        expect(clampTelescopePreviewColumnPct(10)).toBe(25);
        expect(clampTelescopePreviewColumnPct(90)).toBe(90);
        expect(clampTelescopePreviewColumnPct(99)).toBe(95);
        expect(snapTelescopePreviewColumnPct(36)).toBe(35);
        expect(snapTelescopePreviewColumnPct(48)).toBe(50);
        expect(telescopePreviewLayoutToColumnPct('reading')).toBe(60);
        const path = [25, 33, 35, 43, 45, 48, 50, 58, 60, 80, 95];
        expect(path.map(snapTelescopePreviewColumnPct)).toEqual([
            25, 35, 35, 45, 45, 50, 50, 60, 60, 80, 95,
        ]);
    });
});

describe('telescope layout presets', () => {
    const n = TELESCOPE_LAYOUT_PRESETS.length;

    it('nextTelescopeLayoutIndex wraps', () => {
        expect(nextTelescopeLayoutIndex(0)).toBe(1 % n);
        expect(nextTelescopeLayoutIndex(n - 1)).toBe(0);
    });

    it('telescopeLayoutPresetById resolves known presets', () => {
        expect(telescopeLayoutPresetById('reading').previewColumnPct).toBe(60);
        expect(telescopeLayoutPresetById('missing' as 'balanced').id).toBe('balanced');
    });

    it('telescopeLayoutPreset wraps negative and oversized indices', () => {
        expect(telescopeLayoutPreset(-1).id).toBe(TELESCOPE_LAYOUT_PRESETS[n - 1]!.id);
        expect(telescopeLayoutPreset(n + 1).id).toBe(TELESCOPE_LAYOUT_PRESETS[1]!.id);
    });

    it('cycle index and label match balanced preset values', () => {
        const p = telescopeLayoutPresetById('balanced');
        expect(telescopeLayoutCycleIndexForSettings(p.previewColumnPct)).toBe(0);
        expect(telescopeLayoutCycleLabel(p.previewColumnPct)).toBe('Balanced');
    });

    it('matches preview share even when modal width disagrees', () => {
        expect(telescopeLayoutCycleLabel(45)).toBe('Balanced');
        expect(telescopeLayoutCycleIndexForSettings(35)).toBe(
            TELESCOPE_LAYOUT_PRESETS.findIndex((p) => p.id === 'list'),
        );
    });
});
