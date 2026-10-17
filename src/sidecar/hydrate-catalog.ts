/**
 * Session cache for catch-up sidecar hydrate. scanJsonl + existing chunk ids are
 * O(sidecar) / O(index); catch-up used to redo both on every 200-file burst.
 * Reuse until the jsonl catalog changes (size key) or the caller invalidates
 * (wipe / rebuild).
 */

import type { ScanResult } from './sidecar';

export class CatchUpHydrateCatalog {
    private sig: string | null = null;
    private scan: ScanResult | null = null;
    private existing: Set<string> | null = null;
    private scanLoads = 0;
    private existingLoads = 0;

    /** Test/telemetry: how many times the jsonl catalog was actually parsed. */
    get scanLoadCount(): number { return this.scanLoads; }
    get existingLoadCount(): number { return this.existingLoads; }

    invalidate(): void {
        this.sig = null;
        this.scan = null;
        this.existing = null;
    }

    async getScan(sig: string, load: () => Promise<ScanResult>): Promise<ScanResult> {
        if (this.scan && this.sig === sig) return this.scan;
        this.scan = null;
        this.existing = null;
        this.sig = sig;
        this.scan = await load();
        this.scanLoads++;
        return this.scan;
    }

    async getExisting(load: () => Promise<Iterable<string>>): Promise<Set<string>> {
        if (this.existing) return this.existing;
        this.existing = new Set(await load());
        this.existingLoads++;
        return this.existing;
    }

    noteHydrated(ids: Iterable<string>): void {
        if (!this.existing) this.existing = new Set();
        for (const id of ids) this.existing.add(id);
    }
}

/** Cache key: jsonl paths plus byte size so an append invalidates the scan. */
export async function hydrateScanSignature(
    stat: (path: string) => Promise<{ size: number } | null>,
    jsonlPaths: string[],
): Promise<string> {
    const parts: string[] = [];
    for (const p of jsonlPaths) {
        const st = await stat(p).catch(() => null);
        parts.push(`${p}:${st?.size ?? 0}`);
    }
    return parts.join('|');
}
