// Telescope preview pane: lightweight DOM from vault text (no MarkdownRenderer).
// Ported from Fast Find preview.ts patterns — classify, segment, caps, lazy lines.

/** Maximum note lines rendered in the telescope preview pane. */
export const MAX_PREVIEW_LINES = 4000;
/** Global budget for query highlight marks across the preview. */
export const MAX_PREVIEW_MARKS = 200;
/** Global budget for wikilink and tag style spans in the preview. */
export const MAX_PREVIEW_STYLES = 2000;
/** Maximum characters per preview line before ellipsis truncation. */
export const MAX_LINE_CHARS = 2000;
/** Maximum link or tag style ranges applied on a single line. */
export const MAX_LINE_STYLES = 50;
const LAZY_MARGIN = 200;
const CACHE_SIZE = 20;
const MIN_TERM = 2;

/** Classified preview line kind for heading, fenced code, or plain text styling. */
export type PreviewLineKind = 'h1' | 'h2' | 'h3' | 'code' | 'text';

/** One classified note line with display text and styling kind. */
export interface PreviewLine {
    kind: PreviewLineKind;
    /** Display text: heading markers stripped, everything else verbatim. */
    text: string;
}

/** Text run within a line with optional link/tag style and query highlight mark. */
export interface PreviewSegment {
    text: string;
    style: 'link' | 'tag' | null;
    mark: boolean;
}

const HEADING = /^(#{1,3})[ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const TAG_BODY = /[\p{L}\p{N}_\-/]+/uy;

/** Lowercase highlight terms from a cleaned query string (inline filters already stripped). */
export function telescopeQueryTerms(cleanedQuery: string): string[] {
    const out: string[] = [];
    for (const raw of cleanedQuery.split(/\s+/)) {
        if (!raw || raw.startsWith('-')) continue;
        const t = raw.replace(/["']/g, '').toLowerCase();
        if (t.length >= MIN_TERM && !out.includes(t)) out.push(t);
    }
    return out;
}

/** Classifies raw note lines into ATX headings, fenced code blocks, or text. */
export function classifyPreviewLines(lines: string[]): PreviewLine[] {
    let fence: string | null = null;
    return lines.map((line) => {
        const f = FENCE.exec(line);
        if (fence !== null) {
            if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
            return { kind: 'code', text: line };
        }
        if (f) {
            fence = f[1];
            return { kind: 'code', text: line };
        }
        const h = HEADING.exec(line);
        if (h) return { kind: `h${h[1].length}` as PreviewLineKind, text: h[2] };
        return { kind: 'text', text: line };
    });
}

/** Mutable counters limiting marks and styles while segmenting preview lines. */
export interface PreviewBudget {
    marks: number;
    styles: number;
}

/** Finds non-overlapping query term highlight ranges on a line under the mark budget. */
function markRanges(text: string, terms: string[], budget: PreviewBudget): [number, number][] {
    const lower = text.toLowerCase();
    const usable = terms.filter((t) => t.length >= MIN_TERM);
    if (lower.length !== text.length || usable.length === 0) return [];
    const next = usable.map((t) => lower.indexOf(t));
    const out: [number, number][] = [];
    let pos = 0;
    while (budget.marks > 0) {
        let best = -1;
        let len = 0;
        for (let k = 0; k < usable.length; k++) {
            if (next[k] >= 0 && next[k] < pos) next[k] = lower.indexOf(usable[k], pos);
            const at = next[k];
            if (at >= 0 && (best < 0 || at < best || (at === best && usable[k].length > len))) {
                best = at;
                len = usable[k].length;
            }
        }
        if (best < 0) break;
        out.push([best, best + len]);
        budget.marks--;
        pos = best + len;
    }
    return out;
}

/** Finds wikilink and hashtag tag character ranges on a line up to the style cap. */
function styleRanges(text: string, cap: number): [number, number, 'link' | 'tag'][] {
    const out: [number, number, 'link' | 'tag'][] = [];
    let pos = 0;
    let link = text.indexOf('[[');
    let hash = text.indexOf('#');
    while (out.length < cap) {
        if (link >= 0 && link < pos) link = text.indexOf('[[', pos);
        if (hash >= 0 && hash < pos) hash = text.indexOf('#', pos);
        if (link < 0 && hash < 0) break;
        if (link >= 0 && (hash < 0 || link < hash)) {
            const close = text.indexOf(']]', link + 2);
            if (close < 0) {
                link = -1;
                continue;
            }
            if (close === link + 2) {
                pos = link + 2;
                continue;
            }
            const s = link > pos && text[link - 1] === '!' ? link - 1 : link;
            out.push([s, close + 2, 'link']);
            pos = close + 2;
            continue;
        }
        pos = hash + 1;
        if (hash > 0 && !/[\s(]/.test(text[hash - 1])) continue;
        TAG_BODY.lastIndex = hash + 1;
        const m = TAG_BODY.exec(text);
        if (!m) continue;
        pos = hash + 1 + m[0].length;
        if (!/^\d+$/.test(m[0])) out.push([hash, pos, 'tag']);
    }
    return out;
}

/** Splits one line into styled and marked segments respecting per-line and global budgets. */
export function segmentPreviewLine(
    text: string,
    terms: string[],
    budget: PreviewBudget,
    plain: boolean,
): PreviewSegment[] {
    let cut = false;
    if (text.length > MAX_LINE_CHARS) {
        let n = MAX_LINE_CHARS;
        const c = text.charCodeAt(n - 1);
        if (c >= 0xd800 && c <= 0xdbff) n--;
        text = text.slice(0, n);
        cut = true;
    }
    const styles = plain ? [] : styleRanges(text, Math.min(MAX_LINE_STYLES, budget.styles));
    budget.styles -= styles.length;
    const marks = markRanges(text, terms, budget);
    const points = [0, text.length];
    for (const [s, e] of styles) points.push(s, e);
    for (const [s, e] of marks) points.push(s, e);
    points.sort((a, b) => a - b);
    const out: PreviewSegment[] = [];
    let si = 0;
    let mi = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        const s = points[i];
        const e = points[i + 1];
        if (s === e) continue;
        while (si < styles.length && styles[si][1] <= s) si++;
        while (mi < marks.length && marks[mi][1] <= s) mi++;
        const style = si < styles.length && styles[si][0] <= s ? styles[si][2] : null;
        const mark = mi < marks.length && marks[mi][0] <= s;
        const last = out[out.length - 1];
        if (last && !mark && !last.mark && last.style === style) last.text += text.slice(s, e);
        else out.push({ text: text.slice(s, e), style, mark });
    }
    if (cut) {
        const last = out[out.length - 1];
        if (last && !last.mark && last.style === null) last.text += '…';
        else out.push({ text: '…', style: null, mark: false });
    }
    return out;
}

/** Inputs for painting a note preview: path, scroll anchor line, and query terms. */
export interface PreviewPaintOptions {
    notePath: string;
    anchorLine: number | null;
    terms: string[];
}

/** rAF-coalesced lightweight DOM preview of vault note text for the search modal. */
export class TelescopePreviewPane {
    private readonly scrollEl: HTMLElement;
    private readonly bodyEl: HTMLElement;
    private readonly texts = new Map<string, string>();
    private token = 0;
    private paintRaf: number | null = null;
    private pending: PreviewPaintOptions | null = null;
    private readonly readNote: (path: string) => Promise<string>;

    /** Mounts the preview body inside scrollEl and stores the vault read callback. */
    constructor(
        scrollEl: HTMLElement,
        readNote: (path: string) => Promise<string>,
    ) {
        this.scrollEl = scrollEl;
        this.bodyEl = scrollEl.createDiv({ cls: 'seek-preview-body' });
        this.readNote = readNote;
    }

    /** Cancels pending paints and empties the preview DOM. */
    clear(): void {
        this.token++;
        if (this.paintRaf != null) {
            cancelAnimationFrame(this.paintRaf);
            this.paintRaf = null;
        }
        this.pending = null;
        this.bodyEl.empty();
    }

    /** Coalesces preview repaints to the next animation frame. */
    schedulePaint(opts: PreviewPaintOptions): void {
        this.pending = opts;
        if (this.paintRaf != null) return;
        this.paintRaf = requestAnimationFrame(() => {
            this.paintRaf = null;
            const p = this.pending;
            this.pending = null;
            if (p) void this.paintNow(p);
        });
    }

    /** Updates the LRU cache of recently read note bodies. */
    private remember(path: string, text: string): void {
        this.texts.delete(path);
        this.texts.set(path, text);
        if (this.texts.size > CACHE_SIZE) {
            const first = this.texts.keys().next().value as string;
            this.texts.delete(first);
        }
    }

    /** Loads note text from cache or readNote and renders if the paint token is still current. */
    private async paintNow(opts: PreviewPaintOptions): Promise<void> {
        const token = ++this.token;
        let text = this.texts.get(opts.notePath);
        if (text === undefined) {
            try {
                text = await this.readNote(opts.notePath);
            } catch {
                text = '';
            }
            if (token !== this.token) return;
            this.remember(opts.notePath, text);
        } else {
            this.remember(opts.notePath, text);
        }
        if (token !== this.token) return;
        this.renderDom(text, opts);
    }

    /** Builds capped classified preview DOM and scrolls to the anchor line or first query mark. */
    private renderDom(text: string, opts: PreviewPaintOptions): void {
        this.bodyEl.empty();
        if (!text) {
            this.bodyEl.createDiv({ cls: 'seek-preview-empty', text: 'No preview' });
            return;
        }
        const all = text.split('\n');
        const sliced = all.slice(0, MAX_PREVIEW_LINES);
        const lines = classifyPreviewLines(sliced);
        const budget: PreviewBudget = { marks: MAX_PREVIEW_MARKS, styles: MAX_PREVIEW_STYLES };
        const segs = lines.map((l) => segmentPreviewLine(l.text, opts.terms, budget, l.kind === 'code'));
        const markLine = segs.findIndex((ss) => ss.some((x) => x.mark));
        let anchor = opts.anchorLine;
        if (anchor == null || anchor < 0 || anchor >= lines.length) {
            anchor = markLine >= 0 ? markLine : 0;
        }
        const lazyFrom = Math.max(anchor, 0) + LAZY_MARGIN;
        let target: HTMLElement | null = null;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const div = this.bodyEl.createDiv({
                cls: line.kind === 'text' ? 'seek-preview-line' : `seek-preview-line seek-preview-${line.kind}`,
            });
            if (i >= lazyFrom) div.addClass('seek-preview-lazy');
            if (line.text === '') div.appendText('\u200b');
            for (const s of segs[i]) {
                const host = s.style ? div.createSpan({ cls: `seek-preview-${s.style}` }) : div;
                if (s.mark) {
                    const m = host.createEl('mark', { cls: 'seek-preview-mark', text: s.text });
                    if (i === anchor && anchor === markLine) target ??= m;
                } else host.appendText(s.text);
            }
            if (i === anchor && anchor !== markLine) target = div;
        }
        if (all.length > MAX_PREVIEW_LINES) {
            this.bodyEl.createDiv({ cls: 'seek-preview-line seek-preview-truncated', text: '… truncated' });
        }
        this.scrollEl.scrollTop = 0;
        target?.scrollIntoView({ block: 'start' });
    }
}
