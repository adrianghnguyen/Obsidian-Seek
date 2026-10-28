// Shared Index status chrome: Settings card, status-bar item, search-modal wait
// card and footer. During an in-flight pass the coordinator job (remaining files)
// is the source of truth — inventory files/chunks from getIndexStats() must not
// compete with that number.

import { setIcon, setTooltip } from 'obsidian';
import {
    formatStableIndexCount,
    formatStableLabelProgress,
    formatStableFileFractionSpaced,
    formatIndexCountPlain,
} from './index-progress-format';
import { INDEX_STATUS_COPY, normalizeHydrateProgress, type IndexHydrateProgress, type IndexStatusHealth, type IndexStatusMode } from './index-status-report';
import type { IndexProgressIndicator } from './index-progress-indicator';

export type { IndexStatusHealth, IndexStatusMode };

export interface IndexStatusCardStats {
    files: number;
    chunks: number;
    lastFullAt: string | null;
    lastFullDurationMs: number | null;
    lastUpdatedAt: string | null;
}

export type IndexJobKind = 'full' | 'delta' | 'catchup';

export interface IndexStatusJob {
    id?: number;
    kind?: IndexJobKind;
    done: number;
    total: number;
    paused?: boolean;
    /** Catch-up is aligning the index with Honor / excluded-folder changes. */
    aligningExclusions?: boolean;
}

/** Live encode-speed inputs for Settings embed diagnostics (not status-bar chrome). */
export interface IndexJobSpeedView {
    chunksDone: number;
    tokensDone: number;
    done: number;
    total: number;
    elapsedMs: number;
    paused: boolean;
    kind?: IndexJobKind;
}

export const INDEX_ALIGNING_EXCLUSIONS_LABEL = 'Aligning with exclusions…';
export const INDEX_ALIGNING_EXCLUSIONS_PASS = 'exclusion pass';

export const INDEX_STATUS_HEALTH = {
    none: INDEX_STATUS_COPY.none,
    starting: INDEX_STATUS_COPY.starting,
    restoring: INDEX_STATUS_COPY.restoring,
    ok: INDEX_STATUS_COPY.ok,
    updating: INDEX_STATUS_COPY.updating,
    indexing: INDEX_STATUS_COPY.indexing,
    error: INDEX_STATUS_COPY.error,
    locked: INDEX_STATUS_COPY.locked,
    stuck: INDEX_STATUS_COPY.stuck,
} as const;

/** Numbered status-bar badge. Replaces the old circular indexing dot. */
export const INDEX_STATUS_BADGE_CLS = 'seek-index-badge';
/** Deprecated circular indexing glyph — must not appear while health is indexing. */
export const INDEX_STATUS_DOT_CLS = 'seek-dot';

export function fmtIndexStamp(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtCount(x: number): string {
    return x.toLocaleString();
}

/** First paint while starting/restoring must not flash stale inventory as the index. */
export function indexWaitCardModel(input: {
    health: IndexStatusHealth;
    job?: IndexStatusJob | null;
    stats?: IndexStatusCardStats | null;
    hydrateProgress?: { done: number; total: number; percent?: number } | null;
    progress?: IndexProgressIndicator | null;
}): {
    health: IndexStatusHealth;
    stats: IndexStatusCardStats | null;
    job: IndexStatusJob | null;
    hydrate: IndexHydrateProgress | null;
    progress: IndexProgressIndicator | null;
} {
    const fromIndicator = input.progress?.units && (input.progress.phase === 'hydrating' || input.progress.phase === 'restoring' || input.progress.phase === 'recovering' || input.progress.phase === 'verifying')
        ? { done: input.progress.units.done, total: input.progress.units.total, percent: input.progress.units.percent }
        : null;
    const hydrate = fromIndicator ?? normalizeHydrateProgress(input.hydrateProgress);
    if (input.health === 'starting' || input.health === 'restoring' || input.health === 'locked' || input.health === 'stuck') {
        const showHydrate = (input.health === 'starting' || input.health === 'restoring') ? hydrate : null;
        return { health: input.health, stats: null, job: null, hydrate: showHydrate, progress: input.progress ?? null };
    }
    const job = input.job && input.job.total > 0
        && (input.health === 'indexing' || input.health === 'updating')
        && !hydrate
        ? input.job
        : null;
    return { health: input.health, stats: input.stats ?? null, job, hydrate, progress: input.progress ?? null };
}

/**
 * Canonical indexing chrome: the reddish-orange numbered remaining-files badge
 * used by the desktop status bar. Idle (non-indexing) health still uses the
 * small status dot. Callers must not paint a seek-dot for indexing.
 */
export function renderIndexStatusBadge(
    parent: HTMLElement,
    opts: { health: IndexStatusHealth; remaining?: number | null; quietCatchUp?: boolean },
): HTMLElement {
    if (opts.health === 'indexing') {
        const remaining = opts.remaining;
        const text = remaining != null ? fmtCount(remaining) : '…';
        const badge = parent.createSpan({ cls: INDEX_STATUS_BADGE_CLS, text });
        badge.setAttr('data-seek-index-badge', remaining != null ? String(remaining) : '');
        badge.setAttr('aria-label', remaining != null ? `Seek: Indexing ${fmtCount(remaining)} remaining` : 'Seek: Indexing');
        return badge;
    }
    const st = INDEX_STATUS_HEALTH[opts.health];
    const glow = opts.quietCatchUp && opts.health === 'ok' ? ' seek-dot-glow' : '';
    return parent.createSpan({ cls: `${INDEX_STATUS_DOT_CLS} seek-dot-${st.tone}${glow}` });
}

interface StatusMetricSlot {
    value: string;
    label: string;
    cls?: string;
}

function emptySlots(): [StatusMetricSlot, StatusMetricSlot, StatusMetricSlot] {
    return [
        { value: '—', label: 'files' },
        { value: '—', label: 'chunks' },
        { value: '—', label: 'last full index', cls: 'seek-status-last' },
    ];
}

function lastSlotFromStats(stats: IndexStatusCardStats | null): StatusMetricSlot {
    if (!stats) return { value: '—', label: 'last full index', cls: 'seek-status-last' };
    if (stats.lastFullAt) {
        return {
            value: fmtIndexStamp(stats.lastFullAt),
            label: 'last full index',
            cls: 'seek-status-last',
        };
    }
    if (stats.lastUpdatedAt) {
        return {
            value: fmtIndexStamp(stats.lastUpdatedAt),
            label: 'last updated',
            cls: 'seek-status-last',
        };
    }
    return { value: 'never', label: 'last full index', cls: 'seek-status-last' };
}

function metricSlots(
    model: ReturnType<typeof indexWaitCardModel>,
    eta?: string | null,
    percent?: number,
    remaining?: number | null,
): [StatusMetricSlot, StatusMetricSlot, StatusMetricSlot] {
    const verify = model.progress?.phase === 'verifying' ? model.progress.units : null;
    if (verify) {
        const value = verify.determinate
            ? formatStableLabelProgress(verify.done, verify.total, verify.percent)
            : formatStableFileFractionSpaced(verify.done, verify.total);
        return [
            { value, label: 'this check', cls: 'seek-status-job' },
            { value: '—', label: 'chunks' },
            lastSlotFromStats(model.stats),
        ];
    }
    if (model.hydrate) {
        const pct = model.hydrate.percent;
        const restoreLabel = model.progress?.phase === 'recovering' ? 'this recover' : 'this restore';
        return [
            {
                value: formatStableLabelProgress(model.hydrate.done, model.hydrate.total, pct),
                label: restoreLabel,
                cls: 'seek-status-job',
            },
            { value: '—', label: 'chunks' },
            lastSlotFromStats(model.stats),
        ];
    }
    if (model.job) {
        const left = remaining ?? 0;
        const pct = percent ?? 0;
        const progressLine = formatStableLabelProgress(model.job.done, model.job.total, pct);
        const aligning = !!model.job.aligningExclusions;
        return [
            {
                value: formatStableIndexCount(left, model.job.total),
                label: 'remaining',
            },
            {
                value: eta ? `${progressLine} · ${eta} left` : progressLine,
                label: model.job.paused
                    ? 'paused this pass'
                    : aligning
                        ? INDEX_ALIGNING_EXCLUSIONS_PASS
                        : 'this pass',
                cls: 'seek-status-job',
            },
            lastSlotFromStats(model.stats),
        ];
    }
    if (model.stats) {
        const width = Math.max(model.stats.files, model.stats.chunks, 1);
        return [
            { value: formatStableIndexCount(model.stats.files, width), label: 'files' },
            { value: formatIndexCountPlain(model.stats.chunks), label: 'chunks' },
            lastSlotFromStats(model.stats),
        ];
    }
    return emptySlots();
}

export function renderIndexStatusCard(
    parent: HTMLElement,
    opts: {
        health: IndexStatusHealth;
        stats: IndexStatusCardStats | null;
        job?: IndexStatusJob | null;
        eta?: string | null;
        mode?: IndexStatusMode;
        /** Optional heading override (aligning). Hydrate counts live in the metric slot. */
        label?: string;
        hydrateProgress?: { done: number; total: number; percent?: number } | null;
        progress?: IndexProgressIndicator | null;
        /** From IndexProgressSnapshot — card formats only. */
        percent?: number;
        remaining?: number | null;
        quietCatchUp?: boolean;
        statusHelp?: string;
        contextHint?: string;
    },
): HTMLElement {
    const model = indexWaitCardModel(opts);
    const card = parent.createDiv({ cls: 'seek-status-card' });
    const mode = opts.mode ?? (model.health as IndexStatusMode);
    const st = INDEX_STATUS_COPY[mode] ?? INDEX_STATUS_HEALTH[model.health];

    const aligning = !!model.job?.aligningExclusions && model.health === 'indexing';
    const main = card.createDiv({ cls: 'seek-status-card-main' });
    const health = main.createDiv({ cls: 'seek-status-health' });
    const remaining = opts.remaining ?? null;
    renderIndexStatusBadge(health, {
        health: model.health,
        remaining,
        quietCatchUp: opts.quietCatchUp,
    });
    const labelRow = health.createDiv({ cls: 'seek-status-label-row' });
    labelRow.createSpan({
        cls: 'seek-status-label',
        text: aligning ? INDEX_ALIGNING_EXCLUSIONS_LABEL : st.label,
    });
    if (opts.statusHelp) {
        const info = labelRow.createSpan({ cls: 'seek-status-info' });
        setIcon(info, 'info');
        info.setAttr('aria-label', opts.statusHelp);
        setTooltip(info, opts.statusHelp, { delay: 300 });
    }

    main.createDiv({ cls: 'seek-status-sep' });
    const metrics = main.createDiv({ cls: 'seek-status-metrics' });
    for (const slot of metricSlots(model, opts.eta, opts.percent, remaining)) {
        const m = metrics.createDiv({
            cls: slot.cls ? `seek-status-metric ${slot.cls}` : 'seek-status-metric',
        });
        m.createDiv({ cls: 'seek-status-value', text: slot.value });
        m.createDiv({ cls: 'seek-status-mlabel', text: slot.label });
    }

    if (opts.statusHelp) {
        card.createDiv({ cls: 'seek-status-help-text', text: opts.statusHelp });
    }
    if (opts.contextHint) {
        card.createDiv({ cls: 'seek-status-context-hint', text: opts.contextHint });
    }

    const meter = card.createEl('progress', { cls: 'seek-status-meter' }) as HTMLProgressElement;
    meter.max = 100;
    const units = opts.progress?.units ?? (model.hydrate
        ? { done: model.hydrate.done, total: model.hydrate.total, percent: model.hydrate.percent, determinate: true }
        : null);
    const working = opts.progress
        && opts.progress.phase !== 'ready'
        && opts.progress.phase !== 'none'
        && opts.progress.phase !== 'stuck'
        && opts.progress.phase !== 'locked'
        && opts.progress.phase !== 'error';
    if (!working && !model.hydrate && !model.job) {
        meter.addClass('is-idle');
    } else if (units && units.determinate) {
        meter.value = units.percent;
    } else {
        meter.addClass('is-indeterminate');
        if (typeof meter.removeAttribute === 'function') meter.removeAttribute('value');
    }

    return card;
}
