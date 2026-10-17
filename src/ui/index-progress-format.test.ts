import { describe, it, expect } from 'vitest';
import {
    FIGURE_SPACE,
    formatIndexCountCompact,
    formatStableCompactProgress,
    formatStableFileFraction,
    formatStableLabelProgress,
    formatStablePercent,
    visibleProgressText,
} from './index-progress-format';

describe('stable progress format', () => {
    it('pads done to the live total width so 9→10 does not change length', () => {
        const a = formatStableFileFraction(9, 63);
        const b = formatStableFileFraction(10, 63);
        expect(a.length).toBe(b.length);
        expect(a.length).toBe(formatStableFileFraction(63, 63).length);
        expect(visibleProgressText(a)).toBe('9/63');
        expect(visibleProgressText(b)).toBe('10/63');
        expect(a.startsWith(FIGURE_SPACE)).toBe(true);
        expect(b.startsWith(FIGURE_SPACE)).toBe(false);
    });

    it('pads through the thousands grouping so 999→1000 is stable against total', () => {
        const total = 3854;
        const a = formatStableCompactProgress(999, total, 26);
        const b = formatStableCompactProgress(1000, total, 26);
        const c = formatStableCompactProgress(total, total, 100);
        expect(a.length).toBe(b.length);
        expect(b.length).toBe(c.length);
        expect(visibleProgressText(a)).toContain('999');
        expect(visibleProgressText(b)).toContain(formatStableFileFraction(1000, total).replaceAll(FIGURE_SPACE, ''));
    });

    it('keeps percent at 3 numeral columns for 9% → 10% → 100%', () => {
        expect(formatStablePercent(9).length).toBe(formatStablePercent(10).length);
        expect(formatStablePercent(10).length).toBe(formatStablePercent(100).length);
        expect(visibleProgressText(formatStablePercent(9))).toBe('9%');
        expect(visibleProgressText(formatStablePercent(100))).toBe('100%');
    });

    it('uses compact k when locale total would overflow the plain slot', () => {
        const total = 120_000;
        const line = formatStableCompactProgress(9, total, 0);
        expect(visibleProgressText(line)).toMatch(/\/120k|k\//);
        expect(visibleProgressText(line)).not.toMatch(/120,000|120000/);
        expect(line.length).toBe(formatStableCompactProgress(total, total, 100).length);
        expect(formatIndexCountCompact(120_000)).toBe('120k');
    });

    it('keeps ~3800-file vaults in full locale form, not k', () => {
        const line = formatStableFileFraction(3800, 3854);
        expect(visibleProgressText(line)).not.toMatch(/k/);
        expect(line.length).toBe(formatStableFileFraction(9, 3854).length);
    });

    it('spaced Settings line matches compact width rules', () => {
        const compact = formatStableCompactProgress(12, 40, 30);
        const label = formatStableLabelProgress(12, 40, 30);
        expect(visibleProgressText(compact)).toBe('12/40 · 30%');
        expect(visibleProgressText(label)).toBe('12 / 40 · 30%');
        expect(label.length).toBe(formatStableLabelProgress(40, 40, 100).length);
    });
});
