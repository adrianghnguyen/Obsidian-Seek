import { describe, expect, it } from 'vitest';
import {
    clampSearchModalWidthPx,
    clampTelescopePreviewColumnPct,
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
    it('clamps to min/max', () => {
        expect(clampSearchModalWidthPx(200)).toBe(400);
        expect(clampSearchModalWidthPx(2000)).toBe(960);
    });

    it('snaps near legacy width notches', () => {
        expect(snapSearchModalWidthPx(638)).toBe(640);
        expect(snapSearchModalWidthPx(805)).toBe(800);
        expect(snapSearchModalWidthPx(955)).toBe(960);
        expect(snapSearchModalWidthPx(500)).toBe(500);
    });

    it('maps legacy enum widths', () => {
        expect(searchModalWidthEnumToPx('default')).toBe(640);
        expect(searchModalWidthEnumToPx('extra-wide')).toBe(960);
    });
});

describe('telescope preview column pct', () => {
    it('clamps and snaps layout notches', () => {
        expect(clampTelescopePreviewColumnPct(10)).toBe(25);
        expect(snapTelescopePreviewColumnPct(36)).toBe(35);
        expect(snapTelescopePreviewColumnPct(48)).toBe(50);
        expect(telescopePreviewLayoutToColumnPct('reading')).toBe(60);
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
        expect(telescopeLayoutCycleIndexForSettings(p.modalWidthPx, p.previewColumnPct)).toBe(0);
        expect(telescopeLayoutCycleLabel(p.modalWidthPx, p.previewColumnPct)).toBe('Balanced');
    });
});
