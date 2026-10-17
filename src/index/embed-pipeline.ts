// Producer-consumer bound between GPU embed dispatches and IndexedDB persists.
//
// The iframe child serializes WebGPU forwards, but the parent may post the next
// embed-batch before the previous reply so N+1 starts as N returns. The parent
// used to wait for the IDB transaction of batch N before posting batch N+1, so
// the GPU sat idle for the disk round-trip. This semaphore lets persist of N
// run in the background and pauses dispatch if disk falls more than maxInFlight
// behind.

export const DEFAULT_EMBED_IN_FLIGHT = 10;
export const EMBED_IN_FLIGHT_MIN = 1;
export const EMBED_IN_FLIGHT_MAX = 16;
/** @deprecated use DEFAULT_EMBED_IN_FLIGHT — kept as an alias for callers/tests */
export const MAX_EMBED_IN_FLIGHT = DEFAULT_EMBED_IN_FLIGHT;

export function clampEmbedInFlightMax(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_EMBED_IN_FLIGHT;
    return Math.max(EMBED_IN_FLIGHT_MIN, Math.min(EMBED_IN_FLIGHT_MAX, Math.round(n)));
}

// Full reindex only: how many embed flushes may sit on the GPU tail so the
// parent can read/chunk/tokenize later notes while batch N is in the iframe.
// Catch-up still awaits each flush so typing stays smooth.
export const GPU_AHEAD_MIN = 2;
export const GPU_AHEAD_MAX = 8;

export function gpuAheadCap(inflightMax: number): number {
    return Math.max(GPU_AHEAD_MIN, Math.min(GPU_AHEAD_MAX, clampEmbedInFlightMax(inflightMax)));
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
