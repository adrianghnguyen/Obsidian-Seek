import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    whenLayoutReady,
    scheduleAfterLayoutReady,
    scheduleAfterLayoutReadyBuffered,
    isObsidianCoreBootIdbNoise,
    isPluginDataJsonBomError,
    isIgnorableStartupConsoleError,
} from './layout-ready';

describe('whenLayoutReady', () => {
    it('resolves immediately when onLayoutReady is missing (tests / stubs)', async () => {
        await expect(whenLayoutReady({})).resolves.toBeUndefined();
    });

    it('does not resolve until onLayoutReady fires', async () => {
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let done = false;
        const pending = whenLayoutReady(workspace).then(() => { done = true; });
        expect(done).toBe(false);
        expect(queued).toHaveLength(1);
        queued[0]();
        await pending;
        expect(done).toBe(true);
    });
});

describe('scheduleAfterLayoutReady', () => {
    it('defers work until the workspace callback', () => {
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        const order: string[] = [];
        scheduleAfterLayoutReady(workspace, () => order.push('boot'));
        order.push('onload');
        expect(order).toEqual(['onload']);
        queued[0]();
        expect(order).toEqual(['onload', 'boot']);
    });

    it('runs immediately when onLayoutReady is missing', () => {
        const order: string[] = [];
        scheduleAfterLayoutReady({}, () => order.push('boot'));
        expect(order).toEqual(['boot']);
    });
});

describe('scheduleAfterLayoutReadyBuffered', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('defers work until layout ready AND the delay elapses', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        const order: string[] = [];
        scheduleAfterLayoutReadyBuffered(workspace, () => order.push('boot'), 3500);
        order.push('onload');
        expect(order).toEqual(['onload']);
        queued[0]();
        expect(order).toEqual(['onload']); // timer now pending, not fired
        vi.advanceTimersByTime(3499);
        expect(order).toEqual(['onload']); // 1ms short
        vi.advanceTimersByTime(1);
        expect(order).toEqual(['onload', 'boot']);
    });

    it('runs immediately when onLayoutReady is missing (tests / stubs), after the delay', () => {
        vi.useFakeTimers();
        const order: string[] = [];
        scheduleAfterLayoutReadyBuffered({}, () => order.push('boot'), 3500);
        expect(order).toEqual([]);
        vi.advanceTimersByTime(3500);
        expect(order).toEqual(['boot']);
    });

    it('cancel before layout ready: work never runs even when layout fires', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let ran = false;
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => { ran = true; }, 3500);
        handle.cancel();
        queued[0]();
        vi.advanceTimersByTime(10_000);
        expect(ran).toBe(false);
    });

    it('cancel mid-delay: work never runs', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let ran = false;
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => { ran = true; }, 3500);
        queued[0]();
        vi.advanceTimersByTime(1000);
        handle.cancel();
        vi.advanceTimersByTime(10_000);
        expect(ran).toBe(false);
    });

    it('cancel after firing is a no-op (work already ran once)', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let runs = 0;
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => { runs++; }, 3500);
        queued[0]();
        vi.advanceTimersByTime(3500);
        expect(runs).toBe(1);
        handle.cancel();
        vi.advanceTimersByTime(10_000);
        expect(runs).toBe(1);
    });

    it('bypass after layout ready runs the work immediately, skipping the delay', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        const order: string[] = [];
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => order.push('boot'), 3500);
        queued[0]();
        vi.advanceTimersByTime(500);
        handle.bypass();
        expect(order).toEqual(['boot']);
        vi.advanceTimersByTime(10_000); // timer must be cleared — no double fire
        expect(order).toEqual(['boot']);
    });

    it('bypass BEFORE layout ready: work runs at layout ready, never before it', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        const order: string[] = [];
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => order.push('boot'), 3500);
        handle.bypass();
        vi.advanceTimersByTime(10_000); // no timer was ever set
        expect(order).toEqual([]);
        queued[0](); // layout ready arrives late — user bypass still honored
        expect(order).toEqual(['boot']); // runs synchronously at layout ready, zero delay
    });

    it('bypass after cancel does not resurrect the work', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let ran = false;
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => { ran = true; }, 3500);
        handle.cancel();
        handle.bypass();
        queued[0]();
        vi.advanceTimersByTime(10_000);
        expect(ran).toBe(false);
    });

    it('bypass after firing is a no-op (single fire guarantee)', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let runs = 0;
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => { runs++; }, 3500);
        queued[0]();
        vi.advanceTimersByTime(3500);
        handle.bypass();
        expect(runs).toBe(1);
    });

    it('cancel racing the timer: whichever lands first wins, work runs at most once', () => {
        vi.useFakeTimers();
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let runs = 0;
        const handle = scheduleAfterLayoutReadyBuffered(workspace, () => { runs++; }, 3500);
        queued[0]();
        // Cancel and fire on the same tick — the timeout already dequeued, but
        // the guard flags must keep exactly-once semantics either way.
        vi.advanceTimersByTime(3499);
        handle.cancel();
        vi.advanceTimersByTime(1);
        handle.cancel();
        expect(runs).toBe(0);
    });
});

describe('core boot IndexedDB noise', () => {
    it('recognizes Obsidian File Recovery / cache / sync / backing-store errors', () => {
        expect(isObsidianCoreBootIdbNoise('File Recovery failed to connect to IndexedDB')).toBe(true);
        expect(isObsidianCoreBootIdbNoise('Failed to load cache, unable to open IndexedDB')).toBe(true);
        expect(isObsidianCoreBootIdbNoise('Failed to load sync data')).toBe(true);
        expect(isObsidianCoreBootIdbNoise(
            'UnknownError: Internal error opening backing store for indexedDB.open',
        )).toBe(true);
    });

    it('does not treat Seek-owned failures as core boot noise', () => {
        expect(isObsidianCoreBootIdbNoise('[seek] index store open deferred')).toBe(false);
        expect(isObsidianCoreBootIdbNoise('QuotaExceededError')).toBe(false);
    });
});

describe('plugin data.json BOM parse errors', () => {
    it('recognizes Unexpected token with a BOM or data.json path', () => {
        expect(isPluginDataJsonBomError("Unexpected token '\uFEFF'")).toBe(true);
        expect(isPluginDataJsonBomError(
            "Failed to parse .obsidian/plugins/agent-client/data.json: Unexpected token",
        )).toBe(true);
    });

    it('is ignorable for startup console gates along with core IDB noise', () => {
        expect(isIgnorableStartupConsoleError('Failed to load cache, unable to open IndexedDB')).toBe(true);
        expect(isIgnorableStartupConsoleError("Unexpected token '\uFEFF'")).toBe(true);
        expect(isIgnorableStartupConsoleError('[seek] sidecar hydrate failed')).toBe(false);
    });
});
