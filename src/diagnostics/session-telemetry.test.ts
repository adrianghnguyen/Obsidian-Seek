import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    StartupSessionTracker,
    StartupBootHistory,
    RecentSearchRing,
    buildStartupTimingRows,
    startupTrend,
    fmtLatency,
    formatBootAge,
    formatStoredBootLine,
    formatRecentSearchLine,
    formatRecentSearchConsole,
    truncateConsoleQuery,
    STARTUP_HISTORY_MAX,
    type StartupBootHistoryBackend,
} from './session-telemetry';

describe('fmtLatency', () => {
    it('formats sub-second as ms', () => {
        expect(fmtLatency(187)).toBe('187ms');
    });

    it('formats seconds with one decimal', () => {
        expect(fmtLatency(8100)).toBe('8.1s');
    });
});

const COMPLETE_VIEW = {
    searchableMs: 8000,
    warmPhaseMs: 3400,
    readyFromStartMs: 11400,
    warmSkipped: false,
    bootComplete: true,
};

describe('buildStartupTimingRows', () => {
    it('shows one number per stage: gate, warm delta, total', () => {
        const rows = buildStartupTimingRows(COMPLETE_VIEW);
        expect(rows).toEqual([
            { label: 'Searchable', value: '8.0s' },
            { label: 'Cache warm', value: '3.4s' },
            { label: 'Fully ready', value: '11.4s' },
        ]);
    });

    it('marks warm skipped instead of a dash', () => {
        const rows = buildStartupTimingRows({
            ...COMPLETE_VIEW,
            warmPhaseMs: null,
            readyFromStartMs: 8100,
            warmSkipped: true,
        });
        expect(rows[1].value).toBe('skipped');
        expect(rows[2].value).toBe('8.1s');
    });

    it('clocks live before the gate releases', () => {
        const rows = buildStartupTimingRows({
            searchableMs: null,
            warmPhaseMs: null,
            readyFromStartMs: null,
            warmSkipped: false,
            bootComplete: false,
        }, 4200);
        expect(rows[0].value).toBe('4.2s');
        expect(rows[1].value).toBe('…');
        expect(rows[2].value).toBe('…');
    });

    it('clocks warm live between the gate and warm end', () => {
        const rows = buildStartupTimingRows({
            searchableMs: 8100,
            warmPhaseMs: null,
            readyFromStartMs: null,
            warmSkipped: false,
            bootComplete: false,
        }, 12100, 4000);
        expect(rows[0].value).toBe('8.1s');
        expect(rows[1].value).toBe('4.0s');
        expect(rows[2].value).toBe('…');
    });

    it('shows queued while warm is owed after catch-up', () => {
        const rows = buildStartupTimingRows({
            searchableMs: 8100,
            warmPhaseMs: null,
            readyFromStartMs: null,
            warmSkipped: false,
            bootComplete: false,
        }, 8100);
        expect(rows[1].value).toBe('queued');
    });
});

describe('startupTrend', () => {
    it('compares ready time against the previous boot', () => {
        expect(startupTrend(COMPLETE_VIEW, {
            readyFromStartMs: 13000,
            warmSkipped: false,
        })).toEqual({ direction: 'faster', text: '▼ 1.6s vs last boot' });
        expect(startupTrend(COMPLETE_VIEW, {
            readyFromStartMs: 10800,
            warmSkipped: false,
        })).toEqual({ direction: 'slower', text: '▲ 600ms vs last boot' });
    });

    it('treats sub-half-second drift as flat', () => {
        expect(startupTrend(COMPLETE_VIEW, {
            readyFromStartMs: 11100,
            warmSkipped: false,
        })?.direction).toBe('flat');
    });

    it('returns null when warm state differs or history is empty', () => {
        expect(startupTrend(COMPLETE_VIEW, null)).toBeNull();
        expect(startupTrend(COMPLETE_VIEW, {
            readyFromStartMs: 8100,
            warmSkipped: true,
        })).toBeNull();
        expect(startupTrend({ ...COMPLETE_VIEW, warmSkipped: true }, {
            readyFromStartMs: 11000,
            warmSkipped: false,
        })).toBeNull();
    });
});

describe('StartupSessionTracker', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('records searchable, warm phase, and ready from start', () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const tracker = new StartupSessionTracker();
        tracker.beginBoot(1000);
        now = 9000;
        tracker.markSearchable();
        tracker.beginWarm();
        now = 12400;
        tracker.endWarm();
        expect(tracker.view()).toEqual(COMPLETE_VIEW);
    });
});

describe('StartupBootHistory', () => {
    let disk: string | null;
    let legacy: Map<string, string>;
    let history: StartupBootHistory;

    const completeBoot = (readyFromStartMs: number) => ({
        searchableMs: 8000,
        warmPhaseMs: readyFromStartMs - 8000,
        readyFromStartMs,
        warmSkipped: false,
        bootComplete: true,
    });

    beforeEach(() => {
        disk = null;
        legacy = new Map();
        const backend: StartupBootHistoryBackend = {
            readRaw: async () => disk,
            writeRaw: async (json) => { disk = json; },
            readLegacyLocalStorage: () => {
                const raw = legacy.get('seek-startup-history');
                if (!raw) return [];
                try {
                    const parsed: unknown = JSON.parse(raw);
                    if (!Array.isArray(parsed)) return [];
                    return parsed.filter((v): v is {
                        searchableMs: number | null;
                        warmPhaseMs: number | null;
                        readyFromStartMs: number | null;
                        warmSkipped: boolean;
                        at: number;
                    } => typeof v === 'object' && v != null && 'readyFromStartMs' in v && 'warmSkipped' in v && 'at' in v);
                } catch {
                    return [];
                }
            },
            clearLegacyLocalStorage: () => { legacy.delete('seek-startup-history'); },
        };
        history = new StartupBootHistory(backend);
    });

    it('round-trips a recorded boot after load', async () => {
        await history.load();
        history.record(completeBoot(11500));
        await new Promise(r => setTimeout(r, 0));
        expect(history.previous()?.readyFromStartMs).toBe(11500);
        expect(disk).toContain('11500');
    });

    it(`keeps only the newest ${STARTUP_HISTORY_MAX} boots`, async () => {
        await history.load();
        for (let i = 1; i <= 10; i++) history.record(completeBoot(10000 + i));
        await new Promise(r => setTimeout(r, 0));
        expect(history.all()).toHaveLength(STARTUP_HISTORY_MAX);
        expect(history.previous()?.readyFromStartMs).toBe(10010);
    });

    it('ignores incomplete boots', async () => {
        await history.load();
        history.record({ searchableMs: 8000, warmPhaseMs: null, readyFromStartMs: null, warmSkipped: false, bootComplete: false });
        expect(history.previous()).toBeNull();
    });

    it('survives corrupt storage and absence', async () => {
        disk = 'not json';
        await history.load();
        expect(history.previous()).toBeNull();
        disk = null;
        expect(new StartupBootHistory({
            readRaw: async () => null,
            writeRaw: async () => {},
            readLegacyLocalStorage: () => [],
            clearLegacyLocalStorage: () => {},
        }).all()).toEqual([]);
    });

    it('migrates legacy localStorage into the disk file once', async () => {
        legacy.set('seek-startup-history', JSON.stringify([
            { searchableMs: 8000, warmPhaseMs: 3500, readyFromStartMs: 11500, warmSkipped: false, at: 1 },
        ]));
        await history.load();
        expect(history.previous()?.readyFromStartMs).toBe(11500);
        expect(disk).toContain('11500');
        expect(legacy.has('seek-startup-history')).toBe(false);
    });

    it('trims an oversized on-disk file on load', async () => {
        const many = Array.from({ length: 8 }, (_, i) => ({
            searchableMs: 8000,
            warmPhaseMs: 1000,
            readyFromStartMs: 9007 - i,
            warmSkipped: false,
            at: i,
        }));
        disk = JSON.stringify(many);
        await history.load();
        expect(history.all()).toHaveLength(STARTUP_HISTORY_MAX);
        expect(history.previous()?.readyFromStartMs).toBe(9007);
    });
});

describe('stored boot formatting', () => {
    it('formats relative boot age', () => {
        const now = Date.now();
        expect(formatBootAge(now - 30_000, now)).toBe('just now');
        expect(formatBootAge(now - 120_000, now)).toBe('2m ago');
    });

    it('formats a stored boot summary line in searchable -> warm -> ready order', () => {
        expect(formatStoredBootLine({
            searchableMs: 8000,
            warmPhaseMs: 3400,
            readyFromStartMs: 11400,
            warmSkipped: false,
            at: 0,
        })).toBe('8.0s searchable · 3.4s warm · 11.4s ready');
    });

    it('formats a stored boot summary line when warm is skipped', () => {
        expect(formatStoredBootLine({
            searchableMs: 8000,
            warmPhaseMs: null,
            readyFromStartMs: 8000,
            warmSkipped: true,
            at: 0,
        })).toBe('8.0s searchable · warm skipped · 8.0s ready');
    });
});

describe('RecentSearchRing', () => {
    it('keeps only the five most recent entries', () => {
        const ring = new RecentSearchRing();
        for (let i = 1; i <= 7; i++) ring.push(`q${i}`, i * 10);
        expect(ring.snapshot().map(e => e.query)).toEqual(['q7', 'q6', 'q5', 'q4', 'q3']);
    });

    it('ignores blank queries', () => {
        const ring = new RecentSearchRing();
        ring.push('   ', 50);
        expect(ring.snapshot()).toHaveLength(0);
    });
});

describe('recent search console formatting', () => {
    it('formats bracketed lines', () => {
        expect(formatRecentSearchLine({ query: 'vacation italy', ms: 187, at: 0 }))
            .toBe('[vacation italy] 187ms');
    });

    it('truncates long queries', () => {
        const long = 'a'.repeat(60);
        expect(truncateConsoleQuery(long).endsWith('…')).toBe(true);
    });

    it('shows empty state', () => {
        expect(formatRecentSearchConsole([])).toBe('No searches this session');
    });
});
