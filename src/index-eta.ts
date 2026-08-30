/** Rough remaining-time buckets from this pass's own throughput — not a countdown clock. */
export function formatRoughEta(done: number, total: number, elapsedMs: number): string | null {
    if (done < 20 || elapsedMs < 15_000 || total <= 0 || done >= total) return null;
    const elapsedSec = elapsedMs / 1000;
    if (elapsedSec <= 0) return null;
    const remainingSec = ((total - done) / done) * elapsedSec;
    if (!Number.isFinite(remainingSec) || remainingSec <= 0) return null;
    if (remainingSec < 45) return '~30s';
    if (remainingSec < 150) return '~2 min';
    if (remainingSec < 420) return '~5 min';
    if (remainingSec < 900) return '~15 min';
    if (remainingSec < 1800) return '~30 min';
    return `~${Math.round(remainingSec / 3600)} hr`;
}

export function indexPercent(done: number, total: number): number {
    if (total <= 0) return 0;
    if (done >= total) return 100;
    return Math.min(100, Math.round((Math.max(0, done) / total) * 100));
}
