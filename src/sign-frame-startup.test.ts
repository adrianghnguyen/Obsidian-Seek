// Packed sign-frame blob: after one warm, a cleared RAM cache must reload the
// frame from the single IDB record and must not cursor-walk `binary`.

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scenario } from './test-harness/scenario';

const open: Scenario[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.teardown(); vi.restoreAllMocks(); });

function noteBody(): string {
    return Array.from({ length: 4 }, (_, i) =>
        `## Section ${i}\n\n${Array.from({ length: 20 }, (_, j) => `word${i}x${j % 4}`).join(' ')}`).join('\n\n');
}

async function bootIndexed(): Promise<Scenario> {
    const s = new Scenario();
    open.push(s);
    await s.boot();
    s.vault.write('Ballast.md', noteBody(), 900);
    s.vault.write('Note.md', noteBody(), 1000);
    await s.coldStart();
    await s.orch.warmCaches('test-sign-frame');
    return s;
}

function dropRamFrame(orch: Scenario['orch']): void {
    orch.frameCache = null;
    orch.binaryIndex = null;
}

describe('persisted sign frame', () => {
    it('reloads the packed frame from one blob and does not walk sign rows', async () => {
        const s = await bootIndexed();
        const blob = await s.store.getSignFrame();
        expect(blob).not.toBeNull();
        expect(blob!.ids.length).toBeGreaterThan(0);
        expect(blob!.packed.byteLength).toBe(blob!.ids.length * blob!.bytesPerVec);

        const spy = vi.spyOn(s.store, 'listAllBinary');
        dropRamFrame(s.orch);
        await s.orch.warmCaches('test-sign-frame-hit');

        expect(spy).not.toHaveBeenCalled();
        expect(s.orch.frameCache).not.toBeNull();
        expect(s.orch.binaryIndex).not.toBeNull();
    });

    it('walks sign rows when the blob does not cover live chunk ids, then rewrites it', async () => {
        const s = await bootIndexed();
        const blob = await s.store.getSignFrame();
        expect(blob).not.toBeNull();
        await s.store.putSignFrame({
            ...blob!,
            ids: blob!.ids.map(() => 'missing-chunk'),
        });

        const spy = vi.spyOn(s.store, 'listAllBinary');
        dropRamFrame(s.orch);
        await s.orch.warmCaches('test-sign-frame-miss');

        expect(spy).toHaveBeenCalled();
        const rewritten = await s.store.getSignFrame();
        expect(rewritten).not.toBeNull();
        expect(rewritten!.ids).not.toContain('missing-chunk');
        expect(s.orch.frameCache).not.toBeNull();
    });
});
