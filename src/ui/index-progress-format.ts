/** Digit-width-stable progress strings for status bar, footer, and Settings. */

export const FIGURE_SPACE = '\u2007';

/** Locale form longer than this (e.g. 100,000) switches both sides to compact k. */
export const INDEX_COUNT_PLAIN_MAX_CHARS = 6;

export function padFigure(text: string, width: number): string {
    const pad = Math.max(0, width - text.length);
    return FIGURE_SPACE.repeat(pad) + text;
}

export function formatIndexCountPlain(n: number): string {
    return Math.max(0, Math.floor(n)).toLocaleString();
}

/** Compact whole-token form — never splits a digit group. */
export function formatIndexCountCompact(n: number): string {
    const v = Math.max(0, Math.floor(n));
    if (v < 1000) return String(v);
    if (v < 10_000) {
        const tenths = Math.round(v / 100) / 10;
        return `${tenths.toFixed(tenths % 1 === 0 ? 0 : 1)}k`;
    }
    if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
    const mills = Math.round(v / 100_000) / 10;
    return `${mills.toFixed(mills % 1 === 0 ? 0 : 1)}m`;
}

export function indexCountUsesCompact(total: number): boolean {
    return formatIndexCountPlain(total).length > INDEX_COUNT_PLAIN_MAX_CHARS;
}

/** Format `n` in the same system as `total`, padded to total's display width. */
export function formatStableIndexCount(n: number, total: number): string {
    const compact = indexCountUsesCompact(total);
    const body = compact ? formatIndexCountCompact(n) : formatIndexCountPlain(n);
    const totalBody = compact ? formatIndexCountCompact(total) : formatIndexCountPlain(total);
    return padFigure(body, totalBody.length);
}

export function formatStableFileFraction(done: number, total: number): string {
    const t = Math.max(0, Math.floor(total));
    const d = Math.max(0, Math.floor(done));
    const totalBody = indexCountUsesCompact(t) ? formatIndexCountCompact(t) : formatIndexCountPlain(t);
    return `${formatStableIndexCount(d, t)}/${totalBody}`;
}

/** Spaced fraction for Settings metrics (`done / total`). */
export function formatStableFileFractionSpaced(done: number, total: number): string {
    const t = Math.max(0, Math.floor(total));
    const d = Math.max(0, Math.floor(done));
    const totalBody = indexCountUsesCompact(t) ? formatIndexCountCompact(t) : formatIndexCountPlain(t);
    return `${formatStableIndexCount(d, t)} / ${totalBody}`;
}

/** Percent always occupies 3 numeral columns (`9%` / `10%` / `100%`). */
export function formatStablePercent(percent: number): string {
    const p = Math.max(0, Math.min(100, Math.floor(percent)));
    return `${padFigure(String(p), 3)}%`;
}

export function formatStableCompactProgress(done: number, total: number, percent: number): string {
    return `${formatStableFileFraction(done, total)} · ${formatStablePercent(percent)}`;
}

export function formatStableLabelProgress(done: number, total: number, percent: number): string {
    return `${formatStableFileFractionSpaced(done, total)} · ${formatStablePercent(percent)}`;
}

export function visibleProgressText(s: string): string {
    return s.replaceAll(FIGURE_SPACE, '');
}
