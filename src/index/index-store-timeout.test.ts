import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexStore, withDeadline, isStoreOpTimeout, STORE_OP_TIMEOUT_PREFIX } from './index-store';

// Regression tests for the production boot-stuck bug: a wedged `files` object
// store whose reads NEVER settle. Unbounded awaits would wedge count() (and its
// single-flight memo) forever, so the boot gate never became searchable and
// startup sat on a silent "Starting". These cover the guard rails that turn that
// hang into a classifiable, recoverable failure.

describe('withDeadline (IDB read guard rail)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('resolves the value when the operation settles in time', async () => {
        await expect(withDeadline(Promise.resolve(42), 'test', 1000)).resolves.toBe(42);
    });

    it('propagates the original rejection (not a timeout) when in time', async () => {
        const err = new Error('boom');
        await expect(withDeadline(Promise.reject(err), 'test', 1000)).rejects.toBe(err);
    });

    it('rejects with a classified timeout when the operation never settles', async () => {
        vi.useFakeTimers();
        const never = new Promise<never>(() => { /* never settles — the wedged-store shape */ });
        const p = withDeadline(never, 'count(chunk_meta)', 5000);
        const assertion = expect(p).rejects.toThrow(/IndexedDB operation timed out: count\(chunk_meta\) after 5000ms/);
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });

    it('classifies timeout errors via isStoreOpTimeout', async () => {
        vi.useFakeTimers();
        const p = withDeadline(new Promise<never>(() => {}), 'listFileRecords', 100);
        let caught: unknown;
        const caughtP = p.catch(e => { caught = e; });
        await vi.advanceTimersByTimeAsync(100);
        await caughtP;
        expect(isStoreOpTimeout(caught)).toBe(true);
        expect((caught as Error).message.startsWith(STORE_OP_TIMEOUT_PREFIX)).toBe(true);
        expect(isStoreOpTimeout(new Error('IndexStore not opened'))).toBe(false);
        expect(isStoreOpTimeout(new Error('something else'))).toBe(false);
    });
});

describe('IndexStore.count guard rails against a wedged store', () => {
    const opened: IndexStore[] = [];
    afterEach(() => {
        for (const store of opened.splice(0)) store.close();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('bounds the four-store count and does NOT pin a rejected memo forever', async () => {
        const store = new IndexStore();
        await store.open(`count-wedge-${Math.random().toString(36).slice(2)}`, 'seek-test');
        opened.push(store);
        const db = (store as unknown as { db: IDBDatabase | null }).db;
        if (!db) throw new Error('test setup failed to open IndexedDB');

        // Simulate the wedged backing store: every request returned from an object
        // store counts forever (no onsuccess/onerror), exactly like production.
        vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(() => {
            return { onsuccess: null, onerror: null } as unknown as IDBRequest<number>;
        });

        // Fake timers only AFTER the store is open (fake-indexeddb setup needs real ones).
        vi.useFakeTimers();
        const first = store.count();
        const firstAssertion = expect(first).rejects.toThrow(/IndexedDB operation timed out/);
        await vi.advanceTimersByTimeAsync(15_000);
        await firstAssertion;

        // The memo must be cleared, so a subsequent call retries (and can recover
        // once the store un-wedges) rather than re-rejecting the stale promise.
        const inFlight = (store as unknown as { countInFlight: unknown }).countInFlight;
        expect(inFlight).toBeNull();
    });

    it('boot-gate chunk-only count skips the files store entirely', async () => {
        const store = new IndexStore();
        await store.open(`count-subset-${Math.random().toString(36).slice(2)}`, 'seek-test');
        opened.push(store);
        const db = (store as unknown as { db: IDBDatabase | null }).db;
        if (!db) throw new Error('test setup failed to open IndexedDB');
        const spy = vi.spyOn(db, 'transaction');

        const c = await store.countStores(['chunk_meta']);
        expect(c).toEqual({ chunks: 0, embeddings: 0, binary: 0, files: 0 });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toEqual(['chunk_meta']);
    });

    it('bounds the files-store reads the boot mtime sweep depends on', async () => {
        const store = new IndexStore();
        await store.open(`files-wedge-${Math.random().toString(36).slice(2)}`, 'seek-test');
        opened.push(store);

        // The production shape: a request returned from the `files` store NEVER
        // settles. Both the point read and the full read must fail fast.
        vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(
            () => ({ onsuccess: null, onerror: null } as unknown as IDBRequest<unknown[]>),
        );
        vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(
            () => ({ onsuccess: null, onerror: null } as unknown as IDBRequest<unknown>),
        );

        vi.useFakeTimers();
        const a = expect(store.listFileRecords()).rejects.toThrow(/listFileRecords/);
        const b = expect(store.getFileRecord('x.md')).rejects.toThrow(/getFileRecord/);
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.all([a, b]);
    });
});
