// Pure logic for the settings coverage surface: per-folder (full-hierarchy) embedder
// coverage and the exclusion-list change diff. No Obsidian / model / IDB — just set
// math over vault path strings, so it is deterministic and cheap to test.
import { describe, it, expect } from 'vitest';
import {
    folderOf,
    segmentOf,
    displayFolderName,
    pathFolderChain,
    computeFolderCoverage,
    emptyFolderCoverage,
    resolveCoveragePanelView,
    diffExcludedPaths,
    exclusionDiffIsEmpty,
    type FolderCoverageNode,
} from './folder-coverage';

describe('folderOf / segmentOf / pathFolderChain', () => {
    it('folderOf returns the top-level folder', () => {
        expect(folderOf('a/b/c.md')).toBe('a');
        expect(folderOf('note.md')).toBe('');
    });
    it('segmentOf returns the last path segment', () => {
        expect(segmentOf('a/b')).toBe('b');
        expect(segmentOf('a')).toBe('a');
        expect(segmentOf('')).toBe('');
    });
    it('pathFolderChain lists ancestors shallow→deep', () => {
        expect(pathFolderChain('a/b/c.md')).toEqual(['a', 'a/b']);
        expect(pathFolderChain('a.md')).toEqual([]);
    });
    it('displayFolderName labels the root and shows a single segment', () => {
        expect(displayFolderName('')).toBe('vault root');
        expect(displayFolderName('a/b')).toBe('b');
    });
});

function byPath(node: FolderCoverageNode, path: string): FolderCoverageNode | undefined {
    if (node.path === path) return node;
    for (const c of node.children) {
        const r = byPath(c, path);
        if (r) return r;
    }
    return undefined;
}

describe('computeFolderCoverage (hierarchy, per-subtree %)', () => {
    it('reports each folder as the count of its own subtree, not the whole vault', () => {
        // A/B has 2 files (1 covered); A/C has 1 file (0 covered); A root file 1 (covered).
        const s = computeFolderCoverage({
            allPaths: ['A/B/x.md', 'A/B/y.md', 'A/C/z.md', 'A/root.md'],
            coveredPaths: ['A/B/x.md', 'A/root.md'],
            excludedPaths: [],
        });
        // A subtree: 4 relevant, 2 covered → 50%
        const a = byPath(s.root, 'A')!;
        expect(a.total).toBe(4);
        expect(a.covered).toBe(2);
        expect(a.percent).toBe(50);
        // A/B subtree: 2 relevant, 1 covered → 50% (NOT the vault total)
        const ab = byPath(s.root, 'A/B')!;
        expect(ab.total).toBe(2);
        expect(ab.covered).toBe(1);
        expect(ab.percent).toBe(50);
        // A/C subtree: 1 relevant, 0 covered → 0%
        const ac = byPath(s.root, 'A/C')!;
        expect(ac.total).toBe(1);
        expect(ac.covered).toBe(0);
        expect(ac.percent).toBe(0);
        // overall (root) = 2/4 = 50%
        expect(s.overall.total).toBe(4);
        expect(s.overall.covered).toBe(2);
        expect(s.overall.percent).toBe(50);
    });

    it('nested folders nest under their parent in the tree', () => {
        const s = computeFolderCoverage({
            allPaths: ['A/B/x.md'],
            coveredPaths: [],
            excludedPaths: [],
        });
        const a = s.root.children.find(c => c.path === 'A')!;
        const ab = a.children.find(c => c.path === 'A/B')!;
        expect(ab.name).toBe('B');
        expect(ab.total).toBe(1);
    });

    it('a parent covers its own files AND its descendants', () => {
        // A has 1 direct file (covered) + 2 in A/B (1 covered) → A: 3 relevant, 2 covered.
        const s = computeFolderCoverage({
            allPaths: ['A/a.md', 'A/B/b1.md', 'A/B/b2.md'],
            coveredPaths: ['A/a.md', 'A/B/b1.md'],
            excludedPaths: [],
        });
        const a = byPath(s.root, 'A')!;
        expect(a.total).toBe(3);
        expect(a.covered).toBe(2);
        expect(a.percent).toBe(67); // round(2/3*100)
        expect(byPath(s.root, 'A/B')!.total).toBe(2);
    });

    it('excluded files are removed from every ancestor subtree\'s denominator', () => {
        // A/B: 2 files, 1 excluded → A/B relevant = 1, 0 covered → 0%.
        // A: 2 files total, 1 excluded → A relevant = 1, 0 covered → 0%.
        const s = computeFolderCoverage({
            allPaths: ['A/B/x.md', 'A/B/y.md'],
            coveredPaths: [],
            excludedPaths: ['A/B/x.md'],
        });
        const ab = byPath(s.root, 'A/B')!;
        expect(ab.total).toBe(1);
        expect(ab.excluded).toBe(1);
        expect(ab.percent).toBe(0);
        const a = byPath(s.root, 'A')!;
        expect(a.total).toBe(1);
        expect(a.excluded).toBe(1);
        expect(a.percent).toBe(0);
    });

    it('a fully-excluded folder shows 0% and is excluded from the overall denominator', () => {
        const s = computeFolderCoverage({
            allPaths: ['Arch/1.md', 'Arch/2.md', 'Main/1.md', 'Main/2.md'],
            coveredPaths: ['Main/1.md', 'Main/2.md'],
            excludedPaths: ['Arch/1.md', 'Arch/2.md'],
        });
        expect(byPath(s.root, 'Arch')!.percent).toBe(0);
        expect(byPath(s.root, 'Arch')!.excluded).toBe(2);
        // overall: 2 relevant (both in Main), 2 covered → 100%
        expect(s.overall.percent).toBe(100);
        expect(s.overall.excluded).toBe(2);
    });

    it('root-level files count toward the vault root, not a folder', () => {
        const s = computeFolderCoverage({
            allPaths: ['a.md', 'b.md', 'A/c.md'],
            coveredPaths: ['a.md'],
            excludedPaths: [],
        });
        // root total = 3 (a, b, and A/c all roll up to root)
        expect(s.root.total).toBe(3);
        expect(s.root.covered).toBe(1);
        expect(s.root.children.find(c => c.path === 'A')!.total).toBe(1);
    });

    it('is empty-safe', () => {
        const s = computeFolderCoverage({ allPaths: [], coveredPaths: [], excludedPaths: [] });
        expect(s.root.total).toBe(0);
        expect(s.root.children).toEqual([]);
        const e = emptyFolderCoverage();
        expect(e.root.total).toBe(0);
        expect(e.overall).toBe(e.root);
    });

    it('sorts sibling children by subtree size desc then name', () => {
        const s = computeFolderCoverage({
            allPaths: ['z/1.md', 'z/2.md', 'a/1.md', 'b/1.md'],
            coveredPaths: [],
            excludedPaths: [],
        });
        expect(s.root.children.map(c => c.path)).toEqual(['z', 'a', 'b']);
    });
});

describe('resolveCoveragePanelView', () => {
    const readySummary = computeFolderCoverage({
        allPaths: ['a/1.md', 'b/1.md'],
        coveredPaths: ['a/1.md'],
        excludedPaths: [],
    });

    it('shows the tree when notes are indexable', () => {
        const view = resolveCoveragePanelView({
            summary: readySummary,
            health: 'ok',
            job: null,
            orchestratorReady: true,
        });
        expect(view.showTree).toBe(true);
        expect(view.placeholder).toBeUndefined();
    });

    it('shows a still-indexing placeholder before the vault is scanned', () => {
        const view = resolveCoveragePanelView({
            summary: emptyFolderCoverage(),
            health: 'indexing',
            job: { kind: 'full', done: 12, total: 100 },
            orchestratorReady: true,
        });
        expect(view.showTree).toBe(false);
        expect(view.placeholder?.title).toBe('Still indexing');
        expect(view.placeholder?.detail).toContain('12 of 100');
    });

    it('shows a starting-up placeholder before the orchestrator exists', () => {
        const view = resolveCoveragePanelView({
            summary: emptyFolderCoverage(),
            health: 'starting',
            job: null,
            orchestratorReady: false,
        });
        expect(view.showTree).toBe(false);
        expect(view.placeholder?.title).toBe('Still starting up');
    });

    it('shows a status banner above a partial tree while indexing', () => {
        const view = resolveCoveragePanelView({
            summary: readySummary,
            health: 'indexing',
            job: { kind: 'catchup', done: 1, total: 2 },
            orchestratorReady: true,
        });
        expect(view.showTree).toBe(true);
        expect(view.statusLine?.title).toBe('Still indexing');
    });

    it('explains when every note is excluded', () => {
        const summary = computeFolderCoverage({
            allPaths: ['arch/1.md'],
            coveredPaths: [],
            excludedPaths: ['arch/1.md'],
        });
        const view = resolveCoveragePanelView({
            summary,
            health: 'ok',
            job: null,
            orchestratorReady: true,
        });
        expect(view.showTree).toBe(false);
        expect(view.placeholder?.title).toBe('Nothing to cover');
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
        expect(diff.newlyIncludedFolders).toEqual(['arch']);
        expect(diff.newlyExcludedFolders).toEqual(['temp']);
    });
});
