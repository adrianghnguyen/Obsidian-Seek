/**
 * Hydrate-in-progress chrome must show files done/total (or %) on the
 * reporter snapshot every surface reads. Empty "Starting" / "Restoring"
 * is the failure mode; stuck stays stuck.
 */
import { describe, it, expect } from 'vitest';
import {
    IndexStatusReporter,
    INDEX_STATUS_COPY,
    type IndexStatusReporterInput,
} from './index-status-report';
import { indexFooterStatus } from './index-notice';
import {
    IndexStatusBar,
} from './index-status-bar';
import { renderIndexStatusCard } from './index-status-card';
import { indexPercent } from './index-eta';
import { formatStableFileFraction, formatStableLabelProgress, visibleProgressText } from './index-progress-format';
import { resolveSidecarHydrateProgress } from '../app/index-self-heal';

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
        events: {} as Record<string, Array<(e: unknown) => void>>,
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
        addEventListener(type: string, fn: unknown) {
            (el.events[type] ??= []).push(fn as (e: unknown) => void);
        },
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

describe('IndexStatusReporter hydrate progress', () => {
    it('appends files done/total and percent while restoring hydrate is in flight', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            searchableChunks: 0,
            inventoryFiles: 0,
            hydrateProgress: { done: 12, total: 40 },
        });
        expect(report.mode).toBe('restoring');
        expect(report.health).toBe('restoring');
        expect(report.hydrateProgress).toEqual({ done: 12, total: 40, percent: 30 });
        expect(visibleProgressText(report.compact)).toBe(`${INDEX_STATUS_COPY.restoring.compact} 12/40 · 30%`);
        expect(visibleProgressText(report.label)).toContain('12 / 40');
        expect(visibleProgressText(report.label)).toContain('30%');
        expect(report.compact).toMatch(/\d/);
        expect(report.label).not.toBe(INDEX_STATUS_COPY.restoring.label);
    });

    it('appends the same counts while boot hydrate is Restoring, not Starting', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            booting: true,
            hydrating: true,
            bootDecisionPending: true,
            searchableChunks: null,
            inventoryFiles: 0,
            hydrateProgress: { done: 3, total: 63 },
        });
        expect(report.mode).toBe('restoring');
        expect(visibleProgressText(report.compact)).toBe(`${INDEX_STATUS_COPY.restoring.compact} 3/63 · ${indexPercent(3, 63)}%`);
        expect(visibleProgressText(report.label)).toMatch(/3 \/ 63/);
        expect(report.compact).not.toMatch(/Starting/i);
        expect(report.label).not.toMatch(/Starting/i);
    });

    it('Consumer boot restore paints file counts before sidecarHydrating latches', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            booting: true,
            hydrating: false,
            mayFullReindex: false,
            searchableChunks: null,
            inventoryFiles: 12,
            hydrateProgress: { done: 12, total: 63 },
        });
        expect(report.mode).toBe('restoring');
        expect(visibleProgressText(report.compact)).toBe(`${INDEX_STATUS_COPY.restoring.compact} 12/63 · ${indexPercent(12, 63)}%`);
        expect(report.hydrateProgress).toEqual({ done: 12, total: 63, percent: indexPercent(12, 63) });
    });

    it('wait-for-producer restoring uses inventory-vs-vault file counts', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            waitingForSidecar: true,
            hydrating: true,
            searchableChunks: 0,
            inventoryFiles: 0,
            hydrateProgress: { done: 0, total: 63 },
        });
        expect(report.mode).toBe('restoring');
        expect(visibleProgressText(report.compact)).toBe('Restoring 0/63 · 0%');
        expect(visibleProgressText(report.label)).toContain('0 / 63');
    });

    it('surfaces skipped partial notes in restoring copy', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            waitingForSidecar: true,
            peerSyncPending: true,
            hydrating: false,
            searchableChunks: 0,
            inventoryFiles: 0,
            sidecarSkippedPartialNotes: 3,
        });
        expect(report.compact).toContain('3 notes awaiting sidecar bytes');
        expect(report.label).toContain('3 notes awaiting sidecar bytes');
    });

    it('does not keep a leftover 1/1 hydrate walk after hydrate has stopped', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            booting: true,
            hydrating: false,
            goodEnough: true,
            searchableChunks: 450,
            inventoryFiles: 123,
            hydrateProgress: { done: 1, total: 1 },
        });
        expect(report.hydrateProgress).toBeNull();
        expect(report.compact).not.toMatch(/1\/1/);
        expect(report.label).not.toMatch(/100%/);
    });

    it('does not invent numbers when hydrate has no total yet', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            searchableChunks: 0,
            inventoryFiles: 0,
            hydrateProgress: { done: 0, total: 0 },
        });
        expect(report.mode).toBe('restoring');
        expect(report.compact).toBe(INDEX_STATUS_COPY.restoring.compact);
        expect(report.label).toBe(INDEX_STATUS_COPY.restoring.label);
        expect(report.hydrateProgress).toBeNull();
    });

    it('stuck stays stuck with no hydrate counts', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            stuck: true,
            hydrating: true,
            hydrateProgress: { done: 4, total: 40 },
        });
        expect(report.mode).toBe('stuck');
        expect(report.compact).toBe(INDEX_STATUS_COPY.stuck.compact);
        expect(report.label).toBe(INDEX_STATUS_COPY.stuck.label);
        expect(report.hydrateProgress).toBeNull();
    });

    it('greedy hydrate on a populated store stays Indexing but uses hydrate file counts, not a catch-up job', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            goodEnough: true,
            indexing: true,
            job: { done: 1, total: 8 },
            jobKind: 'catchup',
            searchableChunks: 400,
            inventoryFiles: 80,
            hydrateProgress: { done: 21, total: 80 },
        });
        expect(report.mode).toBe('indexing');
        expect(visibleProgressText(report.compact)).toBe(`${INDEX_STATUS_COPY.indexing.compact} 21/80 · 26%`);
        expect(report.hydrateProgress).toEqual({ done: 21, total: 80, percent: 26 });
    });

    it('catch-up without hydrate still uses static Indexing copy (job stays on the bar)', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            indexing: true,
            jobKind: 'catchup',
            job: { done: 2, total: 8 },
        });
        expect(report.mode).toBe('catching-up');
        expect(report.compact.startsWith(INDEX_STATUS_COPY['catching-up'].compact)).toBe(true);
        expect(report.hydrateProgress).toBeNull();
    });
});

describe('footer + Settings card read reporter hydrate copy', () => {
    it('search-modal footer compact matches the reporter', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            searchableChunks: 0,
            inventoryFiles: 0,
            hydrateProgress: { done: 12, total: 40 },
        });
        const footer = indexFooterStatus({
            kind: 'restoring',
            modelReady: true,
            phase: 'hydrating',
            health: 'healthy',
            uiHealth: 'restoring',
            statusReport: report,
        });
        expect(footer.kind).toBe('restoring');
        expect(footer.label).toBe(report.compact);
        expect(visibleProgressText(footer.label)).toContain('12/40');
    });

    it('Settings Index card keeps a short heading and puts counts in the metric slot', () => {
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            searchableChunks: 0,
            inventoryFiles: 0,
            hydrateProgress: { done: 12, total: 40 },
        });
        const root = stubEl();
        renderIndexStatusCard(root as unknown as HTMLElement, {
            health: report.health,
            mode: report.mode,
            label: report.label,
            hydrateProgress: report.hydrateProgress,
            stats: { files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
        });
        expect(root.querySelector('.seek-status-card-main')).not.toBeNull();
        expect(root.querySelectorAll('.seek-status-metric').length).toBe(3);
        expect(root.querySelector('.seek-status-label')?.textContent).toBe(INDEX_STATUS_COPY.restoring.label);
        expect(visibleProgressText(textOf(root))).toContain(visibleProgressText(formatStableLabelProgress(12, 40, 30)));
        expect(textOf(root)).not.toContain('Indexing');
    });

    it('bar compact and Settings do not paint 1/3132 · 1% after a batch {1,1}', () => {
        const progress = resolveSidecarHydrateProgress({
            walk: { done: 1, total: 1 },
            hydrating: true,
            waitingForSidecar: false,
            dropRecovering: false,
            bootPending: true,
            goodEnough: false,
            inventoryFiles: 839,
            indexableNotes: 3132,
        });
        expect(progress).toEqual({ done: 839, total: 3132 });
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            mayFullReindex: false,
            searchableChunks: 839,
            inventoryFiles: 839,
            hydrateProgress: progress,
        });
        expect(visibleProgressText(report.compact)).not.toMatch(/1\/3,132|1\/3132/);
        expect(visibleProgressText(report.compact)).toContain('839');
        expect(visibleProgressText(report.compact)).not.toMatch(/· 1%/);
        const card = stubEl();
        renderIndexStatusCard(card as unknown as HTMLElement, {
            health: report.health,
            mode: report.mode,
            label: report.label,
            hydrateProgress: report.hydrateProgress,
            stats: { files: 839, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
        });
        expect(visibleProgressText(textOf(card))).toContain(visibleProgressText(formatStableLabelProgress(839, 3132, indexPercent(839, 3132))));
        expect(visibleProgressText(textOf(card))).not.toMatch(/1 \/ 3,132|1 \/ 3132/);
        const labels: string[] = [];
        const root = stubEl();
        root.setAttr = (key: string, value: string) => { if (key === 'aria-label') labels.push(value); };
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, {
            getStats: async () => ({ files: 839, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null }),
            getReport: () => report,
            onOpenSettings: () => {},
            onRecover: () => {},
        });
        expect(root.querySelector('.seek-status-bar-files')?.textContent).toBe(formatStableFileFraction(839, 3132));
        expect(labels.at(-1)).not.toMatch(/1\/3,132|1\/3132/);
        expect(labels.at(-1)).toMatch(/839/);
    });
});

describe('status bar compact label while hydrating', () => {
    it('paints files done/total on idle Restoring instead of a bare Seek label', () => {
        const labels: string[] = [];
        const root = stubEl();
        root.setAttr = (key: string, value: string) => { if (key === 'aria-label') labels.push(value); };
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            searchableChunks: 0,
            inventoryFiles: 0,
            hydrateProgress: { done: 12, total: 40 },
        });
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, {
            getStats: async () => ({ files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null }),
            getReport: () => report,
            onOpenSettings: () => {},
            onRecover: () => {},
        });
        expect(root.querySelector('.seek-status-bar-files')?.textContent).toBe(formatStableFileFraction(12, 40));
        expect(root.querySelector('.seek-dot')?.className).toContain('seek-dot-info');
        expect(labels.at(-1)).toBe(`Seek: ${report.compact}`);
        expect(labels.at(-1)).toMatch(/12\/40/);
        expect(root.querySelector('progress')?.className).not.toContain('is-hidden');
        expect(root.querySelector('progress')?.value).toBe(30);
    });

    it('Consumer boot hydrate paints Restoring counts, not a bare Starting up', () => {
        const labels: string[] = [];
        const root = stubEl();
        root.setAttr = (key: string, value: string) => { if (key === 'aria-label') labels.push(value); };
        const report = IndexStatusReporter.compute({
            ...idle,
            booting: true,
            hydrating: true,
            mayFullReindex: false,
            bootDecisionPending: true,
            searchableChunks: null,
            inventoryFiles: 0,
            hydrateProgress: { done: 18, total: 63 },
        });
        expect(report.mode).toBe('restoring');
        expect(report.compact).toMatch(/18\/63/);
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, {
            getStats: async () => ({ files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null }),
            getReport: () => report,
            onOpenSettings: () => {},
            onRecover: () => {},
        });
        expect(root.querySelector('.seek-status-bar-files')?.textContent).toBe(formatStableFileFraction(18, 63));
        expect(labels.at(-1)).toMatch(/Restoring/);
        expect(labels.at(-1)).toMatch(/18\/63/);
        expect(labels.at(-1)).not.toMatch(/Starting/);
        expect(root.querySelector('progress')?.className).not.toContain('is-hidden');
    });

    it('leftover catch-up job during restoring still shows hydrate counts, not Indexing', () => {
        const labels: string[] = [];
        const root = stubEl();
        root.setAttr = (key: string, value: string) => { if (key === 'aria-label') labels.push(value); };
        const report = IndexStatusReporter.compute({
            ...idle,
            hydrating: true,
            indexing: true,
            job: { done: 0, total: 80 },
            jobKind: 'catchup',
            searchableChunks: 0,
            inventoryFiles: 0,
            hydrateProgress: { done: 5, total: 80 },
        });
        expect(report.mode).toBe('restoring');
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, {
            getStats: async () => ({ files: 0, chunks: 0, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null }),
            getReport: () => report,
            onOpenSettings: () => {},
            onRecover: () => {},
        });
        bar.show(80, 'Seek: indexing…', { id: 1, kind: 'catchup' });
        expect(root.querySelector('.seek-status-bar-files')?.textContent).toBe(formatStableFileFraction(5, 80));
        expect(labels.at(-1)).toMatch(/Restoring/);
        expect(labels.at(-1)).toMatch(/5\/80/);
        expect(labels.at(-1)).not.toMatch(/Indexing 0 \/ 80/);
    });
});
