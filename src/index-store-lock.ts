/**
 * Deferred IndexedDB open retries after a lock, plus command-palette visibility.
 * Pure helpers — main.ts wires timers and plugin lifecycle.
 */

export function storeOpenRetryDelaysMs(): number[] {
    return [2000, 5000, 10000, 15000];
}

export function isRetryIndexStoreCommandEnabled(locked: boolean): boolean {
    return locked;
}

export interface StoreOpenRetrySchedulerDeps {
    delaysMs: number[];
    ensureOpen: () => Promise<void>;
    isCurrent: () => boolean;
    onLocked: () => void;
    onSuccess: () => void;
    schedule: (fn: () => void, ms: number) => number;
    cancel: (id: number) => void;
}

export interface StoreOpenRetryScheduler {
    start: () => void;
    dispose: () => void;
}

/** Schedule ensureOpen at absolute offsets; cancel all pending timers on success or dispose. */
export function createStoreOpenRetryScheduler(deps: StoreOpenRetrySchedulerDeps): StoreOpenRetryScheduler {
    let timerIds: number[] = [];

    const dispose = (): void => {
        for (const id of timerIds) deps.cancel(id);
        timerIds = [];
    };

    const tryOnce = async (): Promise<void> => {
        if (!deps.isCurrent()) return;
        try {
            await deps.ensureOpen();
            if (!deps.isCurrent()) return;
            dispose();
            deps.onSuccess();
        } catch {
            /* next scheduled attempt may succeed */
        }
    };

    const start = (): void => {
        deps.onLocked();
        for (const delay of deps.delaysMs) {
            const id = deps.schedule(() => { void tryOnce(); }, delay);
            timerIds.push(id);
        }
    };

    return { start, dispose };
}
