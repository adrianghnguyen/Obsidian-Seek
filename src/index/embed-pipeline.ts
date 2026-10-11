// Producer-consumer bound between GPU embed dispatches and IndexedDB persists.
//
// The iframe child is still single-flight (one WebGPU forward at a time). The
// parent used to wait for the IDB transaction of batch N before posting batch
// N+1, so the GPU sat idle for the disk round-trip. This semaphore lets the
// next embed start as soon as vectors return, while persist of N runs in the
// background, and pauses dispatch if disk falls more than maxInFlight behind.

export const DEFAULT_EMBED_IN_FLIGHT = 10;
export const EMBED_IN_FLIGHT_MIN = 1;
export const EMBED_IN_FLIGHT_MAX = 16;
/** @deprecated use DEFAULT_EMBED_IN_FLIGHT — kept as an alias for callers/tests */
export const MAX_EMBED_IN_FLIGHT = DEFAULT_EMBED_IN_FLIGHT;

export function clampEmbedInFlightMax(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_EMBED_IN_FLIGHT;
    return Math.max(EMBED_IN_FLIGHT_MIN, Math.min(EMBED_IN_FLIGHT_MAX, Math.round(n)));
}

export class InFlightSemaphore {
    private current = 0;
    private readonly waiters: Array<() => void> = [];
    /** Wall time spent parked because disk was still catching up. */
    waitMs = 0;
    /** Peak unwritten batches (1…max). */
    highWater = 0;

    constructor(readonly max: number) {}

    get inFlight(): number {
        return this.current;
    }

    async acquire(): Promise<void> {
        const parked = performance.now();
        while (this.current >= this.max) {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
        this.waitMs += performance.now() - parked;
        this.current++;
        if (this.current > this.highWater) this.highWater = this.current;
    }

    release(): void {
        this.current--;
        this.waiters.shift()?.();
    }
}

/** Fraction of wall the iframe reported it was inside an embed forward (0–100). */
export function gpuOccupancyPct(gpuBusyMs: number, wallMs: number): number {
    if (!(wallMs > 0) || !(gpuBusyMs >= 0)) return 0;
    return Math.min(100, (gpuBusyMs / wallMs) * 100);
}

export function effectiveBatchSize(vectors: number, dispatches: number): number {
    if (!(dispatches > 0) || !(vectors >= 0)) return 0;
    return vectors / dispatches;
}

/** FIFO async mutex whose tail never poisons after a rejected job. */
export function createExclusiveChain(): {
    run: <T>(fn: () => Promise<T>) => Promise<T>;
    idle: () => Promise<void>;
} {
    let tail: Promise<void> = Promise.resolve();
    return {
        run<T>(fn: () => Promise<T>): Promise<T> {
            const job = tail.then(fn, fn);
            tail = job.then(() => undefined, () => undefined);
            return job;
        },
        idle: () => tail,
    };
}
