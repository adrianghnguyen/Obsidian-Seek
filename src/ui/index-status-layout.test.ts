/**
 * Both index-status surfaces share the same compact / card layout rules:
 * status-bar + footer compact, and Settings Index card metrics.
 */
import { describe, it, expect } from 'vitest';
import {
    IndexStatusReporter,
    INDEX_STATUS_COPY,
    type IndexStatusReporterInput,
} from './index-status-report';
import { indexFooterStatus } from './index-notice';
import { IndexStatusBar } from './index-status-bar';
import { renderIndexStatusCard } from './index-status-card';
import { renderSettingsIndexStatusCard } from './index-status-settings';
import {
    formatStableCompactProgress,
    formatStableFileFraction,
    formatStableLabelProgress,
    visibleProgressText,
} from './index-progress-format';
import { indexPercent } from './index-eta';
import type { IndexStatusHealth } from './index-status-card';

const idle: IndexStatusReporterInput = {
    booting: false,
    hydrating: false,
    waitingForSidecar: false,
    peerSyncPending: false,
    health: 'healthy',
    reason: null,
    indexing: false,
    job: null,
    searchableChunks: 400,
    inventoryFiles: 80,
};

function stubEl(tagName = 'div'): any {
    const el: any = {
        tagName,
        className: '',
        textContent: '',
        max: 1,
        value: 0,
        children: [] as any[],
        empty() { el.children = []; el.textContent = ''; },
        createDiv(opts?: { cls?: string; text?: string }) { return el.createEl('div', opts); },
        createSpan(opts?: { cls?: string; text?: string }) { return el.createEl('span', opts); },
        createEl(tag: string, opts?: { cls?: string; text?: string }) {
            const child = stubEl(tag);
            if (opts?.cls) child.className = opts.cls;
            if (opts?.text) child.textContent = opts.text;
            el.children.push(child);
            return child;
        },
        addClass(cls: string) { el.className = el.className ? `${el.className} ${cls}` : cls; },
        removeClass(cls: string) {
            el.className = el.className.split(/\s+/).filter((c: string) => c && c !== cls).join(' ');
        },
        setText(text: string) { el.textContent = text; },
        setAttr() { /* unused */ },
        addEventListener() { /* unused */ },
        querySelector(sel: string) {
            return el.querySelectorAll(sel)[0] ?? null;
        },
        querySelectorAll(sel: string) {
            const out: any[] = [];
            const walk = (n: any) => {
                if (sel.startsWith('.')) {
                    if (n.className.split(/\s+/).includes(sel.slice(1))) out.push(n);
                } else if (n.tagName === sel) out.push(n);
                for (const c of n.children) walk(c);
            };
            walk(el);
            return out;
        },
    };
    return el;
}

function textOf(el: any): string {
    return [el.textContent, ...el.children.map(textOf)].join(' ');
}

function hydrateReport(done: number, total: number) {
    return IndexStatusReporter.compute({
        ...idle,
        hydrating: true,
        mayFullReindex: false,
        searchableChunks: 0,
        inventoryFiles: 0,
        hydrateProgress: { done, total },
    });
}

function paintBar(report: ReturnType<typeof hydrateReport>) {
    const labels: string[] = [];
    const root = stubEl();
    root.setAttr = (key: string, value: string) => { if (key === 'aria-label') labels.push(value); };
    const bar = new IndexStatusBar();
    bar.mount(root as unknown as HTMLElement, {
        getStats: async () => ({ files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null }),
        getReport: () => report,
        onOpenSettings: () => {},
        onRecover: () => {},
    });
    return { root, labels, bar };
}

function paintSettingsCard(report: ReturnType<typeof hydrateReport>, extra?: { health?: IndexStatusHealth; job?: { done: number; total: number } | null }) {
    const root = stubEl();
    renderSettingsIndexStatusCard(root as unknown as HTMLElement, {
        health: extra?.health ?? report.health,
        mode: report.mode,
        label: report.label,
        hydrateProgress: report.hydrateProgress,
        progress: report.progress,
        percent: report.progress.units?.percent ?? report.hydrateProgress?.percent,
        remaining: report.progress.units
            ? Math.max(0, report.progress.units.total - report.progress.units.done)
            : null,
        stats: { files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
        job: extra?.job ?? null,
    });
    return root;
}

describe('reporter compact chrome (bar + footer)', () => {
    it('keeps compact length stable across 9→10 and 9%→10%→100%', () => {
        const total = 63;
        const a = hydrateReport(9, total);
        const b = hydrateReport(10, total);
        const c = hydrateReport(total, total);
        expect(a.compact.length).toBe(b.compact.length);
        expect(b.compact.length).toBe(c.compact.length);
        expect(visibleProgressText(a.compact)).toBe(`Restoring ${visibleProgressText(formatStableCompactProgress(9, total, indexPercent(9, total)))}`);
        const footerA = indexFooterStatus({
            kind: 'restoring',
            modelReady: true,
            phase: 'hydrating',
            uiHealth: a.health,
            statusReport: a,
        });
        const footerC = indexFooterStatus({
            kind: 'restoring',
            modelReady: true,
            phase: 'hydrating',
            uiHealth: c.health,
            statusReport: c,
        });
        expect(footerA.label).toBe(a.compact);
        expect(footerC.label.length).toBe(footerA.label.length);
        const barA = paintBar(a);
        const barB = paintBar(b);
        expect(barA.root.querySelector('.seek-status-bar-files')?.textContent)
            .toBe(formatStableFileFraction(9, total));
        expect(barA.root.querySelector('.seek-status-bar-files')?.textContent?.length)
            .toBe(barB.root.querySelector('.seek-status-bar-files')?.textContent?.length);
        expect(barA.labels.at(-1)).toBe(`Seek: ${a.compact}`);
        expect(barA.root.querySelector('progress')?.value).toBe(indexPercent(9, total));
    });

    it('reserves thousands-digit width from live total and never clips to k at ~3800', () => {
        const total = 3854;
        const a = hydrateReport(9, total);
        const b = hydrateReport(1000, total);
        const c = hydrateReport(total, total);
        expect(a.compact.length).toBe(b.compact.length);
        expect(b.compact.length).toBe(c.compact.length);
        expect(visibleProgressText(a.compact)).not.toMatch(/k/);
        expect(visibleProgressText(c.compact)).toContain(visibleProgressText(formatStableFileFraction(total, total)));
        const bar = paintBar(b);
        expect(bar.root.querySelector('.seek-status-bar-files')?.textContent)
            .toBe(formatStableFileFraction(1000, total));
        expect(visibleProgressText(bar.root.querySelector('.seek-status-bar-files')?.textContent ?? '')).not.toMatch(/k/);
    });

    it('switches compact k once when locale total would overflow', () => {
        const total = 120_000;
        const a = hydrateReport(9, total);
        const b = hydrateReport(total, total);
        expect(a.compact.length).toBe(b.compact.length);
        expect(visibleProgressText(a.compact)).toMatch(/120k/);
        expect(visibleProgressText(b.compact)).toMatch(/120k/);
    });
});

describe('Settings Index card', () => {
    it('keeps a short heading and Restoring counts in the metric slot', () => {
        const report = hydrateReport(12, 40);
        const root = paintSettingsCard(report);
        expect(root.querySelector('.seek-status-card-main')).not.toBeNull();
        expect(root.querySelectorAll('.seek-status-metric').length).toBe(3);
        expect(root.querySelector('.seek-status-label')?.textContent).toBe(INDEX_STATUS_COPY.restoring.label);
        expect(root.querySelector('.seek-status-label')?.textContent).not.toMatch(/\d/);
        expect(root.querySelector('.seek-status-job')?.querySelector('.seek-status-value')?.textContent)
            .toBe(formatStableLabelProgress(12, 40, 30));
        expect(visibleProgressText(textOf(root))).toContain('12 / 40 · 30%');
    });

    it('keeps the Restoring metric string width stable for 9→10, 99→100, and 100%', () => {
        const total = 3854;
        const a = paintSettingsCard(hydrateReport(9, total));
        const b = paintSettingsCard(hydrateReport(10, total));
        const c = paintSettingsCard(hydrateReport(total, total));
        const jobValue = (root: { querySelector: (sel: string) => { querySelector: (sel: string) => { textContent?: string } | null } | null }) =>
            root.querySelector('.seek-status-job')?.querySelector('.seek-status-value')?.textContent ?? '';
        const va = jobValue(a);
        const vb = jobValue(b);
        const vc = jobValue(c);
        expect(va.length).toBe(vb.length);
        expect(vb.length).toBe(vc.length);
        expect(va.length).toBe(formatStableLabelProgress(9, total, indexPercent(9, total)).length);
        expect(visibleProgressText(vc)).toContain('100%');
        expect(visibleProgressText(va)).not.toMatch(/k/);
    });

    it('holds the same card skeleton across Starting / Restoring / Ready / Stuck / Indexing', () => {
        const skeleton = (root: any) => ({
            main: !!root.querySelector('.seek-status-card-main'),
            metrics: root.querySelectorAll('.seek-status-metric').length,
            heading: root.querySelector('.seek-status-label')?.textContent ?? '',
        });
        const emptyStats = { files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null };
        const paint = (health: IndexStatusHealth, over: Record<string, unknown> = {}) => {
            const root = stubEl();
            renderIndexStatusCard(root as unknown as HTMLElement, {
                health,
                stats: emptyStats,
                ...over,
            });
            return skeleton(root);
        };
        const starting = paint('starting');
        const restoring = skeleton(paintSettingsCard(hydrateReport(3, 15)));
        const ready = paint('ok', { stats: { files: 15, chunks: 40, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null } });
        const stuck = paint('stuck');
        const indexing = paint('indexing', { job: { done: 3, total: 15 } });
        for (const row of [starting, restoring, ready, stuck, indexing]) {
            expect(row.main).toBe(true);
            expect(row.metrics).toBe(3);
        }
        expect(starting.heading).toBe(INDEX_STATUS_COPY.starting.label);
        expect(restoring.heading).toBe(INDEX_STATUS_COPY.restoring.label);
        expect(ready.heading).toBe(INDEX_STATUS_COPY.ok.label);
        expect(stuck.heading).toBe(INDEX_STATUS_COPY.stuck.label);
        expect(indexing.heading).toBe(INDEX_STATUS_COPY.indexing.label);
        expect(restoring.heading).not.toMatch(/\d/);
    });
});
