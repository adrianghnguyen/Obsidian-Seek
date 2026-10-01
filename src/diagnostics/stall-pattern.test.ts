// The detector's job is to separate a clock from a workload. The regression it
// guards against is the one that cost a day of issue #5: an hourly 14 s stall
// sitting in plain sight in the report, indistinguishable from noise.

import { describe, it, expect } from 'vitest';
import { detectPeriodicStalls, describePeriodicStalls } from './stall-pattern';

// Verbatim from issue #5's report — the hourly cluster, startTimeMs as logged.
const ISSUE_5 = [
    { startTimeMs: 169201615.0, durationMs: 14708 },
    { startTimeMs: 172801615.2, durationMs: 14435 },
    { startTimeMs: 176401613.8, durationMs: 14444 },
    { startTimeMs: 180001615.1, durationMs: 14377 },
    { startTimeMs: 183601612.9, durationMs: 14351 },
    { startTimeMs: 187201613.5, durationMs: 15051 },
    { startTimeMs: 190801615.0, durationMs: 14403 },
];

describe('detectPeriodicStalls', () => {
    it('recovers the hourly period from issue #5 data', () => {
        const p = detectPeriodicStalls(ISSUE_5)!;
        expect(p).not.toBeNull();
        expect(p.periodMs).toBeCloseTo(3_600_000, -1);
        expect(p.count).toBe(7);
        expect(p.jitterMs).toBeLessThan(5);          // the striking part: ±2 ms over 6 hours
        expect(p.medianDurationMs).toBeCloseTo(14435, -2);
    });

    it('still finds the clock when sub-second UI stalls are interleaved', () => {
        // The real report mixes these in; they must not break the run.
        const noisy = [...ISSUE_5,
            { startTimeMs: 169500000, durationMs: 310 },
            { startTimeMs: 171000000, durationMs: 1578 },
            { startTimeMs: 184000000, durationMs: 420 },
        ];
        expect(detectPeriodicStalls(noisy)!.periodMs).toBeCloseTo(3_600_000, -1);
    });

    it('does not invent a period for event-driven stalls', () => {
        // Indexing bursts: same magnitude, irregular spacing.
        const bursty = [
            { startTimeMs: 1_000_000, durationMs: 14000 },
            { startTimeMs: 1_430_000, durationMs: 14000 },
            { startTimeMs: 3_900_000, durationMs: 14000 },
            { startTimeMs: 4_050_000, durationMs: 14000 },
            { startTimeMs: 9_000_000, durationMs: 14000 },
        ];
        expect(detectPeriodicStalls(bursty)).toBeNull();
    });

    it('needs four stalls before calling it a pattern', () => {
        expect(detectPeriodicStalls(ISSUE_5.slice(0, 3))).toBeNull();
        expect(detectPeriodicStalls(ISSUE_5.slice(0, 4))).not.toBeNull();
    });

    it('tolerates a timer delayed by a busy main thread', () => {
        const delayed = [
            { startTimeMs: 0, durationMs: 5000 },
            { startTimeMs: 300_000, durationMs: 5000 },
            { startTimeMs: 604_000, durationMs: 5000 },   // 4 s late
            { startTimeMs: 900_000, durationMs: 5000 },
        ];
        const p = detectPeriodicStalls(delayed)!;
        expect(p.periodMs).toBeCloseTo(300_000, -3);
        expect(p.jitterMs).toBeGreaterThan(1000);   // reported, so the reader can judge
    });

    it('returns null on an empty or tiny set', () => {
        expect(detectPeriodicStalls([])).toBeNull();
        expect(detectPeriodicStalls([{ startTimeMs: 1, durationMs: 9000 }])).toBeNull();
    });
});

describe('describePeriodicStalls', () => {
    it('renders the hourly case in minutes with its inference', () => {
        const line = describePeriodicStalls(detectPeriodicStalls(ISSUE_5)!);
        expect(line).toContain('60.0 min');
        expect(line).toContain('interval timer');
        expect(line).toMatch(/±\d+ ms/);
    });
});
