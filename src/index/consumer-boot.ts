/**
 * Consumer boot after sidecar hydrate: Ready without waiting on embed catch-up,
 * no GPU catch-up when the fleet forbids embed catch-up, and no second hydrate
 * from post-boot recovery once boot continuation already ran.
 */

import type { SidecarIndexRole } from '../sidecar/sidecar-fleet';

export interface ConsumerFleetReadyInput {
    role: 'producer' | 'contributor' | 'consumer';
    waitingForProducer: boolean;
    matchingReady: boolean;
    mayFullReindex: boolean;
    mayEmbedCatchUp?: boolean;
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
    inventoryFiles?: number | null;
}): ConsumerHydrateCompletePlan {
    const ready = input.hydrateReleasedGate && isConsumerHydrateReady(input.fleet);
    const waitingOnProducer = !!input.fleet?.waitingForProducer && input.fleet.role === 'consumer';
    const relieveStuckWhileWaiting = input.hydrateReleasedGate && waitingOnProducer;
    const preflightReadyEmpty = input.hydrateReleasedGate
        && input.fleet?.role === 'consumer'
        && !input.fleet.waitingForProducer
        && input.fleet.matchingReady
        && (input.inventoryFiles ?? 0) === 0;
    const relieveStuck = ready || relieveStuckWhileWaiting || preflightReadyEmpty;
    return {
        markGoodEnough: ready,
        clearBootPending: ready,
        clearBootStuck: relieveStuck,
        clearIndexingStalled: relieveStuck,
    };
}

/** Before the first fleet inspect, never assume GPU catch-up (consumer-safe default). */
export function resolveMayEmbedCatchUp(
    fleetValue: boolean | null | undefined,
    roleSetting: SidecarIndexRole,
): boolean {
    if (fleetValue != null) return fleetValue;
    if (roleSetting === 'consumer') return false;
    if (roleSetting === 'producer') return true;
    return false;
}

export type CatchUpKind = 'embed' | 'lexical' | 'none';

/** GPU/embed catch-up is lead + contributor. Phones / hydrate-only stay lexical. */
export function resolveConsumerCatchUpKind(input: {
    mayEmbedCatchUp: boolean;
    catchUpPending: boolean;
    mobile: boolean;
}): CatchUpKind {
    if (input.mobile) return 'none';
    if (!input.catchUpPending) return 'none';
    if (!input.mayEmbedCatchUp) return 'lexical';
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
