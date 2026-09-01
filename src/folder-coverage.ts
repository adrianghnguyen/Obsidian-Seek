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

// Top-level folder key for a vault path. '' (empty) means the file lives directly
// under the vault root.
export function folderOf(path: string): string {
    const i = path.indexOf('/');
    return i < 0 ? '' : path.slice(0, i);
}

// Human label for a folder key; the root reads better than a blank cell.
export function displayFolderName(folder: string): string {
    return folder === '' ? 'vault root' : folder;
}

export interface FolderCoverage {
    folder: string;         // top-level folder key ('' = vault root)
    total: number;          // every indexable-extension file in the folder
    covered: number;        // files with a FileRecord (ran through the embedder)
    excluded: number;       // files currently excluded by Obsidian's ignore rules
    // covered / (total - excluded) — % of the files this folder is SUPPOSED to have
    // covered. Excluded files don't count against coverage. Falls back to 0% when
    // the folder is fully excluded (denominator 0).
    percent: number;
}

export interface FolderCoverageSummary {
    rows: FolderCoverage[]; // one per top-level folder, sorted by total desc then name
    overall: FolderCoverage;
}

export interface FolderCoverageInput {
    allPaths: string[];      // every indexable-extension file, before exclusion
    coveredPaths: string[];  // subset of allPaths that has a FileRecord
    excludedPaths: string[]; // subset of allPaths currently excluded by ignore rules
}

function pct(covered: number, denom: number): number {
    if (denom <= 0) return 0;
    return Math.round((covered / denom) * 100);
}

export function computeFolderCoverage(input: FolderCoverageInput): FolderCoverageSummary {
    const covered = new Set(input.coveredPaths);
    const excluded = new Set(input.excludedPaths);

    const total = new Map<string, number>();
    const cov = new Map<string, number>();
    const exc = new Map<string, number>();
    let allTotal = 0, allCov = 0, allExc = 0;

    for (const p of input.allPaths) {
        const f = folderOf(p);
        total.set(f, (total.get(f) ?? 0) + 1);
        allTotal++;
        if (covered.has(p)) { cov.set(f, (cov.get(f) ?? 0) + 1); allCov++; }
        if (excluded.has(p)) { exc.set(f, (exc.get(f) ?? 0) + 1); allExc++; }
    }

    const rows: FolderCoverage[] = [...total.keys()].map((f) => {
        const t = total.get(f) ?? 0;
        const c = cov.get(f) ?? 0;
        const e = exc.get(f) ?? 0;
        // If the whole folder is excluded there is nothing that SHOULD be covered,
        // so report 0% (the UI tags the row "excluded"). Otherwise exclude the
        // excluded files from the denominator so a nested ignore doesn't look like
        // a coverage hole.
        const percent = t - e === 0 ? 0 : pct(c, t - e);
        return { folder: f, total: t, covered: c, excluded: e, percent };
    });

    rows.sort((a, b) => b.total - a.total || a.folder.localeCompare(b.folder));

    const overallDenom = allTotal - allExc;
    const overall: FolderCoverage = {
        folder: '',
        total: allTotal,
        covered: allCov,
        excluded: allExc,
        percent: overallDenom <= 0 ? 0 : pct(allCov, overallDenom),
    };

    return { rows, overall };
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
