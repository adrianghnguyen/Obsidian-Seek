// Vault-path exclusion helpers: the single index-membership predicate and the
// path-normalization helpers it builds on. Pure (no orchestrator state) so the
// settings tab, suggest, and the orchestrator share one implementation.
// Extracted from search.ts; re-exported there for existing callers.

import type { App } from 'obsidian';
import type { SeekSettings } from '../types/types';

// Vault-root files that are machine-generated and would otherwise pollute
// the index with constant-touch recency. The mtime on these files moves
// every time the plugin writes, which means recency=~1.0 → +0.25 lift on
// every fused score, drowning out actual content matches.
//
// This is a v0 hardcoded list rather than a settings string because we
// have zero admin console in v0. Anything that turns into a recurring
// "where did my note go" complaint should be added here.
const EXCLUDED_PATHS = new Set([
    'seek-report.md',
    'spike-report.md',
]);
const EXCLUDED_PREFIXES = [
    // Future-proofing: if someone runs multiple spike variants, the
    // generated reports tend to share these stems.
    'spike-init',
    'seek-init',
    '.seek-artifacts/',
];

// Honor Obsidian's user-configured "Excluded files" (Settings → Files & Links).
// A user who hid a folder from Obsidian's own search/link suggestions expects
// Seek to hide it too — but vault.getMarkdownFiles() ignores that list, so we
// must filter it ourselves. The API isn't in the public typings, so reach the
// runtime defensively: prefer metadataCache.isUserIgnored() (Obsidian's own
// matcher — it handles both the folder-prefix and /regex/ filter forms and
// stays drift-free across versions), falling back to matching the raw
// userIgnoreFilters list on builds that predate that method.
function isUserIgnored(app: App, path: string): boolean {
    const mc = app.metadataCache as unknown as { isUserIgnored?: (p: string) => boolean };
    if (typeof mc.isUserIgnored === 'function') return mc.isUserIgnored(path);
    const getConfig = (app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig;
    const filters = (typeof getConfig === 'function'
        ? getConfig.call(app.vault, 'userIgnoreFilters')
        : null) as string[] | null;
    if (!Array.isArray(filters)) return false;
    return filters.some(filter => {
        // /pattern/ → regex (Obsidian's own delimiter convention).
        if (filter.length > 1 && filter.startsWith('/') && filter.endsWith('/')) {
            try { return new RegExp(filter.slice(1, -1)).test(path); } catch { return false; }
        }
        // Otherwise a folder/path prefix: match the file itself or anything under it.
        return path === filter || path.startsWith(filter.endsWith('/') ? filter : filter + '/');
    });
}

/** Normalize a vault-relative folder path for customExcludedFolders storage/matching. */
export function normalizeExcludedFolderPath(path: string): string {
    return path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
}

/** True when filePath is the folder itself or a descendant (Obsidian prefix convention). */
export function isUnderExcludedFolder(folder: string, filePath: string): boolean {
    const f = normalizeExcludedFolderPath(folder);
    if (!f) return false;
    return filePath === f || filePath.startsWith(f + '/');
}

/** True when path is under any entry in settings.customExcludedFolders. */
export function isSeekExcludedPath(settings: SeekSettings, path: string): boolean {
    const folders = settings.customExcludedFolders;
    if (!folders || folders.length === 0) return false;
    return folders.some(f => isUnderExcludedFolder(f, path));
}

// The single index-membership predicate, exported so any code that offers a
// value SOURCED from the note (a filter pill, an autocomplete suggestion, …)
// can check whether the note it came from actually reaches the index — a
// pill built from Obsidian's raw metadataCache (which doesn't honor "Excluded
// files") can otherwise promise a result that the matcher will never return.
// SearchOrchestrator.shouldIndex delegates here so there is exactly one
// implementation to keep in sync (see the audit note in suggest.ts).
export function shouldIndexPath(app: App, settings: SeekSettings, path: string): boolean {
    if (EXCLUDED_PATHS.has(path)) return false;
    if (EXCLUDED_PREFIXES.some(p => path.startsWith(p))) return false;
    if (isSeekExcludedPath(settings, path)) return false;
    if (settings.honorIgnoredFolders && isUserIgnored(app, path)) return false;
    return true;
}
