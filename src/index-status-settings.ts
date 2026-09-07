// Settings-only extensions to the shared index status card — startup latency
// breakdown and embedding diagnostics. The block always renders and fills in as
// the boot progresses: Searchable clocks live until the gate releases, Cache warm
// shows queued → live clock → final duration, Fully ready opens when warm ends (or
// carries the last boot's total plus a trend while this boot is still working).
// Status-bar hover keeps calling renderIndexStatusCard without these.

import { setIcon, setTooltip } from 'obsidian';
import {
    buildStartupTimingRows,
    startupTrend,
    fmtLatency,
    formatBootAge,
    formatStoredBootLine,
    type StartupTimingView,
    type StoredStartupBoot,
} from './session-telemetry';
import {
    renderIndexStatusCard,
    type IndexStatusHealth,
    type IndexStatusCardStats,
    type IndexStatusJob,
    type IndexJobKind,
} from './index-status-card';
import {
    indexChunksPerSec,
    indexFilesPerSec,
    type IndexJobSpeedView,
} from './index-status-bar';
import type { IndexCompleteEntry, LoadEntry } from './types';

/** Novice glossary for embed-metric labels (hover target = muted label). */
export const EMBED_METRIC_HELP: Record<string, string> = {
    embedding: 'How fast Seek is turning notes into search vectors.',
    'ch/s': 'Chunks finished per second. A chunk is a slice of a note. Higher means the encoder is moving faster.',
    'files/s': 'Notes finished per second. Usually lower than chunks/s because one note can be many slices.',
    live: 'This run is happening now. The number updates as files finish.',
    'last pass': 'From the last finished run, not this moment.',
    paused: 'Indexing is paused. Speed is frozen.',
    'this pass': 'The current run, or the last one if nothing is running.',
    full: 'Full rebuilds the whole vault.',
    'catch-up': 'Catch-up only updates notes that changed.',
    files: 'Notes Seek has finished in this run.',
    chunks: 'Slices of notes turned into vectors so search can find them.',
    phases: 'Where time went in the last finished run. These freeze until a run completes.',
    chunk: 'Reading notes and splitting them into slices. Usually the cheap part.',
    embed: 'The model turning those slices into vectors. Usually most of the time.',
    commit: 'Saving the new vectors into the local index.',
    pace: 'Time Seek waited so the rest of Obsidian stayed responsive. A large number here means the computer was busy, not that the model is slow.',
    total: 'Clock time for the whole run, including waiting.',
    batch: 'How work is sent to the model.',
    dispatches: 'How many times Seek sent a group of slices to the model.',
    'batch size': 'Average slices per send. Closer to 8 means the model is well fed.',
    p50: 'Typical time for one model batch. Half of batches were faster than this.',
    p95: 'A slow batch. Most batches were faster than this. Spikes mean hitching.',
    health: 'Whether the last run finished cleanly.',
    pass: "The run met Seek's quality bar (few skipped files).",
    skipped: 'Notes that failed and were left out of the index.',
    quarantined: 'Notes that mostly worked, but a few slices could not be encoded. The rest is still searchable.',
    recycles: 'Times the graphics encoder had to restart mid-run. Zero is healthy.',
    model: 'The encoder currently loaded.',
    webgpu: 'Which engine is running the model. WebGPU is the fast path.',
    wasm: 'Which engine is running the model. WebGPU is the fast path.',
    q4: 'How compressed the model weights are.',
    q8: 'How compressed the model weights are.',
    fp32: 'How compressed the model weights are.',
    '768d': 'How long each search vector is.',
    '384d': 'How long each search vector is.',
    cold: 'How long the model took to load this boot.',
    'last completed': 'Timings from the previous finished run while this one is still going.',
};

const EMBED_VS_PASS_HELP =
    'While indexing, the header speed is live. Phase, batch, and health rows stay on the last completed pass until this run finishes.';

/** Phase / cold durations: ms, seconds, or m+s for longer passes. */
export function fmtPhaseDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) {
        const sec = ms / 1000;
        return sec >= 10 ? `${Math.round(sec)}s` : `${sec.toFixed(1)}s`;
    }
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
}

export function fmtRate(n: number): string {
    if (!Number.isFinite(n) || n <= 0) return '—';
    return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}

function jobKindLabel(kind: IndexJobKind | undefined, mode?: 'full' | 'incremental'): string {
    if (kind === 'full' || mode === 'full') return 'full';
    if (kind === 'catchup' || kind === 'delta' || mode === 'incremental') return 'catch-up';
    return 'pass';
}

function helpLabel(parent: HTMLElement, key: string, text?: string): HTMLElement {
    const el = parent.createSpan({ cls: 'seek-embed-help', text: text ?? key });
    markHelp(el, key);
    return el;
}

function markHelp(el: HTMLElement, key: string): void {
    el.addClass('seek-embed-help');
    const tip = EMBED_METRIC_HELP[key] ?? key;
    el.setAttr('aria-label', tip);
    setTooltip(el, tip, { delay: 400 });
}

function sep(parent: HTMLElement): void {
    parent.createSpan({ cls: 'seek-embed-sep', text: ' · ' });
}

export interface EmbedDiagView {
    open: boolean;
    onToggle: () => void;
    live: IndexJobSpeedView | null;
    lastComplete: IndexCompleteEntry | null;
    lastLoad: LoadEntry | null;
}

/** Folded-by-default embedding disclosure — Settings status card only. */
export function renderEmbedDiagnostic(card: HTMLElement, view: EmbedDiagView): void {
    const live = view.live;
    const complete = view.lastComplete;
    const load = view.lastLoad;
    const jobActive = live != null;

    let chRate = 0;
    let filesRate = 0;
    let pillKey: 'live' | 'paused' | 'last pass' | null = null;
    if (jobActive) {
        chRate = indexChunksPerSec(live.chunksDone, live.elapsedMs);
        filesRate = indexFilesPerSec(live.done, live.elapsedMs);
        pillKey = live.paused ? 'paused' : 'live';
    } else if (complete) {
        chRate = complete.chunksPerSec;
        filesRate = complete.filesPerSec;
        pillKey = 'last pass';
    }

    const block = card.createDiv({ cls: 'seek-status-embed' });
    const head = block.createDiv({ cls: 'seek-status-embed-head' });
    head.setAttr('role', 'button');
    head.setAttr('tabindex', '0');
    head.setAttr('aria-expanded', view.open ? 'true' : 'false');
    head.onclick = (e) => { e.preventDefault(); view.onToggle(); };
    head.onkeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            view.onToggle();
        }
    };

    head.createSpan({ cls: 'seek-status-embed-chev', text: view.open ? '▾' : '▸' });
    const title = head.createSpan({ cls: 'seek-status-embed-title' });
    helpLabel(title, 'embedding');
    const info = title.createSpan({ cls: 'seek-status-embed-info' });
    setIcon(info, 'info');
    info.setAttr('aria-label', EMBED_VS_PASS_HELP);
    setTooltip(info, EMBED_VS_PASS_HELP, { delay: 300 });
    info.onclick = (e) => e.stopPropagation();

    const rates = head.createSpan({ cls: 'seek-status-embed-rates' });
    if (pillKey == null && chRate <= 0 && filesRate <= 0) {
        rates.createSpan({ cls: 'seek-status-embed-empty', text: '—' });
    } else {
        rates.createSpan({ cls: 'seek-status-embed-rate-val', text: fmtRate(chRate) });
        rates.createSpan({ text: ' ' });
        helpLabel(rates, 'ch/s');
        sep(rates);
        rates.createSpan({ cls: 'seek-status-embed-rate-val', text: fmtRate(filesRate) });
        rates.createSpan({ text: ' ' });
        helpLabel(rates, 'files/s');
    }

    const pill = head.createSpan({
        cls: `seek-status-embed-pill${pillKey ? '' : ' is-empty'}`,
        text: pillKey ?? 'no pass yet',
    });
    if (pillKey) markHelp(pill, pillKey);

    if (!view.open) return;

    const body = block.createDiv({ cls: 'seek-status-embed-body' });

    // —— this pass ——
    const passSec = body.createDiv({ cls: 'seek-status-embed-section' });
    helpLabel(passSec.createDiv({ cls: 'seek-status-embed-sec-head' }), 'this pass');
    const passLine = passSec.createDiv({ cls: 'seek-status-embed-line' });
    if (jobActive) {
        const kind = jobKindLabel(live.kind);
        helpLabel(passLine, kind);
        sep(passLine);
        passLine.createSpan({ text: `${live.done.toLocaleString()} ` });
        helpLabel(passLine, 'files');
        sep(passLine);
        passLine.createSpan({ text: `${live.chunksDone.toLocaleString()} ` });
        helpLabel(passLine, 'chunks');
    } else if (complete) {
        const kind = jobKindLabel(undefined, complete.mode);
        helpLabel(passLine, kind);
        sep(passLine);
        passLine.createSpan({ text: `${complete.filesIndexed.toLocaleString()} ` });
        helpLabel(passLine, 'files');
        sep(passLine);
        passLine.createSpan({ text: `${complete.chunksIndexed.toLocaleString()} ` });
        helpLabel(passLine, 'chunks');
    } else {
        passLine.createSpan({ cls: 'seek-status-embed-empty', text: '—' });
    }

    const staleLabel = jobActive && complete ? 'last completed' : null;

    // —— phases / batch / health from last completed ——
    if (complete) {
        if (staleLabel) {
            const note = body.createDiv({ cls: 'seek-status-embed-stale' });
            helpLabel(note, 'last completed');
        }

        const phases = body.createDiv({ cls: 'seek-status-embed-section' });
        helpLabel(phases.createDiv({ cls: 'seek-status-embed-sec-head' }), 'phases');
        const phaseRow = phases.createDiv({ cls: 'seek-status-embed-line seek-status-embed-phases' });
        for (const [key, ms] of [
            ['chunk', complete.chunkDurationMs],
            ['embed', complete.embedDurationMs],
            ['commit', complete.commitDurationMs],
            ['pace', complete.paceWaitMs ?? 0],
        ] as const) {
            const cell = phaseRow.createSpan({ cls: 'seek-status-embed-phase' });
            helpLabel(cell, key);
            cell.createSpan({ text: ` ${fmtPhaseDuration(ms)}` });
        }
        const totalRow = phases.createDiv({ cls: 'seek-status-embed-line' });
        helpLabel(totalRow, 'total');
        totalRow.createSpan({ text: ` ${fmtPhaseDuration(complete.totalDurationMs)}` });

        const batch = body.createDiv({ cls: 'seek-status-embed-section' });
        helpLabel(batch.createDiv({ cls: 'seek-status-embed-sec-head' }), 'batch');
        const batchLine = batch.createDiv({ cls: 'seek-status-embed-line' });
        const dist = complete.embedBatchLatencyMs;
        const dispatches = dist?.n ?? 0;
        const effectiveBatch = dispatches > 0 ? complete.vectorsWritten / dispatches : 0;
        batchLine.createSpan({ text: `${dispatches.toLocaleString()} ` });
        helpLabel(batchLine, 'dispatches');
        sep(batchLine);
        helpLabel(batchLine, 'batch size', 'batch');
        batchLine.createSpan({ text: ` ${effectiveBatch > 0 ? effectiveBatch.toFixed(1) : '—'}` });
        if (dist) {
            sep(batchLine);
            helpLabel(batchLine, 'p50');
            batchLine.createSpan({ text: ` ${fmtLatency(dist.p50)}` });
            sep(batchLine);
            helpLabel(batchLine, 'p95');
            batchLine.createSpan({ text: ` ${fmtLatency(dist.p95)}` });
        }

        const health = body.createDiv({ cls: 'seek-status-embed-section' });
        helpLabel(health.createDiv({ cls: 'seek-status-embed-sec-head' }), 'health');
        const healthLine = health.createDiv({ cls: 'seek-status-embed-line' });
        helpLabel(healthLine, 'pass', complete.pass ? 'pass' : 'fail');
        sep(healthLine);
        healthLine.createSpan({ text: `${complete.filesSkippedError} ` });
        helpLabel(healthLine, 'skipped');
        sep(healthLine);
        healthLine.createSpan({ text: `${complete.filesQuarantined ?? 0} ` });
        helpLabel(healthLine, 'quarantined');
        sep(healthLine);
        healthLine.createSpan({ text: `${complete.embedRecycles} ` });
        helpLabel(healthLine, 'recycles');
    } else {
        const empty = body.createDiv({ cls: 'seek-status-embed-section' });
        empty.createDiv({ cls: 'seek-status-embed-line seek-status-embed-empty', text: 'No completed pass yet' });
    }

    // —— model (last load) ——
    const model = body.createDiv({ cls: 'seek-status-embed-section' });
    helpLabel(model.createDiv({ cls: 'seek-status-embed-sec-head' }), 'model');
    const modelLine = model.createDiv({ cls: 'seek-status-embed-line' });
    if (load) {
        const deviceKey = load.actualDevice === 'webgpu' ? 'webgpu' : 'wasm';
        helpLabel(modelLine, deviceKey, load.actualDevice);
        sep(modelLine);
        helpLabel(modelLine, load.dtype, load.dtype);
        sep(modelLine);
        const dimKey = `${load.embeddingDim}d`;
        helpLabel(modelLine, dimKey in EMBED_METRIC_HELP ? dimKey : '768d', dimKey);
        sep(modelLine);
        helpLabel(modelLine, 'cold');
        modelLine.createSpan({ text: ` ${fmtPhaseDuration(load.coldStartMs)}` });
    } else {
        modelLine.createSpan({ cls: 'seek-status-embed-empty', text: '—' });
    }
}

export function renderSettingsIndexStatusCard(
    parent: HTMLElement,
    opts: {
        health: IndexStatusHealth;
        stats: IndexStatusCardStats | null;
        job?: IndexStatusJob | null;
        startup?: StartupTimingView | null;
        liveElapsedMs?: number | null;
        prevBoot?: { readyFromStartMs: number | null; warmSkipped: boolean } | null;
        recentBoots?: readonly StoredStartupBoot[];
        embedDiag?: EmbedDiagView | null;
    },
): HTMLElement {
    const card = renderIndexStatusCard(parent, {
        health: opts.health,
        stats: opts.stats,
        job: opts.job,
    });

    const startup = opts.startup;
    const warmRunning = !!startup && !startup.warmSkipped && startup.warmPhaseMs == null
        && startup.searchableMs != null && opts.liveElapsedMs != null;
    const liveWarmMs = warmRunning && opts.liveElapsedMs != null && startup?.searchableMs != null
        ? opts.liveElapsedMs - startup.searchableMs
        : null;
    const showTrendWhileWorking = !!startup && startup.readyFromStartMs == null
        && opts.prevBoot && !opts.prevBoot.warmSkipped && opts.prevBoot.readyFromStartMs != null;

    const block = card.createDiv({ cls: 'seek-status-startup' });

    const current = block.createDiv({ cls: 'seek-status-startup-current' });
    const head = current.createDiv({ cls: 'seek-status-startup-head' });
    head.createSpan({ text: 'startup' });
    const info = head.createSpan({ cls: 'seek-status-startup-info' });
    setIcon(info, 'info');
    info.setAttr('aria-label', 'Startup stages: Searchable, Cache warm, Fully ready');

    const pop = info.createDiv({ cls: 'seek-status-startup-popover' });
    pop.createDiv({ cls: 'seek-startup-popover-title', text: 'Startup stages' });

    const stages = [
        { name: 'Searchable', desc: 'Search modal accepts queries and returns initial results.' },
        { name: 'Cache warm', desc: 'Preloads index into memory for instant first queries (or skipped).' },
        { name: 'Fully ready', desc: 'Total time until background cache warming and startup tasks finish.' },
    ];
    for (const s of stages) {
        const item = pop.createDiv({ cls: 'seek-startup-popover-stage' });
        item.createSpan({ cls: 'seek-startup-popover-name', text: s.name });
        item.createSpan({ cls: 'seek-startup-popover-desc', text: s.desc });
    }

    const rows = current.createDiv({ cls: 'seek-status-startup-rows' });
    for (const row of buildStartupTimingRows(startup ?? {
        searchableMs: null,
        warmPhaseMs: null,
        readyFromStartMs: null,
        warmSkipped: false,
        bootComplete: false,
    }, opts.liveElapsedMs ?? null, liveWarmMs)) {
        const line = rows.createDiv({ cls: 'seek-status-startup-row' });
        line.createSpan({ cls: 'seek-status-startup-label', text: row.label });
        line.createSpan({ cls: 'seek-status-startup-phase', text: row.value });
    }

    const trend = startup ? startupTrend(startup, opts.prevBoot ?? null) : null;
    if (trend) {
        const foot = current.createDiv({
            cls: `seek-status-startup-trend is-${trend.direction}`,
            text: trend.text,
        });
        foot.setAttr('aria-label', 'Fully ready time compared with the previous boot on this device');
    } else if (showTrendWhileWorking && opts.prevBoot?.readyFromStartMs != null) {
        current.createDiv({
            cls: 'seek-status-startup-trend is-baseline',
            text: `last boot ${fmtLatency(opts.prevBoot.readyFromStartMs)}`,
        });
    }

    const recentBoots = opts.recentBoots ?? [];
    if (recentBoots.length > 0) {
        const hist = block.createDiv({ cls: 'seek-status-startup-history' });
        hist.createDiv({ cls: 'seek-status-startup-head', text: 'recent boots' });
        const histRows = hist.createDiv({ cls: 'seek-status-startup-history-rows' });
        for (const boot of recentBoots) {
            const line = histRows.createDiv({ cls: 'seek-status-startup-history-row' });
            line.createSpan({ cls: 'seek-status-startup-history-when', text: formatBootAge(boot.at) });
            line.createSpan({ cls: 'seek-status-startup-history-value', text: formatStoredBootLine(boot) });
        }
    }

    if (opts.embedDiag) renderEmbedDiagnostic(card, opts.embedDiag);

    return card;
}

export function renderRecentSearchConsole(parent: HTMLElement, lines: string[]): void {
    const panel = parent.createDiv({ cls: 'seek-search-console' });
    if (lines.length === 0) {
        panel.createDiv({ cls: 'seek-search-console-empty', text: 'No searches this session' });
        return;
    }
    for (const line of lines) {
        panel.createDiv({ cls: 'seek-search-console-line', text: line });
    }
}
