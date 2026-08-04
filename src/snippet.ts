// Pure snippet helpers, extracted from search-modal.ts / search.ts so they can
// be unit-tested without Obsidian (same reasoning as ./highlight). No runtime
// imports — string in, string out.

import type { SnippetPreview } from './types';
import { passageWindow, type PassageTerm } from './passage';

/** Lines + character window for each Display → snippet preview preset. */
export const SNIPPET_PREVIEW_LIMITS: Record<SnippetPreview, { lines: number; chars: number }> = {
    compact: { lines: 1, chars: 200 },
    standard: { lines: 3, chars: 400 },
    expanded: { lines: 6, chars: 800 },
};

// Project a chunk to the plain text a reader would see, collapsing markdown
// link/embed syntax to its display text. Run BEFORE the snippet window is
// chosen so a query term that exists only inside a URL can't drag the window
// into the URL and slice the link into unreadable fragments.
function snippetPlainText(md: string): string {
    return md
        .replace(/!\[\[[^\]]*?\]\]/g, '')
        .replace(/!\[[^\]]*?\]\([^)]*?\)/g, '')
        .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
        .replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) =>
            inner.includes('|') ? inner.slice(inner.lastIndexOf('|') + 1) : (inner.split('#')[0] || inner))
        .replace(/\[([^\]]*?)\]\([^)]*?\)/g, '$1');
}

/** Pick a snippet window from chunk body (search + modal). */
export function makeSnippet(content: string, queryOrTerms: string | PassageTerm[], maxLen: number): string {
    const text = snippetPlainText(content);
    if (Array.isArray(queryOrTerms)) {
        const { start, end } = passageWindow(text, queryOrTerms, maxLen);
        let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
        if (start > 0) snippet = '…' + snippet;
        if (end < text.length) snippet = snippet + '…';
        return snippet;
    }
    const query = queryOrTerms;
    const lower = text.toLowerCase();
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    let best = -1;
    for (const tok of q) {
        const idx = lower.indexOf(tok);
        if (idx !== -1 && (best === -1 || idx < best)) best = idx;
    }
    const start = best === -1 ? 0 : Math.max(0, best - 40);
    const end = Math.min(text.length, start + maxLen);
    let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';
    return snippet;
}

// A line that's part of a GFM pipe table: either a normal row that's wrapped in
// outer pipes (`| a | b |`, incl. the header) or a delimiter row (`|---|:--:|`,
// with or without outer pipes). Requiring outer pipes on content rows keeps a
// stray inline pipe in prose ("A | B") from being mistaken for a table.
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

// Sanitize a snippet before markdown-rendering it. Notes often open with a
// banner image, a transcluded note, a table, or a $$…$$ formula — all of which
// the renderer would expand into a full-height block and blow out the result
// row. We strip:
//   • $$display math$$          → a centred MathJax block (spans lines)
//   • Obsidian wikilink embeds  `![[cover.jpg]]` / `![[file|size]]`
//   • markdown image embeds     `![alt](url)`
//   • GFM pipe-table lines      `| a | b |`, `|---|---|`
//   • code-fence markers        ```` ```json ```` / `~~~` — see below
// Plain links (`[[…]]`, `[text](url)`), inline `$math$`, and inline formatting
// are left intact so they still render inline. Leftover blank lines are
// collapsed. (The CSS row-height ceiling is the backstop for anything that still
// slips through as a block — see .seek-result-snippet in styles.css.)
//
// Code fences get only their FENCE LINES removed (not the inner code): a real
// fenced block renders as a <pre> with Obsidian's floating "copy" button, and
// the row's nowrap+overflow clip then hides the code text but NOT the
// absolutely-positioned button — so a config-dump note (body = one ```json
// block) shows up as a lone copy icon with no preview. Dropping the fence lines
// lets the inner text render as a normal clipped one-liner instead.
//
// A chunk that's ENTIRELY a table or a $$…$$ formula (no surrounding prose)
// strips down to nothing above, which would otherwise render as a blank
// result row even though it's the thing that matched. In that case fall back
// to a flattened, single-line rendering of the stripped table/math content
// itself so the row still shows something recognizable.
export function sanitizeSnippet(md: string): string {
    const mathBlocks: string[] = [];
    const noEmbeds = md
        .replace(/\$\$[\s\S]*?\$\$/g, (block) => {           // $$display math$$ (multi-line)
            mathBlocks.push(block.slice(2, -2).trim());
            return '';
        })
        .replace(/!\[\[[^\]]*?\]\]/g, '')       // ![[file]] / ![[file|size]]
        .replace(/!\[[^\]]*?\]\([^)]*?\)/g, ''); // ![alt](url)

    const tableRows: string[] = [];
    const noTables = noEmbeds
        .split('\n')
        .filter(line => {
            if (TABLE_DELIM_RE.test(line)) return false; // |---|---| — no content to keep
            if (TABLE_ROW_RE.test(line)) {
                tableRows.push(line);
                return false;
            }
            return true;
        })
        .join('\n');

    const noFences = noTables.replace(/^\s*(?:```|~~~).*$/gm, ''); // ``` / ```json / ~~~

    const result = noFences.replace(/\n{3,}/g, '\n\n').trim();
    if (result) return result;

    // Nothing left after stripping — the chunk was entirely a table and/or a
    // math block. Flatten whichever we captured into a compact one-liner.
    const fallbackParts: string[] = [];
    if (tableRows.length) {
        const flatCells = tableRows
            .map(row => row.trim().replace(/^\|/, '').replace(/\|$/, ''))
            .map(row => row.split('|').map(cell => cell.trim()).filter(Boolean).join(' · '))
            .filter(Boolean);
        if (flatCells.length) fallbackParts.push(flatCells.join('  |  '));
    }
    if (mathBlocks.length) {
        const flatMath = mathBlocks
            .map(block => block.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('  ');
        if (flatMath) fallbackParts.push(flatMath);
    }

    return fallbackParts.join('  —  ');
}
