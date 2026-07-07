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

// Slow benches: cap iterations so BM25 fit/fromJSON don't OOM the worker.
const SLOW_BENCH = { iterations: 5, time: 3000 } as const;

for (const n of ALL_SIZES) {
    describe(`startup @ ~${n} chunks`, () => {
        bench('store.open (fresh scoped DB)', async () => {
            const store = new IndexStore();
            await store.open(`bench-open-${n}-${Math.random().toString(36).slice(2)}`, 'seek-bench');
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

        bench('warmCaches (cache hit)', async () => {
            await corpus(n).scenario.orch.warmCaches('bench-hit');
        });

        bench('warmCaches (cold miss)', async () => {
            const { orch } = corpus(n).scenario;
            orch.invalidateBm25Cache();
            await orch.warmCaches('bench-cold');
        }, SLOW_BENCH);

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
