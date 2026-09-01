import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    storeOpenRetryDelaysMs,
    storeOpenBackoffDelaysMs,
    isRetryIndexStoreCommandEnabled,
    createStoreOpenRetryScheduler,
} from './index-store-lock';

describe('storeOpenRetryDelaysMs', () => {
    it('schedules deferred ensureOpen at 2s, 5s, 10s, and 15s', () => {
        expect(storeOpenRetryDelaysMs()).toEqual([2000, 5000, 10000, 15000]);
    });
});

describe('storeOpenBackoffDelaysMs', () => {
    it('returns exponential backoff: 30s, 60s, 120s, 300s', () => {
        expect(storeOpenBackoffDelaysMs()).toEqual([30000, 60000, 120000, 300000]);
    });
});

describe('isRetryIndexStoreCommandEnabled', () => {
    it('is enabled only while the store is locked', () => {
        expect(isRetryIndexStoreCommandEnabled(true)).toBe(true);
        expect(isRetryIndexStoreCommandEnabled(false)).toBe(false);
    });
});

const NOOP = () => {};

describe('createStoreOpenRetryScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires ensureOpen at each fixed delay until success', async () => {
        const ensureOpen = vi.fn()
            .mockRejectedValueOnce(new Error('locked'))
            .mockRejectedValueOnce(new Error('locked'))
            .mockResolvedValueOnce(undefined);
        const onLocked = vi.fn();
        const onSuccess = vi.fn();
        const onRetry = vi.fn();
        const onExhausted = vi.fn();
        const isCurrent = vi.fn().mockReturnValue(true);

        const scheduler = createStoreOpenRetryScheduler({
            delaysMs: storeOpenRetryDelaysMs(),
            backoffDelaysMs: storeOpenBackoffDelaysMs(),
            ensureOpen,
            isCurrent,
            onLocked,
            onRetry,
            onExhausted,
            onSuccess,
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: (id) => window.clearTimeout(id),
        });

        scheduler.start();
        expect(onLocked).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2000);
        expect(ensureOpen).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(3000);
        expect(ensureOpen).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(5000);
        expect(ensureOpen).toHaveBeenCalledTimes(3);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onExhausted).not.toHaveBeenCalled();
        scheduler.dispose();
    });

    it('cancels pending retries on dispose (unload)', async () => {
        const ensureOpen = vi.fn().mockRejectedValue(new Error('locked'));
        const isCurrent = vi.fn().mockReturnValue(true);

        const scheduler = createStoreOpenRetryScheduler({
            delaysMs: storeOpenRetryDelaysMs(),
            backoffDelaysMs: storeOpenBackoffDelaysMs(),
            ensureOpen,
            isCurrent,
            onLocked: NOOP,
            onRetry: NOOP,
            onExhausted: NOOP,
            onSuccess: NOOP,
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: (id) => window.clearTimeout(id),
        });

        scheduler.start();
        scheduler.dispose();

        await vi.advanceTimersByTimeAsync(20000);
        expect(ensureOpen).not.toHaveBeenCalled();
    });

    it('skips ticks when isCurrent returns false', async () => {
        const ensureOpen = vi.fn().mockRejectedValue(new Error('locked'));
        const isCurrent = vi.fn().mockReturnValue(false);

        const scheduler = createStoreOpenRetryScheduler({
            delaysMs: [100],
            backoffDelaysMs: [500],
            ensureOpen,
            isCurrent,
            onLocked: NOOP,
            onRetry: NOOP,
            onExhausted: NOOP,
            onSuccess: NOOP,
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: (id) => window.clearTimeout(id),
        });

        scheduler.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(ensureOpen).not.toHaveBeenCalled();
        scheduler.dispose();
    });

    it('fires onExhausted after all fixed + backoff delays fail', async () => {
        const ensureOpen = vi.fn().mockRejectedValue(new Error('locked'));
        const onExhausted = vi.fn();
        const isCurrent = vi.fn().mockReturnValue(true);

        const scheduler = createStoreOpenRetryScheduler({
            delaysMs: [10, 20],
            backoffDelaysMs: [50, 100],
            ensureOpen,
            isCurrent,
            onLocked: NOOP,
            onRetry: NOOP,
            onExhausted,
            onSuccess: NOOP,
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: (id) => window.clearTimeout(id),
        });

        scheduler.start();
        // Fixed delays: 10ms, 20ms
        await vi.advanceTimersByTimeAsync(30);
        // Backoff starter fires after last fixed delay (20ms)
        // Backoff chain: 50ms, then 100ms
        await vi.advanceTimersByTimeAsync(200);
        expect(onExhausted).toHaveBeenCalledTimes(1);
        scheduler.dispose();
    });

    it('retryNow cancels pending ticks and fires immediately', async () => {
        const ensureOpen = vi.fn()
            .mockRejectedValueOnce(new Error('locked'))
            .mockResolvedValueOnce(undefined);
        const onSuccess = vi.fn();
        const onExhausted = vi.fn();
        const onRetry = vi.fn();
        const isCurrent = vi.fn().mockReturnValue(true);

        const scheduler = createStoreOpenRetryScheduler({
            delaysMs: [50000],
            backoffDelaysMs: [100],
            ensureOpen,
            isCurrent,
            onLocked: NOOP,
            onRetry,
            onExhausted,
            onSuccess,
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: (id) => window.clearTimeout(id),
        });

        scheduler.start();
        expect(ensureOpen).not.toHaveBeenCalled();

        scheduler.retryNow();
        // retryNow fires synchronously via tryOnceBackoff.
        // await 0 to drain the microtask from the async promise rejection.
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        expect(ensureOpen).toHaveBeenCalledTimes(1);
        expect(onSuccess).not.toHaveBeenCalled();

        // Backoff chain schedules at 100ms.
        await vi.advanceTimersByTimeAsync(200);
        await Promise.resolve();
        expect(ensureOpen).toHaveBeenCalledTimes(2);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onExhausted).not.toHaveBeenCalled();
        scheduler.dispose();
    });
});