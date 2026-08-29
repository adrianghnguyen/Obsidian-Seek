// T4 persist-cache — restore IDB BM25 + resident frame before reconcileOnLoad so
// the first post-eviction delta can apply incrementally instead of cold-rebuilding.

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scenario } from './test-harness/scenario';
import { buildBm25Stamp, type Bm25PersistStamp } from './search';
import { MultiFieldBM25 } from './bm25';
import { DEFAULT_SETTINGS } from './types';

const open: Scenario[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.teardown(); vi.restoreAllMocks(); });

function noteBody(): string {
    return Array.from({ length: 8 }, (_, i) =>
        `## Section ${i}\n\n${Array.from({ length: 30 }, (_, j) => `word${i}x${j % 5}`).join(' ')}`).join('\n\n');
}

async function bootIndexed(): Promise<Scenario> {
    const s = new Scenario();
    open.push(s);
    await s.boot();
    s.vault.write('Ballast.md', noteBody(), 900);
    s.vault.write('Note.md', noteBody(), 1000);
    await s.coldStart();
    await s.orch.warmCaches('test-persist');
    const t0 = Date.now();
    while (!(await s.store.getBm25()) && Date.now() - t0 < 3000) {
        await new Promise(r => setTimeout(r, 10));
    }
    if (!(await s.store.getBm25())) {
        const o = s.orch as unknown as { bm25Cache: MultiFieldBM25 | null };
        const meta = await s.store.getMeta();
        const chunks = await s.store.listAllMeta();
        if (!o.bm25Cache || !meta.lastIndexedAt) throw new Error('expected warm BM25 + stamped meta');
        await s.store.putBm25(o.bm25Cache.toJSON(), buildBm25Stamp(meta, chunks.length, DEFAULT_SETTINGS));
    }
    return s;
}

function simulateProcessRestart(orch: Scenario['orch']): void {
    const o = orch as unknown as {
        frameCache: unknown;
        bm25Cache: unknown;
        bm25CacheGeneration: number;
        bm25CacheChunkCount: number;
        synonymCache: unknown;
    };
    o.frameCache = null;
    o.bm25Cache = null;
    o.bm25CacheGeneration = -1;
    o.bm25CacheChunkCount = -1;
    o.synonymCache = null;
}

function fallbackLogs(infoSpy: ReturnType<typeof vi.spyOn>): string[] {
    return infoSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('applyDelta fallback'));
}

describe('restorePersistedCachesBeforeReconcile', () => {
    it('loads frame + BM25 from IDB after simulated eviction', async () => {
        const s = await bootIndexed();
        simulateProcessRestart(s.orch);

        const restored = await s.orch.restorePersistedCachesBeforeReconcile();
        expect(restored.frameRestored).toBe(true);
        expect(restored.bm25Restored).toBe(true);
        expect(restored.chunkCount).toBeGreaterThan(0);

        const o = s.orch as unknown as { frameCache: unknown; bm25Cache: unknown };
        expect(o.frameCache).not.toBeNull();
        expect(o.bm25Cache).not.toBeNull();
    });

    it('lets reconcile delta apply incrementally after restore (delta-apply telemetry)', async () => {
        const s = await bootIndexed();
        simulateProcessRestart(s.orch);

        await s.orch.restorePersistedCachesBeforeReconcile();

        const appended: Array<Record<string, unknown>> = [];
        const orch = s.orch as unknown as { logger: { append: (e: Record<string, unknown>) => Promise<void> } };
        const origAppend = orch.logger.append.bind(orch.logger);
        orch.logger.append = async (e): Promise<void> => { appended.push(e); return origAppend(e); };

        const infoSpy = vi.spyOn(console, 'info');
        const body = noteBody().replace('word0x0', 'word0x0 EDITED');
        await s.edit('Note.md', body, 2000);

        expect(fallbackLogs(infoSpy)).toEqual([]);
        const deltas = appended.filter(e => e.type === 'delta-apply');
        expect(deltas).toHaveLength(1);
        expect(deltas[0].appliedIncrementally).toBe(true);
        expect(deltas[0].fallbackReason).toBeUndefined();
    });

    it('rejects a stamp-mismatched BM25 blob and leaves BM25 cold', async () => {
        const s = await bootIndexed();
        const meta = await s.store.getMeta();
        const blob = await s.store.getBm25();
        expect(blob).not.toBeNull();
        const stamp = blob!.stamp as Bm25PersistStamp;
        const badStamp = buildBm25Stamp({ ...meta, modelId: 'wrong-model' }, stamp.chunkCount, DEFAULT_SETTINGS);
        await s.store.putBm25(blob!.json, badStamp);

        simulateProcessRestart(s.orch);
        const restored = await s.orch.restorePersistedCachesBeforeReconcile();
        expect(restored.frameRestored).toBe(true);
        expect(restored.bm25Restored).toBe(false);

        const o = s.orch as unknown as { bm25Cache: unknown };
        expect(o.bm25Cache).toBeNull();
    });
});
