import { describe, expect, it } from 'vitest';
import { moveSidecarFiles, type SidecarMoveAdapter } from './sidecar-location';
import { forceSharedSidecarLocation } from '../types/types';

const HIDDEN = '.obsidian/plugins/seek/index';
const VISIBLE = 'Seek Index';

function memAdapter(initial: Record<string, string>, failRename: string[] = []) {
    const files = new Map(Object.entries(initial));
    const folders = new Set<string>();
    const adapter: SidecarMoveAdapter = {
        async list(dir) {
            const prefix = `${dir}/`;
            const out = [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
            if (out.length === 0 && !folders.has(dir)) throw new Error('ENOENT');
            return { files: out, folders: [] };
        },
        async exists(p) { return files.has(p) || folders.has(p); },
        async mkdir(p) { folders.add(p); },
        async rename(from, to) {
            if (failRename.includes(from)) throw new Error('locked');
            files.set(to, files.get(from)!);
            files.delete(from);
        },
    };
    return { adapter, files, folders };
}

describe('moveSidecarFiles (hidden → Seek Index/)', () => {
    it('moves hidden shards into the visible folder', async () => {
        const { adapter, files } = memAdapter({ [`${HIDDEN}/a.jsonl`]: 'A', [`${HIDDEN}/b.bin`]: 'B' });
        expect(await moveSidecarFiles(adapter, HIDDEN, VISIBLE)).toBe(2);
        expect([...files.keys()].sort()).toEqual([`${VISIBLE}/a.jsonl`, `${VISIBLE}/b.bin`]);
    });

    it('is a no-op for an empty or missing source', async () => {
        const { adapter, folders } = memAdapter({});
        expect(await moveSidecarFiles(adapter, HIDDEN, VISIBLE)).toBe(0);
        expect(folders.has(VISIBLE)).toBe(false);
    });

    it('is idempotent and never clobbers destination files (partial prior migration)', async () => {
        const { adapter, files } = memAdapter({
            [`${HIDDEN}/a.jsonl`]: 'old-A',
            [`${HIDDEN}/b.bin`]: 'B',
            [`${VISIBLE}/a.jsonl`]: 'new-A',
        });
        expect(await moveSidecarFiles(adapter, HIDDEN, VISIBLE)).toBe(1);
        expect(files.get(`${VISIBLE}/a.jsonl`)).toBe('new-A');
        expect(files.get(`${VISIBLE}/b.bin`)).toBe('B');
        expect(await moveSidecarFiles(adapter, HIDDEN, VISIBLE)).toBe(0);
    });

    it('onlyIfDestEmpty skips when the visible folder already has files (on-load path)', async () => {
        const { adapter, files } = memAdapter({ [`${HIDDEN}/b.bin`]: 'B', [`${VISIBLE}/a.jsonl`]: 'A' });
        expect(await moveSidecarFiles(adapter, HIDDEN, VISIBLE, { onlyIfDestEmpty: true })).toBe(0);
        expect(files.has(`${HIDDEN}/b.bin`)).toBe(true);
    });

    it('onlyIfDestEmpty migrates stale hidden shards when visible is empty', async () => {
        const { adapter, files } = memAdapter({ [`${HIDDEN}/b.bin`]: 'B' });
        expect(await moveSidecarFiles(adapter, HIDDEN, VISIBLE, { onlyIfDestEmpty: true })).toBe(1);
        expect(files.has(`${VISIBLE}/b.bin`)).toBe(true);
    });

    it('reports a failed rename and leaves the source for the next pass', async () => {
        const errors: unknown[] = [];
        const { adapter, files } = memAdapter({ [`${HIDDEN}/a.jsonl`]: 'A', [`${HIDDEN}/b.bin`]: 'B' }, [`${HIDDEN}/a.jsonl`]);
        expect(await moveSidecarFiles(adapter, HIDDEN, VISIBLE, { onError: e => errors.push(e) })).toBe(1);
        expect(errors).toHaveLength(1);
        expect(files.has(`${HIDDEN}/a.jsonl`)).toBe(true);
    });
});

describe('forceSharedSidecarLocation', () => {
    it('forces visible when sync is on', () => {
        expect(forceSharedSidecarLocation({ sidecarEnabled: true, sidecarIndexLocation: 'config', sidecarHiddenIndexExpert: false }).sidecarIndexLocation).toBe('visible');
    });
    it('respects the expert hidden opt-in', () => {
        expect(forceSharedSidecarLocation({ sidecarEnabled: true, sidecarIndexLocation: 'config', sidecarHiddenIndexExpert: true }).sidecarIndexLocation).toBe('config');
    });
    it('leaves location alone when sync is off', () => {
        expect(forceSharedSidecarLocation({ sidecarEnabled: false, sidecarIndexLocation: 'config', sidecarHiddenIndexExpert: false }).sidecarIndexLocation).toBe('config');
    });
});
