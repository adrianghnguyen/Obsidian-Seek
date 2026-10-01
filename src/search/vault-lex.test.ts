import { describe, it, expect } from 'vitest';
import { TFile } from 'obsidian';
import {
    buildVaultLexIndex,
    fileCacheAliases,
    fileCacheHeadings,
    fileCacheTags,
    pickRecentForBodies,
    stripFrontmatter,
    aliasesFromMarkdown,
    vaultChunkId,
    vaultFileSignature,
    vaultFileToMeta,
    VAULT_LEX_BODY_MAX_FILES,
} from './vault-lex';

function tf(path: string, mtime: number, size = 100): TFile {
    const f = new TFile();
    f.path = path;
    f.stat = { mtime, ctime: mtime, size };
    f.extension = 'md';
    return f;
}

describe('vault-lex helpers', () => {
    it('aliases come from frontmatter aliases or alias', () => {
        expect(fileCacheAliases({ frontmatter: { aliases: ['AC', 'Alex C'] } })).toEqual(['AC', 'Alex C']);
        expect(fileCacheAliases({ frontmatter: { alias: 'AC' } })).toEqual(['AC']);
        expect(fileCacheAliases(null)).toEqual([]);
    });

    it('tags union cache tags and frontmatter', () => {
        expect(fileCacheTags({
            tags: [{ tag: '#work' }],
            frontmatter: { tags: ['inbox', '#work'] },
        })).toEqual(['work', 'inbox']);
    });

    it('headings flatten cache headings', () => {
        expect(fileCacheHeadings({ headings: [{ heading: 'Intro' }, { heading: 'Next' }] }))
            .toEqual(['Intro', 'Next']);
    });

    it('signature is file count + max mtime (not contents)', () => {
        const a = [tf('a.md', 10), tf('b.md', 50)];
        const b = [tf('a.md', 10), tf('b.md', 50)];
        expect(vaultFileSignature(a)).toBe(vaultFileSignature(b));
        expect(vaultFileSignature(a)).toBe('2:50');
        expect(vaultFileSignature([tf('a.md', 10)])).not.toBe(vaultFileSignature(a));
    });

    it('meta uses basename and cache aliases without reading the file body', () => {
        const meta = vaultFileToMeta(
            tf('People/Alex Chen.md', 1),
            { frontmatter: { aliases: ['Alex C'] } },
        );
        expect(meta.chunk_id).toBe(vaultChunkId('People/Alex Chen.md'));
        expect(meta.title).toBe('Alex Chen');
        expect(meta.metadata.aliases).toEqual(['Alex C']);
        expect(meta.lexicalOnly).toBe(true);
    });

    it('picks newest files and stops at the file/byte cap', () => {
        const files = [
            tf('old.md', 1, 100),
            tf('mid.md', 50, 100),
            tf('new.md', 100, 100),
        ];
        const picked = pickRecentForBodies(files, 2, 10_000);
        expect(picked.map(f => f.path)).toEqual(['new.md', 'mid.md']);
        const tiny = pickRecentForBodies(files, VAULT_LEX_BODY_MAX_FILES, 150);
        expect(tiny.length).toBeLessThanOrEqual(2);
    });

    it('strips YAML frontmatter from bodies', () => {
        expect(stripFrontmatter('---\naliases: [x]\n---\nhello')).toBe('hello');
    });

    it('reads list aliases from markdown YAML', () => {
        expect(aliasesFromMarkdown('---\naliases:\n  - Alex C\n  - AC\n---\nbody')).toEqual(['Alex C', 'AC']);
    });

    it('BM25 scores a topical body query without IDB', async () => {
        const bodies: Record<string, string> = {
            'Gadgets/Pixel.md': 'the verge reviews the new google pixel phone camera',
            'Noise/n0.md': 'alex mentioned a 1x1 in passing and a pixel camera review 0',
        };
        const files = [tf('Gadgets/Pixel.md', 1, bodies['Gadgets/Pixel.md'].length), tf('Noise/n0.md', 2, bodies['Noise/n0.md'].length)];
        const idx = await buildVaultLexIndex(
            files,
            () => null,
            async f => bodies[f.path],
            { searchableProperties: false, headingsField: false, yieldFn: async () => {} },
        );
        const scores = idx.bm25.getScores('pixel camera review');
        const pixelI = idx.chunks.findIndex(c => c.note_path === 'Gadgets/Pixel.md');
        expect(idx.bodiesIndexed).toBe(2);
        expect(pixelI).toBeGreaterThanOrEqual(0);
        expect(scores[pixelI]).toBeGreaterThan(0);
    });

    it('a prior BM25 query does not blank later name-prefix matching', async () => {
        const { matchNamePrefix } = await import('./fusion');
        const bodies: Record<string, string> = {
            'Meetings/Alex 1x1 2026-05-19.md': 'standup notes with alex and the weekly 1x1',
            'People/Alex Chen.md': '---\naliases:\n  - Alex C\n  - AC\n---\nmanager notes\n',
        };
        const files = Object.keys(bodies).map((p, i) => tf(p, 1000 + i, bodies[p].length));
        const idx = await buildVaultLexIndex(
            files,
            () => null,
            async f => bodies[f.path],
            { searchableProperties: false, headingsField: false, yieldFn: async () => {} },
        );
        expect(idx.bm25.getScores('alex 1x1').some(s => s > 0)).toBe(true);
        expect(matchNamePrefix('alex che', 'Alex Chen', []).score).toBeGreaterThan(0.4);
        expect(idx.bm25.getScores('alex che').some(s => s > 0)).toBe(true);
    });
});
