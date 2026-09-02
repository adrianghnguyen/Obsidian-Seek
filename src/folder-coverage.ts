// Per-folder embedder-pipeline coverage for the Seek settings surface, plus the
// user-ignore-filter diff that detects when Obsidian's "Excluded files" list
// changed so a previously-excluded folder can be backfilled.
//
// Pure and dependency-injected (no Obsidian / model coupling) so the math and the
// change detection are unit-testable. The plugin supplies the three live path sets
// (all indexable-extension files, the subset already through the embedder, the
// subset currently excluded by Obsidian's ignore rules) and the two exclusion
// snapshots; everything here is set/grouping arithmetic.
//
// "Coverage" = live indexable files that have a FileRecord, i.e. they were committed
// through the embedder at some point. A FileRecord only exists once a file is
// embedded, so a file with no record is, by construction, not yet covered.
//
// The coverage is a FULL directory hierarchy: every folder node reports its own
// subtree, so a nested folder A/B shows "covered / relevant files within A/B",
// not the whole vault. A file is "relevant" to a folder unless it is currently
// excluded by Obsidian's ignore rules; percent = covered / relevant.

// The single-segment name of a folder key ('A/B' → 'B'); '' → ''.
export function segmentOf(folderKey: string): string {
    const i = folderKey.lastIndexOf('/');
    return i < 0 ? folderKey : folderKey.slice(i + 1);
}

// Human label for a folder node; the vault root reads better than a blank cell.
export function displayFolderName(folder: string): string {
    return folder === '' ? 'vault root' : segmentOf(folder);
}

// One directory in the hierarchy. `total` is the count of RELEVANT (non-excluded)
// files in this folder's own subtree (recursively) — the denominator the user cares
// about. `covered` is the subset of those that have a FileRecord. `excluded` is the
// count of files in the subtree currently hidden by Obsidian's ignore rules (they
// are NOT part of `total`). `percent` = covered / total (0% when total is 0, e.g. a
// fully-excluded folder).
export interface FolderCoverageNode {
    path: string;          // folder key ('' = vault root, 'A', 'A/B', …)
    name: string;          // single-segment display name
    total: number;         // relevant (non-excluded) files in the subtree
    covered: number;       // relevant files in the subtree with a FileRecord
    excluded: number;      // files in the subtree hidden by ignore rules
    percent: number;       // covered / total, 0-100
    children: FolderCoverageNode[]; // nested subfolders (recursive hierarchy)
}

export interface FolderCoverageSummary {
    root: FolderCoverageNode;   // the vault node: the whole hierarchy
    overall: FolderCoverageNode; // alias for root (the grand total)
}

export interface FolderCoverageInput {
    allPaths: string[];      // every indexable-extension file, before exclusion
    coveredPaths: string[];  // subset of allPaths that has a FileRecord
    excludedPaths: string[]; // subset of allPaths currently excluded by ignore rules
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

function pct(covered: number, denom: number): number {
    if (denom <= 0) return 0;
    return Math.round((covered / denom) * 100);
}

// A well-formed empty summary, used by callers (e.g. the plugin) before the
// orchestrator exists or on a read failure.
export function emptyFolderCoverage(): FolderCoverageSummary {
    const root: FolderCoverageNode = {
        path: '',
        name: 'vault root',
        total: 0,
        covered: 0,
        excluded: 0,
        percent: 0,
        children: [],
    };
    return { root, overall: root };
}

export function computeFolderCoverage(input: FolderCoverageInput): FolderCoverageSummary {
    const coveredSet = new Set(input.coveredPaths);
    const excludedSet = new Set(input.excludedPaths);

    // Mutable accumulator per folder node; children keyed by single segment name.
    interface Acc {
        path: string;
        total: number;
        covered: number;
        excluded: number;
        children: Map<string, Acc>;
    }
    const makeAcc = (path: string): Acc => ({ path, total: 0, covered: 0, excluded: 0, children: new Map() });
    const rootAcc = makeAcc('');

    const bump = (acc: Acc, isCovered: boolean, isExcluded: boolean): void => {
        if (isExcluded) acc.excluded++;
        else { acc.total++; if (isCovered) acc.covered++; }
    };

    for (const p of input.allPaths) {
        const isCovered = coveredSet.has(p);
        const isExcluded = excludedSet.has(p);
        bump(rootAcc, isCovered, isExcluded);
        let node = rootAcc;
        for (const key of pathFolderChain(p)) {
            const seg = segmentOf(key);
            let child = node.children.get(seg);
            if (!child) { child = makeAcc(key); node.children.set(seg, child); }
            node = child;
            bump(node, isCovered, isExcluded);
        }
    }

    const finalize = (acc: Acc, depth: number): FolderCoverageNode => {
        const kids = [...acc.children.values()]
            .sort((a, b) => b.total - a.total || segmentOf(a.path).localeCompare(segmentOf(b.path)));
        const node: FolderCoverageNode = {
            path: acc.path,
            name: displayFolderName(acc.path),
            total: acc.total,
            covered: acc.covered,
            excluded: acc.excluded,
            percent: pct(acc.covered, acc.total),
            children: kids.map(c => finalize(c, depth + 1)),
        };
        return node;
    };

    const root = finalize(rootAcc, 0);
    return { root, overall: root };
}

// ── Exclusion-list change detection ─────────────────────────────────────────────
// The plugin polls the set of live indexable paths that Obsidian's "Excluded files"
// (via metadataCache.isUserIgnored, honoring the "Honor excluded folders" toggle)
// currently excludes, and diffs it against the previous snapshot. Diffing the actual
// matched PATHS — not the raw filter strings — is what makes it robust: it fires
// exactly when a file's index membership changes, and stays silent when the filter
// list is edited in a way that matches the same files (whitespace, order, or a regex
// that resolves identically).

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
