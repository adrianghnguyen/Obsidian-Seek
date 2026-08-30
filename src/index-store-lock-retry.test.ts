import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    storeOpenRetryDelaysMs,
    isRetryIndexStoreCommandEnabled,
    createStoreOpenRetryScheduler,
} from './index-store-lock';

describe('storeOpenRetryDelaysMs', () => {
    it('schedules deferred ensureOpen at 2s, 5s, 10s, and 15s', () => {
        expect(storeOpenRetryDelaysMs()).toEqual([2000, 5000, 10000, 15000]);
    });
});

describe('isRetryIndexStoreCommandEnabled', () => {
    it('is enabled only while the store is locked', () => {
        expect(isRetryIndexStoreCommandEnabled(true)).toBe(true);
        expect(isRetryIndexStoreCommandEnabled(false)).toBe(false);
    });
});

describe('createStoreOpenRetryScheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires ensureOpen at each delay until success', async () => {
        const ensureOpen = vi.fn()
            .mockRejectedValueOnce(new Error('locked'))
            .mockRejectedValueOnce(new Error('locked'))
            .mockResolvedValueOnce(undefined);
        const onLocked = vi.fn();
        const onSuccess = vi.fn();
        const isCurrent = vi.fn().mockReturnValue(true);

        const scheduler = createStoreOpenRetryScheduler({
            delaysMs: storeOpenRetryDelaysMs(),
            ensureOpen,
            isCurrent,
            onLocked,
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
        scheduler.dispose();
    });

    it('cancels pending retries on dispose (unload)', async () => {
        const ensureOpen = vi.fn().mockRejectedValue(new Error('locked'));
        const isCurrent = vi.fn().mockReturnValue(true);

        const scheduler = createStoreOpenRetryScheduler({
            delaysMs: storeOpenRetryDelaysMs(),
            ensureOpen,
            isCurrent,
            onLocked: () => {},
            onSuccess: () => {},
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
            ensureOpen,
            isCurrent,
            onLocked: () => {},
            onSuccess: () => {},
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: (id) => window.clearTimeout(id),
        });

        scheduler.start();
        await vi.advanceTimersByTimeAsync(100);
        expect(ensureOpen).not.toHaveBeenCalled();
        scheduler.dispose();
    });
});
