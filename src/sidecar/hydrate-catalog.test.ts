import { describe, it, expect } from 'vitest';
import { CatchUpHydrateCatalog, hydrateScanSignature } from './hydrate-catalog';
import type { ScanResult } from './sidecar';

function emptyScan(): ScanResult {
    return { map: new Map(), tombstoneIds: new Set(), parseMs: 0, recordCount: 0, skippedLines: 0 };
}

describe('CatchUpHydrateCatalog', () => {
    it('parses jsonl once while the signature is unchanged', async () => {
        const cat = new CatchUpHydrateCatalog();
        let loads = 0;
        const load = async () => {
            loads++;
            const s = emptyScan();
            s.map.set('a1', { id: 'a1', shard: 'd', seq: 0, off: 0, mtime: 1, dim: 384 });
            return s;
        };
        const a = await cat.getScan('p:10', load);
        const b = await cat.getScan('p:10', load);
        expect(loads).toBe(1);
        expect(a).toBe(b);
        expect(a.map.has('a1')).toBe(true);
    });

    it('rescans and drops existing ids when the jsonl grows', async () => {
        const cat = new CatchUpHydrateCatalog();
        await cat.getExisting(async () => ['old']);
        await cat.getScan('p:10', async () => emptyScan());
        expect(cat.existingLoadCount).toBe(1);
        await cat.getScan('p:99', async () => emptyScan());
        const existing = await cat.getExisting(async () => ['fresh']);
        expect(cat.scanLoadCount).toBe(2);
        expect(existing.has('old')).toBe(false);
        expect(existing.has('fresh')).toBe(true);
    });

    it('reuses existing ids and records hydrated ids without a reload', async () => {
        const cat = new CatchUpHydrateCatalog();
        let loads = 0;
        const first = await cat.getExisting(async () => {
            loads++;
            return ['a'];
        });
        cat.noteHydrated(['b']);
        const second = await cat.getExisting(async () => {
            loads++;
            return ['should-not-run'];
        });
        expect(loads).toBe(1);
        expect(first).toBe(second);
        expect([...second].sort()).toEqual(['a', 'b']);
    });
});

describe('hydrateScanSignature', () => {
    it('changes when a jsonl file grows', async () => {
        const sizes = new Map([['index.d.jsonl', 10]]);
        const stat = async (p: string) => ({ size: sizes.get(p) ?? 0 });
        const a = await hydrateScanSignature(stat, ['index.d.jsonl']);
        sizes.set('index.d.jsonl', 80);
        const b = await hydrateScanSignature(stat, ['index.d.jsonl']);
        expect(a).not.toBe(b);
    });
});
