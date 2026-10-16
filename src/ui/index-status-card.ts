// Shared Index status chrome: Settings card, status-bar item, search-modal wait
// card and footer. During an in-flight pass the coordinator job (remaining files)
// is the source of truth — inventory files/chunks from getIndexStats() must not
// compete with that number.

import { indexPercent } from './index-eta';
import { INDEX_STATUS_COPY, type IndexHydrateProgress, type IndexStatusHealth, type IndexStatusMode } from './index-status-report';

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

export const INDEX_ALIGNING_EXCLUSIONS_LABEL = 'Aligning with exclusions…';
export const INDEX_ALIGNING_EXCLUSIONS_PASS = 'exclusion pass';

export const INDEX_STATUS_HEALTH = {
    none: INDEX_STATUS_COPY.none,
    starting: INDEX_STATUS_COPY.starting,
    restoring: INDEX_STATUS_COPY.restoring,
    ok: INDEX_STATUS_COPY.ok,
    indexing: INDEX_STATUS_COPY.indexing,
    error: INDEX_STATUS_COPY.error,
    locked: INDEX_STATUS_COPY.locked,
    stuck: INDEX_STATUS_COPY.stuck,
} as const;

/** Numbered status-bar badge. Replaces the old circular indexing dot. */
export const INDEX_STATUS_BADGE_CLS = 'seek-index-badge';
/** Deprecated circular indexing glyph — must not appear while health is indexing. */
export const INDEX_STATUS_DOT_CLS = 'seek-dot';

export function jobRemaining(job: IndexStatusJob | null | undefined): number | null {
    if (!job || job.total <= 0) return null;
    return Math.max(0, job.total - job.done);
}

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
    hydrateProgress?: IndexHydrateProgress | null;
}): {
    health: IndexStatusHealth;
    stats: IndexStatusCardStats | null;
    job: IndexStatusJob | null;
    hydrate: IndexHydrateProgress | null;
} {
    const hydrate = input.hydrateProgress && input.hydrateProgress.total > 0
        ? input.hydrateProgress
        : null;
    // Starting/Restoring/Locked/Stuck win over an in-flight job so hydrate/lock never paints Indexing.
    if (input.health === 'starting' || input.health === 'restoring' || input.health === 'locked' || input.health === 'stuck') {
        const showHydrate = (input.health === 'starting' || input.health === 'restoring') ? hydrate : null;
        return { health: input.health, stats: null, job: null, hydrate: showHydrate };
    }
    const job = input.job && input.job.total > 0 && input.health === 'indexing' && !hydrate
        ? input.job
        : null;
    return { health: input.health, stats: input.stats ?? null, job, hydrate };
}

/**
 * Canonical indexing chrome: the reddish-orange numbered remaining-files badge
 * used by the desktop status bar. Idle (non-indexing) health still uses the
 * small status dot. Callers must not paint a seek-dot for indexing.
 */
export function renderIndexStatusBadge(
    parent: HTMLElement,
    opts: { health: IndexStatusHealth; remaining?: number | null },
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
    return parent.createSpan({ cls: `${INDEX_STATUS_DOT_CLS} seek-dot-${st.tone}` });
}

export function renderIndexStatusCard(
    parent: HTMLElement,
    opts: {
        health: IndexStatusHealth;
        stats: IndexStatusCardStats | null;
        job?: IndexStatusJob | null;
        eta?: string | null;
        mode?: IndexStatusMode;
        /** Live reporter heading (includes hydrate counts when restoring). */
        label?: string;
        hydrateProgress?: IndexHydrateProgress | null;
    },
): HTMLElement {
    const model = indexWaitCardModel(opts);
    const card = parent.createDiv({ cls: 'seek-status-card' });
    const mode = opts.mode ?? (model.health as IndexStatusMode);
    const st = INDEX_STATUS_COPY[mode] ?? INDEX_STATUS_HEALTH[model.health];

    const aligning = !!model.job?.aligningExclusions && model.health === 'indexing';
    const health = card.createDiv({ cls: 'seek-status-health' });
    const remaining = model.hydrate && model.health === 'indexing'
        ? Math.max(0, model.hydrate.total - model.hydrate.done)
        : jobRemaining(model.job);
    renderIndexStatusBadge(health, { health: model.health, remaining });
    health.createSpan({
        cls: 'seek-status-label',
        text: aligning ? INDEX_ALIGNING_EXCLUSIONS_LABEL : (opts.label ?? st.label),
    });

    card.createDiv({ cls: 'seek-status-sep' });

    const metric = (value: string, label: string) => {
        const m = card.createDiv({ cls: 'seek-status-metric' });
        m.createDiv({ cls: 'seek-status-value', text: value });
        m.createDiv({ cls: 'seek-status-mlabel', text: label });
    };

    if (model.hydrate) {
        const pct = indexPercent(model.hydrate.done, model.hydrate.total);
        const progressLine = `${fmtCount(model.hydrate.done)} / ${fmtCount(model.hydrate.total)} · ${pct}%`;
        const job = card.createDiv({ cls: 'seek-status-metric seek-status-job' });
        job.createDiv({ cls: 'seek-status-value', text: progressLine });
        job.createDiv({ cls: 'seek-status-mlabel', text: 'this restore' });
        return card;
    }

    if (model.job) {
        const remaining = jobRemaining(model.job) ?? 0;
        const pct = indexPercent(model.job.done, model.job.total);
        metric(fmtCount(remaining), 'remaining');
        const job = card.createDiv({ cls: 'seek-status-metric seek-status-job' });
        const progressLine = `${fmtCount(model.job.done)} / ${fmtCount(model.job.total)} · ${pct}%`;
        job.createDiv({ cls: 'seek-status-value', text: opts.eta ? `${progressLine} · ${opts.eta} left` : progressLine });
        job.createDiv({
            cls: 'seek-status-mlabel',
            text: model.job.paused
                ? 'paused this pass'
                : aligning
                    ? INDEX_ALIGNING_EXCLUSIONS_PASS
                    : 'this pass',
        });
        if (model.stats?.lastUpdatedAt) {
            const last = card.createDiv({ cls: 'seek-status-metric seek-status-last' });
            last.createDiv({ cls: 'seek-status-mlabel', text: 'last updated' });
            last.createDiv({
                cls: 'seek-status-value seek-status-stamp',
                text: fmtIndexStamp(model.stats.lastUpdatedAt),
            });
        }
        return card;
    }

    if (model.stats) {
        metric(fmtCount(model.stats.files), 'files');
        metric(fmtCount(model.stats.chunks), 'chunks');
        const last = card.createDiv({ cls: 'seek-status-metric seek-status-last' });
        if (model.stats.lastFullAt) {
            const dur = model.stats.lastFullDurationMs != null
                ? ` · ${(model.stats.lastFullDurationMs / 1000).toFixed(1)}s` : '';
            last.createDiv({ cls: 'seek-status-mlabel', text: 'last full index' });
            last.createDiv({
                cls: 'seek-status-value seek-status-stamp',
                text: `${fmtIndexStamp(model.stats.lastFullAt)}${dur}`,
            });
            if (model.stats.lastUpdatedAt && model.stats.lastUpdatedAt > model.stats.lastFullAt) {
                last.createDiv({ cls: 'seek-status-updated', text: `updated ${fmtIndexStamp(model.stats.lastUpdatedAt)}` });
            }
        } else if (model.stats.lastUpdatedAt) {
            last.createDiv({ cls: 'seek-status-mlabel', text: 'last updated' });
            last.createDiv({
                cls: 'seek-status-value seek-status-stamp',
                text: fmtIndexStamp(model.stats.lastUpdatedAt),
            });
        } else {
            last.createDiv({ cls: 'seek-status-mlabel', text: 'last full index' });
            last.createDiv({ cls: 'seek-status-value seek-status-stamp', text: 'never' });
        }
    } else {
        metric('…', 'loading');
    }

    return card;
}
