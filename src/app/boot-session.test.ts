import { describe, it, expect } from 'vitest';
import {
    isLoadGenerationCurrent,
    isSessionWorkCurrent,
    shouldLogSessionError,
} from './boot-session';

/** Simulates plugin:reload generation bumps (main.ts onload/onunload). */
function simulateReloadSequence(): {
    onload: () => number;
    onunload: () => void;
    isBootCurrent: (captured: number) => boolean;
} {
    let loadGeneration = 0;
    let unloading = false;
    return {
        onload: () => {
            unloading = false;
            loadGeneration++;
            return loadGeneration;
        },
        onunload: () => {
            loadGeneration++;
            unloading = true;
        },
        isBootCurrent: (captured: number) =>
            isLoadGenerationCurrent(captured, loadGeneration, unloading),
    };
}

describe('isLoadGenerationCurrent (plugin:reload boot gate)', () => {
    it('allows work while the captured generation matches and not unloading', () => {
        expect(isLoadGenerationCurrent(2, 2, false)).toBe(true);
    });

    it('blocks work after onunload bumps generation and sets unloading', () => {
        const sim = simulateReloadSequence();
        const bootGen = sim.onload();
        expect(sim.isBootCurrent(bootGen)).toBe(true);
        sim.onunload();
        expect(sim.isBootCurrent(bootGen)).toBe(false);
    });

    it('blocks stale boot IIFE after a new onload (reload without full quit)', () => {
        const sim = simulateReloadSequence();
        const staleGen = sim.onload();
        sim.onunload();
        const freshGen = sim.onload();
        expect(sim.isBootCurrent(staleGen)).toBe(false);
        expect(sim.isBootCurrent(freshGen)).toBe(true);
    });

    it('blocks embedder continuation when unloading is latched on same generation', () => {
        expect(isLoadGenerationCurrent(3, 3, true)).toBe(false);
    });
});

describe('isSessionWorkCurrent (background async gate)', () => {
    it('allows work when not unloading and no generation token was captured', () => {
        expect(isSessionWorkCurrent(false, 5)).toBe(true);
    });

    it('blocks periodic reconcile / catch-up while unloading even without a token', () => {
        expect(isSessionWorkCurrent(true, 5)).toBe(false);
    });

    it('blocks stale catch-up after reload bumps generation', () => {
        expect(isSessionWorkCurrent(false, 4, 3)).toBe(false);
        expect(isSessionWorkCurrent(false, 4, 4)).toBe(true);
    });
});

describe('shouldLogSessionError', () => {
    it('suppresses false errors from torn-down reload sessions', () => {
        expect(shouldLogSessionError(true, 2, 2)).toBe(false);
        expect(shouldLogSessionError(false, 3, 2)).toBe(false);
    });

    it('allows logging for the current live session', () => {
        expect(shouldLogSessionError(false, 2, 2)).toBe(true);
        expect(shouldLogSessionError(false, 2)).toBe(true);
    });
});
