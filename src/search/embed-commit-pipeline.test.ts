// GPU embed vs IndexedDB persist pipeline and uncapped full-reindex batch size.
// Parent coordinator: batch N+1's embedBatch starts while batch N's
// putBatchQuantized is still in flight, and two embedBatches may overlap.
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { Scenario } from '../test-harness/scenario';
import { ROLLING_MAX } from '../index/rolling-batch';

const LONG_BUCKET = 512;
const BODY = 'Note about mountain weather patterns and sourdough hydration cycles for the index pipeline.';

async function until(cond: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
        if (cond()) return;
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for: ${what}`);
}

describe('embed vs IndexedDB pipeline', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        s.embedder.tokenCounts = async (texts: string[]) => texts.map(() => LONG_BUCKET);
        active = s;
        return s;
    };
    afterEach(async () => {
        await active?.teardown();
        active = null;
    });

    it('starts the next embedBatch while the previous commit is still gated', async () => {
        const s = await boot();
        for (let i = 0; i < 16; i++) s.vault.write(`n${i}.md`, `${BODY} ${i}`, 1000 + i);

        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        let gated = false;
        const realPut = s.store.putBatchQuantized.bind(s.store);
        s.store.putBatchQuantized = async (chunks, tiers, fileRecord) => {
            if (!gated && chunks.length > 0) {
                gated = true;
                await gate;
            }
            return realPut(chunks, tiers, fileRecord);
        };

        const sizes: number[] = [];
        const realEmbed = s.embedder.embedBatch.bind(s.embedder);
        s.embedder.embedBatch = async (texts, bucket) => {
            sizes.push(texts.length);
            return realEmbed(texts, bucket);
        };

        const pass = s.orch.reindexAll();
        await until(() => sizes.length >= 2, 'second embedBatch while first commit gated');
        expect(sizes[0]).toBe(ROLLING_MAX);
        expect(sizes[1]).toBe(ROLLING_MAX);

        release();
        const entry = await pass;
        expect(entry.pass).toBe(true);
        expect(entry.committedFilePaths).toHaveLength(16);
        expect(entry.gpuBusyMs).toBeGreaterThanOrEqual(0);
        expect(entry.persistWaitMs).toBeGreaterThanOrEqual(0);
        expect(entry.effectiveBatch).toBeGreaterThanOrEqual(ROLLING_MAX - 0.01);
        expect(entry.inflightHighWater).toBeGreaterThanOrEqual(2);
    });

    it('starts a second embedBatch before the first embed RPC returns', async () => {
        const s = await boot();
        for (let i = 0; i < 16; i++) s.vault.write(`n${i}.md`, `${BODY} ${i}`, 2000 + i);
        let inflight = 0;
        let maxInflight = 0;
        const realEmbed = s.embedder.embedBatch.bind(s.embedder);
        s.embedder.embedBatch = async (texts, bucket) => {
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise(r => setTimeout(r, 25));
            try {
                return await realEmbed(texts, bucket);
            } finally {
                inflight--;
            }
        };
        const entry = await s.orch.reindexAll();
        expect(entry.pass).toBe(true);
        expect(maxInflight).toBeGreaterThanOrEqual(2);
        expect(entry.committedFilePaths).toHaveLength(16);
    });

    it('full reindex flushes long-bucket chunks at 8; incremental catch-up stays on the token budget', async () => {
        const s = await boot();
        s.vault.write('seed.md', `${BODY} seed`, 1);
        const fullSizes: number[] = [];
        const realEmbed = s.embedder.embedBatch.bind(s.embedder);
        s.embedder.embedBatch = async (texts, bucket) => {
            fullSizes.push(texts.length);
            return realEmbed(texts, bucket);
        };
        for (let i = 0; i < 8; i++) s.vault.write(`full${i}.md`, `${BODY} full ${i}`, 100 + i);
        const fullEntry = await s.orch.reindexAll();
        expect(fullEntry.pass).toBe(true);
        expect(fullSizes).toContain(ROLLING_MAX);
        expect(Math.max(...fullSizes)).toBe(ROLLING_MAX);

        const incrSizes: number[] = [];
        s.embedder.embedBatch = async (texts, bucket) => {
            incrSizes.push(texts.length);
            return realEmbed(texts, bucket);
        };
        for (let i = 0; i < 9; i++) s.vault.write(`inc${i}.md`, `${BODY} inc ${i}`, 2000 + i);
        await s.reconcile();
        expect(incrSizes.length).toBeGreaterThan(0);
        expect(Math.max(...incrSizes)).toBe(3);
        expect(incrSizes).toContain(3);
    });

    it('tokenCounts later files while a full-reindex embedBatch is in flight', async () => {
        const s = await boot();
        for (let i = 0; i < 16; i++) s.vault.write(`n${i}.md`, `${BODY} ${i}`, 1000 + i);

        let releaseEmbed!: () => void;
        const embedHold = new Promise<void>(r => { releaseEmbed = r; });
        let embedInFlight = 0;
        let tokenCountsDuringEmbed = 0;
        const realEmbed = s.embedder.embedBatch.bind(s.embedder);
        s.embedder.embedBatch = async (texts, bucket) => {
            embedInFlight++;
            try {
                await embedHold;
                return realEmbed(texts, bucket);
            } finally {
                embedInFlight--;
            }
        };
        s.embedder.tokenCounts = async (texts: string[]) => {
            if (embedInFlight > 0) tokenCountsDuringEmbed++;
            return texts.map(() => LONG_BUCKET);
        };

        const pass = s.orch.reindexAll();
        await until(() => tokenCountsDuringEmbed > 0, 'tokenCounts overlapped in-flight embedBatch');
        releaseEmbed();
        const entry = await pass;
        expect(entry.pass).toBe(true);
        expect(entry.committedFilePaths).toHaveLength(16);
        expect(tokenCountsDuringEmbed).toBeGreaterThan(0);
    });

    it('a multi-batch file still commits one coherent record', async () => {
        const s = await boot();
        const sections = Array.from({ length: 9 }, (_, i) =>
            `## Heading ${i}\n\n${BODY} section ${i} extra padding for the chunker floor.\n`,
        );
        s.vault.write('long.md', sections.join('\n'), 1000);
        const entry = await s.orch.reindexAll();
        expect(entry.pass).toBe(true);
        const rec = await s.store.getFileRecord('long.md');
        expect(rec?.chunk_ids.length).toBeGreaterThanOrEqual(9);
        expect((await s.orch.computeDelta()).dirty).toEqual([]);
    });
});
