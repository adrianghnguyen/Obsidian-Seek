import { describe, expect, it, vi } from 'vitest';
import { awaitCatchUpQuiescence } from './index-work-quiescence';

describe('awaitCatchUpQuiescence', () => {
    it('returns immediately when catch-up is not running', async () => {
        await expect(awaitCatchUpQuiescence(() => false)).resolves.toBe(true);
    });

    it('waits until catch-up stops', async () => {
        vi.useFakeTimers();
        let running = true;
        setTimeout(() => { running = false; }, 100);
        const p = awaitCatchUpQuiescence(() => running, { pollMs: 20, timeoutMs: 500 });
        await vi.advanceTimersByTimeAsync(120);
        await expect(p).resolves.toBe(true);
        vi.useRealTimers();
    });

    it('times out when catch-up never stops', async () => {
        vi.useFakeTimers();
        const p = awaitCatchUpQuiescence(() => true, { pollMs: 10, timeoutMs: 50 });
        await vi.advanceTimersByTimeAsync(60);
        await expect(p).resolves.toBe(false);
        vi.useRealTimers();
    });
});
