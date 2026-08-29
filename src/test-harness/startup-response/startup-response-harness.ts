import 'fake-indexeddb/auto';

import type { App, DataAdapter } from 'obsidian';
import { packSignBits } from '../../binary';
import { IndexStore } from '../../index-store';
import { quantizeInt8 } from '../../quant';
import { SearchOrchestrator } from '../../search';
import { bulkAppend, SIDECAR_FORMAT, type TierBytes } from '../../sidecar';
import { expectationFor } from '../../sidecar-meta';
import {
    hydrateFromSidecar,
    type HydrateDeps,
    type HydrateResult,
    type ReChunkedNote,
} from '../../sidecar-sync';
import { DEFAULT_SETTINGS, type Chunk } from '../../types';
import { FakeVault, fakeEmbedder, hashVec } from '../scenario';
import { mtimeMs, type StartupNoteFixture, type StartupResponseFixture } from './fixtures';
import { MemoryDataAdapter } from './memory-adapter';

const INDEX_DIR = '.obsidian/plugins/seek/index';
const PRODUCER_ID = 'fixture-peer';

export interface StartupCostFixture {
    sidecarScanMs: number;
    fileRechunkMs: number;
    commitMs: number;
}

export interface StartupHydrateObservation {
    gateAtMs: number | null;
    walkedPaths: string[];
    searchablePaths: string[];
    hydrate: HydrateResult;
}

const DEFAULT_COSTS: StartupCostFixture = {
    sidecarScanMs: 500,
    fileRechunkMs: 2_000,
    commitMs: 500,
};

/**
 * Deterministic startup-response integration harness.
 *
 * Real code under test:
 * - sidecar encoding and scan
 * - greedy 3-day hydration policy
 * - fake-indexeddb-backed IndexStore writes
 * - SearchOrchestrator frame/BM25/ranking pipeline
 *
 * Replaced boundaries:
 * - Obsidian Vault and DataAdapter are in memory
 * - embeddings are deterministic token hashes
 * - elapsed time is a logical fixture cost, not a hardware benchmark
 */
export class StartupResponseHarness {
    readonly adapter = new MemoryDataAdapter();
    readonly vault = new FakeVault();
    readonly store = new IndexStore();
    readonly embedder = fakeEmbedder();

    private readonly anchorMs = Date.now();
    private logicalMs = 0;
    private gateAtMs: number | null = null;
    private readonly walkedPaths: string[] = [];
    private orchestrator: SearchOrchestrator | null = null;

    constructor(
        readonly fixture: StartupResponseFixture,
        readonly costs: StartupCostFixture = DEFAULT_COSTS,
    ) {
        for (const note of fixture.notes) {
            this.vault.write(note.path, note.body, mtimeMs(note, this.anchorMs));
        }
    }

    async boot(): Promise<void> {
        await this.store.open(
            `startup-response-${Math.random().toString(36).slice(2)}`,
            'seek-test',
        );
        await this.seedPeerSidecar();
    }

    async hydrateRecentFirst(): Promise<StartupHydrateObservation> {
        this.logicalMs += this.costs.sidecarScanMs;
        const hydrate = await hydrateFromSidecar(this.hydrateDeps());
        const searchablePaths = (await this.store.listFileRecords())
            .map(record => record.note_path)
            .sort();
        return {
            gateAtMs: this.gateAtMs,
            walkedPaths: [...this.walkedPaths],
            searchablePaths,
            hydrate,
        };
    }

    async search(query = this.fixture.query): Promise<string[]> {
        if (!this.orchestrator) {
            const app = {
                vault: this.vault,
                metadataCache: { isUserIgnored: () => false },
            } as unknown as App;
            const logger = {
                deviceId: 'fixture-consumer',
                append: async () => {},
                appendError: async () => {},
            } as never;
            this.orchestrator = new SearchOrchestrator(
                app,
                this.store,
                this.embedder,
                logger,
                structuredClone(DEFAULT_SETTINGS),
            );
        }
        const { results } = await this.orchestrator.search(query, 10);
        return results.map(result => result.note_path);
    }

    async teardown(): Promise<void> {
        this.orchestrator?.dispose();
    }

    private hydrateDeps(): HydrateDeps {
        const notes = new Map(this.fixture.notes.map(note => [note.path, note]));
        return {
            adapter: this.adapter.asDataAdapter(),
            indexDir: INDEX_DIR,
            expect: expectationFor(),
            reChunk: async () => this.fixture.notes.map(note => this.rechunked(note)),
            reChunkSubset: async files => {
                const out: ReChunkedNote[] = [];
                for (const file of files) {
                    const note = notes.get(file.path);
                    if (!note) continue;
                    this.walkedPaths.push(file.path);
                    this.logicalMs += this.costs.fileRechunkMs;
                    out.push(this.rechunked(note));
                }
                return out;
            },
            listHydrateFiles: async () => this.fixture.notes
                .map(note => ({ path: note.path, mtimeMs: mtimeMs(note, this.anchorMs) }))
                .sort((a, b) => b.mtimeMs - a.mtimeMs),
            ensureTokenizer: async () => {},
            greedyHydrate: true,
            existingIds: async () => new Set(
                (await this.store.listAllMeta()).map(chunk => chunk.chunk_id),
            ),
            putQuantized: async (chunks, tiers) => {
                this.logicalMs += this.costs.commitMs;
                await this.store.putBatchQuantized(chunks, tiers);
            },
            putFileRecord: record => this.store.putFileRecord(record),
            onGoodEnough: () => {
                if (this.gateAtMs === null) this.gateAtMs = this.logicalMs;
            },
        };
    }

    private async seedPeerSidecar(): Promise<void> {
        const records = this.fixture.notes.map(note => {
            const vector = hashVec(note.body);
            const quantized = quantizeInt8(vector);
            const tiers: TierBytes = {
                q: quantized.q,
                s: quantized.s,
                sign: packSignBits(vector),
            };
            return {
                id: note.chunkId,
                tiers,
                mtime: mtimeMs(note, this.anchorMs),
            };
        });
        await bulkAppend(
            this.adapter.asDataAdapter(),
            INDEX_DIR,
            PRODUCER_ID,
            records,
        );
        const expect = expectationFor();
        const meta = {
            format: SIDECAR_FORMAT,
            ...expect,
            deviceId: PRODUCER_ID,
            lastFullReindex: null,
        };
        const { writeDeviceMeta } = await import('../../sidecar-meta');
        await writeDeviceMeta(
            this.adapter.asDataAdapter() as DataAdapter,
            INDEX_DIR,
            meta,
        );
    }

    private rechunked(note: StartupNoteFixture): ReChunkedNote {
        return {
            notePath: note.path,
            mtimeMs: mtimeMs(note, this.anchorMs),
            chunks: [this.chunk(note)],
        };
    }

    private chunk(note: StartupNoteFixture): Chunk {
        const modified = new Date(mtimeMs(note, this.anchorMs)).toISOString();
        return {
            chunk_id: note.chunkId,
            title: note.path.split('/').pop()!.replace(/\.md$/, ''),
            content: note.body,
            note_path: note.path,
            heading_path: [],
            metadata: {
                tags: [],
                aliases: [],
                created: null,
                modified,
                properties: {},
            },
            start_line: 1,
            end_line: 1,
        };
    }
}
