import { describe, it, expect } from 'vitest';
import { rollingBatchFor, ROLLING_BUDGET, ROLLING_MAX } from './rolling-batch';

describe('rollingBatchFor', () => {
    it('interactive catch-up sizes long buckets by the token budget', () => {
        expect(rollingBatchFor(512, 'incremental')).toBe(3);
        expect(rollingBatchFor(384, 'incremental')).toBe(4);
        expect(rollingBatchFor(256, 'incremental')).toBe(6);
        expect(rollingBatchFor(192, 'incremental')).toBe(8);
        expect(rollingBatchFor(32, 'incremental')).toBe(8);
    });

    it('full reindex always dispatches the warmed ceiling', () => {
        for (const bucket of [512, 384, 256, 192, 128, 96, 64, 48, 32]) {
            expect(rollingBatchFor(bucket, 'full')).toBe(ROLLING_MAX);
        }
    });

    it('honors a smaller rollingBatchMax from settings', () => {
        expect(rollingBatchFor(512, 'full', { rollingBatchMax: 4 })).toBe(4);
        expect(rollingBatchFor(32, 'incremental', { rollingBatchMax: 4 })).toBe(4);
    });

    it('honors a catch-up token budget from settings', () => {
        expect(rollingBatchFor(512, 'incremental', { rollingTokenBudget: 4096 })).toBe(8);
        expect(rollingBatchFor(512, 'incremental', { rollingTokenBudget: 512 })).toBe(1);
    });

    it('budgeted sizes stay inside the warmup grid [1..ROLLING_MAX]', () => {
        for (const bucket of [512, 384, 256, 192, 128, 96, 64, 48, 32]) {
            const n = rollingBatchFor(bucket, 'incremental');
            expect(n).toBeGreaterThanOrEqual(1);
            expect(n).toBeLessThanOrEqual(ROLLING_MAX);
            expect(n).toBe(Math.max(1, Math.min(ROLLING_MAX, Math.round(ROLLING_BUDGET / bucket))));
        }
    });
});
