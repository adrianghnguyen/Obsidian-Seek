import { describe, expect, it } from 'vitest';
import {
    coverageGap,
    hydrateProgressAgainstVault,
    shouldResumeIndexing,
    staleCompleteHydrateWalk,
    vaultCoverageIncomplete,
} from './index-self-heal';

describe('vaultCoverageIncomplete', () => {
    it('treats 123 indexed of 4864 notes as incomplete', () => {
        expect(coverageGap(123, 4864)).toBe(4741);
        expect(vaultCoverageIncomplete(123, 4864)).toBe(true);
    });

    it('treats a 1/1 paint as incomplete when the vault is larger', () => {
        expect(vaultCoverageIncomplete(1, 4864)).toBe(true);
    });

    it('is complete when indexed meets the vault', () => {
        expect(vaultCoverageIncomplete(4864, 4864)).toBe(false);
        expect(coverageGap(4864, 4864)).toBe(0);
    });
});

describe('hydrateProgressAgainstVault', () => {
    it('does not report 100% on a 1-file hydrate walk in a large vault', () => {
        expect(hydrateProgressAgainstVault({ done: 1, total: 1 }, 4864)).toEqual({
            done: 1,
            total: 4864,
        });
    });

    it('keeps a real hydrate walk that already matches the vault', () => {
        expect(hydrateProgressAgainstVault({ done: 12, total: 40 }, 40)).toEqual({
            done: 12,
            total: 40,
        });
    });
});

describe('shouldResumeIndexing', () => {
    const gap = {
        indexableNotes: 4864,
        indexedFiles: 123,
        indexing: false,
        hydrating: false,
        waitingForProducer: false,
    };

    it('resumes catch-up when coverage is short and nothing is running', () => {
        expect(shouldResumeIndexing(gap)).toBe(true);
    });

    it('does not stack on a live hydrate or catch-up', () => {
        expect(shouldResumeIndexing({ ...gap, hydrating: true })).toBe(false);
        expect(shouldResumeIndexing({ ...gap, indexing: true })).toBe(false);
        expect(shouldResumeIndexing({ ...gap, waitingForProducer: true })).toBe(false);
    });
});

describe('staleCompleteHydrateWalk', () => {
    it('flags leftover 1/1 against a large vault', () => {
        expect(staleCompleteHydrateWalk({ done: 1, total: 1 }, 4864)).toBe(true);
    });

    it('leaves a live walk or a matching vault alone', () => {
        expect(staleCompleteHydrateWalk({ done: 12, total: 40 }, 4864)).toBe(false);
        expect(staleCompleteHydrateWalk({ done: 40, total: 40 }, 40)).toBe(false);
    });
});
