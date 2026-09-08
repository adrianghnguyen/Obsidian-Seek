import { describe, it, expect } from 'vitest';
import {
    IndexDeltaTracker,
    emptyIndexDeltaSnapshot,
    mergePendingPaths,
    removeCommittedPaths,
} from './index-delta-view';

describe('mergePendingPaths / removeCommittedPaths', () => {
    it('unions delta dirty with the live dirty queue', () => {
        expect(mergePendingPaths(['a.md', 'b.md'], ['b.md', 'c.md'])).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('drops committed paths from pending', () => {
        expect(removeCommittedPaths(['a.md', 'b.md', 'c.md'], ['b.md'])).toEqual(['a.md', 'c.md']);
        expect(removeCommittedPaths(['a.md'], [])).toEqual(['a.md']);
    });
});

describe('IndexDeltaTracker', () => {
    it('starts empty', () => {
        const t = new IndexDeltaTracker();
        expect(t.snapshot()).toEqual(emptyIndexDeltaSnapshot(0));
    });

    it('accumulates enqueue then replaces from computeDelta', () => {
        const t = new IndexDeltaTracker();
        t.addPending(['notes/a.md']);
        expect(t.snapshot().pendingPaths).toEqual(['notes/a.md']);

        t.setFromDelta(['notes/b.md', 'notes/c.md'], ['notes/a.md']);
        expect(t.snapshot().pendingPaths).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);
    });

    it('removes committed paths and remembers lastCommitted', () => {
        const t = new IndexDeltaTracker();
        t.setFromDelta(['a.md', 'b.md', 'c.md'], []);
        t.applyCommitted(['b.md']);
        const snap = t.snapshot();
        expect(snap.pendingPaths).toEqual(['a.md', 'c.md']);
        expect(snap.lastCommitted).toEqual(['b.md']);
    });

    it('clear empties pending and lastCommitted', () => {
        const t = new IndexDeltaTracker();
        t.setFromDelta(['a.md'], []);
        t.applyCommitted(['a.md']);
        t.clear();
        expect(t.snapshot().pendingPaths).toEqual([]);
        expect(t.snapshot().lastCommitted).toBeUndefined();
    });

    it('removePending drops deleted/renamed-away paths', () => {
        const t = new IndexDeltaTracker();
        t.addPending(['old.md', 'keep.md']);
        t.removePending(['old.md']);
        expect(t.snapshot().pendingPaths).toEqual(['keep.md']);
    });
});
