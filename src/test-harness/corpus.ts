// Corpus generator for startup micro-benchmarks. Seeds IndexedDB rows matching
// production shape via putBatch (fast setup — avoids a full reindexAll embed pass
// that dominated bench beforeAll). fake-indexeddb is W3C-faithful, NOT WKWebView.
import type { Chunk } from '../types';
import { META_SCHEMA_VERSION } from '../index-store';
import { MODEL_ID, PLUGIN_VERSION } from '../embedder';
import { CHUNKER_VERSION } from '../chunker';
import { MultiFieldBM25 } from '../bm25';
import { DEFAULT_SETTINGS } from '../types';
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
    const chunks: Chunk[] = [];
    const vectors: Float32Array[] = [];
    let chunkIdx = 0;

    for (let n = 0; n < notes && chunkIdx < targetChunks; n++) {
        const path = `bench/note-${n}.md`;
        const chunkIds: string[] = [];
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
        await scenario.store.putBatch(chunks.slice(-chunkIds.length), vectors.slice(-chunkIds.length));
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

    const meta = await scenario.store.listAllMeta();
    const bodies = await scenario.store.getBodiesMap(meta.map(c => c.chunk_id));
    const bm25Json = new MultiFieldBM25().fit(meta, bodies, {
        searchableProperties: DEFAULT_SETTINGS.searchableProperties,
        headingsField: DEFAULT_SETTINGS.headingsField,
    }).toJSON();

    const counts = await scenario.store.count();
    return {
        scenario,
        chunkCount: counts.chunks,
        fileCount: counts.files,
        bm25Json,
    };
}
