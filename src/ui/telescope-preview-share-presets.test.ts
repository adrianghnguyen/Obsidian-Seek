import { describe, expect, it } from 'vitest';
import {
    applyTelescopePreviewSharePresetSlot,
    cycleTelescopePreviewSharePct,
    DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT,
    normalizeTelescopePreviewSharePresetsPct,
    telescopePreviewShareCycleLabel,
    telescopePreviewSharePresetIndexForPct,
} from './telescope-preview-share-presets';

describe('telescope preview share presets', () => {
    it('normalizes missing arrays to List/Balanced/Even/Reading defaults', () => {
        expect(normalizeTelescopePreviewSharePresetsPct(undefined)).toEqual([25, 40, 50, 80]);
        expect(normalizeTelescopePreviewSharePresetsPct([30])).toEqual([30, 40, 50, 80]);
        expect(normalizeTelescopePreviewSharePresetsPct([10, 20, 30, 99])).toEqual([25, 25, 30, 95]);
    });

    it('cycles List → Balanced → Even → Reading without touching modal width', () => {
        const presets: [number, number, number, number] = [25, 40, 50, 80];
        expect(cycleTelescopePreviewSharePct(25, presets)).toEqual({ nextPct: 40, nextIndex: 1 });
        expect(cycleTelescopePreviewSharePct(40, presets)).toEqual({ nextPct: 50, nextIndex: 2 });
        expect(cycleTelescopePreviewSharePct(50, presets)).toEqual({ nextPct: 80, nextIndex: 3 });
        expect(cycleTelescopePreviewSharePct(80, presets)).toEqual({ nextPct: 25, nextIndex: 0 });
    });

    it('starts at List when current share is not a preset', () => {
        expect(cycleTelescopePreviewSharePct(45, DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT)).toEqual({
            nextPct: 25,
            nextIndex: 0,
        });
        expect(telescopePreviewSharePresetIndexForPct(45, DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT)).toBeNull();
        expect(telescopePreviewShareCycleLabel(45, DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT)).toBe('Custom (45%)');
    });

    it('labels a matching preset without consulting modal width', () => {
        expect(telescopePreviewShareCycleLabel(80, DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT)).toBe('Reading');
    });

    it('updates live share only when editing the active preset slot', () => {
        expect(applyTelescopePreviewSharePresetSlot(0, 30, 25, DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT)).toEqual({
            presets: [30, 40, 50, 80],
            currentPct: 30,
        });
        expect(applyTelescopePreviewSharePresetSlot(3, 90, 25, DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT)).toEqual({
            presets: [25, 40, 50, 90],
            currentPct: 25,
        });
        expect(applyTelescopePreviewSharePresetSlot(1, 42, 45, DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT)).toEqual({
            presets: [25, 42, 50, 80],
            currentPct: 45,
        });
    });
});
