// Pure memory + distribution helpers. Extracted from types.ts (no domain
// types here so diagnostics/report code can import them without pulling in
// the settings/schema surface).

// ---- heap + memory ----

export interface HeapMB {
    mb: number | null;
    available: boolean;
}

// performance.memory is Chromium-only. On iOS WebKit and Safari this returns
// { mb: null, available: false } — every "Heap Δ" field in the report is
// blank there. See MemorySnapshot below for the iOS-friendly proxy.
export function snapshotHeap(): HeapMB {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (!mem) return { mb: null, available: false };
    return { mb: mem.usedJSHeapSize / 1e6, available: true };
}

export function heapDelta(before: HeapMB, after: HeapMB): number | null {
    if (before.mb == null || after.mb == null) return null;
    return after.mb - before.mb;
}

// Full memory snapshot. `heapMB` mirrors snapshotHeap (null on iOS). `storageMB`
// reads navigator.storage.estimate().usage — counts on-disk IDB + Cache API
// bytes and works on iOS. It's not a true heap proxy but it does answer
// "did this operation actually write data to disk", which is the question
// that mattered for the iOS spike's jetsam diagnosis.
export interface MemorySnapshot {
    heapMB: number | null;
    storageMB: number | null;
    timestampMs: number;
}

export async function snapshotMemory(): Promise<MemorySnapshot> {
    const heap = snapshotHeap();
    let storageMB: number | null = null;
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        try {
            const est = await navigator.storage.estimate();
            storageMB = est.usage != null ? est.usage / 1e6 : null;
        } catch { /* swallow */ }
    }
    return {
        heapMB: heap.mb,
        storageMB,
        timestampMs: performance.now(),
    };
}

export function memoryDelta(before: MemorySnapshot, after: MemorySnapshot): {
    heapDeltaMB: number | null;
    storageDeltaMB: number | null;
    elapsedMs: number;
} {
    return {
        heapDeltaMB: before.heapMB != null && after.heapMB != null ? after.heapMB - before.heapMB : null,
        storageDeltaMB: before.storageMB != null && after.storageMB != null ? after.storageMB - before.storageMB : null,
        elapsedMs: after.timestampMs - before.timestampMs,
    };
}

// ---- distribution stats ----

// Generic min/max/p50/p95 over a sample. Used to summarize per-file timings
// and chunks-per-file without bloating the log with raw arrays.
export interface DistributionStats {
    n: number;
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
}

export function distributionStats(samples: number[]): DistributionStats | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((q / 100) * (sorted.length - 1)))];
    return {
        n: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sum / sorted.length,
        p50: pick(50),
        p95: pick(95),
    };
}
