// Pure logic for the settings coverage surface: per-folder embedder coverage and
// the exclusion-list change diff. No Obsidian / model / IDB — just set math over
// vault path strings, so it is deterministic and cheap to test.
import { describe, it, expect } from 'vitest';
import {
    folderOf,
    displayFolderName,
    computeFolderCoverage,
    diffExcludedPaths,
    exclusionDiffIsEmpty,
} from './folder-coverage';

describe('folderOf', () => {
    it('returns the top-level folder', () => {
        expect(folderOf('a/b/c.md')).toBe('a');
    });
    it('returns "" for a root-level file', () => {
        expect(folderOf('note.md')).toBe('');
    });
});

describe('displayFolderName', () => {
    it('labels the vault root', () => {
        expect(displayFolderName('')).toBe('vault root');
    });
    it('passes through a normal folder', () => {
        expect(displayFolderName('Projects')).toBe('Projects');
    });
});

describe('computeFolderCoverage', () => {
    it('computes per-folder and overall percentages', () => {
        const summary = computeFolderCoverage({
            allPaths: ['a/1.md', 'a/2.md', 'b/1.md', 'root.md'],
            coveredPaths: ['a/1.md', 'root.md'],
            excludedPaths: [],
        });
        const byName = Object.fromEntries(summary.rows.map(r => [r.folder, r]));
        // a: 1 of 2 covered = 50%; b: 0 of 1 = 0%; root: 1 of 1 = 100%
        expect(byName['a'].percent).toBe(50);
        expect(byName['a'].covered).toBe(1);
        expect(byName['a'].total).toBe(2);
        expect(byName['b'].percent).toBe(0);
        expect(byName[''].percent).toBe(100);
        // overall: 2 of 4 = 50%
        expect(summary.overall.percent).toBe(50);
        expect(summary.overall.covered).toBe(2);
        expect(summary.overall.total).toBe(4);
    });

    it('sorts rows by total desc then name', () => {
        const summary = computeFolderCoverage({
            allPaths: ['z/x.md', 'z/y.md', 'a/1.md'],
            coveredPaths: [],
            excludedPaths: [],
        });
        expect(summary.rows.map(r => r.folder)).toEqual(['z', 'a']);
    });

    it('excludes excluded files from the coverage denominator', () => {
        // a has 3 files, one excluded; 1 of the 2 non-excluded covered = 50%.
        const summary = computeFolderCoverage({
            allPaths: ['a/1.md', 'a/2.md', 'a/3.md'],
            coveredPaths: ['a/1.md'],
            excludedPaths: ['a/3.md'],
        });
        const a = summary.rows.find(r => r.folder === 'a')!;
        expect(a.excluded).toBe(1);
        expect(a.percent).toBe(50); // 1 / (3 - 1)
        expect(a.covered).toBe(1);
    });

    it('reports a fully-excluded folder as 0%', () => {
        const summary = computeFolderCoverage({
            allPaths: ['arch/1.md', 'arch/2.md', 'main/1.md'],
            coveredPaths: ['main/1.md'],
            excludedPaths: ['arch/1.md', 'arch/2.md'],
        });
        const arch = summary.rows.find(r => r.folder === 'arch')!;
        expect(arch.percent).toBe(0);
        expect(arch.excluded).toBe(2);
        // overall denominator excludes the 2 excluded files → 1/1 = 100%
        expect(summary.overall.percent).toBe(100);
    });

    it('reports 0% for an empty input', () => {
        const summary = computeFolderCoverage({ allPaths: [], coveredPaths: [], excludedPaths: [] });
        expect(summary.rows).toEqual([]);
        expect(summary.overall.percent).toBe(0);
    });

    it('never counts a covered path that is also excluded toward the denominator', () => {
        // A path can be both in coveredPaths (has a record) and excludedPaths (now
        // ignored) during a transition; the denominator is total-excluded, so it is
        // not double-counted.
        const summary = computeFolderCoverage({
            allPaths: ['a/1.md'],
            coveredPaths: ['a/1.md'],
            excludedPaths: ['a/1.md'],
        });
        expect(summary.rows[0].percent).toBe(0);
        expect(summary.rows[0].excluded).toBe(1);
    });
});

describe('diffExcludedPaths', () => {
    it('detects a folder that was revealed (backfill)', () => {
        const diff = diffExcludedPaths(['arch/1.md', 'arch/2.md'], []);
        expect(diff.newlyIncludedPaths).toEqual(['arch/1.md', 'arch/2.md']);
        expect(diff.newlyIncludedFolders).toEqual(['arch']);
        expect(diff.newlyExcludedPaths).toEqual([]);
        expect(exclusionDiffIsEmpty(diff)).toBe(false);
    });

    it('detects a folder that was hidden (soft-delete)', () => {
        const diff = diffExcludedPaths([], ['arch/1.md']);
        expect(diff.newlyExcludedPaths).toEqual(['arch/1.md']);
        expect(diff.newlyExcludedFolders).toEqual(['arch']);
        expect(diff.newlyIncludedPaths).toEqual([]);
    });

    it('is a no-op when the set is unchanged', () => {
        const diff = diffExcludedPaths(['a/1.md', 'b/1.md'], ['b/1.md', 'a/1.md']);
        expect(exclusionDiffIsEmpty(diff)).toBe(true);
    });

    it('collects multiple folders from a mixed change', () => {
        const diff = diffExcludedPaths(
            ['arch/1.md', 'archive/x/y.md'],
            ['archive/x/y.md', 'temp/1.md'],
        );
        // arch was revealed, temp was hidden, archive unchanged.
        expect(diff.newlyIncludedFolders).toEqual(['arch']);
        expect(diff.newlyExcludedFolders).toEqual(['temp']);
    });
});
