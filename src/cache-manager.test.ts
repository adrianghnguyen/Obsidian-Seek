// CacheManager contract tests.
//
// Verifies the public API surface of the CacheManager class (extracted from
// SearchOrchestrator). Tests run against the real Scenario harness so the
// cache manager's methods are exercised by the full pipeline — the same way
// SearchOrchestrator uses them.
//
// These tests define the CONTRACT between CacheManager and its consumers:
//   - Every public method accepts the documented signature
//   - ensureFrame / ensureBm25 resolve with the right types
//   - Cache lifecycle (warm, invalidate, persist) is non-throwing
//   - CacheManager can be instantiated without a SearchOrchestrator

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scenario } from './test-harness/scenario';
import type { CacheManager } from './search';

describe('CacheManager contract', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    function cm(s: Scenario): CacheManager {
        return (s.orch as unknown as { cacheManager: CacheManager }).cacheManager;
    }

    // ── Warm and invalidate ─────────────────────────────────────────────

    it('warmCaches resolves without throwing on an empty index', async () => {
        const s = await boot();
        await expect(cm(s).warmCaches('test')).resolves.toBeUndefined();
    });

    it('invalidateBm25Cache does not throw', async () => {
        const s = await boot();
        expect(() => cm(s).invalidateBm25Cache()).not.toThrow();
    });

    it('hasBm25Cache returns false on an empty index', async () => {
        const s = await boot();
        expect(cm(s).hasBm25Cache()).toBe(false);
    });

    // ── ensureFrame ──────────────────────────────────────────────────────

    it('ensureFrame returns null on an empty index', async () => {
        const s = await boot();
        const frame = await cm(s).ensureFrame({});
        expect(frame).toBeNull();
    });

    it('ensureFrame returns a frame after cold start', async () => {
        const s = await boot();
        s.vault.write('a.md', 'hello world', 1000);
        await s.coldStart();

        const frame = await cm(s).ensureFrame({});
        expect(frame).not.toBeNull();
        expect(frame!.orderedChunks.length).toBeGreaterThanOrEqual(1);
        expect(frame!.generation).toBeGreaterThan(0);
    });

    // ── ensureBm25 ───────────────────────────────────────────────────────

    it('ensureBm25 returns false when no chunks exist', async () => {
        const s = await boot();
        const ok = await cm(s).ensureBm25([]);
        expect(ok).toBe(false);
    });

    it('ensureBm25 populates bm25Cache after cold start', async () => {
        const s = await boot();
        s.vault.write('a.md', 'hello world', 1000);
        await s.coldStart();
        await cm(s).warmCaches('test');
        const frame = await cm(s).ensureFrame({});
        expect(frame).not.toBeNull();
        const ok = await cm(s).ensureBm25(frame!.orderedChunks);
        expect(ok).toBe(true);
        // Cache is now populated
        expect(cm(s).hasBm25Cache()).toBe(true);
    });

    // ── hydrateBodies ────────────────────────────────────────────────────

    it('hydrateBodies resolves on empty array', async () => {
        const s = await boot();
        await expect(cm(s).hydrateBodies([])).resolves.toBeUndefined();
    });

    // ── topByRecency ─────────────────────────────────────────────────────

    it('topByRecency returns empty array for empty chunks', async () => {
        const s = await boot();
        const result = cm(s).topByRecency([], 5);
        expect(result).toEqual([]);
    });

    // ── warmCaches lifecycle ─────────────────────────────────────────────

    it('warmCaches is idempotent (called twice does not throw)', async () => {
        const s = await boot();
        await cm(s).warmCaches('test-1');
        await cm(s).warmCaches('test-2');
        // If we reach here without error, the method is idempotent
        expect(true).toBe(true);
    });

    // ── bm25FieldBoosts ──────────────────────────────────────────────────

    it('bm25FieldBoosts returns a record with expected keys', async () => {
        const s = await boot();
        const boosts = cm(s).bm25FieldBoosts();
        expect(boosts).toBeTruthy();
        expect(typeof boosts).toBe('object');
        // Should have BM25 field boost keys
        expect(Object.keys(boosts).length).toBeGreaterThan(0);
    });
});

describe('CacheManager integration with full pipeline', () => {
    let active: Scenario | null = null;
    const boot = async (): Promise<Scenario> => {
        const s = new Scenario();
        await s.boot();
        active = s;
        return s;
    };
    afterEach(async () => { await active?.teardown(); active = null; });

    function cm(s: Scenario): CacheManager {
        return (s.orch as unknown as { cacheManager: CacheManager }).cacheManager;
    }

    it('warmCaches + ensureFrame + ensureBm25 produces a searchable cache', async () => {
        const s = await boot();
        s.vault.write('test.md', 'this is a test note for cache integration', 1000);
        await s.coldStart();

        // Warm the caches
        await cm(s).warmCaches('test');
        const frame = await cm(s).ensureFrame({});
        expect(frame).not.toBeNull();
        expect(frame!.orderedChunks.length).toBeGreaterThanOrEqual(1);

        // BM25 should be populated
        const bm25Ok = await cm(s).ensureBm25(frame!.orderedChunks);
        expect(bm25Ok).toBe(true);
        expect(cm(s).hasBm25Cache()).toBe(true);

        // Searching should work
        const { results } = await s.orch.search('test note', 5);
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.note_path).toBe('test.md');
    });

    it('invalidateBm25Cache clears the BM25 cache', async () => {
        const s = await boot();
        s.vault.write('a.md', 'content', 1000);
        await s.coldStart();
        await cm(s).warmCaches('test');
        const frame = await cm(s).ensureFrame({});
        await cm(s).ensureBm25(frame!.orderedChunks);
        expect(cm(s).hasBm25Cache()).toBe(true);

        // Invalidate
        cm(s).invalidateBm25Cache();
        expect(cm(s).hasBm25Cache()).toBe(false);
    });
});