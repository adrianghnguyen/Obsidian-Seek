import { describe, it, expect } from 'vitest';
import {
    EMBED_METRIC_HELP,
    fmtPhaseDuration,
    fmtRate,
    renderEmbedDiagnostic,
    renderSettingsIndexStatusCard,
} from './index-status-settings';
import type { IndexCompleteEntry, LoadEntry } from './types';

interface StubEl {
    tagName: string;
    className: string;
    textContent: string;
    children: StubEl[];
    attrs: Record<string, string>;
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
        children: [],
        attrs: {},
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
        setAttr(key, value) { el.attrs[key] = value; },
        addEventListener() { /* unused */ },
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

function sampleComplete(over: Partial<IndexCompleteEntry> = {}): IndexCompleteEntry {
    return {
        type: 'index-complete',
        timestamp: '2026-09-06T12:00:00.000Z',
        mode: 'incremental',
        dtype: 'q8',
        embeddingDim: 768,
        filesIndexed: 2856,
        committedFilePaths: [],
        chunksIndexed: 18402,
        vectorsWritten: 18402,
        filesSkippedError: 0,
        embedRecycles: 0,
        embedDurationMs: 192_000,
        chunkDurationMs: 42_000,
        bm25DurationMs: 0,
        commitDurationMs: 18_000,
        totalDurationMs: 258_000,
        heapDeltaMB: null,
        storageDeltaMB: null,
        chunksPerSec: 6.1,
        filesPerSec: 1.2,
        perFileWallMs: null,
        chunksPerFile: null,
        embedBatchLatencyMs: { n: 412, min: 10, max: 200, mean: 50, p50: 48, p95: 91 },
        paceWaitMs: 6000,
        pass: true,
        checks: [],
        ...over,
    };
}

function sampleLoad(over: Partial<LoadEntry> = {}): LoadEntry {
    return {
        type: 'load',
        timestamp: '2026-09-06T11:00:00.000Z',
        requestedDevice: 'webgpu',
        actualDevice: 'webgpu',
        dtype: 'q8',
        embeddingDim: 768,
        coldStartMs: 1800,
        warmupMs: 400,
        warmupSkipped: false,
        heapBeforeMB: null,
        heapAfterMB: null,
        heapDeltaMB: null,
        storageBeforeMB: null,
        storageAfterMB: null,
        storageDeltaMB: null,
        webgpuAttempted: true,
        webgpuFailed: false,
        webgpuError: null,
        glue: null,
        proxy: false,
        proxyAttempted: false,
        proxyError: null,
        pass: true,
        checks: [],
        ...over,
    };
}

describe('fmtPhaseDuration', () => {
    it('formats ms, seconds, and minutes', () => {
        expect(fmtPhaseDuration(480)).toBe('480ms');
        expect(fmtPhaseDuration(4200)).toBe('4.2s');
        expect(fmtPhaseDuration(42_000)).toBe('42s');
        expect(fmtPhaseDuration(192_000)).toBe('3m 12s');
    });
});

describe('fmtRate', () => {
    it('shows one decimal under 10', () => {
        expect(fmtRate(0)).toBe('—');
        expect(fmtRate(4.2)).toBe('4.2');
        expect(fmtRate(12.3)).toBe('12');
    });
});

describe('EMBED_METRIC_HELP', () => {
    it('covers core labels', () => {
        expect(EMBED_METRIC_HELP['ch/s']).toMatch(/Chunks finished/);
        expect(EMBED_METRIC_HELP.pace).toMatch(/waited/);
    });
});

describe('renderEmbedDiagnostic', () => {
    it('folded header shows last-pass rates without body', () => {
        const card = stubEl();
        renderEmbedDiagnostic(card as unknown as HTMLElement, {
            open: false,
            onToggle: () => {},
            live: null,
            lastComplete: sampleComplete(),
            lastLoad: sampleLoad(),
        });
        const blob = textOf(card);
        expect(blob).toContain('embedding');
        expect(blob).toContain('6.1');
        expect(blob).toContain('1.2');
        expect(blob).toContain('last pass');
        expect(blob).not.toContain('phases');
        expect(card.querySelector('.seek-status-embed-body')).toBeNull();
    });

    it('unrolled shows phases batch health model and last-completed note while live', () => {
        const card = stubEl();
        renderEmbedDiagnostic(card as unknown as HTMLElement, {
            open: true,
            onToggle: () => {},
            live: {
                chunksDone: 18402,
                done: 2856,
                total: 2998,
                elapsedMs: 60_000,
                paused: false,
                kind: 'catchup',
            },
            lastComplete: sampleComplete(),
            lastLoad: sampleLoad(),
        });
        const blob = textOf(card);
        expect(blob).toContain('live');
        expect(blob).toContain('catch-up');
        expect(blob).toContain('last completed');
        expect(blob).toContain('phases');
        expect(blob).toContain('3m 12s');
        expect(blob).toContain('412');
        expect(blob).toContain('webgpu');
        expect(blob).toContain('1.8s');
        expect(card.querySelector('.seek-status-embed-body')).not.toBeNull();
    });

    it('renderSettingsIndexStatusCard appends embed block after startup', () => {
        const root = stubEl();
        renderSettingsIndexStatusCard(root as unknown as HTMLElement, {
            health: 'ok',
            stats: { files: 10, chunks: 40, lastFullAt: null, lastFullDurationMs: null, lastUpdatedAt: null },
            embedDiag: {
                open: false,
                onToggle: () => {},
                live: null,
                lastComplete: sampleComplete(),
                lastLoad: null,
            },
        });
        expect(root.querySelector('.seek-status-startup')).not.toBeNull();
        expect(root.querySelector('.seek-status-embed')).not.toBeNull();
    });
});
