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
    flattenCoverageTree,
    createLiveCoverageSnapshot,
    coverageBarTone,
    coverageBarWidth,
    formatCoverageMeta,
    formatCoveragePercent,
    formatCoverageCountTip,
    coverageDisplayPercent,
    coverageIsSettled,
    coverageCongruenceError,
    ownFilesRow,
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
        expect(coverageCongruenceError(s.root)).toBeNull();
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
        expect(a.percent).toBe(66.67); // 2/3 → 66.67
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

    it('shows a status banner above a partial tree while starting up when notes exist', () => {
        const view = resolveCoveragePanelView({
            summary: readySummary,
            health: 'starting',
            job: { kind: 'full', done: 1, total: 2 },
            orchestratorReady: true,
        });
        expect(view.showTree).toBe(true);
        expect(view.statusLine?.title).toBe('Still starting up');
        expect(view.statusLine?.detail).toContain('1 of 2 notes so far');
    });

    it('shows a status banner above a partial tree while restoring when notes exist', () => {
        const view = resolveCoveragePanelView({
            summary: readySummary,
            health: 'restoring',
            job: null,
            orchestratorReady: true,
        });
        expect(view.showTree).toBe(true);
        expect(view.statusLine?.title).toBe('Restoring index…');
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
        expect(view.statusLine?.detail).toContain('1 remaining');
        expect(view.statusLine?.detail).not.toContain('Folder coverage will appear');
    });

    it('prefers aligning-with-exclusions copy over still-indexing', () => {
        const view = resolveCoveragePanelView({
            summary: readySummary,
            health: 'indexing',
            job: { kind: 'catchup', done: 1, total: 2 },
            orchestratorReady: true,
            aligningExclusions: true,
        });
        expect(view.showTree).toBe(true);
        expect(view.statusLine?.title).toBe('Aligning with exclusions');
        expect(view.statusLine?.detail).toContain('1 of 2');
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

describe('FolderCoverageNode remaining and status', () => {
    it('computes complete, in-progress, pending, and excluded folder states', () => {
        const summary = computeFolderCoverage({
            allPaths: [
                'done/1.md',
                'done/2.md',
                'partial/1.md',
                'partial/2.md',
                'waiting/1.md',
                'ignored/1.md',
            ],
            coveredPaths: [
                'done/1.md',
                'done/2.md',
                'partial/1.md',
            ],
            excludedPaths: [
                'ignored/1.md',
            ],
        });

        const byPath = new Map(summary.root.children.map(c => [c.path, c]));

        const done = byPath.get('done')!;
        expect(done.total).toBe(2);
        expect(done.covered).toBe(2);
        expect(done.remaining).toBe(0);
        expect(done.status).toBe('complete');

        const partial = byPath.get('partial')!;
        expect(partial.total).toBe(2);
        expect(partial.covered).toBe(1);
        expect(partial.remaining).toBe(1);
        expect(partial.status).toBe('in-progress');

        const waiting = byPath.get('waiting')!;
        expect(waiting.total).toBe(1);
        expect(waiting.covered).toBe(0);
        expect(waiting.remaining).toBe(1);
        expect(waiting.status).toBe('pending');

        const ignored = byPath.get('ignored')!;
        expect(ignored.total).toBe(0);
        expect(ignored.excluded).toBe(1);
        expect(ignored.status).toBe('excluded');
    });

    it('overlays pendingPaths as catchingUp and forces in-progress', () => {
        const summary = computeFolderCoverage({
            allPaths: [
                'Private/References/a.md',
                'Private/References/b.md',
                'Private/Spreedly/c.md',
                'Notes/x.md',
            ],
            coveredPaths: [
                'Private/References/a.md',
                'Private/References/b.md',
                'Private/Spreedly/c.md',
                'Notes/x.md',
            ],
            excludedPaths: [],
            pendingPaths: [
                'Private/References/a.md',
                'Private/Spreedly/c.md',
            ],
        });

        expect(summary.overall.catchingUp).toBe(2);
        expect(summary.overall.status).toBe('in-progress');
        // Re-embeds must not report 100% — % matches covered/total, capped while in-flight.
        expect(summary.overall.percent).toBeLessThan(100);
        expect(summary.overall.percent).toBe(99.99);
        expect(summary.overall.remaining).toBe(0);
        expect(coverageBarTone(summary.overall)).toBe('warn');
        expect(coverageCongruenceError(summary.root)).toBeNull();

        const priv = summary.root.children.find(c => c.path === 'Private')!;
        expect(priv.catchingUp).toBe(2);
        expect(priv.status).toBe('in-progress');
        expect(priv.percent).toBeLessThan(100);
        expect(coverageBarTone(priv)).toBe('warn');

        const refs = priv.children.find(c => c.path === 'Private/References')!;
        expect(refs.catchingUp).toBe(1);
        expect(refs.covered).toBe(2);
        expect(refs.percent).toBe(99.99);
        expect(refs.status).toBe('in-progress');
        expect(coverageBarTone(refs)).toBe('warn');

        const notes = summary.root.children.find(c => c.path === 'Notes')!;
        expect(notes.catchingUp).toBe(0);
        expect(notes.percent).toBe(100);
        expect(notes.status).toBe('complete');
        expect(coverageBarTone(notes)).toBe('good');
    });

    it('new uncovered pending notes keep percent below 100 and yellow bar', () => {
        const summary = computeFolderCoverage({
            allPaths: ['NewFolder/a.md', 'NewFolder/b.md'],
            coveredPaths: [],
            excludedPaths: [],
            pendingPaths: ['NewFolder/a.md', 'NewFolder/b.md'],
        });
        const folder = summary.root.children.find(c => c.path === 'NewFolder')!;
        expect(folder.catchingUp).toBe(2);
        expect(folder.covered).toBe(0);
        expect(folder.percent).toBe(0);
        expect(folder.status).toBe('in-progress');
        expect(coverageBarTone(folder)).toBe('warn');
        expect(formatCoverageMeta(folder)).toBe('0 / 2');
        expect(formatCoveragePercent(folder)).toBe('0.00%');
        expect(formatCoverageMeta(folder)).not.toMatch(/pending|excluded|catching up/i);
    });

    it('formatCoverageMeta always shows the live indexed/total fraction', () => {
        const summary = computeFolderCoverage({
            allPaths: ['done/1.md', 'done/2.md'],
            coveredPaths: ['done/1.md', 'done/2.md'],
            excludedPaths: [],
            pendingPaths: ['done/1.md'],
        });
        const done = summary.root.children.find(c => c.path === 'done')!;
        expect(formatCoverageMeta(done)).toBe('2 / 2');
        expect(formatCoveragePercent(done)).toBe('99.99%');
        expect(formatCoverageMeta(done)).not.toMatch(/pending|excluded|catching up/i);
        expect(done.percent).toBe(99.99);
        expect(coverageBarTone(done)).toBe('warn');

        const idle = computeFolderCoverage({
            allPaths: ['done/1.md', 'done/2.md'],
            coveredPaths: ['done/1.md', 'done/2.md'],
            excludedPaths: [],
        }).root.children[0];
        expect(formatCoverageMeta(idle)).toBe('2 / 2');
        expect(formatCoveragePercent(idle)).toBe('100.00%');
        expect(coverageBarTone(idle)).toBe('good');

        const ignored = computeFolderCoverage({
            allPaths: ['Archive/old.md'],
            coveredPaths: [],
            excludedPaths: ['Archive/old.md'],
        }).root.children[0];
        expect(formatCoverageMeta(ignored)).toBe('—');
        expect(formatCoveragePercent(ignored)).toBe('—');
        expect(formatCoverageMeta(ignored)).not.toMatch(/pending|catching up/i);
        expect(ignored.status).toBe('excluded');
    });

    it('never rounds a live delta up to 100% on a large folder', () => {
        const allPaths = Array.from({ length: 1000 }, (_, i) => `Big/n${i}.md`);
        const summary = computeFolderCoverage({
            allPaths,
            coveredPaths: allPaths,
            excludedPaths: [],
            pendingPaths: ['Big/n0.md'],
        });
        const big = summary.root.children.find(c => c.path === 'Big')!;
        expect(big.catchingUp).toBe(1);
        expect(big.covered).toBe(1000);
        expect(big.percent).toBeLessThan(100);
        expect(big.percent).toBe(99.99);
        expect(coverageBarTone(big)).toBe('warn');
        expect(coverageBarWidth(big)).toBeLessThan(100);
    });

    it('overall and folder rows share remaining-aware % and meta', () => {
        const remainingPaths = Array.from({ length: 13 }, (_, i) => `Gap/n${i}.md`);
        const coveredPaths = Array.from({ length: 3024 }, (_, i) => `Done/n${i}.md`);
        const summary = computeFolderCoverage({
            allPaths: [...coveredPaths, ...remainingPaths],
            coveredPaths,
            excludedPaths: [],
        });
        expect(summary.overall.covered).toBe(3024);
        expect(summary.overall.total).toBe(3037);
        expect(summary.overall.remaining).toBe(13);
        expect(summary.overall.percent).toBe(99.57);
        expect(formatCoveragePercent(summary.overall)).toBe('99.57%');
        expect(formatCoverageMeta(summary.overall)).toBe('3,024 / 3,037');
        expect(coverageBarTone(summary.overall)).toBe('warn');
        expect(coverageBarWidth(summary.overall)).toBeLessThan(100);
        expect(coverageBarWidth(summary.overall)).toBeCloseTo((3024 / 3037) * 100, 5);
        expect(coverageCongruenceError(summary.root)).toBeNull();

        const gap = summary.root.children.find(c => c.path === 'Gap')!;
        expect(gap.remaining).toBe(13);
        expect(gap.percent).toBe(0);
        expect(formatCoverageMeta(gap)).toBe('0 / 13');
        expect(formatCoveragePercent(gap)).toBe('0.00%');
        expect(coverageBarTone(gap)).toBe('warn');

        const done = summary.root.children.find(c => c.path === 'Done')!;
        expect(done.remaining).toBe(0);
        expect(formatCoverageMeta(done)).toBe('3,024 / 3,024');
        expect(formatCoveragePercent(done)).toBe('100.00%');
        expect(coverageBarTone(done)).toBe('good');
        expect(formatCoverageCountTip(summary.overall)).toContain('3,024 of 3,037');
        expect(formatCoverageCountTip(summary.overall)).toContain('13 remaining');
    });

    it('coverageDisplayPercent is 2-decimal and never 100 until settled', () => {
        expect(coverageDisplayPercent(3024, 3037)).toBe(99.57);
        expect(coverageDisplayPercent(2, 2, 1)).toBe(99.99);
        expect(coverageDisplayPercent(2, 2, 0)).toBe(100);
        expect(coverageDisplayPercent(0, 0)).toBe(0);
        expect(coverageDisplayPercent(1, 3)).toBe(33.33);
        expect(coverageDisplayPercent(2, 3)).toBe(66.67);
    });

    it('ignores pendingPaths that are excluded', () => {
        const summary = computeFolderCoverage({
            allPaths: ['Archive/old.md'],
            coveredPaths: [],
            excludedPaths: ['Archive/old.md'],
            pendingPaths: ['Archive/old.md'],
        });
        const arch = summary.root.children.find(c => c.path === 'Archive')!;
        expect(arch.catchingUp).toBe(0);
        expect(arch.status).toBe('excluded');
    });

    it('treats 3 newly added files as a live indexed/total snapshot, not 100%', () => {
        const summary = computeFolderCoverage({
            allPaths: ['Notes/a.md', 'Notes/b.md', 'Notes/c.md', 'Notes/d.md', 'Notes/e.md'],
            coveredPaths: ['Notes/a.md', 'Notes/b.md'],
            excludedPaths: [],
            pendingPaths: ['Notes/c.md', 'Notes/d.md', 'Notes/e.md'],
        });
        const notes = summary.root.children.find(c => c.path === 'Notes')!;
        expect(notes.covered).toBe(2);
        expect(notes.total).toBe(5);
        expect(notes.remaining).toBe(3);
        expect(notes.percent).toBe(40);
        expect(formatCoveragePercent(notes)).toBe('40.00%');
        expect(formatCoverageMeta(notes)).toBe('2 / 5');
        expect(coverageBarTone(notes)).toBe('warn');
        expect(summary.overall.percent).toBe(40);
        expect(formatCoverageMeta(summary.overall)).toBe('2 / 5');
        expect(coverageCongruenceError(summary.root)).toBeNull();
        expect(coverageIsSettled(notes)).toBe(false);
        expect(coverageIsSettled(summary.overall)).toBe(false);
    });

    it('marks every folder with remaining work yellow, not only the one currently draining', () => {
        const summary = computeFolderCoverage({
            allPaths: [
                'Alpha/a.md', 'Alpha/b.md', 'Alpha/c.md',
                'Beta/x.md', 'Beta/y.md',
                'Done/z.md',
            ],
            coveredPaths: ['Alpha/a.md', 'Done/z.md'],
            excludedPaths: [],
            pendingPaths: ['Alpha/b.md'],
        });
        const alpha = summary.root.children.find(c => c.path === 'Alpha')!;
        const beta = summary.root.children.find(c => c.path === 'Beta')!;
        const done = summary.root.children.find(c => c.path === 'Done')!;

        expect(formatCoverageMeta(alpha)).toBe('1 / 3');
        expect(formatCoveragePercent(alpha)).toBe('33.33%');
        expect(coverageBarTone(alpha)).toBe('warn');
        expect(alpha.status).toBe('in-progress');

        expect(formatCoverageMeta(beta)).toBe('0 / 2');
        expect(formatCoveragePercent(beta)).toBe('0.00%');
        expect(coverageBarTone(beta)).toBe('warn');
        expect(beta.status).toBe('pending');

        expect(formatCoverageMeta(done)).toBe('1 / 1');
        expect(formatCoveragePercent(done)).toBe('100.00%');
        expect(coverageBarTone(done)).toBe('good');

        expect(formatCoverageMeta(summary.overall)).toBe('2 / 6');
        expect(formatCoveragePercent(summary.overall)).toBe('33.33%');
        expect(coverageBarTone(summary.overall)).toBe('warn');
        expect(summary.overall.percent).toBeLessThan(100);
        expect(coverageCongruenceError(summary.root)).toBeNull();
    });

    it('never lets overall read 100% while a child still has work', () => {
        const summary = computeFolderCoverage({
            allPaths: ['A/1.md', 'A/2.md', 'B/1.md'],
            coveredPaths: ['A/1.md', 'A/2.md'],
            excludedPaths: [],
        });
        expect(summary.overall.percent).toBeLessThan(100);
        expect(coverageIsSettled(summary.overall)).toBe(false);
        const a = summary.root.children.find(c => c.path === 'A')!;
        const b = summary.root.children.find(c => c.path === 'B')!;
        expect(coverageIsSettled(a)).toBe(true);
        expect(coverageIsSettled(b)).toBe(false);
        expect(coverageCongruenceError(summary.root)).toBeNull();
    });

    it('surfaces vault-root notes as their own row so overall matches the visible parts', () => {
        const summary = computeFolderCoverage({
            allPaths: ['root.md', 'A/1.md', 'A/2.md'],
            coveredPaths: ['A/1.md', 'A/2.md'],
            excludedPaths: [],
        });
        expect(summary.root.ownTotal).toBe(1);
        expect(summary.root.ownCovered).toBe(0);
        const own = ownFilesRow(summary.root)!;
        expect(own.name).toBe('vault root');
        expect(formatCoverageMeta(own)).toBe('0 / 1');
        expect(coverageBarTone(own)).toBe('warn');
        expect(summary.overall.covered).toBe(2);
        expect(summary.overall.total).toBe(3);
        expect(summary.overall.percent).toBe(66.67);
        expect(coverageCongruenceError(summary.root)).toBeNull();
    });
});

describe('createLiveCoverageSnapshot and flattenCoverageTree', () => {
    it('creates flat list of folders and overall stats for live polling', () => {
        const summary = computeFolderCoverage({
            allPaths: ['work/project/spec.md', 'work/tasks.md', 'notes/today.md'],
            coveredPaths: ['work/tasks.md'],
            excludedPaths: [],
        });

        const snapshot = createLiveCoverageSnapshot({
            summary,
            health: 'indexing',
            job: { kind: 'full', done: 1, total: 3 },
        });

        expect(snapshot.health).toBe('indexing');
        expect(snapshot.job?.total).toBe(3);
        expect(snapshot.overall.total).toBe(3);
        expect(snapshot.overall.covered).toBe(1);
        expect(snapshot.overall.remaining).toBe(2);
        expect(snapshot.overall.percent).toBe(33.33);
        expect(coverageCongruenceError(summary.root)).toBeNull();

        const paths = snapshot.folders.map(f => f.path);
        expect(paths).toContain('work');
        expect(paths).toContain('work/project');
        expect(paths).toContain('notes');

        const work = snapshot.folders.find(f => f.path === 'work')!;
        expect(work.total).toBe(2);
        expect(work.covered).toBe(1);
        expect(work.remaining).toBe(1);
        expect(work.catchingUp).toBe(0);
        expect(work.status).toBe('in-progress');
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
