// Per-folder embedder-pipeline coverage for the Seek settings surface, plus the
// user-ignore-filter diff that detects when Obsidian's "Excluded files" list
// changed so a previously-excluded folder can be backfilled.
//
// resolveCoveragePanelView() decides whether Settings → Index shows the folder
// tree, a placeholder ("still indexing"), or both (tree + status banner).
//
import type { IndexStatusHealth, IndexStatusJob } from './index-status-card';

// Pure and dependency-injected (no Obsidian / model coupling) so the math and the
// change detection are unit-testable. The plugin supplies the three live path sets
// (all indexable-extension files, the subset already through the embedder, the
// subset currently excluded by Obsidian's ignore rules) and the two exclusion
// snapshots; everything here is set/grouping arithmetic.
//
// "Coverage" is a live snapshot of vault files vs FileRecords (a FileRecord exists
// only after a file has been chunked/tokenized and committed). Percent and the
// `covered / total` fraction are the same counts at every node:
//
//   overall.covered === sum of each top-level folder's covered + vault-root files
//   overall.total   === sum of each top-level folder's total   + vault-root files
//
// 100.00% is allowed only when remaining=0 and nothing is in-flight. A parent
// cannot read 100% while any descendant still has remaining or catching-up files.
//
// State machine (folderStatus → bar tone):
//   excluded    — no relevant files, ignore-rules hide the subtree     → muted / —
//   complete    — remaining=0 and catchingUp=0                       → green / 100.00%
//   in-progress  — catchingUp>0, or some-but-not-all files indexed       → yellow
//   pending     — relevant files exist, none indexed, none in-flight   → yellow
//
// Yellow means "this folder still has work". Two folders with new files both
// stay yellow and both show their own indexed/total fractions.

export function segmentOf(folderKey: string): string {
    const i = folderKey.lastIndexOf('/');
    return i < 0 ? folderKey : folderKey.slice(i + 1);
}

// Human label for a folder node; the vault root reads better than a blank cell.
export function displayFolderName(folder: string): string {
    return folder === '' ? 'vault root' : segmentOf(folder);
}

export type FolderCoverageStatus = 'complete' | 'in-progress' | 'pending' | 'excluded';

/** Sentinel path for notes that sit in a folder (or vault root) rather than a subfolder. */
export const OWN_FILES_PATH = '.';

// One directory in the hierarchy. `total` / `covered` are the RELEVANT (non-excluded)
// files in this folder's own subtree (recursively). `own*` is the slice that lives
// directly in this folder (not in a child). Percent is covered/total to 2 decimals;
// 100 only when remaining=0 and catchingUp=0.
export interface FolderCoverageNode {
    path: string;          // folder key ('' = vault root, 'A', 'A/B', …)
    name: string;          // single-segment display name
    total: number;         // relevant (non-excluded) files in the subtree
    covered: number;       // relevant files in the subtree with a FileRecord
    remaining: number;     // total - covered (files needing processing)
    excluded: number;      // files in the subtree hidden by ignore rules
    /** Paths in this subtree currently queued / in the active delta (catch-up). */
    catchingUp: number;
    ownTotal: number;     // relevant files sitting directly in this folder
    ownCovered: number;
    ownRemaining: number;
    ownExcluded: number;
    ownCatchingUp: number;
    percent: number;       // display % of covered/total to 2 decimals
    status: FolderCoverageStatus;
    children: FolderCoverageNode[]; // nested subfolders (recursive hierarchy)
}

export interface FolderCoverageSummary {
    root: FolderCoverageNode;   // the vault node: the whole hierarchy
    overall: FolderCoverageNode; // alias for root (the grand total)
}

export interface FlatFolderCoverageItem {
    path: string;
    name: string;
    total: number;
    covered: number;
    remaining: number;
    excluded: number;
    catchingUp: number;
    percent: number;
    status: FolderCoverageStatus;
    depth: number;
}

export interface LiveCoverageSnapshot {
    health: IndexStatusHealth;
    job: IndexStatusJob | null;
    overall: {
        total: number;
        covered: number;
        remaining: number;
        excluded: number;
        percent: number;
    };
    folders: FlatFolderCoverageItem[];
    summary: FolderCoverageSummary;
}

export interface FolderCoverageInput {
    allPaths: string[];      // every indexable-extension file, before exclusion
    coveredPaths: string[];  // subset of allPaths that has a FileRecord
    excludedPaths: string[]; // subset of allPaths currently excluded by ignore rules
    /** Paths actively queued or in the current computeDelta dirty set. */
    pendingPaths?: string[];
}

// The chain of ancestor folder keys for a file path, from shallowest to deepest.
// 'A/B/file.md' → ['A', 'A/B']; 'file.md' → [] (root-level file, no folders).
export function pathFolderChain(path: string): string[] {
    const parts = path.split('/');
    parts.pop(); // drop the file name
    const chain: string[] = [];
    let acc = '';
    for (const part of parts) {
        if (part === '') continue; // skip a leading '/' (never happens in Obsidian, but be safe)
        acc = acc ? acc + '/' + part : part;
        chain.push(acc);
    }
    return chain;
}

// Top-level folder key for a vault path (used by the exclusion diff). '' = root.
export function folderOf(path: string): string {
    const i = path.indexOf('/');
    return i < 0 ? '' : path.slice(0, i);
}

function folderStatus(
    total: number,
    covered: number,
    excluded: number,
    catchingUp = 0,
): FolderCoverageStatus {
    if (total === 0 && excluded > 0) return 'excluded';
    if (total === 0) return 'pending';
    // Actively draining (including re-embeds of already-covered notes).
    if (catchingUp > 0) return 'in-progress';
    if (covered >= total) return 'complete';
    if (covered > 0) return 'in-progress';
    return 'pending';
}

export type CoverageBarTone = 'good' | 'warn' | 'low';

export interface CoverageDisplayNode {
    total: number;
    covered: number;
    remaining: number;
    excluded?: number;
    catchingUp?: number;
    percent: number;
}

/** True when this node may show 100.00% / green. */
export function coverageIsSettled(node: CoverageDisplayNode): boolean {
    return node.total > 0 && node.remaining === 0 && (node.catchingUp ?? 0) === 0 && node.covered >= node.total;
}

/** Bar / % tone: green only when settled complete; yellow while remaining or catching up. */
export function coverageBarTone(node: CoverageDisplayNode): CoverageBarTone {
    if (node.total <= 0) return 'low';
    if ((node.catchingUp ?? 0) > 0) return 'warn';
    if (node.remaining > 0) return 'warn';
    if (coverageIsSettled(node)) return 'good';
    return 'low';
}

/**
 * Display percent to 2 decimal places. 100.00 only when every relevant file is
 * covered and none are in-flight. Incomplete work never rounds up to 100.00
 * (3024/3037 → 99.57, not 100.00).
 */
export function coverageDisplayPercent(covered: number, total: number, catchingUp = 0): number {
    if (total <= 0) return 0;
    if (covered >= total && catchingUp === 0) return 100;
    if (covered <= 0) return 0;
    const raw = (covered / total) * 100;
    const rounded = Math.round(raw * 100) / 100;
    if (covered < total || catchingUp > 0) return Math.min(99.99, rounded);
    return rounded;
}

/** CSS bar width 0–100; never full while files remain or a delta is in-flight. */
export function coverageBarWidth(node: CoverageDisplayNode): number {
    if (node.total <= 0) return 0;
    if (coverageIsSettled(node)) return 100;
    const raw = (node.covered / node.total) * 100;
    if (raw >= 100) return 99.99;
    return Math.max(0, raw);
}

export function formatCoveragePercent(node: CoverageDisplayNode): string {
    if (node.total <= 0) return '—';
    return `${node.percent.toFixed(2)}%`;
}

/** Live indexed/total fraction at every node. Empty or excluded → em dash. */
export function formatCoverageMeta(node: CoverageDisplayNode): string {
    if (node.total <= 0) return '—';
    return `${node.covered.toLocaleString()} / ${node.total.toLocaleString()}`;
}

/** Hover detail that always includes the fraction plus remaining / in-flight. */
export function formatCoverageCountTip(node: CoverageDisplayNode): string {
    if (node.total <= 0) {
        return (node.excluded ?? 0) > 0
            ? `${node.excluded!.toLocaleString()} notes excluded from the index.`
            : 'No indexable notes in this folder.';
    }
    const fraction = `${node.covered.toLocaleString()} of ${node.total.toLocaleString()} notes indexed`;
    if (node.remaining > 0) return `${fraction} · ${node.remaining.toLocaleString()} remaining.`;
    if ((node.catchingUp ?? 0) > 0) return `${fraction} · some notes are still updating.`;
    return `${fraction}.`;
}

/**
 * Walk the tree and return the first congruence failure, or null if overall
 * and every folder share the same live snapshot (parent = own files + children).
 */
export function coverageCongruenceError(node: FolderCoverageNode): string | null {
    const childTotal = node.children.reduce((s, c) => s + c.total, 0);
    const childCovered = node.children.reduce((s, c) => s + c.covered, 0);
    const childRemaining = node.children.reduce((s, c) => s + c.remaining, 0);
    const childExcluded = node.children.reduce((s, c) => s + c.excluded, 0);
    const childCatching = node.children.reduce((s, c) => s + c.catchingUp, 0);

    if (node.remaining !== node.total - node.covered) {
        return `${node.path || 'vault'}: remaining ${node.remaining} !== total-covered ${node.total - node.covered}`;
    }
    if (node.ownRemaining !== node.ownTotal - node.ownCovered) {
        return `${node.path || 'vault'}: ownRemaining mismatch`;
    }
    if (node.total !== node.ownTotal + childTotal) {
        return `${node.path || 'vault'}: total ${node.total} !== own ${node.ownTotal} + children ${childTotal}`;
    }
    if (node.covered !== node.ownCovered + childCovered) {
        return `${node.path || 'vault'}: covered ${node.covered} !== own ${node.ownCovered} + children ${childCovered}`;
    }
    if (node.remaining !== node.ownRemaining + childRemaining) {
        return `${node.path || 'vault'}: remaining ${node.remaining} !== own ${node.ownRemaining} + children ${childRemaining}`;
    }
    if (node.excluded !== node.ownExcluded + childExcluded) {
        return `${node.path || 'vault'}: excluded mismatch`;
    }
    if (node.catchingUp !== node.ownCatchingUp + childCatching) {
        return `${node.path || 'vault'}: catchingUp ${node.catchingUp} !== own ${node.ownCatchingUp} + children ${childCatching}`;
    }

    const expectedPct = coverageDisplayPercent(node.covered, node.total, node.catchingUp);
    if (node.percent !== expectedPct) {
        return `${node.path || 'vault'}: percent ${node.percent} !== ${expectedPct}`;
    }
    if (coverageIsSettled(node) && node.percent !== 100) {
        return `${node.path || 'vault'}: settled but percent is ${node.percent}`;
    }
    if (!coverageIsSettled(node) && node.percent >= 100 && node.total > 0) {
        return `${node.path || 'vault'}: ${node.percent}% while remaining=${node.remaining} catchingUp=${node.catchingUp}`;
    }
    if (node.percent >= 100 && node.children.some(c => c.total > 0 && !coverageIsSettled(c))) {
        return `${node.path || 'vault'}: 100% while a child is not settled`;
    }

    for (const child of node.children) {
        const err = coverageCongruenceError(child);
        if (err) return err;
    }
    return null;
}

/** Synthetic row for notes that live in this folder rather than a subfolder. */
export function ownFilesRow(parent: FolderCoverageNode): FolderCoverageNode | null {
    if (parent.ownTotal <= 0 && parent.ownExcluded <= 0) return null;
    const remaining = Math.max(0, parent.ownTotal - parent.ownCovered);
    return {
        path: parent.path ? `${parent.path}/${OWN_FILES_PATH}` : OWN_FILES_PATH,
        name: parent.path === '' ? 'vault root' : 'notes here',
        total: parent.ownTotal,
        covered: parent.ownCovered,
        remaining,
        excluded: parent.ownExcluded,
        catchingUp: parent.ownCatchingUp,
        ownTotal: parent.ownTotal,
        ownCovered: parent.ownCovered,
        ownRemaining: remaining,
        ownExcluded: parent.ownExcluded,
        ownCatchingUp: parent.ownCatchingUp,
        percent: coverageDisplayPercent(parent.ownCovered, parent.ownTotal, parent.ownCatchingUp),
        status: folderStatus(parent.ownTotal, parent.ownCovered, parent.ownExcluded, parent.ownCatchingUp),
        children: [],
    };
}

// A well-formed empty summary, used by callers (e.g. the plugin) before the
// orchestrator exists or on a read failure.
export type CoveragePlaceholderTone = 'pending' | 'muted' | 'bad';

export interface CoveragePanelMessage {
    title: string;
    detail: string;
    tone: CoveragePlaceholderTone;
}

export interface CoveragePanelView {
    showTree: boolean;
    summary: FolderCoverageSummary;
    /** Shown instead of the tree when showTree is false. */
    placeholder?: CoveragePanelMessage;
    /** Optional banner above the tree while indexing is still catching up. */
    statusLine?: CoveragePanelMessage;
}

function indexingDetail(job: IndexStatusJob | null, pendingCount?: number, remainingCount?: number): string {
    const remainingBit = remainingCount != null && remainingCount > 0
        ? `${remainingCount.toLocaleString()} remaining`
        : null;
    if (job && job.total > 0) {
        const pass = `Indexed ${job.done.toLocaleString()} of ${job.total.toLocaleString()} this pass`;
        return remainingBit ? `${pass} · ${remainingBit}.` : `${pass}. Folder bars update as files finish.`;
    }
    if (remainingBit) {
        return `${remainingCount!.toLocaleString()} notes still need embeddings. Folder bars update as files finish.`;
    }
    if (pendingCount != null && pendingCount > 0) {
        return `Seek is embedding ${pendingCount.toLocaleString()} notes. Folder bars turn yellow until they settle.`;
    }
    return 'Seek is still embedding notes. Folder bars update as files finish.';
}

function aligningDetail(job: IndexStatusJob | null): string {
    if (job && job.total > 0) {
        return `Reindexing ${job.done.toLocaleString()} of ${job.total.toLocaleString()} notes so the index matches your excluded folders.`;
    }
    return 'Reindexing notes that moved in or out of your excluded folders.';
}

function isIndexingActive(health: IndexStatusHealth, job: IndexStatusJob | null): boolean {
    if (health === 'indexing') return true;
    return job != null && job.total > 0 && job.done < job.total;
}

/** Settings → Index coverage panel: tree vs explicit placeholder copy. */
export function resolveCoveragePanelView(input: {
    summary: FolderCoverageSummary;
    health: IndexStatusHealth;
    job: IndexStatusJob | null;
    orchestratorReady: boolean;
    loadFailed?: boolean;
    aligningExclusions?: boolean;
    /** Active dirty/delta pending count for the status banner. */
    pendingCount?: number;
}): CoveragePanelView {
    const { summary, health, job, orchestratorReady, loadFailed, aligningExclusions, pendingCount } = input;
    const { total, covered, excluded } = summary.overall;

    if (loadFailed) {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'bad',
                title: "Couldn't read coverage",
                detail: 'Try reloading Seek or reopening Settings.',
            },
        };
    }

    if (!orchestratorReady) {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'pending',
                title: 'Still starting up',
                detail: 'Seek is loading the search index. Folder coverage will appear once your vault is ready.',
            },
        };
    }

    if (health === 'error') {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'bad',
                title: 'Index error',
                detail: 'Fix the index (try a full reindex) to see embedder coverage by folder.',
            },
        };
    }

    if (health === 'locked') {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'bad',
                title: 'Index locked',
                detail: 'Close other Obsidian windows using this vault, then reopen Settings.',
            },
        };
    }

    // If indexable files exist, show the live tree with an informative status banner!
    if (total > 0) {
        const view: CoveragePanelView = { showTree: true, summary };
        if (health === 'starting') {
            view.statusLine = {
                tone: 'pending',
                title: 'Still starting up',
                detail: job && job.total > 0
                    ? `Indexed ${job.done.toLocaleString()} of ${job.total.toLocaleString()} notes so far. Folder coverage is updating live.`
                    : 'Seek is loading the search index. Folder coverage updates as notes are indexed.',
            };
        } else if (health === 'restoring') {
            view.statusLine = {
                tone: 'pending',
                title: 'Restoring index…',
                detail: 'Seek is restoring your index. Folder coverage is updating live as notes are restored.',
            };
        } else if (aligningExclusions) {
            view.statusLine = {
                tone: 'pending',
                title: 'Aligning with exclusions',
                detail: aligningDetail(job),
            };
        }         else if (isIndexingActive(health, job) && covered < total) {
            view.statusLine = {
                tone: 'pending',
                title: 'Still indexing',
                detail: indexingDetail(job, pendingCount, total - covered),
            };
        } else if ((isIndexingActive(health, job) || (pendingCount ?? 0) > 0) && covered >= total) {
            // Re-embeds of already-covered notes (edits) — tree is full but catch-up is live.
            view.statusLine = {
                tone: 'pending',
                title: 'Still indexing',
                detail: indexingDetail(job, pendingCount, 0),
            };
        }
        return view;
    }

    if (excluded > 0) {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'muted',
                title: 'Nothing to cover',
                detail: `Every indexable note is excluded (${excluded.toLocaleString()} excluded). Adjust Obsidian's Excluded files, Seek's additional excluded folders, or turn off Honor excluded folders to include them.`,
            },
        };
    }

    if (health === 'starting' || health === 'restoring') {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'pending',
                title: health === 'restoring' ? 'Restoring index…' : 'Still starting up',
                detail: health === 'restoring'
                    ? 'Seek is restoring your index. Folder coverage will appear once the vault layout is ready.'
                    : 'Seek is loading the search index. Folder coverage will appear once your vault is ready.',
            },
        };
    }

    if (aligningExclusions) {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'pending',
                title: 'Aligning with exclusions',
                detail: aligningDetail(job),
            },
        };
    }

    if (isIndexingActive(health, job) || health === 'none') {
        return {
            showTree: false,
            summary,
            placeholder: {
                tone: 'pending',
                title: 'Still indexing',
                detail: job && job.total > 0
                    ? indexingDetail(job, pendingCount)
                    : 'Seek is still scanning and embedding your vault. Folder coverage will appear once notes are indexed.',
            },
        };
    }

    return {
        showTree: false,
        summary,
        placeholder: {
            tone: 'muted',
            title: 'No indexable notes',
            detail: 'This vault has no markdown notes (or other indexable files) for Seek to cover.',
        },
    };
}

export function emptyFolderCoverage(): FolderCoverageSummary {
    const root: FolderCoverageNode = {
        path: '',
        name: 'vault root',
        total: 0,
        covered: 0,
        remaining: 0,
        excluded: 0,
        catchingUp: 0,
        ownTotal: 0,
        ownCovered: 0,
        ownRemaining: 0,
        ownExcluded: 0,
        ownCatchingUp: 0,
        percent: 0,
        status: 'pending',
        children: [],
    };
    return { root, overall: root };
}

export function computeFolderCoverage(input: FolderCoverageInput): FolderCoverageSummary {
    const coveredSet = new Set(input.coveredPaths);
    const excludedSet = new Set(input.excludedPaths);
    const pendingSet = new Set(input.pendingPaths ?? []);

    // Mutable accumulator per folder node; children keyed by single segment name.
    interface Acc {
        path: string;
        total: number;
        covered: number;
        excluded: number;
        catchingUp: number;
        children: Map<string, Acc>;
    }
    const makeAcc = (path: string): Acc => ({
        path, total: 0, covered: 0, excluded: 0, catchingUp: 0, children: new Map(),
    });
    const rootAcc = makeAcc('');

    const bump = (acc: Acc, isCovered: boolean, isExcluded: boolean, isPending: boolean): void => {
        if (isExcluded) acc.excluded++;
        else {
            acc.total++;
            if (isCovered) acc.covered++;
            if (isPending) acc.catchingUp++;
        }
    };

    for (const p of input.allPaths) {
        const isCovered = coveredSet.has(p);
        const isExcluded = excludedSet.has(p);
        const isPending = !isExcluded && pendingSet.has(p);
        bump(rootAcc, isCovered, isExcluded, isPending);
        let node = rootAcc;
        for (const key of pathFolderChain(p)) {
            const seg = segmentOf(key);
            let child = node.children.get(seg);
            if (!child) { child = makeAcc(key); node.children.set(seg, child); }
            node = child;
            bump(node, isCovered, isExcluded, isPending);
        }
    }

    const finalize = (acc: Acc, depth: number): FolderCoverageNode => {
        const kids = [...acc.children.values()]
            .sort((a, b) => b.total - a.total || segmentOf(a.path).localeCompare(segmentOf(b.path)))
            .map(c => finalize(c, depth + 1));
        const remaining = Math.max(0, acc.total - acc.covered);
        const ownTotal = acc.total - kids.reduce((s, c) => s + c.total, 0);
        const ownCovered = acc.covered - kids.reduce((s, c) => s + c.covered, 0);
        const ownExcluded = acc.excluded - kids.reduce((s, c) => s + c.excluded, 0);
        const ownCatchingUp = acc.catchingUp - kids.reduce((s, c) => s + c.catchingUp, 0);
        const ownRemaining = Math.max(0, ownTotal - ownCovered);
        const percent = coverageDisplayPercent(acc.covered, acc.total, acc.catchingUp);
        const node: FolderCoverageNode = {
            path: acc.path,
            name: displayFolderName(acc.path),
            total: acc.total,
            covered: acc.covered,
            remaining,
            excluded: acc.excluded,
            catchingUp: acc.catchingUp,
            ownTotal,
            ownCovered,
            ownRemaining,
            ownExcluded,
            ownCatchingUp,
            percent,
            status: folderStatus(acc.total, acc.covered, acc.excluded, acc.catchingUp),
            children: kids,
        };
        return node;
    };

    const root = finalize(rootAcc, 0);
    return { root, overall: root };
}

export function flattenCoverageTree(node: FolderCoverageNode, depth = 0): FlatFolderCoverageItem[] {
    const list: FlatFolderCoverageItem[] = [];
    if (node.path !== '') {
        list.push({
            path: node.path,
            name: node.name,
            total: node.total,
            covered: node.covered,
            remaining: node.remaining,
            excluded: node.excluded,
            catchingUp: node.catchingUp,
            percent: node.percent,
            status: node.status,
            depth,
        });
    }
    for (const child of node.children) {
        list.push(...flattenCoverageTree(child, node.path === '' ? 0 : depth + 1));
    }
    return list;
}

export function createLiveCoverageSnapshot(input: {
    summary: FolderCoverageSummary;
    health: IndexStatusHealth;
    job: IndexStatusJob | null;
}): LiveCoverageSnapshot {
    const { summary, health, job } = input;
    const { total, covered, remaining, excluded, percent } = summary.overall;
    return {
        health,
        job,
        overall: {
            total,
            covered,
            remaining,
            excluded,
            percent,
        },
        folders: flattenCoverageTree(summary.root),
        summary,
    };
}

// ── Exclusion-list change detection ─────────────────────────────────────────────
// The plugin polls the set of live indexable paths that Obsidian's "Excluded files"
// (via metadataCache.isUserIgnored, honoring the "Honor excluded folders" toggle)
// and Seek's customExcludedFolders currently exclude, and diffs it against the
// previous snapshot. Diffing the actual matched PATHS — not the raw filter strings —
// is what makes it robust: it fires exactly when a file's index membership changes,
// and stays silent when the filter list is edited in a way that matches the same
// files (whitespace, order, or a regex that resolves identically).

export interface ExclusionDiff {
    newlyIncludedPaths: string[]; // were excluded, now indexable → backfill
    newlyExcludedPaths: string[]; // were indexable, now excluded → soft-delete
    newlyIncludedFolders: string[]; // distinct top-level folders among newlyIncluded
    newlyExcludedFolders: string[]; // distinct top-level folders among newlyExcluded
}

function distinctFolders(paths: string[]): string[] {
    const set = new Set<string>();
    for (const p of paths) set.add(folderOf(p));
    return [...set].sort();
}

// Set difference of two snapshots of the live *excluded* path set. `prev` is what
// was out of the index on the last poll, `next` what is out of it now. A path in
// `prev` but not `next` came back into the index (a filter was removed / the honor
// toggle flipped off) and needs backfilling; a path in `next` but not `prev` was
// newly hidden and its chunks need soft-deleting. The affected top-level folders are
// surfaced so the UI can name them ("detected a change in folder: Archive").
export function diffExcludedPaths(prev: readonly string[], next: readonly string[]): ExclusionDiff {
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    const newlyIncludedPaths = [...prevSet].filter(p => !nextSet.has(p)).sort();
    const newlyExcludedPaths = [...nextSet].filter(p => !prevSet.has(p)).sort();
    return {
        newlyIncludedPaths,
        newlyExcludedPaths,
        newlyIncludedFolders: distinctFolders(newlyIncludedPaths),
        newlyExcludedFolders: distinctFolders(newlyExcludedPaths),
    };
}

export function exclusionDiffIsEmpty(diff: ExclusionDiff): boolean {
    return diff.newlyIncludedPaths.length === 0 && diff.newlyExcludedPaths.length === 0;
}

export function emptyExclusionDiff(): ExclusionDiff {
    return {
        newlyIncludedPaths: [],
        newlyExcludedPaths: [],
        newlyIncludedFolders: [],
        newlyExcludedFolders: [],
    };
}
