// Tier-2 composed scenarios — the real orchestrator + real store (fake-indexeddb)
// + fake vault/embedder, driven by a scripted event stream. These pin emergent
// ORDERING bugs that single-decision unit tests miss by construction. See
// scenario.ts and [[Seek Testing Strategy]].
import { describe, it, expect, vi, afterEach } from 'vitest';
import { drainCatchUp } from '../catchup';
import { cyrb53Hex } from '../chunker';
import { Scenario } from './scenario';

describe('Tier-2 scenario harness', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    // ── Scenario 1 — the cold-build re-heal loop ────────────────────────────
    // Regression for the worst bug to date: the cold build ran the incremental
    // path, which preserves prevMeta — undefined on an empty store — so identity
    // was never stamped and the gate re-healed forever. "Fix A" (search.ts: cold
    // build with sawWholeCorpus stamps the live identity) is what this pins. A
    // unit test of the stamp decision can't see the convergence; only a composed
    // scenario can.
    it('cold build on an empty store STAMPS live identity and converges — no re-heal loop', async () => {
        const s = await boot();
        s.vault.write('a.md', 'the verge reviews the new pixel phone', 1000);
        s.vault.write('b.md', 'imogene heap concert notes and setlist', 1000);

        await s.coldStart();                                    // the path that used to run incremental + never stamp

        // (a) it indexed
        expect((await s.store.count()).chunks).toBeGreaterThan(0);

        // (b) identity STAMPED on the empty-store build — modelId AND the three
        //     identity fields the re-heal gate reads. The buggy path leaves these
        //     undefined (prevMeta on an empty store), looping the heal forever.
        const meta = await s.store.getMeta();
        expect(meta.modelId).toBe('test-model');
        expect(meta.lastIndexedAt).not.toBeNull();
        expect(meta.chunkerVersion).toBeTypeOf('number');
        expect(meta.analyzerVersion).toBeTypeOf('string');
        expect('revision' in meta).toBe(true);

        // (c) a second reconcile finds nothing dirty and does NOT re-embed
        //     (no spurious full rebuild). The buggy code re-embeds every time.
        const fingerprint = meta.lastIndexedAt;
        const spy = vi.spyOn(s.embedder, 'embedBatch');
        await s.reconcile();
        expect(spy).not.toHaveBeenCalled();
        expect((await s.store.getMeta()).lastIndexedAt).toBe(fingerprint);
    });

    // ── Scenario 2 — the iCloud mtime re-stamp ──────────────────────────────
    // The content-hash gate, composed through the REAL store: mtime moves, bytes
    // do not, and no re-embed fires. computeDelta must classify check-bytes →
    // unchanged → dirty:[].
    it('an iCloud mtime re-stamp with unchanged bytes does NOT re-embed', async () => {
        const s = await boot();
        s.vault.write('a.md', 'stable content that does not change', 1000);
        await s.coldStart();                                   // build + stamp identity (the real first-index path)

        const spy = vi.spyOn(s.embedder, 'embedBatch');
        await s.touch('a.md', 9999);                            // mtime jumps, bytes identical

        expect(spy).not.toHaveBeenCalled();                    // contentHash gate: computeDelta → dirty:[]
    });

    // ── Scenario 3 — end-to-end search returns the right note rank-1 ─────────
    // Proves the harness asserts RESULTS, not just index state: the full
    // chunk→embed→store→binary-scan→int8-rerank→BM25-fuse→rank pipeline runs on
    // the real orchestrator. The fake embedder is content-derived, so a query
    // sharing tokens with one note out-scores the other on the dense channel.
    it('a query returns the topically-matching note at rank 1 (full pipeline)', async () => {
        const s = await boot();
        s.vault.write('pixel.md', 'the verge reviews the new google pixel phone camera', 1000);
        s.vault.write('music.md', 'imogene heap concert setlist and tour dates', 1000);
        await s.coldStart();

        const { results } = await s.orch.search('google pixel phone camera review', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].note_path).toBe('pixel.md');
    });

    it('an already-superseded query exits before embedding', async () => {
        const s = await boot();
        s.vault.write('pixel.md', 'the verge reviews the new google pixel phone camera', 1000);
        await s.coldStart();
        const spy = vi.spyOn(s.embedder, 'embed');
        const controller = new AbortController();
        controller.abort();

        await expect(s.orch.search('superseded query', 5, undefined, undefined, controller.signal))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(spy).not.toHaveBeenCalled();
    });

    // ── Scenario 4 — a read failure mid-pass skips one file, not the batch ───
    // The carryover NotFoundError family: a file vanishes BETWEEN the directory
    // listing and its read. embedAndCommitFiles must skip just that file
    // (filesSkippedError++ / continue) and still index the rest — only a
    // closed-store error may abort the whole pass.
    it('an unreadable file mid-pass is skipped; the rest of the corpus still indexes', async () => {
        const s = await boot();
        s.vault.write('good1.md', 'first healthy note about gardening', 1000);
        s.vault.write('gone.md',  'this file disappears before it is read', 1000);
        s.vault.write('good2.md', 'second healthy note about cooking', 1000);
        s.vault.failReads.add('gone.md');                      // read throws NotFoundError

        await s.coldStart();                                   // must NOT abort on the one bad file

        const paths = new Set((await s.store.listFileRecords()).map(r => r.note_path));
        expect(paths.has('good1.md')).toBe(true);
        expect(paths.has('good2.md')).toBe(true);
        expect(paths.has('gone.md')).toBe(false);              // skipped, not indexed
    });

    // ── Scenario 4b — a persistently unreadable file does not wedge computeDelta ─
    // Scenario 4 pins the single-pass skip. Without quarantining, that skipped
    // file's record never gets written, so classifyFileDelta(undefined, mtime)
    // reports it 'dirty' again on EVERY later computeDelta call — forever. That
    // wedges reconcileIdentityInPlace in 'drained' permanently (search.ts),
    // which short-circuits periodicReconcile past sidecar reconcile / orphan
    // sweep / compaction for the rest of the session over one bad file.
    // quarantineUnreadable() backs it off after the first attempt instead.
    it('a persistently unreadable file is quarantined out of dirty after one attempt', async () => {
        const s = await boot();
        s.vault.write('good.md', 'a healthy note about hiking', 1000);
        await s.coldStart();

        s.vault.write('bad.md', 'an undownloaded iCloud placeholder', 2000);
        s.vault.failReads.add('bad.md');                       // permanently unreadable

        // First pass: attempted (and skipped) — the quarantine is set here.
        let delta = await s.orch.computeDelta();
        expect(delta.dirty).toContain('bad.md');
        await s.orch.reindexDelta(delta.dirty, delta.deleted, { embed: true });

        // Second pass: WITHOUT the fix, bad.md's dropped record makes it dirty
        // again — forever. With the fix it is quarantined and excluded.
        delta = await s.orch.computeDelta();
        expect(delta.dirty).not.toContain('bad.md');

        // A third pass, still inside the backoff window, still excludes it.
        delta = await s.orch.computeDelta();
        expect(delta.dirty).not.toContain('bad.md');
    });

    // ── Scenario 5 — a real edit re-embeds; a delete removes from index+search ─
    // The complement of Scenario 2 (changed bytes MUST re-embed) plus the
    // deleted-path drop, both composed through the real store after a cold build.
    it('editing bytes re-embeds, and deleting a note removes it from the index', async () => {
        const s = await boot();
        s.vault.write('note.md', 'original content about astronomy', 1000);
        s.vault.write('keep.md', 'unrelated note about pottery', 1000);
        await s.coldStart();

        // (a) a real edit (bytes change) DOES re-embed
        const spy = vi.spyOn(s.embedder, 'embedBatch');
        await s.edit('note.md', 'rewritten content about marine biology', 2000);
        expect(spy).toHaveBeenCalled();

        // (b) deleting the note drops its file record; the other note survives
        await s.del('note.md');
        const paths = new Set((await s.store.listFileRecords()).map(r => r.note_path));
        expect(paths.has('note.md')).toBe(false);
        expect(paths.has('keep.md')).toBe(true);
    });

    // ── Scenario 6 — a dirty IDB lock must not wedge the next catch-up ─────
    // A partial commit aborts its readwrite transaction (the IndexedDB lock the
    // chunk stores are held under). That abort has to finish: the write mutex
    // (isWriting), the delta gate (currentDelta), and the connection itself
    // (the next count() opens a fresh transaction on the same stores). Files
    // then change outside the plugin — FakeVault.write, no reconcile — and
    // drainCatchUp must index them. A lock left open fails this: count() never
    // returns, or the drain stays pending with the new bytes uncommitted.
    it('an aborted commit releases the IDB lock so later external edits still catch up', async () => {
        const s = await boot();
        const seed = 'seed note that anchors the cold index identity';
        const partial = 'gamma note left dirty by the partial commit';
        s.vault.write('seed.md', seed, 1000);
        s.vault.write('partial.md', partial, 1000);
        await s.coldStart();

        // Three notes appear while Seek is not watching (external edits).
        const before = {
            'a.md': 'alpha note written outside the plugin before the fault',
            'b.md': 'beta note written outside the plugin before the fault',
            'c.md': 'gamma sibling written outside the plugin before the fault',
        };
        s.vault.write('a.md', before['a.md'], 2000);
        s.vault.write('b.md', before['b.md'], 2000);
        s.vault.write('c.md', before['c.md'], 2000);

        const db = (s.store as unknown as { db: IDBDatabase }).db;
        const orig = db.transaction.bind(db);
        let aborts = 0;
        let abortSeen = false;
        const spy = vi.spyOn(db, 'transaction').mockImplementation((storeNames, mode, options) => {
            const tx = orig(storeNames, mode, options);
            const names = (Array.isArray(storeNames) ? storeNames : [storeNames]).map(String);
            // The per-file commit transaction (putBatchQuantized). Abort the first
            // one the way a quota/crash abort does: tx.abort() finishes the
            // transaction and drops its store locks. Later commits in this pass
            // must still be able to open.
            if (mode === 'readwrite' && names.includes('chunk_meta') && aborts === 0) {
                aborts += 1;
                tx.onabort = () => { abortSeen = true; };
                tx.abort();
            }
            return tx;
        });

        const coord = (s.orch as unknown as { coord: { currentDelta: Promise<void> | null } }).coord;
        try {
            const delta = await s.orch.computeDelta();
            expect(delta.dirty.slice().sort()).toEqual(['a.md', 'b.md', 'c.md']);
            await s.orch.reindexDelta(delta.dirty, delta.deleted, { embed: true });
        } finally {
            spy.mockRestore();
        }

        // The abort actually ran against a live transaction, then released.
        expect(aborts).toBe(1);
        await new Promise<void>(r => setImmediate(r));
        expect(abortSeen).toBe(true);

        // Lock released: mutex idle, delta gate clear, next transaction on the
        // same stores succeeds. A stuck readwrite or a coalesced count that
        // never settles fails the race.
        expect(s.orch.isWriting()).toBe(false);
        expect(coord.currentDelta).toBeNull();
        expect(s.store.isOpen()).toBe(true);
        const genAfterFault = s.orch.currentGeneration();
        const counted = await Promise.race([
            s.store.count(),
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('count blocked on a dirty IDB lock')), 2000);
            }),
        ]);
        expect(counted.chunks).toBeGreaterThan(0);

        // Further external edits, still with no plugin event — the catch-up
        // path has to notice them from the vault, not from a queued handler.
        const after = {
            'a.md': 'kelp forest rewritten after the aborted commit',
            'b.md': 'obsidian basalt rewritten after the aborted commit',
            'd.md': 'quartz geode created outside the plugin after the lock',
        };
        s.vault.write('a.md', after['a.md'], 3000);
        s.vault.write('b.md', after['b.md'], 3000);
        s.vault.write('d.md', after['d.md'], 3000);

        const { pending } = await drainCatchUp({
            computeDelta: () => s.orch.computeDelta(),
            reindexDelta: (dirty, deleted, opts) => s.orch.reindexDelta(dirty, deleted, opts),
            isHidden: () => false,
            isSearchActive: () => false,
            pace: async () => {},
            maxFiles: 3,
        });

        expect(pending).toBe(false);
        expect(s.orch.isWriting()).toBe(false);
        expect(coord.currentDelta).toBeNull();
        expect(s.orch.currentGeneration()).toBeGreaterThanOrEqual(genAfterFault);
        expect((await s.orch.computeDelta()).dirty).toEqual([]);

        const byPath = new Map((await s.store.listFileRecords()).map(r => [r.note_path, r]));
        expect(byPath.get('a.md')?.contentHash).toBe(cyrb53Hex(after['a.md']));
        expect(byPath.get('b.md')?.contentHash).toBe(cyrb53Hex(after['b.md']));
        expect(byPath.get('d.md')?.contentHash).toBe(cyrb53Hex(after['d.md']));
        expect(byPath.get('partial.md')?.contentHash).toBe(cyrb53Hex(partial));
        expect(byPath.has('seed.md')).toBe(true);
        expect(byPath.has('c.md')).toBe(true);

        // Search waits on currentDelta. A gate left unresolved hangs here.
        const { results } = await s.orch.search('kelp forest rewritten', 5);
        expect(results[0]?.note_path).toBe('a.md');
    });
});
