import { describe, expect, it } from 'vitest';
import {
    nextTelescopeLayoutIndex,
    TELESCOPE_LAYOUT_PRESETS,
    telescopeLayoutPreset,
} from './telescope-layout';

describe('telescope-layout', () => {
    it('cycles layout index modulo preset count', () => {
        const n = TELESCOPE_LAYOUT_PRESETS.length;
        expect(nextTelescopeLayoutIndex(0)).toBe(1 % n);
        expect(nextTelescopeLayoutIndex(n - 1)).toBe(0);
    });

    it('telescopeLayoutPreset wraps negative and oversized indices', () => {
        const n = TELESCOPE_LAYOUT_PRESETS.length;
        expect(telescopeLayoutPreset(-1).id).toBe(TELESCOPE_LAYOUT_PRESETS[n - 1]!.id);
        expect(telescopeLayoutPreset(n + 1).id).toBe(TELESCOPE_LAYOUT_PRESETS[1]!.id);
    });
});
