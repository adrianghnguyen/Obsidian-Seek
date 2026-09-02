// CLI-facing performance console mirror for Obsidian Developer commands.
//
// Seek's authoritative timings live in NDJSON (SeekLogger). CDP `dev:console`
// only sees `console.*`, and `dev:debug` does not survive restart — so cold
// hydrate often finishes before the debugger can reattach. This helper:
//   1. Emits a single-line `console.info('[seek:perf] ' + JSON)` on each major
//      beat (live capture when debug is already attached, e.g. after reload).
//   2. Keeps an in-memory ring so `dump()` can re-print into the CDP buffer
//      after reattach (`obsidian eval` → dumpPerfConsole).
//
// Format is intentional: one string argument so `dev:console` text stays
// greppable (objects often become "[object Object]"). Level is `info` so
// `level=info` includes these lines. See https://obsidian.md/help/cli#Developer%20commands

import type { IndexCompleteEntry, LoadEntry, LongTaskEntry, SearchEntry, StartupGateEntry, StartupSpanEntry } from './types';

export const SEEK_PERF_PREFIX = '[seek:perf]';
export const SEEK_PERF_RING_SIZE = 80;

/** JSON-serializable scalar payload for a single CLI-visible beat. */
export type SeekPerfPayload = {
    type: string;
    [key: string]: string | number | boolean | null | undefined;
};

export function formatPerfLine(payload: SeekPerfPayload): string {
    return `${SEEK_PERF_PREFIX} ${JSON.stringify(payload)}`;
}

export class SeekPerfConsole {
    private readonly ring: string[] = [];
    private readonly maxSize: number;
    private readonly info: (msg: string) => void;

    constructor(
        maxSize: number = SEEK_PERF_RING_SIZE,
        info: (msg: string) => void = (msg) => { console.info(msg); },
    ) {
        this.maxSize = maxSize;
        this.info = info;
    }

    record(payload: SeekPerfPayload): void {
        const line = formatPerfLine(payload);
        this.ring.push(line);
        while (this.ring.length > this.maxSize) this.ring.shift();
        this.info(line);
    }

    /** Re-print the ring into the console (for CDP after `dev:debug on`). */
    dump(): number {
        for (const line of this.ring) this.info(line);
        return this.ring.length;
    }

    /** Clear the in-memory ring only — does not clear the CDP console buffer. */
    clear(): void {
        this.ring.length = 0;
    }

    /** Test / inspect helper. */
    snapshot(): readonly string[] {
        return this.ring;
    }

    // ---- Slimmers: keep CLI lines small; omit ranking traces / checklists ----

    recordStartupSpan(entry: Pick<StartupSpanEntry, 'type' | 'timestamp' | 'span' | 'phase' | 'durationMs'> & { bypassed?: boolean }): void {
        this.record({
            ...entry,
        });
    }

    recordStartupGate(entry: Pick<StartupGateEntry, 'type' | 'timestamp' | 'event' | 'warmPhase' | 'uiHealth' | 'elapsedMs' | 'searchResult'>): void {
        this.record({
            type: entry.type,
            timestamp: entry.timestamp,
            event: entry.event,
            warmPhase: entry.warmPhase,
            uiHealth: entry.uiHealth,
            elapsedMs: entry.elapsedMs,
            searchResult: entry.searchResult,
        });
    }

    recordIndexComplete(entry: IndexCompleteEntry): void {
        this.record({
            type: entry.type,
            timestamp: entry.timestamp,
            mode: entry.mode,
            filesIndexed: entry.filesIndexed,
            chunksIndexed: entry.chunksIndexed,
            chunkDurationMs: entry.chunkDurationMs,
            embedDurationMs: entry.embedDurationMs,
            bm25DurationMs: entry.bm25DurationMs,
            commitDurationMs: entry.commitDurationMs,
            totalDurationMs: entry.totalDurationMs,
            paceWaitMs: entry.paceWaitMs,
            pass: entry.pass,
        });
    }

    recordSearch(entry: SearchEntry): void {
        this.record({
            type: entry.type,
            timestamp: entry.timestamp,
            topK: entry.topK,
            idbReadMs: entry.idbReadMs,
            binaryMs: entry.binaryMs,
            selectFetchMs: entry.selectFetchMs,
            alignMs: entry.alignMs,
            queryEmbedMs: entry.queryEmbedMs,
            iframeEmbedMs: entry.iframeEmbedMs,
            cosineMs: entry.cosineMs,
            bm25Ms: entry.bm25Ms,
            bm25CacheHit: entry.bm25CacheHit,
            fusionMs: entry.fusionMs,
            snippetMs: entry.snippetMs,
            totalMs: entry.totalMs,
            totalChunks: entry.totalChunks,
            candidateUnionSize: entry.candidateUnionSize,
            searchId: entry.searchId,
        });
    }

    recordLongTask(entry: LongTaskEntry): void {
        this.record({
            type: entry.type,
            timestamp: entry.timestamp,
            durationMs: entry.durationMs,
            startTimeMs: entry.startTimeMs,
            context: entry.context,
            culprit: entry.culprit,
        });
    }

    recordLoad(entry: LoadEntry): void {
        this.record({
            type: entry.type,
            timestamp: entry.timestamp,
            requestedDevice: entry.requestedDevice,
            actualDevice: entry.actualDevice,
            dtype: entry.dtype,
            coldStartMs: entry.coldStartMs,
            warmupMs: entry.warmupMs,
            warmupSkipped: entry.warmupSkipped,
            pass: entry.pass,
        });
    }
}

/** Process-wide instance used by main/search; plugin dump/clear delegates here. */
export const seekPerf = new SeekPerfConsole();
