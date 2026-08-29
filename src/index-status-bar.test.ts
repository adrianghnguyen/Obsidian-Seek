import { describe, it, expect } from 'vitest';
import {
    IndexStatusBar,
    extendIndexPassTotal,
    parseIndexedProgress,
    quantizePercent,
} from './index-status-bar';
import {
    renderIndexStatusCard,
    renderIndexStatusBadge,
    indexWaitCardModel,
    jobRemaining,
    INDEX_STATUS_BADGE_CLS,
    INDEX_STATUS_DOT_CLS,
} from './index-status-card';

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

describe('extendIndexPassTotal', () => {
    it('keeps committed progress when new edits enlarge the dirty set', () => {
        expect(extendIndexPassTotal(50, 100, 55)).toBe(105);
        expect(extendIndexPassTotal(50, 100, 50)).toBe(100);
    });

    it('never shrinks the pass total', () => {
        expect(extendIndexPassTotal(80, 100, 15)).toBe(100);
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

    it('paints remaining files as the numbered badge and skips same-remaining updates', () => {
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, hooks);
        bar.show(5, 'Seek: indexing…');
        bar.update(1, 5);
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('4');
        bar.update(1, 5);
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('4');
        bar.update(2, 5);
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('3');
    });

    it('uses Seek: Indexing as the tooltip while a pass is in flight', () => {
        const labels: string[] = [];
        const root = stubEl();
        root.setAttr = (key, value) => { if (key === 'aria-label') labels.push(value); };
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, hooks);
        bar.show(15, 'Seek: indexing 15 notes…');
        expect(labels.at(-1)).toBe('Seek: Indexing');
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('15');
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
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)).toBeNull();
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
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)).toBeNull();
    });

    it('refreshIdle repaints chrome when health changes outside a job', () => {
        let health: 'indexing' | 'ok' | 'starting' = 'indexing';
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, { ...hooks, getHealth: () => health });
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('…');
        expect(root.querySelector('.seek-dot')).toBeNull();
        health = 'ok';
        bar.refreshIdle();
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-good');
        health = 'starting';
        bar.refreshIdle();
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-info');
    });

    it('does not paint an indexing badge while canonical health is Starting or Restoring', () => {
        let health: 'starting' | 'restoring' | 'ok' = 'starting';
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, { ...hooks, getHealth: () => health });
        bar.show(15, 'Seek: indexing 15 notes…');
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)).toBeNull();
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-info');
        health = 'restoring';
        bar.refreshIdle();
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)).toBeNull();
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-info');
        health = 'ok';
        bar.refreshIdle();
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('15');
    });

    it('clamps done to total and ignores stale job ids', () => {
        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, hooks);
        bar.show(10, 'Seek: indexing…', { id: 1, kind: 'catchup' });
        bar.update(12, 10, undefined, 1);
        expect(bar.job()?.done).toBe(10);
        bar.update(3, 10, undefined, 99);
        expect(bar.job()?.done).toBe(10);
        bar.hide(99);
        expect(bar.job()?.total).toBe(10);
        bar.hide(1);
        expect(bar.job()).toBeNull();
    });
});

describe('jobRemaining', () => {
    it('is total minus done for a live pass', () => {
        expect(jobRemaining({ done: 0, total: 15 })).toBe(15);
        expect(jobRemaining({ done: 5, total: 15 })).toBe(10);
        expect(jobRemaining({ done: 15, total: 15 })).toBe(0);
        expect(jobRemaining(null)).toBeNull();
        expect(jobRemaining({ done: 0, total: 0 })).toBeNull();
    });
});

describe('indexWaitCardModel', () => {
    const inventory = {
        files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: '2026-08-19T00:05:00',
    };

    it('drops stale inventory on the starting/restoring first paint', () => {
        expect(indexWaitCardModel({ health: 'starting', stats: inventory, job: { done: 0, total: 15 } }))
            .toEqual({ health: 'starting', stats: null, job: null });
        expect(indexWaitCardModel({ health: 'restoring', stats: inventory }))
            .toEqual({ health: 'restoring', stats: null, job: null });
    });

    it('keeps the coordinator job as the indexing source of truth', () => {
        const model = indexWaitCardModel({ health: 'ok', stats: inventory, job: { done: 0, total: 15 } });
        expect(model.health).toBe('indexing');
        expect(model.job).toEqual({ done: 0, total: 15 });
        expect(jobRemaining(model.job)).toBe(15);
        expect(jobRemaining(model.job)).not.toBe(model.stats?.files);
    });
});

describe('renderIndexStatusBadge', () => {
    it('paints a numbered badge for indexing and a dot otherwise', () => {
        const indexing = stubEl();
        renderIndexStatusBadge(indexing as unknown as HTMLElement, { health: 'indexing', remaining: 15 });
        expect(indexing.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('15');
        expect(indexing.querySelector(`.${INDEX_STATUS_DOT_CLS}`)).toBeNull();

        const ready = stubEl();
        renderIndexStatusBadge(ready as unknown as HTMLElement, { health: 'ok' });
        expect(ready.querySelector(`.${INDEX_STATUS_DOT_CLS}`)?.className).toContain('seek-dot-good');
        expect(ready.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)).toBeNull();
    });
});

describe('renderIndexStatusCard', () => {
    it('shows inventory metrics and raw pass counts for an active job', () => {
        const root = stubEl();
        renderIndexStatusCard(root as unknown as HTMLElement, {
            health: 'indexing',
            stats: { files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
            job: { done: 0, total: 15 },
        });
        const blob = textOf(root);
        expect(blob).toContain('15');
        expect(blob).toContain('0 / 15');
        expect(blob).toContain('Indexing');
        expect(blob).not.toMatch(/\b5\b/);
        expect(blob).not.toMatch(/\b18\b/);
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('15');
        expect(root.querySelector(`.${INDEX_STATUS_DOT_CLS}`)).toBeNull();
    });

    it('matches the status-bar badge remaining count, not committed inventory', () => {
        const barRoot = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(barRoot as unknown as HTMLElement, {
            getStats: async () => ({
                files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null,
            }),
            getHealth: () => 'indexing' as const,
            onOpenSettings: () => {},
        });
        bar.show(15, 'Seek: indexing 15 notes…');

        const cardRoot = stubEl();
        renderIndexStatusCard(cardRoot as unknown as HTMLElement, {
            health: 'indexing',
            stats: { files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
            job: bar.job(),
        });

        const badge = barRoot.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent;
        const cardBadge = cardRoot.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent;
        expect(badge).toBe('15');
        expect(cardBadge).toBe(badge);
        expect(textOf(cardRoot)).toContain('15 remaining');
        expect(textOf(cardRoot)).not.toContain('5 files');
    });

    it('does not use the deprecated circular indexing dot', () => {
        const root = stubEl();
        renderIndexStatusCard(root as unknown as HTMLElement, {
            health: 'indexing',
            stats: { files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
            job: { done: 3, total: 15 },
        });
        expect(root.querySelector(`.${INDEX_STATUS_DOT_CLS}`)).toBeNull();
        expect(root.querySelector(`.${INDEX_STATUS_BADGE_CLS}`)?.textContent).toBe('12');
    });

    it('names starting and restoring as distinct from indexing and no-index', () => {
        const start = stubEl();
        renderIndexStatusCard(start as unknown as HTMLElement, {
            health: 'starting',
            stats: { files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
        });
        expect(textOf(start)).toContain('Starting up');
        expect(textOf(start)).not.toContain('No index');
        expect(textOf(start)).not.toMatch(/\b5\b/);
        expect(textOf(start)).toContain('…');

        const restore = stubEl();
        renderIndexStatusCard(restore as unknown as HTMLElement, {
            health: 'restoring',
            stats: { files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
        });
        expect(textOf(restore)).toContain('Restoring');
        expect(textOf(restore)).not.toContain('No index');
        expect(textOf(restore)).not.toMatch(/\b5\b/);
    });
});
