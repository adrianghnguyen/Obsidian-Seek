/**
 * Failed / interrupted IndexedDB drop (clearAllStores timeout, torn wipe,
 * process death mid-nuke). Architecture theme 9: never leave a wedged None/error
 * that never hydrates; next boot must restore or stay Restoring.
 */

export type FailedDropAction = 'hydrate' | 'cold-build' | 'reopen';

export interface FailedDropPlan {
    dropRecovering: true;
    waitingForSidecar: boolean;
    action: FailedDropAction;
}

export function planFailedDropRecovery(input: {
    sidecarEnabled: boolean;
    storeOpen: boolean;
    mayFullReindex: boolean;
    mobile: boolean;
}): FailedDropPlan {
    if (!input.storeOpen) {
        return {
            dropRecovering: true,
            waitingForSidecar: input.sidecarEnabled,
            action: 'reopen',
        };
    }
    if (input.sidecarEnabled) {
        return { dropRecovering: true, waitingForSidecar: true, action: 'hydrate' };
    }
    if (!input.mobile && input.mayFullReindex) {
        return { dropRecovering: true, waitingForSidecar: false, action: 'cold-build' };
    }
    return { dropRecovering: true, waitingForSidecar: false, action: 'reopen' };
}

/**
 * Wipe then hydrate in one sequence. A thrown wipe still notifies drop and
 * attempts hydrate (torn IDB / deadline). Hydrate success wins; if both fail,
 * the wipe error is rethrown so the caller can schedule next-boot restore.
 */
export async function continueAfterStoreWipe<T>(opts: {
    wipe: () => Promise<unknown>;
    onDropped?: () => void;
    hydrate: () => Promise<T>;
}): Promise<T> {
    let wipeError: unknown = null;
    try {
        await opts.wipe();
    } catch (e) {
        wipeError = e;
    }
    opts.onDropped?.();
    try {
        return await opts.hydrate();
    } catch (hydrateErr) {
        throw wipeError ?? hydrateErr;
    }
}
