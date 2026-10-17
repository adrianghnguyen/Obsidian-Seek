import { describe, it, expect } from 'vitest';
import {
    EMBED_METRIC_HELP,
    fmtPhaseDuration,
    fmtRate,
    renderEmbedDiagnostic,
    renderCoverageDiagnostic,
    renderSettingsIndexStatusCard,
} from './index-status-settings';
import type { IndexCompleteEntry, LoadEntry } from '../types/types';
import { embedDerivedFromInputs } from './index-progress-snapshot';

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
        paddedTokens: 1_172_000,
        tokensPerSec: 4520,
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
        expect(EMBED_METRIC_HELP['tok/s']).toMatch(/tokens/i);
        expect(EMBED_METRIC_HELP.pace).toMatch(/waited/);
    });
});

describe('renderEmbedDiagnostic', () => {
    it('folded header shows last-pass rates without body', () => {
        const card = stubEl();
        const complete = sampleComplete();
        renderEmbedDiagnostic(card as unknown as HTMLElement, {
            open: false,
            onToggle: () => {},
            live: null,
            lastComplete: complete,
            lastLoad: sampleLoad(),
            derived: embedDerivedFromInputs(null, complete),
        });
        const blob = textOf(card);
        expect(blob).toContain('Embedding pass');
        expect(blob).toContain('6.1');
        expect(blob).toContain('1.2');
        expect(blob).toContain('4520');
        expect(blob).toContain('tok/s');
        expect(blob).toContain('Last pass');
        expect(blob).not.toContain('Phases');
        expect(card.querySelector('.seek-status-embed-body')).toBeNull();
    });

    it('unrolled live pass shows this-run files and hides last-pass phases', () => {
        const card = stubEl();
        const live = {
            chunksDone: 18402,
            tokensDone: 920_100,
            done: 2856,
            total: 2998,
            elapsedMs: 60_000,
            paused: false,
            kind: 'catchup' as const,
        };
        renderEmbedDiagnostic(card as unknown as HTMLElement, {
            open: true,
            onToggle: () => {},
            live,
            lastComplete: sampleComplete(),
            lastLoad: sampleLoad(),
            derived: embedDerivedFromInputs(live, sampleComplete()),
        });
        const blob = textOf(card);
        expect(blob).toContain('Live');
        expect(blob).toContain('Catch-up');
        expect(blob).toContain('2,856');
        expect(blob).toContain('18,402');
        expect(blob).toContain('1m 0s');
        expect(blob).not.toContain('From last completed pass');
        expect(blob).not.toContain('Phases');
        expect(blob).not.toContain('3m 12s');
        expect(blob).toContain('webgpu');
        expect(blob).toContain('1.8s');
        expect(card.querySelector('.seek-status-embed-grid')).not.toBeNull();
        expect(card.querySelector('.seek-status-embed-body')).not.toBeNull();
    });

    it('folded header always includes tok/s slot (dash when unknown)', () => {
        const card = stubEl();
        const complete = sampleComplete({ tokensPerSec: undefined, paddedTokens: undefined });
        renderEmbedDiagnostic(card as unknown as HTMLElement, {
            open: false,
            onToggle: () => {},
            live: null,
            lastComplete: complete,
            lastLoad: null,
            derived: embedDerivedFromInputs(null, complete),
        });
        const blob = textOf(card);
        expect(blob).toContain('tok/s');
        expect(blob).toContain('ch/s');
        expect(blob).toContain('files/s');
    });

    it('derives last-pass tok/s from paddedTokens when tokensPerSec missing', () => {
        const card = stubEl();
        const complete = sampleComplete({
            tokensPerSec: undefined,
            paddedTokens: 258_000,
            totalDurationMs: 258_000,
        });
        renderEmbedDiagnostic(card as unknown as HTMLElement, {
            open: false,
            onToggle: () => {},
            live: null,
            lastComplete: complete,
            lastLoad: null,
            derived: embedDerivedFromInputs(null, complete),
        });
        expect(textOf(card)).toContain('1000');
        expect(textOf(card)).toContain('tok/s');
    });

    it('unrolled shows encoder-feed occupancy when pipeline fields are present', () => {
        const card = stubEl();
        const complete = sampleComplete({
            gpuBusyMs: 129_000,
            persistWaitMs: 800,
            inflightHighWater: 8,
            embedInFlightMax: 10,
            effectiveBatch: 7.9,
        });
        renderEmbedDiagnostic(card as unknown as HTMLElement, {
            open: true,
            onToggle: () => {},
            live: null,
            lastComplete: complete,
            lastLoad: sampleLoad(),
            derived: embedDerivedFromInputs(null, complete),
        });
        const blob = textOf(card);
        expect(blob).toContain('Encoder feed');
        expect(blob).toContain('50%');
        expect(blob).toContain('8 / 10');
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

    it('coverage disclosure sits below embed and stays collapsed by default', () => {
        const root = stubEl();
        renderSettingsIndexStatusCard(root as unknown as HTMLElement, {
            health: 'ok',
            stats: { files: 10, chunks: 40, lastFullAt: '2026-10-17T13:42:00.000Z', lastFullDurationMs: 12_300, lastUpdatedAt: null },
            embedDiag: {
                open: false,
                onToggle: () => {},
                live: null,
                lastComplete: sampleComplete(),
                lastLoad: null,
                derived: embedDerivedFromInputs(null, sampleComplete()),
            },
            coverage: {
                open: false,
                onToggle: () => {},
                headline: { done: 80, total: 80, caption: 'in the index', live: false, percent: 100 },
                roleHint: 'This device copies the lead computer’s index files. Folder cells are notes already searchable, not a local embed pass.',
                attachBody: () => { throw new Error('collapsed coverage must not attach the tree'); },
            },
        });
        expect(root.querySelector('.seek-status-coverage')).not.toBeNull();
        expect(textOf(root)).toContain('Index coverage by folder');
        expect(root.querySelector('.seek-status-coverage-body')).toBeNull();
        expect(textOf(root.querySelector('.seek-status-last') as StubEl)).not.toMatch(/12\.3s/);
    });

    it('expanded coverage disclosure mounts the folder host', () => {
        const root = stubEl();
        let attached = false;
        renderCoverageDiagnostic(root as unknown as HTMLElement, {
            open: true,
            onToggle: () => {},
            headline: { done: 12, total: 40, caption: 'this restore', live: true, percent: 30 },
            roleHint: 'Share of notes already searchable. Same counts as the status bar.',
            attachBody: (host) => {
                attached = true;
                host.createDiv({ cls: 'seek-coverage-panel', text: 'tree' });
            },
        });
        expect(attached).toBe(true);
        expect(root.querySelector('.seek-coverage-host')).not.toBeNull();
        expect(textOf(root)).toContain('12 / 40 · 30%');
    });
});

describe('fmtRate', () => {
    it('keeps sub-1 rates readable instead of rounding to 0.0', () => {
        expect(fmtRate(0.048)).toBe('0.05');
        expect(fmtRate(0)).toBe('—');
        expect(fmtRate(6.1)).toBe('6.1');
        expect(fmtRate(12.4)).toBe('12');
    });
});
