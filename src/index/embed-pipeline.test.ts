import { describe, it, expect } from 'vitest';
import { InFlightSemaphore, createExclusiveChain, clampEmbedInFlightMax, DEFAULT_EMBED_IN_FLIGHT, gpuOccupancyPct, effectiveBatchSize } from './embed-pipeline';

describe('clampEmbedInFlightMax', () => {
    it('clamps to 1–16 and falls back to the default', () => {
        expect(clampEmbedInFlightMax(DEFAULT_EMBED_IN_FLIGHT)).toBe(10);
        expect(clampEmbedInFlightMax(0)).toBe(1);
        expect(clampEmbedInFlightMax(99)).toBe(16);
        expect(clampEmbedInFlightMax(Number.NaN)).toBe(DEFAULT_EMBED_IN_FLIGHT);
    });
});

describe('InFlightSemaphore', () => {
    it('lets max tasks overlap and parks the next until a slot frees', async () => {
        const sem = new InFlightSemaphore(2);
        let started = 0;
        let releaseFirst!: () => void;
        const firstHold = new Promise<void>(r => { releaseFirst = r; });

        const a = (async () => {
            await sem.acquire();
            started++;
            await firstHold;
            sem.release();
        })();
        const b = (async () => {
            await sem.acquire();
            started++;
            sem.release();
        })();
        let cStarted = false;
        const c = (async () => {
            await sem.acquire();
            cStarted = true;
            started++;
            sem.release();
        })();

        await Promise.resolve();
        await Promise.resolve();
        expect(started).toBe(2);
        expect(cStarted).toBe(false);
        expect(sem.inFlight).toBe(2);

        releaseFirst();
        await Promise.all([a, b, c]);
        expect(started).toBe(3);
        expect(cStarted).toBe(true);
        expect(sem.inFlight).toBe(0);
        expect(sem.highWater).toBe(2);
        expect(sem.waitMs).toBeGreaterThan(0);
    });
});

describe('gpuOccupancyPct / effectiveBatchSize', () => {
    it('caps occupancy at 100 and treats empty wall as 0', () => {
        expect(gpuOccupancyPct(40_000, 100_000)).toBe(40);
        expect(gpuOccupancyPct(200_000, 100_000)).toBe(100);
        expect(gpuOccupancyPct(10, 0)).toBe(0);
        expect(effectiveBatchSize(800, 100)).toBe(8);
        expect(effectiveBatchSize(800, 0)).toBe(0);
    });
});

describe('createExclusiveChain', () => {
    it('runs jobs FIFO and a rejection does not poison the next job', async () => {
        const chain = createExclusiveChain();
        const order: string[] = [];
        const a = chain.run(async () => { order.push('a'); });
        const b = chain.run(async () => { order.push('b'); throw new Error('b-fail'); });
        const c = chain.run(async () => { order.push('c'); return 7; });
        await expect(a).resolves.toBeUndefined();
        await expect(b).rejects.toThrow('b-fail');
        await expect(c).resolves.toBe(7);
        expect(order).toEqual(['a', 'b', 'c']);
        await chain.idle();
    });
});
