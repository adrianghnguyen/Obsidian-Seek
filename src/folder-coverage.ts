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
// `covered / total` fraction are the same counts at every node — "in the index",
// not "this pass is idle". 100.00% is allowed while notes are refreshing.
//
//   overall.covered === sum of each top-level folder's covered + vault-root files
//   overall.total   === sum of each top-level folder's total   + vault-root files
//
// Exclusive file buckets (one per relevant note; catchingUp = refreshing + indexing):
//   healthy     — covered, not pending                         → solid green cell
//   refreshing  — covered and pending (edits / re-embed)       → hatched green cell
//   indexing    — not covered, pending or a full job is active → yellow cell
//   uncovered   — not covered, not queued, no full job         → grey cell
//
// State machine (folderStatus):
//   excluded    — no relevant files, ignore-rules hide the subtree
//   complete    — remaining=0 and catchingUp=0
//   in-progress — catchingUp>0, or some-but-not-all files indexed
//   pending     — relevant files exist, none indexed, none in-flight

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
// directly in this folder (not in a child). Percent is covered/total to 2 decimals
// ("in the index"); 100 is allowed while refreshing.
export interface FolderCoverageNode {
    path: string;          // folder key ('' = vault root, 'A', 'A/B', …)
    name: string;          // single-segment display name
    total: number;         // relevant (non-excluded) files in the subtree
    covered: number;       // relevant files in the subtree with a FileRecord
    remaining: number;     // total - covered (files needing processing)
    excluded: number;      // files in the subtree hidden by ignore rules
    /** refreshing + indexing — any in-flight work in this subtree. */
    catchingUp: number;
    healthy: number;       // covered, not pending
    refreshing: number;    // covered and pending
    indexing: number;      // not covered, pending or full job
    uncovered: number;     // not covered, idle
    ownTotal: number;     // relevant files sitting directly in this folder
    ownCovered: number;
    ownRemaining: number;
    ownExcluded: number;
    ownCatchingUp: number;
    ownHealthy: number;
    ownRefreshing: number;
    ownIndexing: number;
    ownUncovered: number;
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

export interface FolderCoveragePathSets {
    allPaths: string[];
    coveredPaths: string[];
    excludedPaths: string[];
}

export interface FolderCoverageInput extends FolderCoveragePathSets {
    /** Paths actively queued or in the current computeDelta dirty set. */
    pendingPaths?: readonly string[];
    /** Full reindex has no pending list — treat uncovered notes as indexing. */
    fullJobActive?: boolean;
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
    refreshing?: number;
    indexing?: number;
    uncovered?: number;
    percent: number;
}

/** True when this node is idle-complete (in the index and nothing in flight). */
export function coverageIsSettled(node: CoverageDisplayNode): boolean {
    return node.total > 0 && node.remaining === 0 && (node.catchingUp ?? 0) === 0 && node.covered >= node.total;
}

/** Percent tone: green when in-index is complete (including refresh-only); yellow while notes are still missing. */
export function coverageBarTone(node: CoverageDisplayNode): CoverageBarTone {
    if (node.total <= 0) return 'low';
    if (node.remaining > 0) return 'warn';
    if (coverageIsSettled(node) || node.covered >= node.total) return 'good';
    return 'low';
}

/**
 * Display percent to 2 decimal places. 100.00 when every relevant file is in
 * the index, even if some are refreshing this pass. Incomplete work never
 * rounds up to 100.00 (3024/3037 → 99.57).
 */
export function coverageDisplayPercent(covered: number, total: number, _catchingUp = 0): number {
    if (total <= 0) return 0;
    if (covered >= total) return 100;
    if (covered <= 0) return 0;
    const raw = (covered / total) * 100;
    const rounded = Math.round(raw * 100) / 100;
    return Math.min(99.99, rounded);
}

/** CSS bar width 0–100; never full while files remain uncovered. */
export function coverageBarWidth(node: CoverageDisplayNode): number {
    if (node.total <= 0) return 0;
    if (node.covered >= node.total) return 100;
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
    const fraction = `${node.covered.toLocaleString()} of ${node.total.toLocaleString()} notes in the index`;
    const refreshing = node.refreshing ?? 0;
    const indexing = node.indexing ?? 0;
    const bits: string[] = [];
    if (node.remaining > 0) bits.push(`${node.remaining.toLocaleString()} remaining`);
    if (refreshing > 0) bits.push(`${refreshing.toLocaleString()} updating this pass`);
    else if ((node.catchingUp ?? 0) > 0 && node.remaining === 0) {
        bits.push(`${node.catchingUp!.toLocaleString()} updating this pass`);
    }
    if (indexing > 0 && node.remaining === 0) bits.push(`${indexing.toLocaleString()} adding`);
    return bits.length > 0 ? `${fraction} · ${bits.join(' · ')}.` : `${fraction}.`;
}

export type CoverageCellKind = 'healthy' | 'refreshing' | 'indexing' | 'uncovered';

export interface CoverageStateCounts {
    healthy: number;
    refreshing: number;
    indexing: number;
    uncovered: number;
}

export const COVERAGE_CELL_COUNT = 10;
export const REMAINING_FILES_LIST_CAP = 50;

const CELL_ORDER: CoverageCellKind[] = ['healthy', 'refreshing', 'indexing', 'uncovered'];

export function coverageStateCounts(node: Pick<FolderCoverageNode, 'healthy' | 'refreshing' | 'indexing' | 'uncovered'>): CoverageStateCounts {
    return {
        healthy: node.healthy,
        refreshing: node.refreshing,
        indexing: node.indexing,
        uncovered: node.uncovered,
    };
}

/**
 * 10 cells, largest remainder, left-to-right healthy → refreshing → indexing → uncovered.
 * Refreshing and indexing always get at least one cell when their count is > 0.
 */
export function allocateCoverageCells(counts: CoverageStateCounts): CoverageCellKind[] | null {
    const total = counts.healthy + counts.refreshing + counts.indexing + counts.uncovered;
    if (total <= 0) return null;

    const cells: Record<CoverageCellKind, number> = {
        healthy: 0, refreshing: 0, indexing: 0, uncovered: 0,
    };
    const remainders: { kind: CoverageCellKind; frac: number }[] = [];
    let assigned = 0;
    for (const kind of CELL_ORDER) {
        const share = (counts[kind] / total) * COVERAGE_CELL_COUNT;
        const floor = Math.floor(share);
        cells[kind] = floor;
        assigned += floor;
        remainders.push({ kind, frac: share - floor });
    }
    remainders.sort((a, b) => b.frac - a.frac || CELL_ORDER.indexOf(a.kind) - CELL_ORDER.indexOf(b.kind));
    let leftover = COVERAGE_CELL_COUNT - assigned;
    for (const r of remainders) {
        if (leftover <= 0) break;
        cells[r.kind]++;
        leftover--;
    }

    const stealFor = (kind: CoverageCellKind) => {
        if (counts[kind] <= 0 || cells[kind] > 0) return;
        const donors: CoverageCellKind[] = ['uncovered', 'healthy', 'refreshing', 'indexing'];
        for (const d of donors) {
            if (d === kind) continue;
            if ((d === 'refreshing' || d === 'indexing') && counts[d] > 0 && cells[d] <= 1) continue;
            if (cells[d] > 0) {
                cells[d]--;
                cells[kind]++;
                return;
            }
        }
    };
    stealFor('refreshing');
    stealFor('indexing');

    const out: CoverageCellKind[] = [];
    for (const kind of CELL_ORDER) {
        for (let i = 0; i < cells[kind]; i++) out.push(kind);
    }
    while (out.length < COVERAGE_CELL_COUNT) out.push('uncovered');
    return out.slice(0, COVERAGE_CELL_COUNT);
}

export function coverageCellClasses(counts: CoverageStateCounts): string[] {
    const cells = allocateCoverageCells(counts);
    if (!cells) return [];
    return cells.map(k => `is-${k}`);
}

export function remainingFileDisplay(path: string): string {
    const i = path.lastIndexOf('/');
    if (i < 0) return path;
    return `${path.slice(i + 1)} · ${path.slice(0, i)}`;
}

export function remainingFilesPreview(
    paths: readonly string[],
    cap = REMAINING_FILES_LIST_CAP,
): { shown: string[]; more: number } {
    const shown = paths.slice(0, cap).map(remainingFileDisplay);
    return { shown, more: Math.max(0, paths.length - cap) };
}

export function remainingFilesFoldLabel(count: number): string {
    if (count <= 0) return '';
    return `${count.toLocaleString()} note${count === 1 ? '' : 's'} updating this pass`;
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
    const childHealthy = node.children.reduce((s, c) => s + c.healthy, 0);
    const childRefreshing = node.children.reduce((s, c) => s + c.refreshing, 0);
    const childIndexing = node.children.reduce((s, c) => s + c.indexing, 0);
    const childUncovered = node.children.reduce((s, c) => s + c.uncovered, 0);

    if (node.remaining !== node.total - node.covered) {
        return `${node.path || 'vault'}: remaining ${node.remaining} !== total-covered ${node.total - node.covered}`;
    }
    if (node.ownRemaining !== node.ownTotal - node.ownCovered) {
        return `${node.path || 'vault'}: ownRemaining mismatch`;
    }
    if (node.healthy + node.refreshing + node.indexing + node.uncovered !== node.total) {
        return `${node.path || 'vault'}: exclusive buckets do not partition total`;
    }
    if (node.catchingUp !== node.refreshing + node.indexing) {
        return `${node.path || 'vault'}: catchingUp !== refreshing + indexing`;
    }
    if (node.ownHealthy + node.ownRefreshing + node.ownIndexing + node.ownUncovered !== node.ownTotal) {
        return `${node.path || 'vault'}: own exclusive buckets do not partition ownTotal`;
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
    if (node.healthy !== node.ownHealthy + childHealthy) {
        return `${node.path || 'vault'}: healthy rollup mismatch`;
    }
    if (node.refreshing !== node.ownRefreshing + childRefreshing) {
        return `${node.path || 'vault'}: refreshing rollup mismatch`;
    }
    if (node.indexing !== node.ownIndexing + childIndexing) {
        return `${node.path || 'vault'}: indexing rollup mismatch`;
    }
    if (node.uncovered !== node.ownUncovered + childUncovered) {
        return `${node.path || 'vault'}: uncovered rollup mismatch`;
    }

    const expectedPct = coverageDisplayPercent(node.covered, node.total, node.catchingUp);
    if (node.percent !== expectedPct) {
        return `${node.path || 'vault'}: percent ${node.percent} !== ${expectedPct}`;
    }
    if (coverageIsSettled(node) && node.percent !== 100) {
        return `${node.path || 'vault'}: settled but percent is ${node.percent}`;
    }
    if (node.remaining > 0 && node.percent >= 100 && node.total > 0) {
        return `${node.path || 'vault'}: ${node.percent}% while remaining=${node.remaining}`;
    }
    if (node.percent >= 100 && node.children.some(c => c.remaining > 0)) {
        return `${node.path || 'vault'}: 100% while a child still has remaining`;
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
        healthy: parent.ownHealthy,
        refreshing: parent.ownRefreshing,
        indexing: parent.ownIndexing,
        uncovered: parent.ownUncovered,
        ownTotal: parent.ownTotal,
        ownCovered: parent.ownCovered,
        ownRemaining: remaining,
        ownExcluded: parent.ownExcluded,
        ownCatchingUp: parent.ownCatchingUp,
        ownHealthy: parent.ownHealthy,
        ownRefreshing: parent.ownRefreshing,
        ownIndexing: parent.ownIndexing,
        ownUncovered: parent.ownUncovered,
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

function aligningDetail(job: IndexStatusJob | null): string {
    if (job && job.total > 0) {
        return `Reindexing ${job.done.toLocaleString()} of ${job.total.toLocaleString()} notes so the index matches your excluded folders.`;
    }
    return 'Reindexing notes that moved in or out of your excluded folders.';
}

function addingDetail(remainingCount: number): string {
    if (remainingCount === 1) return '1 note is not searchable yet.';
    if (remainingCount > 0) {
        return `${remainingCount.toLocaleString()} notes are not searchable yet.`;
    }
    return 'Seek is adding notes to the search index.';
}

function updatingDetail(updatingCount: number): string {
    if (updatingCount === 1) {
        return '1 note in this pass · searchable while it updates.';
    }
    if (updatingCount > 0) {
        return `${updatingCount.toLocaleString()} notes in this pass · searchable while they update.`;
    }
    return 'Notes already in the index are updating.';
}

function isIndexingActive(health: IndexStatusHealth, job: IndexStatusJob | null): boolean {
    if (health === 'indexing') return true;
    return job != null && job.total > 0 && job.done < job.total;
}

function treeBanner(title: string, detail: string, tone: CoveragePlaceholderTone = 'pending'): CoveragePanelMessage {
    return { title, detail, tone };
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
    const { total, covered, excluded, remaining, refreshing } = summary.overall;
    const hasTree = total > 0;
    const updatingCount = Math.max(pendingCount ?? 0, refreshing);

    const withTree = (statusLine?: CoveragePanelMessage): CoveragePanelView => ({
        showTree: true,
        summary,
        statusLine,
    });
    const placeholderOnly = (placeholder: CoveragePanelMessage): CoveragePanelView => ({
        showTree: false,
        summary,
        placeholder,
    });

    if (loadFailed && !hasTree) {
        return placeholderOnly({
            tone: 'bad',
            title: "Couldn't read coverage",
            detail: 'Try reloading Seek or reopening Settings.',
        });
    }
    if (loadFailed && hasTree) {
        return withTree(treeBanner(
            "Couldn't read coverage",
            'Showing the last snapshot. Try reloading Seek or reopening Settings.',
            'bad',
        ));
    }

    if (!orchestratorReady && !hasTree) {
        return placeholderOnly({
            tone: 'pending',
            title: 'Still starting up',
            detail: 'Seek is loading the search index. Folder coverage will appear once your vault is ready.',
        });
    }
    if (!orchestratorReady && hasTree) {
        return withTree(treeBanner(
            'Still starting up',
            'Seek is loading the search index. Folder coverage updates as notes are indexed.',
        ));
    }

    if (health === 'error' && !hasTree) {
        return placeholderOnly({
            tone: 'bad',
            title: 'Index error',
            detail: 'Fix the index (try a full reindex) to see embedder coverage by folder.',
        });
    }
    if (health === 'error' && hasTree) {
        return withTree(treeBanner(
            'Index error',
            'Fix the index (try a full reindex). Folder coverage is the last snapshot.',
            'bad',
        ));
    }

    if (health === 'locked' && !hasTree) {
        return placeholderOnly({
            tone: 'bad',
            title: 'Index locked',
            detail: 'Close other Obsidian windows using this vault, then reopen Settings.',
        });
    }
    if (health === 'locked' && hasTree) {
        return withTree(treeBanner(
            'Index locked',
            'Close other Obsidian windows using this vault. Folder coverage is the last snapshot.',
            'bad',
        ));
    }

    if (hasTree) {
        if (health === 'starting') {
            return withTree(treeBanner(
                'Still starting up',
                job && job.total > 0
                    ? `Indexed ${job.done.toLocaleString()} of ${job.total.toLocaleString()} notes so far. Folder coverage is updating live.`
                    : 'Seek is loading the search index. Folder coverage updates as notes are indexed.',
            ));
        }
        if (health === 'restoring') {
            return withTree(treeBanner(
                'Restoring index…',
                'Seek is restoring your index. Folder coverage is updating live as notes are restored.',
            ));
        }
        if (aligningExclusions) {
            return withTree(treeBanner('Aligning with exclusions', aligningDetail(job)));
        }
        if ((isIndexingActive(health, job) || (pendingCount ?? 0) > 0 || remaining > 0) && covered < total) {
            return withTree(treeBanner('Adding notes to the index', addingDetail(remaining)));
        }
        if ((isIndexingActive(health, job) || (pendingCount ?? 0) > 0 || refreshing > 0) && covered >= total) {
            return withTree(treeBanner('Updating notes already in the index', updatingDetail(updatingCount)));
        }
        return withTree();
    }

    if (excluded > 0) {
        return placeholderOnly({
            tone: 'muted',
            title: 'Nothing to cover',
            detail: `Every indexable note is excluded (${excluded.toLocaleString()} excluded). Adjust Obsidian's Excluded files, Seek's additional excluded folders, or turn off Honor excluded folders to include them.`,
        });
    }

    if (health === 'starting' || health === 'restoring') {
        return placeholderOnly({
            tone: 'pending',
            title: health === 'restoring' ? 'Restoring index…' : 'Still starting up',
            detail: health === 'restoring'
                ? 'Seek is restoring your index. Folder coverage will appear once the vault layout is ready.'
                : 'Seek is loading the search index. Folder coverage will appear once your vault is ready.',
        });
    }

    if (aligningExclusions) {
        return placeholderOnly({
            tone: 'pending',
            title: 'Aligning with exclusions',
            detail: aligningDetail(job),
        });
    }

    if (isIndexingActive(health, job) || health === 'none') {
        return placeholderOnly({
            tone: 'pending',
            title: 'Still indexing',
            detail: job && job.total > 0
                ? `Indexed ${job.done.toLocaleString()} of ${job.total.toLocaleString()} this pass. Folder coverage will appear once notes are indexed.`
                : 'Seek is still scanning and embedding your vault. Folder coverage will appear once notes are indexed.',
        });
    }

    return placeholderOnly({
        tone: 'muted',
        title: 'No indexable notes',
        detail: 'This vault has no markdown notes (or other indexable files) for Seek to cover.',
    });
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
        healthy: 0,
        refreshing: 0,
        indexing: 0,
        uncovered: 0,
        ownTotal: 0,
        ownCovered: 0,
        ownRemaining: 0,
        ownExcluded: 0,
        ownCatchingUp: 0,
        ownHealthy: 0,
        ownRefreshing: 0,
        ownIndexing: 0,
        ownUncovered: 0,
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
    const fullJobActive = !!input.fullJobActive;

    interface Acc {
        path: string;
        total: number;
        covered: number;
        excluded: number;
        catchingUp: number;
        healthy: number;
        refreshing: number;
        indexing: number;
        uncovered: number;
        children: Map<string, Acc>;
    }
    const makeAcc = (path: string): Acc => ({
        path, total: 0, covered: 0, excluded: 0, catchingUp: 0,
        healthy: 0, refreshing: 0, indexing: 0, uncovered: 0, children: new Map(),
    });
    const rootAcc = makeAcc('');

    const bump = (acc: Acc, isCovered: boolean, isExcluded: boolean, isPending: boolean): void => {
        if (isExcluded) {
            acc.excluded++;
            return;
        }
        acc.total++;
        if (isCovered) acc.covered++;
        if (isCovered && !isPending) acc.healthy++;
        else if (isCovered && isPending) acc.refreshing++;
        else if (!isCovered && (isPending || fullJobActive)) acc.indexing++;
        else acc.uncovered++;
        acc.catchingUp = acc.refreshing + acc.indexing;
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
        const ownHealthy = acc.healthy - kids.reduce((s, c) => s + c.healthy, 0);
        const ownRefreshing = acc.refreshing - kids.reduce((s, c) => s + c.refreshing, 0);
        const ownIndexing = acc.indexing - kids.reduce((s, c) => s + c.indexing, 0);
        const ownUncovered = acc.uncovered - kids.reduce((s, c) => s + c.uncovered, 0);
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
            healthy: acc.healthy,
            refreshing: acc.refreshing,
            indexing: acc.indexing,
            uncovered: acc.uncovered,
            ownTotal,
            ownCovered,
            ownRemaining,
            ownExcluded,
            ownCatchingUp,
            ownHealthy,
            ownRefreshing,
            ownIndexing,
            ownUncovered,
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
