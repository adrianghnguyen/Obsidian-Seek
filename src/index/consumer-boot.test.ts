import { describe, expect, it } from 'vitest';
import {
    isConsumerHydrateReady,
    planConsumerHydrateComplete,
    resolveConsumerCatchUpKind,
    resolveMayEmbedCatchUp,
    shouldStartHydrateFromRecovery,
    type ConsumerFleetReadyInput,
} from './consumer-boot';

const consumerReady: ConsumerFleetReadyInput = {
    role: 'consumer',
    waitingForProducer: false,
    matchingReady: true,
    mayFullReindex: false,
};

describe('consumer hydrate completing → good-enough / not stuck', () => {
    it('marks good-enough and clears pending + stuck after hydrate releases the gate', () => {
        const plan = planConsumerHydrateComplete({
            fleet: consumerReady,
            hydrateReleasedGate: true,
        });
        expect(isConsumerHydrateReady(consumerReady)).toBe(true);
        expect(plan).toEqual({
            markGoodEnough: true,
            clearBootPending: true,
            clearBootStuck: true,
            clearIndexingStalled: true,
        });
    });

    it('does not wait for catch-up embed when matching producer shards are already ready', () => {
        const plan = planConsumerHydrateComplete({
            fleet: { ...consumerReady, matchingReady: true },
            hydrateReleasedGate: true,
        });
        expect(plan.markGoodEnough).toBe(true);
    });

    it('stays pending while still hydrating or waiting on the producer', () => {
        expect(planConsumerHydrateComplete({
            fleet: consumerReady,
            hydrateReleasedGate: false,
        }).markGoodEnough).toBe(false);
        expect(planConsumerHydrateComplete({
            fleet: { ...consumerReady, waitingForProducer: true, matchingReady: false },
            hydrateReleasedGate: true,
        }).markGoodEnough).toBe(false);
        const waitingWithInventory = planConsumerHydrateComplete({
            fleet: { ...consumerReady, waitingForProducer: true, matchingReady: false },
            hydrateReleasedGate: true,
            inventoryFiles: 120,
        });
        expect(waitingWithInventory.markGoodEnough).toBe(false);
        expect(waitingWithInventory.clearBootStuck).toBe(true);
        expect(waitingWithInventory.clearIndexingStalled).toBe(true);
        expect(isConsumerHydrateReady({
            role: 'producer',
            waitingForProducer: false,
            matchingReady: false,
            mayFullReindex: true,
        })).toBe(false);
    });
});

describe('resolveMayEmbedCatchUp before fleet inspect', () => {
    it('defaults to false for consumer and auto, true for producer', () => {
        expect(resolveMayEmbedCatchUp(null, 'consumer')).toBe(false);
        expect(resolveMayEmbedCatchUp(null, 'auto')).toBe(false);
        expect(resolveMayEmbedCatchUp(null, 'producer')).toBe(true);
        expect(resolveMayEmbedCatchUp(undefined, 'consumer')).toBe(false);
    });

    it('prefers the last fleet inspect result when present', () => {
        expect(resolveMayEmbedCatchUp(true, 'consumer')).toBe(true);
        expect(resolveMayEmbedCatchUp(false, 'producer')).toBe(false);
    });
});

describe('no embed catch-up when mayEmbedCatchUp is false', () => {
    it('schedules lexical-only catch-up on a desktop consumer', () => {
        expect(resolveConsumerCatchUpKind({
            mayEmbedCatchUp: false,
            catchUpPending: true,
            mobile: false,
        })).toBe('lexical');
    });

    it('still schedules GPU/embed catch-up on a producer or contributor', () => {
        expect(resolveConsumerCatchUpKind({
            mayEmbedCatchUp: true,
            catchUpPending: true,
            mobile: false,
        })).toBe('embed');
    });

    it('does not schedule catch-up when nothing is pending', () => {
        expect(resolveConsumerCatchUpKind({
            mayEmbedCatchUp: false,
            catchUpPending: false,
            mobile: false,
        })).toBe('none');
        expect(resolveConsumerCatchUpKind({
            mayEmbedCatchUp: true,
            catchUpPending: true,
            mobile: true,
        })).toBe('none');
    });
});

describe('no duplicate hydrate when boot continuation is done', () => {
    it('refuses post-boot recovery hydrate after bootContinuationDone', () => {
        expect(shouldStartHydrateFromRecovery({
            reason: 'post-boot',
            bootContinuationDone: true,
        })).toBe(false);
    });

    it('still hydrates when boot continuation has not run, or on force-reset', () => {
        expect(shouldStartHydrateFromRecovery({
            reason: 'post-boot',
            bootContinuationDone: false,
        })).toBe(true);
        expect(shouldStartHydrateFromRecovery({
            reason: 'force-reset',
            bootContinuationDone: true,
        })).toBe(true);
        expect(shouldStartHydrateFromRecovery({
            reason: 'full-reindex',
            bootContinuationDone: true,
        })).toBe(true);
    });
});
