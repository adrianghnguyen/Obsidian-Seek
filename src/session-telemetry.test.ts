import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    StartupSessionTracker,
    RecentSearchRing,
    buildStartupTimingRows,
    fmtLatency,
    formatRecentSearchLine,
    formatRecentSearchConsole,
    truncateConsoleQuery,
} from './session-telemetry';

describe('fmtLatency', () => {
    it('formats sub-second as ms', () => {
        expect(fmtLatency(187)).toBe('187ms');
    });

    it('formats seconds with one decimal', () => {
        expect(fmtLatency(8100)).toBe('8.1s');
    });
});

describe('buildStartupTimingRows', () => {
    it('shows phase and cumulative from start', () => {
        const rows = buildStartupTimingRows({
            searchableMs: 8100,
            warmPhaseMs: 3400,
            readyFromStartMs: 11500,
            warmSkipped: false,
            bootComplete: true,
        });
        expect(rows[0]).toEqual({
            label: 'Searchable',
            phase: '8.1s',
            fromStart: '8.1s from start',
        });
        expect(rows[1]).toEqual({
            label: 'Cache warm',
            phase: '3.4s',
            fromStart: '11.5s from start',
        });
        expect(rows[2]).toEqual({
            label: 'Fully ready',
            phase: '—',
            fromStart: '11.5s from start',
        });
    });

    it('shows dashes when warm was skipped', () => {
        const rows = buildStartupTimingRows({
            searchableMs: 8100,
            warmPhaseMs: null,
            readyFromStartMs: 8100,
            warmSkipped: true,
            bootComplete: true,
        });
        expect(rows[1]).toEqual({
            label: 'Cache warm',
            phase: '—',
            fromStart: '—',
        });
        expect(rows[2].fromStart).toBe('8.1s from start');
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
        expect(tracker.view()).toEqual({
            searchableMs: 8000,
            warmPhaseMs: 3400,
            readyFromStartMs: 11400,
            warmSkipped: false,
            bootComplete: true,
        });
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
