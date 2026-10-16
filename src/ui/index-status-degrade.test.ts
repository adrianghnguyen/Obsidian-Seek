/**
 * Graceful degradation is the default (docs/ARCHITECTURE.md theme 9).
 * Corrupt sidecar, process death mid-write, and unload while the mutex is
 * held must not present healthy chrome or wedge a new session.
 */
import { describe, it, expect } from 'vitest';
import {
    IndexStatusReporter,
    INDEX_STATUS_COPY,
    type IndexStatusReporterInput,
    type IndexStatusReport,
} from './index-status-report';
import { resolveSidecarWait, sidecarHydrateHealedIndex } from './index-notice';
import { IndexCoordinator } from '../index/index-coordinator';
import type { SeekSettings } from '../types/types';
import { INDEX_STATUS_HEALTH } from './index-status-card';

const idle: IndexStatusReporterInput = {
    booting: false,
    hydrating: false,
    waitingForSidecar: false,
    peerSyncPending: false,
    health: 'healthy',
    reason: null,
    indexing: false,
    job: null,
    searchableChunks: 400,
    inventoryFiles: 80,
};

function surfaces(report: IndexStatusReport) {
    return { bar: report.compact, settings: report.label, mode: report.mode, health: report.health };
}

describe('IndexStatusReporter — one snapshot for bar + Settings', () => {
    it('uses the same object fields for both UIs on every mode', () => {
        const modes: Array<IndexStatusReporterInput> = [
            idle,
            { ...idle, waitingForSidecar: true, searchableChunks: 0, inventoryFiles: 0 },
            { ...idle, indexing: true, jobKind: 'catchup', job: { done: 1, total: 4 } },
            { ...idle, indexing: true, jobKind: 'full', job: { done: 1, total: 40 } },
            { ...idle, searchableChunks: 0, inventoryFiles: 0 },
            { ...idle, stuck: true },
            { ...idle, storeLocked: true },
            { ...idle, health: 'degraded', reason: 'version' },
        ];
        for (const input of modes) {
            const report = IndexStatusReporter.compute(input);
            const copy = INDEX_STATUS_COPY[report.mode];
            expect(report.label, report.mode).toBe(copy.label);
            expect(report.compact, report.mode).toBe(copy.compact);
            expect(surfaces(report).bar).toBe(copy.compact);
            expect(surfaces(report).settings).toBe(copy.label);
        }
    });

    it('overlapping drop + hydrate is Restoring on both surfaces, not Indexing or None', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            goodEnough: true,
            indexing: true,
            catchUpPending: true,
            job: { done: 0, total: 80 },
            jobKind: 'catchup',
            searchableChunks: 0,
            inventoryFiles: 0,
        });
        expect(report.mode).toBe('restoring');
        expect(surfaces(report)).toEqual({
            bar: INDEX_STATUS_COPY.restoring.compact,
            settings: INDEX_STATUS_COPY.restoring.label,
            mode: 'restoring',
            health: 'restoring',
        });
        expect(report.mode).not.toBe('ok');
        expect(report.mode).not.toBe('none');
        expect(report.mode).not.toBe('indexing');
    });

    it('full reindex is Reindexing everywhere; catch-up is Indexing everywhere', () => {
        const full = IndexStatusReporter.compute({
            ...idle,
            indexing: true,
            jobKind: 'full',
            job: { done: 10, total: 100 },
        });
        const catchUp = IndexStatusReporter.compute({
            ...idle,
            indexing: true,
            jobKind: 'catchup',
            job: { done: 2, total: 8 },
        });
        expect(full.mode).toBe('full-reindex');
        expect(full.health).toBe('indexing');
        expect(full.label).toBe('Reindexing…');
        expect(full.compact).toBe('Reindexing');
        expect(catchUp.mode).toBe('indexing');
        expect(catchUp.label).toBe('Indexing…');
        expect(catchUp.compact).toBe('Indexing');
        expect(full.label).not.toBe(catchUp.label);
    });
});

describe('corrupt / torn sidecar → not healthy', () => {
    it('0-byte / dataless shards wait Restoring; hydrate is not healed', () => {
        const wait = resolveSidecarWait({
            hydrated: 0,
            skippedPartialNotes: 0,
            acceptedProducers: 1,
            incompleteFolder: true,
            datalessShards: 1,
        }, 0);
        expect(wait).toBe(true);
        expect(sidecarHydrateHealedIndex({
            hydrated: 0, acceptedProducers: 1, incompleteFolder: true, datalessShards: 1,
        })).toBe(false);
        const report = IndexStatusReporter.compute({
            ...idle,
            waitingForSidecar: wait,
            searchableChunks: 0,
            inventoryFiles: 0,
        });
        expect(report.mode).toBe('restoring');
        expect(report.compact).toBe(INDEX_STATUS_COPY.restoring.compact);
        expect(report.label).toBe(INDEX_STATUS_COPY.restoring.label);
        expect(report.mode).not.toBe('ok');
    });

    it('truncated jsonl / skipped lines do not count as a healed Ready index', () => {
        expect(sidecarHydrateHealedIndex({
            hydrated: 0, acceptedProducers: 0, skippedPartialNotes: 2,
        })).toBe(false);
        const stillWaiting = resolveSidecarWait({
            hydrated: 0, skippedPartialNotes: 2, acceptedProducers: 0,
        }, 0);
        expect(stillWaiting).toBe(true);
        const report = IndexStatusReporter.compute({
            ...idle,
            waitingForSidecar: stillWaiting,
            searchableChunks: 0,
            inventoryFiles: 0,
        });
        expect(report.mode).toBe('restoring');
    });

    it('drop then quit before hydrate is empty-honest, never silent healthy-empty', () => {
        const afterWipe = IndexStatusReporter.compute({
            ...idle,
            hydrating: false,
            waitingForSidecar: false,
            goodEnough: false,
            searchableChunks: 0,
            inventoryFiles: 0,
        });
        expect(afterWipe.mode).toBe('none');
        expect(afterWipe.mode).not.toBe('ok');
        expect(INDEX_STATUS_HEALTH[afterWipe.health].compact).toBe('None');
    });

    it('partial IDB after interrupted full reindex is Indexing/Reindexing or Ready with chunks, never ok at 0/0', () => {
        const midNuke = IndexStatusReporter.compute({
            ...idle,
            indexing: true,
            jobKind: 'full',
            job: { done: 3, total: 40 },
            searchableChunks: 12,
            inventoryFiles: 3,
        });
        expect(midNuke.mode).toBe('full-reindex');
        const afterKillEmpty = IndexStatusReporter.compute({
            ...idle,
            searchableChunks: 0,
            inventoryFiles: 0,
        });
        expect(afterKillEmpty.mode).not.toBe('ok');
        const lastGood = IndexStatusReporter.compute({
            ...idle,
            searchableChunks: 12,
            inventoryFiles: 3,
        });
        expect(lastGood.mode).toBe('ok');
    });
});

describe('unload / process death vs write mutex', () => {
    it('a throw inside runExclusive (store closed mid-pass) still releases the lock', async () => {
        const coord = new IndexCoordinator(null, { sidecarEnabled: false } as unknown as SeekSettings);
        await expect(coord.runExclusive(async () => {
            throw new Error('IndexStore not opened');
        })).rejects.toThrow(/not opened/);
        expect(coord.isWriting()).toBe(false);
        await expect(coord.runExclusive(async () => 'next-boot')).resolves.toBe('next-boot');
    });

    it('abandoning a held coordinator (killed process / skipped onunload) does not wedge a new session', async () => {
        const dying = new IndexCoordinator(null, { sidecarEnabled: false } as unknown as SeekSettings);
        void dying.runExclusive(() => new Promise(() => { /* never resolves — process death */ }));
        await new Promise(r => setTimeout(r, 0));
        expect(dying.isWriting()).toBe(true);
        const nextBoot = new IndexCoordinator(null, { sidecarEnabled: false } as unknown as SeekSettings);
        expect(nextBoot.isWriting()).toBe(false);
        await expect(nextBoot.runExclusive(async () => 1)).resolves.toBe(1);
    });
});

describe('reporter chrome for degraded modes', () => {
    it('Restoring copy is shared; INDEX_STATUS_HEALTH chrome matches the report', () => {
        const report = IndexStatusReporter.compute({
            ...idle, hydrating: true, searchableChunks: 0, inventoryFiles: 0,
        });
        expect(INDEX_STATUS_HEALTH[report.health].label).toBe(report.label);
        expect(INDEX_STATUS_HEALTH[report.health].compact).toBe(report.compact);
        expect(report.label).toBe('Restoring…');
    });
});
