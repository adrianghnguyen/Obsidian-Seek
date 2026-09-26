// Exact / regex text search mode — parsed from the free-text portion of a query.
// Pure module (no Obsidian imports) for vitest.

import type { PassageTerm } from './passage';

export type TextSearchKind = 'hybrid' | 'exact' | 'regex';

export interface TextSearchMode {
    kind: TextSearchKind;
    /** Case-sensitive matching for literal units (leading ~ on the text segment). */
    matchCase: boolean;
    /** Each quoted "…" or +word unit — must all appear as substrings in the chunk body. */
    literals: string[];
    /** Body regex when /…/ is present and valid. Combined with literals via AND. */
    regex: RegExp | null;
    /** Unquoted words remaining after extracting operators — literal AND when kind !== hybrid. */
    bareTerms: string[];
    /** True when a /…/ was present but did not compile. */
    regexInvalid: boolean;
}

export interface TextSearchModeParse {
    /** Text after stripping ~ prefix (still contains quotes, +, /). */
    text: string;
    mode: TextSearchMode;
}

function foldCase(s: string): string {
    return s.toLocaleLowerCase();
}

/** User-facing badge / footer label for the current mode. */
export function describeTextSearchMode(mode: TextSearchMode): string | null {
    if (mode.kind === 'hybrid') return null;
    if (mode.regexInvalid) return 'Regex invalid';
    const cs = mode.matchCase ? ' · case-sensitive' : '';
    if (mode.regex && mode.literals.length === 0 && mode.bareTerms.length === 0) {
        return `Regex${cs}`;
    }
    const n = mode.literals.length + mode.bareTerms.length + (mode.regex ? 1 : 0);
    if (n === 1 && mode.literals.length === 1 && mode.literals[0].includes(' ') && !mode.regex && mode.bareTerms.length === 0) {
        return `Exact phrase${cs}`;
    }
    if (mode.regex && n === 1) return `Regex${cs}`;
    return `Exact · ${n} literal${n === 1 ? '' : 's'}${cs}`;
}

/**
 * Parse exact-search shorthands from the residual query text (post filter extraction).
 * Hybrid when no ", +word, or /…/ trigger is present.
 */
export function parseTextSearchMode(raw: string): TextSearchModeParse {
    let text = raw.trim();
    let matchCase = false;
    if (text.startsWith('~')) {
        matchCase = true;
        text = text.slice(1).trimStart();
    }

    const literals: string[] = [];
    let regex: RegExp | null = null;
    let regexInvalid = false;
    const plusTerms: string[] = [];
    const chunks: string[] = [];
    let i = 0;

    while (i < text.length) {
        const ch = text[i];
        if (ch === '"') {
            const end = text.indexOf('"', i + 1);
            if (end < 0) {
                chunks.push(text.slice(i));
                i = text.length;
                break;
            }
            const inner = text.slice(i + 1, end);
            if (inner.length > 0) literals.push(inner);
            i = end + 1;
            continue;
        }
        if (ch === '/') {
            const end = text.indexOf('/', i + 1);
            if (end < 0) {
                chunks.push(text.slice(i));
                i = text.length;
                break;
            }
            const pattern = text.slice(i + 1, end);
            try {
                regex = new RegExp(pattern, matchCase ? '' : 'i');
            } catch {
                regexInvalid = true;
            }
            i = end + 1;
            continue;
        }
        if (ch === '+' && (i === 0 || /\s/.test(text[i - 1]!))) {
            const m = /^\+(\S+)/.exec(text.slice(i));
            if (m) {
                plusTerms.push(m[1]!);
                i += m[0].length;
                continue;
            }
        }
        const nextSpecial = (() => {
            let q = text.indexOf('"', i);
            let s = text.indexOf('/', i);
            let p = text.indexOf('+', i);
            const cands = [q, s, p].filter(x => x >= 0);
            return cands.length ? Math.min(...cands) : -1;
        })();
        if (nextSpecial < 0) {
            chunks.push(text.slice(i));
            break;
        }
        if (nextSpecial > i) chunks.push(text.slice(i, nextSpecial));
        i = nextSpecial;
    }

    for (const t of plusTerms) literals.push(t);

    const quoteCount = (text.match(/"/g) ?? []).length;
    const hasOpenQuote = quoteCount % 2 === 1;
    const triggered = !hasOpenQuote && (literals.length > 0 || regex !== null || regexInvalid);
    const remainder = chunks.join(' ').replace(/\s+/g, ' ').trim();
    const bareTerms = triggered
        ? remainder.split(/\s+/).filter(Boolean)
        : [];

    let kind: TextSearchKind = 'hybrid';
    if (regexInvalid) {
        kind = 'regex';
    } else if (triggered) {
        kind = regex && literals.length === 0 && bareTerms.length === 0 ? 'regex' : 'exact';
        if (regex && (literals.length > 0 || bareTerms.length > 0)) kind = 'exact';
    }

    return {
        text,
        mode: {
            kind,
            matchCase,
            literals,
            regex: regexInvalid ? null : regex,
            bareTerms,
            regexInvalid,
        },
    };
}

/** True when chunk body satisfies all literal / regex constraints. */
export function bodyMatchesTextMode(body: string, mode: TextSearchMode): boolean {
    if (mode.kind === 'hybrid') return true;
    if (mode.regexInvalid) return false;
    const hay = mode.matchCase ? body : foldCase(body);
    const norm = (s: string) => (mode.matchCase ? s : foldCase(s));
    for (const lit of mode.literals) {
        if (!hay.includes(norm(lit))) return false;
    }
    for (const term of mode.bareTerms) {
        if (!hay.includes(norm(term))) return false;
    }
    if (mode.regex) {
        if (!mode.regex.test(body)) return false;
    }
    return true;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Global RegExp for decorating snippet marks in exact / regex mode. */
export function literalMarkPattern(mode: TextSearchMode): RegExp | null {
    if (mode.kind === 'hybrid' || mode.regexInvalid) return null;
    const parts: string[] = [];
    const flags = mode.matchCase ? 'g' : 'gi';
    for (const lit of [...mode.literals, ...mode.bareTerms]) {
        if (lit.length > 0) parts.push(escapeRegExp(lit));
    }
    if (mode.regex) {
        parts.push(mode.regex.source);
    }
    if (parts.length === 0) return null;
    return new RegExp(parts.join('|'), flags);
}

/** Passage terms for snippet window selection in exact mode (simple substring anchors). */
export function literalPassageTerms(mode: TextSearchMode): PassageTerm[] {
    if (mode.kind === 'hybrid' || mode.regexInvalid) return [];
    const out: PassageTerm[] = [];
    const flags = mode.matchCase ? 'g' : 'gi';
    for (const lit of [...mode.literals, ...mode.bareTerms]) {
        if (!lit.trim()) continue;
        out.push({ re: new RegExp(escapeRegExp(lit), flags), idf: 1 });
    }
    return out;
}
