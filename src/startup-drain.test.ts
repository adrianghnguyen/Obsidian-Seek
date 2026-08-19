import { describe, it, expect } from 'vitest';
import { shouldAutoDrainStartupCatchUp } from './startup-drain';

describe('shouldAutoDrainStartupCatchUp', () => {
    it('loads and drains pending work on desktop', () => {
        expect(shouldAutoDrainStartupCatchUp({ mobile: false, catchUpPending: true })).toBe(true);
    });

    it('does not load on desktop when nothing is pending', () => {
        expect(shouldAutoDrainStartupCatchUp({ mobile: false, catchUpPending: false })).toBe(false);
    });

    it('keeps mobile lazy even when work is pending', () => {
        expect(shouldAutoDrainStartupCatchUp({ mobile: true, catchUpPending: true })).toBe(false);
    });

    it('drains an empty desktop index when the vault has notes', () => {
        expect(shouldAutoDrainStartupCatchUp({
            mobile: false, catchUpPending: false, emptyIndexWithNotes: true,
        })).toBe(true);
        expect(shouldAutoDrainStartupCatchUp({
            mobile: true, catchUpPending: false, emptyIndexWithNotes: true,
        })).toBe(false);
    });
});
