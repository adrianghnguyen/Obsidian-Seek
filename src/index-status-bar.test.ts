import { describe, it, expect } from 'vitest';
import {
    IndexStatusBar,
    parseIndexedProgress,
    quantizePercent,
} from './index-status-bar';
import { renderIndexStatusCard } from './index-status-card';

interface StubEl {
    tagName: string;
    className: string;
    textContent: string;
    max: number;
    value: number;
    children: StubEl[];
    empty(): void;
    createDiv(opts?: { cls?: string; text?: string }): StubEl;
    createSpan(opts?: { cls?: string; text?: string }): StubEl;
    createEl(tag: string, opts?: { cls?: string; text?: string }): StubEl;
    addClass(cls: string): void;
    removeClass(cls: string): void;
    setText(text: string): void;
    setAttr(key: string, value: string): void;
    addEventListener(_type: string, _fn: unknown): void;
    querySelector(sel: string): StubEl | null;
}

function stubEl(tagName = 'div'): StubEl {
    const el: StubEl = {
        tagName,
        className: '',
        textContent: '',
        max: 1,
        value: 0,
        children: [],
        empty() { el.children = []; el.textContent = ''; },
        createDiv(opts) { return el.createEl('div', opts); },
        createSpan(opts) { return el.createEl('span', opts); },
        createEl(tag, opts) {
            const child = stubEl(tag);
            if (opts?.cls) child.className = opts.cls;
            if (opts?.text) child.textContent = opts.text;
            el.children.push(child);
            return child;
        },
        addClass(cls) { el.className = el.className ? `${el.className} ${cls}` : cls; },
        removeClass(cls) {
            el.className = el.className.split(/\s+/).filter(c => c && c !== cls).join(' ');
        },
        setText(text) { el.textContent = text; },
        setAttr() { /* unused in assertions */ },
        addEventListener() { /* unused in assertions */ },
        querySelector(sel) {
            const walk = (n: StubEl): StubEl | null => {
                if (sel.startsWith('.')) {
                    if (n.className.split(/\s+/).includes(sel.slice(1))) return n;
                } else if (n.tagName === sel) {
                    return n;
                }
                for (const c of n.children) {
                    const hit = walk(c);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(el);
        },
    };
    return el;
}

function textOf(el: StubEl): string {
    return [el.textContent, ...el.children.map(textOf)].join(' ');
}

describe('parseIndexedProgress', () => {
    it('reads a simple indexed-files line', () => {
        expect(parseIndexedProgress('Indexed 12 files · 40 chunks')).toEqual({ files: 12 });
    });

    it('reads comma-grouped counts and a pause suffix', () => {
        expect(parseIndexedProgress('Indexed 1,234 files · 40 chunks — paused while you search…'))
            .toEqual({ files: 1234 });
    });

    it('returns null for garbage', () => {
        expect(parseIndexedProgress('still working')).toBeNull();
    });
});

describe('quantizePercent', () => {
    it('snaps to a 5% grid from files in the current pass', () => {
        expect(quantizePercent(1, 5)).toBe(20);
        expect(quantizePercent(1, 4)).toBe(25);
        expect(quantizePercent(0, 4)).toBe(0);
        expect(quantizePercent(4, 4)).toBe(100);
        expect(quantizePercent(2, 5)).toBe(40);
    });
});

describe('IndexStatusBar', () => {
    const hooks = {
        getStats: async () => ({
            files: 12, chunks: 40, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null,
        }),
        getHealth: () => 'ok' as const,
        onOpenSettings: () => {},
    };

    it('paints quantized percent and skips same-bucket updates', () => {
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, hooks);
        bar.show(5, 'Seek: indexing…');
        bar.update(1, 5);
        expect(root.querySelector('.seek-status-bar-label')?.textContent).toBe('Seek 20%');
        bar.update(1, 5);
        expect(root.querySelector('.seek-status-bar-label')?.textContent).toBe('Seek 20%');
        bar.update(2, 5);
        expect(root.querySelector('.seek-status-bar-label')?.textContent).toBe('Seek 40%');
    });

    it('returns to idle Seek on hide', () => {
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, hooks);
        bar.show(5, 'Seek: indexing…');
        bar.update(1, 5);
        bar.hide();
        expect(root.querySelector('.seek-status-bar-label')?.textContent).toBe('Seek');
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-good');
    });

    it('paints idle from getHealth after the job ends, not the in-flight indexing state', () => {
        let busy = true;
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, {
            ...hooks,
            getHealth: () => busy ? 'indexing' : 'ok',
        });
        bar.show(5, 'Seek: indexing…');
        busy = false;
        bar.hide();
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-good');
        expect(root.querySelector('.seek-dot')?.className).not.toContain('seek-dot-accent');
    });

    it('refreshIdle repaints the dot when health changes outside a job', () => {
        let health: 'indexing' | 'ok' = 'indexing';
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, { ...hooks, getHealth: () => health });
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-accent');
        health = 'ok';
        bar.refreshIdle();
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-good');
    });
});

describe('renderIndexStatusCard', () => {
    it('shows inventory metrics and raw pass counts for an active job', () => {
        const root = stubEl();
        renderIndexStatusCard(root as unknown as HTMLElement, {
            health: 'indexing',
            stats: { files: 12, chunks: 40, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
            job: { done: 3, total: 12 },
        });
        const blob = textOf(root);
        expect(blob).toContain('12');
        expect(blob).toContain('40');
        expect(blob).toContain('3 / 12');
        expect(blob).toContain('Indexing');
    });

    it('names starting and restoring as distinct from indexing and no-index', () => {
        const start = stubEl();
        renderIndexStatusCard(start as unknown as HTMLElement, {
            health: 'starting',
            stats: { files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
        });
        expect(textOf(start)).toContain('Starting up');
        expect(textOf(start)).not.toContain('No index');

        const restore = stubEl();
        renderIndexStatusCard(restore as unknown as HTMLElement, {
            health: 'restoring',
            stats: { files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
        });
        expect(textOf(restore)).toContain('Restoring');
        expect(textOf(restore)).not.toContain('No index');
    });
});
