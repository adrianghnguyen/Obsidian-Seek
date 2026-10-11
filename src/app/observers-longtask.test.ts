import { describe, it, expect } from 'vitest';
import { beginLongTaskPass } from './observers';

describe('beginLongTaskPass', () => {
    it('stop is idempotent and returns zeros when longtask is unavailable', () => {
        const pass = beginLongTaskPass();
        const a = pass.stop();
        const b = pass.stop();
        expect(a.count).toBe(0);
        expect(a.ms).toBe(0);
        expect(b).toEqual(a);
    });
});
