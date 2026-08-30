import { afterEach, describe, expect, it } from 'vitest';
import {
    SMALL_PEER_DELTA_FIXTURE,
    recentFixturePaths,
} from './fixtures';
import { ModalResponseHarness } from './modal-response-harness';
import { StartupResponseHarness } from './startup-response-harness';

const SLO_MS = 10_000;
const harnesses: StartupResponseHarness[] = [];

async function startupHarness(): Promise<StartupResponseHarness> {
    const harness = new StartupResponseHarness(SMALL_PEER_DELTA_FIXTURE);
    harnesses.push(harness);
    await harness.boot();
    return harness;
}

afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.teardown()));
});

describe('startup response without a live Obsidian vault', () => {
    it('returns a ranked result from the newest modified file within the logical SLO', async () => {
        const harness = await startupHarness();

        const observation = await harness.hydrateRecentFirst();
        const results = await harness.search();

        expect(observation.gateAtMs).not.toBeNull();
        expect(observation.gateAtMs!).toBeLessThan(SLO_MS);
        expect(observation.walkedPaths).toEqual(
            recentFixturePaths(SMALL_PEER_DELTA_FIXTURE),
        );
        expect(results[0]).toBe(SMALL_PEER_DELTA_FIXTURE.expectedFirstPath);
    });

    it('uses real sidecar and IndexedDB code while leaving older files for background work', async () => {
        const harness = await startupHarness();

        const observation = await harness.hydrateRecentFirst();

        expect(observation.hydrate.hydrated).toBe(2);
        expect(observation.searchablePaths).toEqual(
            recentFixturePaths(SMALL_PEER_DELTA_FIXTURE).sort(),
        );
        expect(observation.hydrate.acceptedProducers).toBe(1);
    });

    it('covers every file modified in the last three days before releasing the SLO gate', async () => {
        const harness = await startupHarness();

        const observation = await harness.hydrateRecentFirst();

        expect(observation.searchablePaths).toEqual(
            recentFixturePaths(SMALL_PEER_DELTA_FIXTURE).sort(),
        );
    });

    it('stays within the recent-window operation budget before gate release', async () => {
        const harness = await startupHarness();
        const recentPaths = recentFixturePaths(SMALL_PEER_DELTA_FIXTURE);

        const observation = await harness.hydrateRecentFirst();

        expect(observation.walkedPaths).toHaveLength(recentPaths.length);
        expect(observation.work).toEqual({
            fullRechunkCalls: 0,
            subsetCalls: recentPaths.length,
            chunkCommits: recentPaths.length,
            fileRecordCommits: recentPaths.length,
        });
    });

    it('retries exactly once when the first chunk becomes searchable', async () => {
        const modal = new ModalResponseHarness();
        modal.primeWaitingQuery(SMALL_PEER_DELTA_FIXTURE.query);

        await modal.pollCurrentState();
        expect(modal.retriedQueries).toEqual([]);

        await modal.commitFirstChunkAndPoll();
        await modal.pollCurrentState();
        await modal.pollCurrentState();

        expect(modal.retriedQueries).toEqual([SMALL_PEER_DELTA_FIXTURE.query]);
    });

    it('returns ranked hits after gate release even when the in-memory frame cache is cold (sandbox T1 regression)', async () => {
        const harness = await startupHarness();
        await harness.hydrateRecentFirst();
        await harness.search();
        const orch = harness['orchestrator'] as unknown as { frameCache: unknown };
        orch.frameCache = null;
        const results = await harness.search();
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]).toBe(SMALL_PEER_DELTA_FIXTURE.expectedFirstPath);
    });
});
