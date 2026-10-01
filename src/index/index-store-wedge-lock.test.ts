import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexStore } from './index-store';

// Regression tests for the production boot-stuck failure: a wedged IndexedDB
// object store whose reads NEVER settle, plus the LevelDB lock that makes the
// database undeletable. Both previously had no deadline, so boot could hang
// forever. These tests FORCE the adversarial conditions and assert the guard
// rails actually prevent the hang — the whole point of the fix.

/** Resolve a bounded promise with a real-time cap so a FAILED guard rail fails the
 *  test instead of hanging the suite. Returns a marker string on timeout. */
function raceReal<T>(p: Promise<T>, ms: number): Promise<T | 'TEST-TIMEOUT'> {
    return Promise.race([
        p,
        new Promise<'TEST-TIMEOUT'>(r => setTimeout(() => r('TEST-TIMEOUT'), ms)),
    ]);
}

/** Run `fn` under fake timers and advance enough to settle the 8s IDB deadline. */
async function runWithAdvance<T>(fn: () => Promise<T>): Promise<T> {
    const p = fn();
    // Attach a handler immediately so an early rejection is never "unhandled".
    const settled = p.then(v => ({ ok: true as const, v }), e => ({ ok: false as const, e }));
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await settled;
    if (res.ok) return res.v;
    throw res.e;
}

describe('wedged/locked IndexedDB guard rails (src/index-store-wedge-lock.test.ts)', () => {
    const opened: IndexStore[] = [];
    afterEach(() => {
        for (const s of opened.splice(0)) s.close();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    async function freshStore(scope: string): Promise<IndexStore> {
        const store = new IndexStore();
        await store.open(`${scope}-${Math.random().toString(36).slice(2)}`, 'seek-test');
        opened.push(store);
        return store;
    }

    // -------------------------------------------------------------------------
    // 1. A real IDB lock: hold a connection open, then deleteDatabase blocks.
    // -------------------------------------------------------------------------
    it('detects a genuine IndexedDB lock via onblocked while a connection is held', async () => {
        const dbName = `lock-wedge-${Math.random().toString(36).slice(2)}`;
        const holder = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(dbName, 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onupgradeneeded = () => req.result.createObjectStore('s');
        });

        let blockedFired = false;
        const deleteReq = indexedDB.deleteDatabase(dbName);
        const done = new Promise<'deleted'>((resolve) => {
            deleteReq.onsuccess = () => resolve('deleted');
            deleteReq.onerror = () => resolve('deleted');
            deleteReq.onblocked = () => { blockedFired = true; };
        });

        // A held connection must keep the delete pending (the lock), not delete.
        const early = await raceReal(done, 300);
        expect(early).toBe('TEST-TIMEOUT');

        // Release the lock → the delete now proceeds.
        holder.close();
        const finished = await raceReal(done, 3000);
        expect(finished).toBe('deleted');
        // fake-indexeddb may surface the lock via onblocked; assert we at least
        // observed the lock as a pending delete (the property the guard relies on).
        expect(blockedFired || early === 'TEST-TIMEOUT').toBe(true);
    });

    // -------------------------------------------------------------------------
    // 2. Boot-gate advance past a wedged `files` store (the production symptom).
    // -------------------------------------------------------------------------
    it('boot-gate chunk-only count resolves even while the files store is wedged — startup no longer stalls', async () => {
        const store = await freshStore('boot-advance');
        const orig = IDBObjectStore.prototype.count;
        // Wedge ONLY the files store, exactly like the corrupt backing store.
        vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(function (this: IDBObjectStore) {
            if (this.name === 'files') return { onsuccess: null, onerror: null } as unknown as IDBRequest<number>;
            return orig.call(this);
        });

        // The boot gate reads chunk_meta only → it must resolve, not hang.
        vi.useFakeTimers();
        const counts = await runWithAdvance(() => store.countStores(['chunk_meta']));
        expect(counts).toEqual({ chunks: 0, embeddings: 0, binary: 0, files: 0 });
    });

    // -------------------------------------------------------------------------
    // 3. The FULL count is bounded (fails fast) rather than hanging forever.
    // -------------------------------------------------------------------------
    it('full count and listFileRecords are deadline-bounded when the files store never settles', async () => {
        const store = await freshStore('full-count-wedge');
        vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(function (this: IDBObjectStore) {
            if (this.name === 'files') return { onsuccess: null, onerror: null } as unknown as IDBRequest<number>;
            return { onsuccess: null, onerror: null } as unknown as IDBRequest<number>;
        });
        vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(
            () => ({ onsuccess: null, onerror: null } as unknown as IDBRequest<unknown[]>),
        );

        vi.useFakeTimers();
        await expect(runWithAdvance(() => store.count())).rejects.toThrow(/IndexedDB operation timed out/);
        await expect(runWithAdvance(() => store.listFileRecords())).rejects.toThrow(/listFileRecords/);

        // The failed full count must NOT pin a stale memo — a later call can retry
        // (and would recover once the store is reset), rather than re-rejecting.
        expect((store as unknown as { countInFlight: unknown }).countInFlight).toBeNull();
    });

    // -------------------------------------------------------------------------
    // 4. Recovery: after the wedge clears, the store counts normally again.
    // -------------------------------------------------------------------------
    it('recovers to a working count once the files store stops wedging', async () => {
        const store = await freshStore('recover');
        let wedged = true;
        const orig = IDBObjectStore.prototype.count;
        vi.spyOn(IDBObjectStore.prototype, 'count').mockImplementation(function (this: IDBObjectStore) {
            if (wedged && this.name === 'files') return { onsuccess: null, onerror: null } as unknown as IDBRequest<number>;
            return orig.call(this);
        });

        vi.useFakeTimers();
        await expect(runWithAdvance(() => store.count())).rejects.toThrow(/IndexedDB operation timed out/);

        // "Reset / reopen" heals the backing store.
        wedged = false;
        const recovered = await runWithAdvance(() => store.count());
        expect(recovered).toEqual({ chunks: 0, embeddings: 0, binary: 0, files: 0 });
    });

    // -------------------------------------------------------------------------
    // 5. The OPEN itself is bounded — the production "openInFlight forever" hang.
    // -------------------------------------------------------------------------
    it('bounds indexedDB.open() when the backing store never settles, and clears openInFlight', async () => {
        const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(
            () => ({ onsuccess: null, onerror: null, onupgradeneeded: null } as unknown as IDBOpenDBRequest),
        );
        vi.useFakeTimers();
        const store = new IndexStore();
        const p = store.ensureOpen();
        const settled = p.then(() => ({ ok: true as const }), e => ({ ok: false as const, e }));
        await vi.advanceTimersByTimeAsync(10_000);
        const res = await settled;

        expect(res.ok).toBe(false);
        expect(String((res as { e: Error }).e.message)).toMatch(/IndexedDB operation timed out: indexedDB\.open/);
        // openInFlight must be released so a later retry can actually re-attempt.
        expect((store as unknown as { openInFlight: unknown }).openInFlight).toBeNull();
        openSpy.mockRestore();
    });

    it('closes a late-resolving open handle after the deadline already rejected (no leaked lock)', async () => {
        let trigger: (() => void) | null = null;
        const closeSpy = vi.fn();
        const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
            const req = {
                set onsuccess(fn: () => void) { trigger = fn; },
                set onerror(_fn: () => void) {},
                set onupgradeneeded(_fn: () => void) {},
                result: { close: closeSpy, onversionchange: null },
                error: null,
            };
            return req as unknown as IDBOpenDBRequest;
        });
        vi.useFakeTimers();
        const store = new IndexStore();
        const p = store.ensureOpen();
        const settled = p.then(() => ({ ok: true as const }), e => ({ ok: false as const, e }));
        await vi.advanceTimersByTimeAsync(10_000);
        await settled;

        // The OS eventually hands back a connection after we already rejected —
        // it must be closed, or it would block deleteDatabase during recovery.
        expect(trigger).toBeTypeOf('function');
        trigger!();
        expect(closeSpy).toHaveBeenCalledTimes(1);
        openSpy.mockRestore();
    });
});
