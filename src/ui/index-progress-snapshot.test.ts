import { describe, it, expect } from 'vitest';
import {
    buildIndexProgressSnapshot,
    coverageHeadlineFromProgress,
    resolveIndexProgressPhase,
    type IndexProgressSnapshot,
} from './index-progress-snapshot';
import { INDEX_STATUS_COPY, resolveIndexStatusHelpForMode, type IndexStatusReport } from './index-status-report';
import { indexPercent } from './index-eta';
import { renderIndexStatusCard } from './index-status-card';
import { formatStableFileFraction } from './index-progress-format';
import { IndexStatusBar } from './index-status-bar';
import { computeFolderCoverage, createLiveCoverageSnapshot } from '../index/folder-coverage';

function reportOf(
    health: IndexStatusReport['health'],
    over: Partial<IndexStatusReport> = {},
): IndexStatusReport {
    const mode = over.mode ?? (health === 'indexing' ? 'indexing' : health);
    const copy = INDEX_STATUS_COPY[mode];
    return {
        mode,
        health,
        label: copy.label,
        compact: copy.compact,
        tone: copy.tone,
        help: resolveIndexStatusHelpForMode(mode),
        hydrateProgress: null,
        progress: { phase: 'ready', units: null },
        ...over,
    };
}

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
            const walk = (n: any): any => {
                if (sel.startsWith('.')) {
                    if (n.className.split(/\s+/).includes(sel.slice(1))) return n;
                } else if (n.tagName === sel) return n;
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

function textOf(el: any): string {
    return [el.textContent, ...el.children.map(textOf)].join(' ');
}

describe('resolveIndexProgressPhase', () => {
    it('hydrate file-walk beats a leftover catch-up job', () => {
        expect(resolveIndexProgressPhase({
            health: 'restoring',
            hydrate: { done: 5, total: 80 },
            job: { done: 0, total: 80, kind: 'catchup' },
        })).toBe('hydrate');
    });

    it('embed wins when indexing with a live job and no hydrate', () => {
        expect(resolveIndexProgressPhase({
            health: 'indexing',
            hydrate: null,
            job: { done: 12, total: 100, kind: 'full' },
        })).toBe('embed');
    });
});

describe('buildIndexProgressSnapshot', () => {
    it('uses hydrate files and drops leftover catch-up speed', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('restoring', {
                mode: 'restoring',
                hydrateProgress: { done: 21, total: 80, percent: 26 },
                compact: 'Restoring 21/80 · 26%',
                label: 'Restoring… 21 / 80 · 26%',
            }),
            job: { done: 1, total: 8, kind: 'catchup' },
            speed: {
                done: 1, total: 8, chunksDone: 4, tokensDone: 100, elapsedMs: 500, paused: false, kind: 'catchup',
            },
            inventoryChunks: 400,
        });
        expect(snap.phase).toBe('hydrate');
        expect(snap.kind).toBe('hydrate');
        expect(snap.filesDone).toBe(21);
        expect(snap.filesTotal).toBe(80);
        expect(snap.chunksDone).toBe(400);
        expect(snap.tokensDone).toBe(0);
        expect(snap.speed).toBeNull();
        expect(snap.job?.done).toBe(21);
        expect(snap.job?.total).toBe(80);
        expect(snap.hydrate).toEqual({ done: 21, total: 80, percent: 26 });
        expect(snap.percent).toBe(26);
    });

    it('prefers pass counts over coverage for catchup jobs', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('indexing', {
                mode: 'catching-up',
                progress: {
                    phase: 'catching-up',
                    units: { done: 3, total: 5, percent: 60, determinate: true },
                },
            }),
            job: { done: 3, total: 5, kind: 'catchup' },
            speed: {
                done: 3, total: 5, chunksDone: 10, tokensDone: 500,
                elapsedMs: 1000, paused: false, kind: 'catchup',
            },
            inventoryFiles: 240,
            coverage: { covered: 240, total: 244 },
        });
        expect(snap.phase).toBe('embed');
        expect(snap.filesDone).toBe(3);
        expect(snap.filesTotal).toBe(5);
        expect(snap.speed?.done).toBe(3);
        expect(snap.speed?.total).toBe(5);
    });

    it('prefers coverage FileRecords over files-started during an embed pass', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('indexing', { mode: 'full-reindex' }),
            job: { done: 500, total: 2998, kind: 'full' },
            speed: {
                done: 500, total: 2998, chunksDone: 1840, tokensDone: 920_100,
                elapsedMs: 12_000, paused: false, kind: 'full',
            },
            inventoryFiles: 200,
            inventoryChunks: 800,
            coverage: { covered: 200, total: 3037 },
        });
        expect(snap.phase).toBe('embed');
        expect(snap.kind).toBe('full');
        expect(snap.filesDone).toBe(200);
        expect(snap.filesTotal).toBe(3037);
        expect(snap.chunksDone).toBe(1840);
        expect(snap.tokensDone).toBe(920_100);
        expect(snap.speed?.done).toBe(500);
        expect(snap.speed?.total).toBe(2998);
        expect(snap.speed?.chunksDone).toBe(1840);
        expect(snap.job?.done).toBe(snap.filesDone);
        expect(snap.job?.total).toBe(snap.filesTotal);
        expect(snap.percent).toBe(indexPercent(200, 3037));
    });

    it('falls back to files-started when coverage and inventory are unknown', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('indexing', { mode: 'full-reindex' }),
            job: { done: 500, total: 2998, kind: 'full' },
            speed: {
                done: 500, total: 2998, chunksDone: 1840, tokensDone: 920_100,
                elapsedMs: 12_000, paused: false, kind: 'full',
            },
        });
        expect(snap.filesDone).toBe(500);
        expect(snap.filesTotal).toBe(2998);
        expect(snap.speed?.done).toBe(500);
        expect(snap.percent).toBe(indexPercent(500, 2998));
    });

    it('idle inventory does not paint 123/123 as complete against a large vault', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('ok'),
            job: null,
            speed: null,
            inventoryFiles: 123,
            inventoryChunks: 450,
            indexableNotes: 4864,
        });
        expect(snap.phase).toBe('idle');
        expect(snap.filesDone).toBe(123);
        expect(snap.filesTotal).toBe(4864);
        expect(snap.percent).toBe(indexPercent(123, 4864));
        expect(snap.percent).toBeLessThan(100);
    });

    it('idle overlay uses coverage FileRecords, not raw inventory', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('ok'),
            job: null,
            speed: null,
            inventoryFiles: 3100,
            inventoryChunks: 12_000,
            coverage: { covered: 3024, total: 3037 },
        });
        expect(snap.phase).toBe('idle');
        expect(snap.filesDone).toBe(3024);
        expect(snap.filesTotal).toBe(3037);
        expect(snap.chunksDone).toBe(12_000);
        expect(snap.job).toBeNull();
        expect(snap.speed).toBeNull();
    });

    it('precomputes remaining, rates, ETA, GPU occupancy, batch, and idle coverage headline', () => {
        const live = buildIndexProgressSnapshot({
            report: reportOf('indexing', { mode: 'full-reindex' }),
            job: { done: 50, total: 200, kind: 'full' },
            speed: {
                done: 50, total: 200, chunksDone: 100, tokensDone: 50_000,
                elapsedMs: 20_000, paused: false, kind: 'full',
            },
            lastComplete: {
                chunksPerSec: 12,
                filesPerSec: 3,
                tokensPerSec: 900,
                totalDurationMs: 100_000,
                gpuBusyMs: 40_000,
                vectorsWritten: 790,
                embedBatchLatencyMs: { n: 100 },
            },
        });
        expect(live.percent).toBe(indexPercent(50, 200));
        expect(live.remaining).toBe(150);
        expect(live.eta).toBe('~2 min');
        expect(live.rates?.chunksPerSec).toBe(5);
        expect(live.rates?.filesPerSec).toBe(2.5);
        expect(live.rates?.tokensPerSec).toBe(2500);
        expect(live.embed.pill).toBe('live');
        expect(live.embed.gpuOccupancyPct).toBe(40);
        expect(live.embed.effectiveBatch).toBe(7.9);

        const idle = buildIndexProgressSnapshot({
            report: reportOf('ok'),
            job: null,
            speed: null,
            coverage: { covered: 80, total: 100 },
        });
        expect(idle.percent).toBe(indexPercent(80, 100));
        expect(idle.coverageHeadline.percent).toBe(idle.percent);
        expect(idle.coverageHeadline.caption).toBe('in the index');
        expect(idle.coverageHeadline.live).toBe(false);
    });
});

describe('status card formats snapshot percent and remaining', () => {
    it('does not recompute percent from job.done/total', () => {
        const card = stubEl();
        renderIndexStatusCard(card as unknown as HTMLElement, {
            health: 'indexing',
            mode: 'indexing',
            stats: { files: 5, chunks: 18, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
            job: { done: 1, total: 100, kind: 'catchup' },
            percent: 42,
            remaining: 7,
        });
        const blob = textOf(card);
        expect(blob).toContain('42%');
        expect(blob).toMatch(/7/);
        expect(blob).not.toContain('1%');
    });
});

describe('coverageHeadlineFromProgress', () => {
    it('keeps in-the-index FileRecords during an embed pass', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('indexing', { mode: 'full-reindex' }),
            job: { done: 500, total: 2998, kind: 'full' },
            speed: {
                done: 500, total: 2998, chunksDone: 1, tokensDone: 1,
                elapsedMs: 20_000, paused: false, kind: 'full',
            },
            coverage: { covered: 200, total: 3037 },
        });
        const headline = coverageHeadlineFromProgress(snap);
        expect(headline.live).toBe(false);
        expect(headline.caption).toBe('in the index');
        expect(headline.done).toBe(200);
        expect(headline.total).toBe(3037);
        expect(headline.percent).toBe(snap.percent);
        expect(headline.percent).toBe(indexPercent(200, 3037));
    });

    it('uses hydrate walk counts for this restore', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('restoring', {
                mode: 'restoring',
                hydrateProgress: { done: 21, total: 80, percent: 26 },
                progress: { phase: 'hydrating', units: { done: 21, total: 80, percent: 26, determinate: true } },
            }),
            job: null,
            speed: null,
        });
        const headline = coverageHeadlineFromProgress(snap);
        expect(headline.live).toBe(true);
        expect(headline.caption).toBe('this restore');
        expect(headline.done).toBe(21);
        expect(headline.total).toBe(80);
        expect(headline.percent).toBe(26);
    });

    it('keeps in-the-index FileRecords when idle', () => {
        const snap = buildIndexProgressSnapshot({
            report: reportOf('ok'),
            job: null,
            speed: null,
            coverage: { covered: 3024, total: 3037 },
        });
        const headline = coverageHeadlineFromProgress(snap);
        expect(headline.live).toBe(false);
        expect(headline.caption).toBe('in the index');
        expect(headline.done).toBe(3024);
        expect(headline.total).toBe(3037);
        expect(headline.percent).toBe(snap.percent);
    });
});

describe('three surfaces read the same snapshot', () => {
    function countsOf(snap: IndexProgressSnapshot) {
        return {
            filesDone: snap.filesDone,
            filesTotal: snap.filesTotal,
            percent: snap.percent,
            chunksDone: snap.chunksDone,
            tokensDone: snap.tokensDone,
            kind: snap.kind,
            phase: snap.phase,
        };
    }

    it('status bar, Settings card, and coverage headline share coverage files', () => {
        const report = reportOf('indexing', { mode: 'full-reindex' });
        const job = { done: 34, total: 216, kind: 'full' as const };
        const speed = {
            done: 34, total: 216, chunksDone: 88, tokensDone: 62_081,
            elapsedMs: 4000, paused: false, kind: 'full' as const,
        };
        const coverage = { covered: 40, total: 216 };
        const snap = buildIndexProgressSnapshot({
            report, job, speed, coverage, inventoryFiles: 40, inventoryChunks: 88,
        });
        const summary = computeFolderCoverage({
            allPaths: Array.from({ length: 216 }, (_, i) => `n${i}.md`),
            coveredPaths: Array.from({ length: 40 }, (_, i) => `n${i}.md`),
            excludedPaths: [],
        });
        const coverageSnap = createLiveCoverageSnapshot({ summary, progress: snap });
        const headline = coverageHeadlineFromProgress(coverageSnap.progress);

        const root = stubEl();
        const bar = new IndexStatusBar();
        bar.mount(root as unknown as HTMLElement, {
            getStats: async () => ({ files: 1, chunks: 2, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null }),
            getReport: () => report,
            getSnapshot: () => snap,
            onOpenSettings: () => {},
            onRecover: () => {},
        });
        bar.show(216, 'Seek: indexing…', { id: 1, kind: 'full' });
        bar.update(34, 216, undefined, 1, 88, 62_081);

        const card = stubEl();
        renderIndexStatusCard(card as unknown as HTMLElement, {
            health: snap.health,
            mode: snap.mode,
            label: snap.report.label,
            hydrateProgress: snap.hydrate,
            stats: { files: 1, chunks: 2, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
            job: snap.job,
            percent: snap.percent,
            remaining: snap.remaining,
            eta: snap.eta,
        });

        expect(countsOf(bar.progressSnapshot())).toEqual(countsOf(snap));
        expect(countsOf(coverageSnap.progress)).toEqual(countsOf(snap));
        expect(headline.done).toBe(snap.filesDone);
        expect(headline.total).toBe(snap.filesTotal);
        expect(headline.caption).toBe('in the index');
        expect(root.querySelector('.seek-status-bar-files')?.textContent).toBe(formatStableFileFraction(40, 216));
        expect(textOf(card)).toMatch(/40/);
        expect(textOf(card)).toMatch(/216/);
        expect(snap.speed?.done).toBe(34);
        expect(snap.speed?.chunksDone).toBe(88);
        expect(snap.tokensDone).toBe(62_081);
    });
});
