/**
 * Consumer boot after sidecar hydrate: Ready without waiting on embed catch-up,
 * no GPU catch-up when the fleet forbids full reindex, and no second hydrate
 * from post-boot recovery once boot continuation already ran.
 */

export interface ConsumerFleetReadyInput {
    role: 'producer' | 'consumer';
    waitingForProducer: boolean;
    matchingReady: boolean;
    mayFullReindex: boolean;
}

/** inspectFleet() says this device can serve search as a hydrate-only consumer. */
export function isConsumerHydrateReady(
    fleet: ConsumerFleetReadyInput | null | undefined,
): boolean {
    if (!fleet) return false;
    if (fleet.role !== 'consumer') return false;
    if (fleet.mayFullReindex) return false;
    return !fleet.waitingForProducer;
}

export interface ConsumerHydrateCompletePlan {
    markGoodEnough: boolean;
    clearBootPending: boolean;
    clearBootStuck: boolean;
    clearIndexingStalled: boolean;
}

/**
 * After sidecar-hydrate / greedy hydrate releases the search gate, a consumer-safe
 * ready fleet always becomes good-enough — do not wait for catch-up embed.
 */
export function planConsumerHydrateComplete(input: {
    fleet: ConsumerFleetReadyInput | null | undefined;
    hydrateReleasedGate: boolean;
}): ConsumerHydrateCompletePlan {
    const ready = input.hydrateReleasedGate && isConsumerHydrateReady(input.fleet);
    return {
        markGoodEnough: ready,
        clearBootPending: ready,
        clearBootStuck: ready,
        clearIndexingStalled: ready,
    };
}

export type CatchUpKind = 'embed' | 'lexical' | 'none';

/** GPU/embed catch-up is producer-only. Consumers may still drain lexical work. */
export function resolveConsumerCatchUpKind(input: {
    mayFullReindex: boolean;
    catchUpPending: boolean;
    mobile: boolean;
}): CatchUpKind {
    if (input.mobile) return 'none';
    if (!input.catchUpPending) return 'none';
    if (!input.mayFullReindex) return 'lexical';
    return 'embed';
}

/**
 * Post-boot recovery must not start a second hydrate after resumeBootAfterStoreOpen
 * already set bootContinuationDone. Force-reset / full-reindex recovery still hydrates.
 */
export function shouldStartHydrateFromRecovery(input: {
    reason: string;
    bootContinuationDone: boolean;
}): boolean {
    if (input.bootContinuationDone && input.reason === 'post-boot') return false;
    return true;
}
