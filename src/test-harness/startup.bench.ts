// Startup / cold-path micro-benchmarks (Node + fake-indexeddb). Run:
//   npm run bench
// Caveat: timings here are relative regression signals and scaling shape — not
// absolute Obsidian/WKWebView numbers (see AGENTS.md Tier-2 harness boundary).
import { bench, describe, beforeAll } from 'vitest';
import { IndexStore } from '../index-store';
import { MultiFieldBM25 } from '../bm25';
import { DEFAULT_SETTINGS } from '../types';
import { seedCorpus, type SeededCorpus } from './corpus';

const SIZES = [1_000, 5_000] as const;
// 20k setup is slow in CI; include only when SEEK_BENCH_FULL=1
const FULL = process.env.SEEK_BENCH_FULL === '1';
const SIZE_FILTER = process.env.SEEK_BENCH_SIZE ? Number(process.env.SEEK_BENCH_SIZE) : null;
const ALL_SIZES = SIZE_FILTER
    ? ([SIZE_FILTER] as const)
    : FULL
        ? ([...SIZES, 20_000] as const)
        : SIZES;

const corpora = new Map<number, SeededCorpus>();

beforeAll(async () => {
    for (const n of ALL_SIZES) {
        corpora.set(n, await seedCorpus(n));
    }
}, 600_000);

function corpus(n: number): SeededCorpus {
    const c = corpora.get(n);
    if (!c) throw new Error(`corpus ${n} not seeded`);
    return c;
}

// Heavy benches (BM25 fit/fromJSON, warmCaches) allocate a full 5k-doc MiniSearch
// per call. Time-based sampling (the vitest default) runs them dozens of times per
// window and OOMs the worker faster than GC reclaims. Pin them to a fixed, tiny
// sample count (time:0 ⇒ exactly `iterations` runs) — directional, not deep stats,
// which is the right trade for a scaling/regression harness at 5k+.
const SLOW_BENCH = { iterations: 5, time: 0, warmupIterations: 1, warmupTime: 0 } as const;
const WARM_BENCH = { iterations: 3, time: 0, warmupIterations: 0, warmupTime: 0 } as const;

for (const n of ALL_SIZES) {
    describe(`startup @ ~${n} chunks`, () => {
        // Reuse ONE fixed DB name and close the connection each iteration: a random
        // name per iteration leaks a fresh database into fake-indexeddb every sample
        // (~15k/run) and OOMs the worker. First sample creates the DB; the rest reopen
        // it — which is the cost we actually want to measure anyway.
        bench('store.open (reopen existing DB)', async () => {
            const store = new IndexStore();
            await store.open(`bench-open-${n}`, 'seek-bench');
            store.close();
        });

        bench('listAllMeta', async () => {
            await corpus(n).scenario.store.listAllMeta();
        });

        bench('listAllBinary', async () => {
            await corpus(n).scenario.store.listAllBinary();
        });

        bench('listAllEmbeddings', async () => {
            await corpus(n).scenario.store.listAllEmbeddings();
        });

        // Bounded: warmCaches fires a fire-and-forget persistBm25 (multi-MB toJSON at
        // 5k) even on a cache hit, so thousands of time-based samples OOM the worker.
        // A small fixed count still captures the ~instant resident-hit cost.
        bench('warmCaches (cache hit)', async () => {
            await corpus(n).scenario.orch.warmCaches('bench-hit');
        }, { iterations: 20, time: 0, warmupIterations: 0, warmupTime: 0 });

        // H7 after: a cold-start trigger (model-load class) now loads the persisted
        // BM25 blob via fromJSON instead of refitting all bodies. Corpus seeds a
        // stamp-matching blob, so this exercises the fast path end-to-end.
        bench('warmCaches cold (persisted, H7)', async () => {
            const { orch } = corpus(n).scenario;
            orch.invalidateBm25Cache();
            await orch.warmCaches('model-load');
        }, WARM_BENCH);

        // H7 before: 'full-reindex' deliberately forces the authoritative fit()
        // rebuild — the baseline the persisted path replaces on cold start.
        bench('warmCaches cold (forced fit, baseline)', async () => {
            const { orch } = corpus(n).scenario;
            orch.invalidateBm25Cache();
            await orch.warmCaches('full-reindex');
        }, WARM_BENCH);

        bench('computeDelta (reconcileOnLoad diff)', async () => {
            await corpus(n).scenario.orch.computeDelta();
        });

        bench('BM25 fit (cold)', async () => {
            const { scenario } = corpus(n);
            const chunks = await scenario.store.listAllMeta();
            const bodies = await scenario.store.getBodiesMap(chunks.map(c => c.chunk_id));
            new MultiFieldBM25().fit(chunks, bodies, {
                searchableProperties: DEFAULT_SETTINGS.searchableProperties,
                headingsField: DEFAULT_SETTINGS.headingsField,
            });
        }, SLOW_BENCH);

        bench('BM25 fromJSON (persisted load)', async () => {
            const { scenario, bm25Json } = corpus(n);
            const chunks = await scenario.store.listAllMeta();
            new MultiFieldBM25().fromJSON(bm25Json, chunks, {
                searchableProperties: DEFAULT_SETTINGS.searchableProperties,
                headingsField: DEFAULT_SETTINGS.headingsField,
            });
        }, SLOW_BENCH);

        bench('store.backfillBinaryIfMissing (steady-state no-op)', async () => {
            await corpus(n).scenario.store.backfillBinaryIfMissing();
        });
    });
}
