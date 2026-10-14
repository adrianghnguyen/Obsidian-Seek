import { describe, it, expect } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { bulkAppend, shardPathFor, Q_BYTES, SIGN_BYTES, SIDECAR_FORMAT, type TierBytes } from './sidecar';
import { writeDeviceMeta } from './sidecar-meta';
import { preflightSidecar } from './sidecar-preflight';

class FakeAdapter {
    files = new Map<string, string>();
    bins = new Map<string, ArrayBuffer>();
    async exists(p: string): Promise<boolean> {
        if (this.files.has(p) || this.bins.has(p)) return true;
        const prefix = p.endsWith('/') ? p : p + '/';
        for (const k of [...this.files.keys(), ...this.bins.keys()]) if (k.startsWith(prefix)) return true;
        return false;
    }
    async mkdir(_p: string): Promise<void> {}
    async read(p: string): Promise<string> {
        const v = this.files.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
    }
    async write(p: string, d: string): Promise<void> { this.files.set(p, d); }
    async append(p: string, d: string): Promise<void> { this.files.set(p, (this.files.get(p) ?? '') + d); }
    async readBinary(p: string): Promise<ArrayBuffer> {
        const v = this.bins.get(p);
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
    }
    async writeBinary(p: string, b: ArrayBuffer): Promise<void> { this.bins.set(p, b); }
    async rename(from: string, to: string): Promise<void> {
        if (this.bins.has(from)) { this.bins.set(to, this.bins.get(from)!); this.bins.delete(from); }
        else if (this.files.has(from)) { this.files.set(to, this.files.get(from)!); this.files.delete(from); }
        else throw new Error(`ENOENT ${from}`);
    }
    async remove(p: string): Promise<void> { this.bins.delete(p); this.files.delete(p); }
    async list(dir: string): Promise<{ folders: string[]; files: string[] }> {
        const folders = new Set<string>();
        const files: string[] = [];
        const prefix = dir.endsWith('/') ? dir : dir + '/';
        for (const p of [...this.files.keys(), ...this.bins.keys()]) {
            if (!p.startsWith(prefix)) continue;
            const rest = p.slice(prefix.length);
            const slash = rest.indexOf('/');
            if (slash >= 0) folders.add(prefix + rest.slice(0, slash));
            else files.push(p);
        }
        return { folders: [...folders], files };
    }
    async stat(p: string): Promise<{ size: number; type: 'file' } | null> {
        if (this.bins.has(p)) return { size: this.bins.get(p)!.byteLength, type: 'file' };
        if (this.files.has(p)) return { size: this.files.get(p)!.length, type: 'file' };
        return null;
    }
}

const DIR = '.obsidian/plugins/seek/index';
const EXPECT = { modelId: 'ml97', revision: null, chunkerVersion: 3, dim: 384 };

function tiers(seed: number): TierBytes {
    const q = new Int8Array(Q_BYTES);
    for (let i = 0; i < Q_BYTES; i++) q[i] = (((seed * 17 + i) % 255) - 127) as number;
    const sign = new Uint8Array(SIGN_BYTES);
    for (let i = 0; i < SIGN_BYTES; i++) sign[i] = (seed + i) & 0xff;
    return { q, s: Math.fround(0.01 + seed * 1e-4), sign };
}

async function seed(a: FakeAdapter, deviceId: string): Promise<void> {
    await bulkAppend(a as unknown as DataAdapter, DIR, deviceId, [
        { id: 'a1', tiers: tiers(1), mtime: 100 },
        { id: 'a2', tiers: tiers(2), mtime: 100 },
    ]);
    await writeDeviceMeta(a as unknown as DataAdapter, DIR, {
        format: SIDECAR_FORMAT, ...EXPECT, deviceId, lastFullReindex: '2026-10-14T00:00:00Z',
    });
}

describe('preflightSidecar', () => {
    it('is not ready when the folder is empty', async () => {
        const a = new FakeAdapter();
        const r = await preflightSidecar(a as unknown as DataAdapter, DIR, EXPECT);
        expect(r.ready).toBe(false);
        expect(r.matchingProducers).toBe(0);
    });

    it('is ready when jsonl offsets resolve to local shards with a real payload', async () => {
        const a = new FakeAdapter();
        await seed(a, 'desktop-win');
        const r = await preflightSidecar(a as unknown as DataAdapter, DIR, EXPECT);
        expect(r.ready).toBe(true);
        expect(r.matchingProducers).toBe(1);
        expect(r.datalessShards).toBe(0);
        expect(r.crcFailures).toBe(0);
    });

    it('treats a 0-byte shard as dataless and not ready', async () => {
        const a = new FakeAdapter();
        await seed(a, 'desktop-win');
        a.bins.set(shardPathFor(DIR, 'desktop-win', 0), new ArrayBuffer(0));
        const r = await preflightSidecar(a as unknown as DataAdapter, DIR, EXPECT);
        expect(r.ready).toBe(false);
        expect(r.datalessShards).toBe(1);
        expect(r.incomplete).toBe(true);
    });

    it('treats a missing shard as incomplete, not a wipe signal', async () => {
        const a = new FakeAdapter();
        await seed(a, 'desktop-win');
        a.bins.delete(shardPathFor(DIR, 'desktop-win', 0));
        const r = await preflightSidecar(a as unknown as DataAdapter, DIR, EXPECT);
        expect(r.ready).toBe(false);
        expect(r.missingShards).toBe(1);
    });

    it('counts CRC-corrupt records without marking the folder incomplete', async () => {
        const a = new FakeAdapter();
        await seed(a, 'desktop-win');
        const path = shardPathFor(DIR, 'desktop-win', 0);
        const buf = new Uint8Array(a.bins.get(path)!);
        buf[0] ^= 0xff;
        a.bins.set(path, buf.buffer);
        const r = await preflightSidecar(a as unknown as DataAdapter, DIR, EXPECT);
        expect(r.ready).toBe(true);
        expect(r.crcFailures).toBeGreaterThan(0);
        expect(r.incomplete).toBe(false);
    });

    it('ignores a stale-model peer instead of counting it as matching', async () => {
        const a = new FakeAdapter();
        await seed(a, 'desktop-win');
        await writeDeviceMeta(a as unknown as DataAdapter, DIR, {
            format: SIDECAR_FORMAT, modelId: 'granite', revision: null, chunkerVersion: 3, dim: 384,
            deviceId: 'desktop-win', lastFullReindex: '2026-10-01T00:00:00Z',
        });
        const r = await preflightSidecar(a as unknown as DataAdapter, DIR, EXPECT);
        expect(r.matchingProducers).toBe(0);
        expect(r.staleProducers).toBe(1);
        expect(r.ready).toBe(false);
    });
});
