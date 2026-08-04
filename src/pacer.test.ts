// CompositorPacer — the hidden-window branch (issue #5).
//
// pace() defers each embed batch to requestIdleCallback so a VISIBLE window's
// compositor wins queue arbitration. A hidden window has no compositor and
// produces no frames, so rIC only ever fires via its timeout guard — in the
// field that stretched a hidden commit's ~1.5 s of embed compute to 92.8 s
// wall (~3 s per batch at 1 Hz wakeups). Hidden must therefore skip rIC
// entirely and take the cheap continuation yield.

import { describe, it, expect, afterEach } from 'vitest';
import { CompositorPacer } from './pacer';

type G = { activeDocument?: { hidden: boolean }; requestIdleCallback?: unknown };
const g = globalThis as unknown as G;

afterEach(() => {
    delete g.activeDocument;
    delete g.requestIdleCallback;
});

describe('CompositorPacer — hidden-aware pacing', () => {
    it('visible: defers to requestIdleCallback (compositor arbitration)', async () => {
        let ricCalls = 0;
        g.requestIdleCallback = (cb: (d: { timeRemaining: () => number; didTimeout: boolean }) => void): number => {
            ricCalls++;
            cb({ timeRemaining: () => 10, didTimeout: false });
            return 1;
        };
        g.activeDocument = { hidden: false };
        await new CompositorPacer().pace();
        expect(ricCalls).toBe(1);
    });

    it('hidden: never touches rIC — resolves via the cheap yield', async () => {
        let ricCalls = 0;
        // An rIC that NEVER fires its callback models the hidden renderer
        // (no frames → no natural idle windows). If the pacer consulted it,
        // this pace() would hang until the test times out.
        g.requestIdleCallback = (): number => { ricCalls++; return 1; };
        g.activeDocument = { hidden: true };
        await new CompositorPacer().pace();
        expect(ricCalls).toBe(0);
    });

    it('no activeDocument global (tests / exotic hosts): falls through to the rIC chain', async () => {
        let ricCalls = 0;
        g.requestIdleCallback = (cb: (d: { timeRemaining: () => number; didTimeout: boolean }) => void): number => {
            ricCalls++;
            cb({ timeRemaining: () => 10, didTimeout: false });
            return 1;
        };
        await new CompositorPacer().pace();
        expect(ricCalls).toBe(1);
    });

    it('a still-fresh idle slice is shared across consecutive paces (visible fast path)', async () => {
        let ricCalls = 0;
        g.requestIdleCallback = (cb: (d: { timeRemaining: () => number; didTimeout: boolean }) => void): number => {
            ricCalls++;
            cb({ timeRemaining: () => 40, didTimeout: false });
            return 1;
        };
        g.activeDocument = { hidden: false };
        const p = new CompositorPacer();
        await p.pace();
        await p.pace();   // budget left in the granted slice → no second rIC
        expect(ricCalls).toBe(1);
    });
});
