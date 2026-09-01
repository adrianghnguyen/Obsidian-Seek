/**
 * Deferred IndexedDB open retries after a lock, plus command-palette visibility.
 * Pure helpers — main.ts wires timers and plugin lifecycle.
 */

export function storeOpenRetryDelaysMs(): number[] {
    // Fixed-delay burst: 2s, 5s, 10s, 15s
    return [2000, 5000, 10000, 15000];
}

/** Exponential backoff stages after the fixed schedule exhausts. */
export function storeOpenBackoffDelaysMs(): number[] {
    // 30s, 60s, 120s, then capped at 300s repeating
    return [30000, 60000, 120000, 300000];
}

export function isRetryIndexStoreCommandEnabled(locked: boolean): boolean {
    return locked;
}

export interface StoreOpenRetrySchedulerDeps {
    delaysMs: number[];
    backoffDelaysMs: number[];
    ensureOpen: () => Promise<void>;
    isCurrent: () => boolean;
    onLocked: () => void;
    onRetry: (attempt: number, delayMs: number, totalElapsedMs: number) => void;
    onExhausted: () => void;
    onSuccess: () => void;
    schedule: (fn: () => void, ms: number) => number;
    cancel: (id: number) => void;
}

export interface StoreOpenRetryScheduler {
    start: () => void;
    /** Trigger an immediate retry attempt outside the scheduled window. */
    retryNow: () => void;
    dispose: () => void;
}

/**
 * Schedule ensureOpen at absolute offsets; fall into exponential backoff when
 * the fixed schedule exhausts. Cancel all pending timers on success or dispose.
 *
 * Retry lifecycle:
 *   - start() fires fixed delays (2s, 5s, 10s, 15s) in parallel from t=0.
 *     Each fires tryOnce; failures stay silent (next fixed delay may succeed).
 *   - After the final fixed delay, a single backoff chain begins: each failure
 *     schedules the next backoff tick serially (30s, 60s, 120s, 300s capped).
 *   - When all stages exhaust, onExhausted fires once. retryNow() resets.
 */
export function createStoreOpenRetryScheduler(deps: StoreOpenRetrySchedulerDeps): StoreOpenRetryScheduler {
    let timerIds: number[] = [];
    let disposed = false;
    let exhausted = false;
    let backoffIndex = 0;
    const startTime = performance.now();

    const elapsed = (): number => Math.round(performance.now() - startTime);

    const dispose = (): void => {
        disposed = true;
        for (const id of timerIds) deps.cancel(id);
        timerIds = [];
    };

    /** tryOnce used by fixed delays: does NOT chain into backoff on failure. */
    const tryOnceFixed = async (): Promise<void> => {
        if (!deps.isCurrent() || disposed) return;
        try {
            await deps.ensureOpen();
            if (!deps.isCurrent() || disposed) return;
            dispose();
            deps.onSuccess();
        } catch {
            // Fixed delays don't chain — the backoff starter handles that.
        }
    };

    /** tryOnce used by backoff chain: schedules next tick on failure. */
    const tryOnceBackoff = async (): Promise<void> => {
        if (!deps.isCurrent() || disposed) return;
        try {
            await deps.ensureOpen();
            if (!deps.isCurrent() || disposed) return;
            dispose();
            deps.onSuccess();
        } catch {
            if (!disposed) {
                scheduleNextBackoff();
            }
        }
    };

    const scheduleNextBackoff = (): void => {
        if (disposed || !deps.isCurrent()) return;
        if (exhausted) return;
        if (backoffIndex >= deps.backoffDelaysMs.length) {
            exhausted = true;
            deps.onExhausted();
            return;
        }
        const delay = deps.backoffDelaysMs[backoffIndex];
        deps.onRetry(deps.delaysMs.length + backoffIndex + 1, delay, elapsed());
        timerIds.push(deps.schedule(() => { void tryOnceBackoff(); }, delay));
        backoffIndex++;
    };

    const start = (): void => {
        deps.onLocked();
        // Schedule all fixed delays in parallel from t=0.
        for (let i = 0; i < deps.delaysMs.length; i++) {
            const delay = deps.delaysMs[i];
            deps.onRetry(i + 1, delay, 0);
            timerIds.push(deps.schedule(() => { void tryOnceFixed(); }, delay));
        }
        // Schedule the backoff starter after the last fixed delay completes,
        // plus the first backoff delay as extra buffer so fixed runs finish.
        const lastFixedDelay = deps.delaysMs[deps.delaysMs.length - 1];
        const firstBackoffDelay = deps.backoffDelaysMs[0];
        timerIds.push(deps.schedule(() => {
            if (disposed) return;
            deps.onRetry(deps.delaysMs.length + 1, firstBackoffDelay, elapsed());
            timerIds.push(deps.schedule(() => { void tryOnceBackoff(); }, firstBackoffDelay));
            backoffIndex++;
        }, lastFixedDelay));
    };

    const retryNow = (): void => {
        if (disposed) return;
        // Cancel all pending timers so this retry is the sole attempt.
        for (const id of timerIds) deps.cancel(id);
        timerIds = [];
        exhausted = false;
        // If we were in backoff phase, reset backoffIndex so the chain restarts.
        backoffIndex = 0;
        // Push a single immediate attempt that chains into backoff on failure.
        deps.onRetry(deps.delaysMs.length + 1, 0, elapsed());
        // Use backoff tryOnce so failure schedules the next backoff tick.
        void tryOnceBackoff();
    };

    return { start, retryNow, dispose };
}