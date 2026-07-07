// Corpus generator for startup micro-benchmarks. Seeds IndexedDB rows matching
// production shape via putBatch (fast setup — avoids a full reindexAll embed pass
// that dominated bench beforeAll). fake-indexeddb is W3C-faithful, NOT WKWebView.
import type { Chunk } from '../types';
import { META_SCHEMA_VERSION } from '../index-store';
import { MODEL_ID, PLUGIN_VERSION } from '../embedder';
import { CHUNKER_VERSION } from '../chunker';
import { MultiFieldBM25 } from '../bm25';
import { DEFAULT_SETTINGS } from '../types';
import { buildBm25Stamp } from '../search';
import { Scenario, hashVec } from './scenario';

export interface SeededCorpus {
    scenario: Scenario;
    chunkCount: number;
    fileCount: number;
    /** Pre-serialized BM25 index for fromJSON bench (avoids fit+fromJSON double cost). */
    bm25Json: ReturnType<MultiFieldBM25['toJSON']>;
}

/** Fast IDB seed: N chunks across ceil(N/5) notes (~5 chunks/note). */
export async function seedCorpus(targetChunks: number): Promise<SeededCorpus> {
    const scenario = new Scenario();
    await scenario.boot();

    const notes = Math.max(1, Math.ceil(targetChunks / 5));
    let chunkIdx = 0;
    const memDbg = process.env.SEEK_BENCH_MEMDBG === '1';

    for (let n = 0; n < notes && chunkIdx < targetChunks; n++) {
        if (memDbg && n % 200 === 0) {
            const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            // eslint-disable-next-line no-console
            console.log(`[seed] note ${n}/${notes} chunk ${chunkIdx} heapUsed=${mb}MB`);
        }
        const path = `bench/note-${n}.md`;
        const chunkIds: string[] = [];
        const chunks: Chunk[] = [];
        const vectors: Float32Array[] = [];
        for (let s = 0; s < 5 && chunkIdx < targetChunks; s++, chunkIdx++) {
            const title = `Note ${n} > Section ${s}`;
            const content = `Benchmark chunk ${chunkIdx} with enough text for lexical indexing.`;
            const chunkId = `bench-${chunkIdx.toString(16).padStart(8, '0')}`;
            const embedText = `${title}\n\n${content}`;
            chunks.push({
                chunk_id: chunkId,
                note_path: path,
                title,
                content,
                heading_path: [`Section ${s}`],
                metadata: {
                    tags: [],
                    aliases: [],
                    created: null,
                    modified: null,
                    properties: {},
                },
                start_line: s * 10,
                end_line: s * 10 + 5,
                link_terms: '',
            });
            vectors.push(hashVec(embedText));
            chunkIds.push(chunkId);
        }
        await scenario.store.putBatch(chunks, vectors);
        await scenario.store.putFileRecord({
            note_path: path,
            mtimeMs: 1_700_000_000 + n,
            chunk_ids: chunkIds,
            contentHash: `hash-${n}`,
        });
    }

    await scenario.store.setMeta({
        embeddingDim: 384,
        lastIndexedAt: new Date().toISOString(),
        schemaVersion: META_SCHEMA_VERSION,
        modelId: MODEL_ID,
        chunkerVersion: CHUNKER_VERSION,
        revision: PLUGIN_VERSION,
    });

    const dbg = (m: string) => { if (memDbg) { const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024); console.log(`[seed] ${m} heapUsed=${mb}MB`); } };
    dbg('loop done');
    const meta = await scenario.store.listAllMeta();
    dbg('listAllMeta');
    const bodies = await scenario.store.getBodiesMap(meta.map(c => c.chunk_id));
    dbg('getBodiesMap');
    const bm25 = new MultiFieldBM25().fit(meta, bodies, {
        searchableProperties: DEFAULT_SETTINGS.searchableProperties,
        headingsField: DEFAULT_SETTINGS.headingsField,
    });
    dbg('fit');
    const bm25Json = bm25.toJSON();
    dbg('toJSON');

    // Persist the BM25 blob with a live-matching stamp so tryLoadPersistedBm25
    // (the H7 fast path) HITS during warmCaches — this is the realistic cold-boot
    // state: a completed index left a persisted MiniSearch index in IDB.
    const metaCfg = await scenario.store.getMeta();
    const stamp = buildBm25Stamp(metaCfg, meta.length, DEFAULT_SETTINGS);
    await scenario.store.putBm25(bm25Json, stamp);
    dbg('putBm25');

    const counts = await scenario.store.count();
    return {
        scenario,
        chunkCount: counts.chunks,
        fileCount: counts.files,
        bm25Json,
    };
}
