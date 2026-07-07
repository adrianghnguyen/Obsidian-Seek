import { describe, expect, it, beforeEach } from 'vitest';
import { Platform } from 'obsidian';
import { normalizeTarget, parsePaneType } from './open-target';

describe('parsePaneType', () => {
    it('maps known paneType strings', () => {
        expect(parsePaneType('tab')).toBe('tab');
        expect(parsePaneType('split')).toBe('split');
        expect(parsePaneType('window')).toBe('window');
    });

    it('defaults to active-tab navigate', () => {
        expect(parsePaneType(undefined)).toBe(false);
        expect(parsePaneType('')).toBe(false);
        expect(parsePaneType('nope')).toBe(false);
    });
});

describe('normalizeTarget', () => {
    beforeEach(() => {
        Platform.isMobile = false;
    });

    it('passes desktop targets through', () => {
        expect(normalizeTarget(false)).toBe(false);
        expect(normalizeTarget('tab')).toBe('tab');
        expect(normalizeTarget('split')).toBe('split');
        expect(normalizeTarget('window')).toBe('window');
    });

    it('falls back split to tab on mobile', () => {
        Platform.isMobile = true;
        expect(normalizeTarget('split')).toBe('tab');
        expect(normalizeTarget('tab')).toBe('tab');
    });
});
