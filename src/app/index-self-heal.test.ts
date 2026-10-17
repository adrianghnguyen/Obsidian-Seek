import { describe, expect, it } from 'vitest';
import {
    applySidecarHydrateProgressUpdate,
    coverageGap,
    hydrateProgressAgainstVault,
    resolveSidecarHydrateProgress,
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
    it('drops a batch-local 1/1 instead of stretching it onto the vault', () => {
        expect(hydrateProgressAgainstVault({ done: 1, total: 1 }, 4864)).toBeNull();
        expect(hydrateProgressAgainstVault({ done: 1, total: 1 }, 3132)).toBeNull();
    });

    it('keeps a real hydrate walk that already matches the vault', () => {
        expect(hydrateProgressAgainstVault({ done: 12, total: 40 }, 40)).toEqual({
            done: 12,
            total: 40,
        });
    });

    it('keeps a vault-scale greedy walk (1047/3132)', () => {
        expect(hydrateProgressAgainstVault({ done: 1047, total: 3132 }, 3132)).toEqual({
            done: 1047,
            total: 3132,
        });
    });
});

describe('applySidecarHydrateProgressUpdate', () => {
    it('does not let {1047,3132} then {1,1} become 1/3132', () => {
        const vault = applySidecarHydrateProgressUpdate(null, { done: 1047, total: 3132 }, true);
        expect(vault).toEqual({ done: 1047, total: 3132 });
        const next = applySidecarHydrateProgressUpdate(vault, { done: 1, total: 1 }, true);
        expect(next).toEqual({ done: 1047, total: 3132 });
        expect(hydrateProgressAgainstVault(next, 3132)).toEqual({ done: 1047, total: 3132 });
    });
});

describe('resolveSidecarHydrateProgress', () => {
    const vault = {
        waitingForSidecar: false,
        dropRecovering: false,
        bootPending: true,
        goodEnough: false,
        inventoryFiles: 839,
        indexableNotes: 3132,
    };

    it('keeps greedy vault progress while hydrating', () => {
        expect(resolveSidecarHydrateProgress({
            ...vault,
            hydrating: true,
            walk: { done: 1047, total: 3132 },
        })).toEqual({ done: 1047, total: 3132 });
    });

    it('falls back to inventory when a batch {1,1} would otherwise paint 1/3132 · 1%', () => {
        expect(resolveSidecarHydrateProgress({
            ...vault,
            hydrating: true,
            walk: { done: 1, total: 1 },
        })).toEqual({ done: 839, total: 3132 });
    });

    it('ignores leftover walk once hydrating is false and uses inventory during boot', () => {
        expect(resolveSidecarHydrateProgress({
            ...vault,
            hydrating: false,
            walk: { done: 1, total: 3132 },
        })).toEqual({ done: 839, total: 3132 });
    });

    it('does not keep a leftover walk after hydrate has finished', () => {
        expect(resolveSidecarHydrateProgress({
            ...vault,
            hydrating: false,
            bootPending: false,
            goodEnough: true,
            walk: { done: 1047, total: 3132 },
        })).toBeNull();
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
