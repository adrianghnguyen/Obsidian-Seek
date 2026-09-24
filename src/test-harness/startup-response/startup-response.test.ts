import { afterEach, describe, expect, it } from 'vitest';
import {
    SMALL_PEER_DELTA_FIXTURE,
    recentFixturePaths,
    type StartupResponseFixture,
} from './fixtures';
import { ModalResponseHarness } from './modal-response-harness';
import { StartupResponseHarness } from './startup-response-harness';

function walkedOrder(fixture: StartupResponseFixture): string[] {
    return [...fixture.notes]
        .sort((a, b) => a.ageDays - b.ageDays)
        .map(note => note.path);
}

/** Logical cost of the scan plus the three-day window, before older tiers. */
function recentWindowBudget(harness: StartupResponseHarness): number {
    const recent = recentFixturePaths(harness.fixture);
    return harness.costs.sidecarScanMs
        + recent.length * (harness.costs.fileRechunkMs + harness.costs.commitMs);
}

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
        expect(observation.gateAtMs!).toBe(recentWindowBudget(harness));
        expect(observation.gateAtMs!).toBeLessThan(SLO_MS);
        expect(observation.walkedPaths).toEqual(walkedOrder(SMALL_PEER_DELTA_FIXTURE));
        expect(results[0]).toBe(SMALL_PEER_DELTA_FIXTURE.expectedFirstPath);
    });

    it('uses real sidecar and IndexedDB code and hydrates older covered files in the same pass', async () => {
        const harness = await startupHarness();

        const observation = await harness.hydrateRecentFirst();

        expect(observation.hydrate.hydrated).toBe(SMALL_PEER_DELTA_FIXTURE.notes.length);
        expect(observation.searchablePaths).toEqual(
            SMALL_PEER_DELTA_FIXTURE.notes.map(note => note.path).sort(),
        );
        expect(observation.hydrate.acceptedProducers).toBe(1);
    });

    it('covers every file modified in the last three days before releasing the SLO gate', async () => {
        const harness = await startupHarness();
        const recentPaths = recentFixturePaths(SMALL_PEER_DELTA_FIXTURE);

        const observation = await harness.hydrateRecentFirst();

        expect(observation.gateAtMs).toBe(recentWindowBudget(harness));
        expect(observation.walkedPaths.slice(0, recentPaths.length)).toEqual(recentPaths);
        expect(observation.searchablePaths).toEqual(expect.arrayContaining(recentPaths));
    });

    it('releases the gate on the recent-window budget, then hydrates older covered files', async () => {
        const harness = await startupHarness();
        const recentPaths = recentFixturePaths(SMALL_PEER_DELTA_FIXTURE);
        const allPaths = walkedOrder(SMALL_PEER_DELTA_FIXTURE);

        const observation = await harness.hydrateRecentFirst();

        expect(observation.gateAtMs).toBe(recentWindowBudget(harness));
        expect(observation.walkedPaths).toEqual(allPaths);
        expect(observation.work).toEqual({
            fullRechunkCalls: 0,
            subsetCalls: allPaths.length,
            chunkCommits: allPaths.length,
            fileRecordCommits: allPaths.length,
        });
        expect(allPaths.length).toBeGreaterThan(recentPaths.length);
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
