// Pure helpers for rendering frontmatter aliases on search result rows.

export interface AliasDisplaySlice {
    visible: string[];
    hiddenCount: number;
    matchedAlias: string | null;
}

export function dedupeAliasesAgainstBasename(aliases: string[], basename: string): string[] {
    const baseLower = basename.trim().toLowerCase();
    if (!baseLower) return [...aliases];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of aliases) {
        const a = String(raw).trim();
        if (!a) continue;
        const key = a.toLowerCase();
        if (key === baseLower || seen.has(key)) continue;
        seen.add(key);
        out.push(a);
    }
    return out;
}

export function sliceResultAliases(
    aliases: string[],
    basename: string,
    limit: number,
    expanded: boolean,
    matchedAlias: string | null,
): AliasDisplaySlice {
    const filtered = dedupeAliasesAgainstBasename(aliases, basename);
    const match = matchedAlias?.trim() || null;

    if (filtered.length === 0) {
        return { visible: [], hiddenCount: 0, matchedAlias: match };
    }

    if (limit <= 0 || expanded || filtered.length <= limit) {
        return { visible: filtered, hiddenCount: 0, matchedAlias: match };
    }

    const visible = filtered.slice(0, limit);
    if (match && !visible.includes(match)) {
        // Promote matched alias: drop the last non-matched visible entry.
        let dropIdx = visible.length - 1;
        while (dropIdx >= 0 && visible[dropIdx] === match) dropIdx--;
        if (dropIdx >= 0) visible[dropIdx] = match;
        else visible.push(match);
    }

    const hiddenCount = filtered.length - visible.length;
    return { visible, hiddenCount, matchedAlias: match };
}
