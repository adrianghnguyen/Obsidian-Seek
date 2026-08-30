// Shared Index status chrome: Settings card, status-bar item, search-modal wait
// card and footer. During an in-flight pass the coordinator job (remaining files)
// is the source of truth — inventory files/chunks from getIndexStats() must not
// compete with that number.

import { indexPercent } from './index-eta';

export interface IndexStatusCardStats {
    files: number;
    chunks: number;
    lastFullAt: string | null;
    lastFullDurationMs: number | null;
    lastUpdatedAt: string | null;
}

export type IndexStatusHealth = 'none' | 'starting' | 'restoring' | 'ok' | 'indexing' | 'error';
export type IndexJobKind = 'full' | 'delta' | 'catchup';

export interface IndexStatusJob {
    id?: number;
    kind?: IndexJobKind;
    done: number;
    total: number;
    paused?: boolean;
}

export const INDEX_STATUS_HEALTH: Record<IndexStatusHealth, { tone: string; label: string; compact: string }> = {
    none: { tone: 'mid', label: 'No index', compact: 'None' },
    starting: { tone: 'pending', label: 'Starting up…', compact: 'Starting' },
    restoring: { tone: 'info', label: 'Restoring…', compact: 'Restoring' },
    ok: { tone: 'good', label: 'Up to date', compact: 'Ready' },
    indexing: { tone: 'accent', label: 'Indexing…', compact: 'Indexing' },
    error: { tone: 'bad', label: 'Index error', compact: 'Error' },
};

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
}): { health: IndexStatusHealth; stats: IndexStatusCardStats | null; job: IndexStatusJob | null } {
    // Starting/Restoring win over an in-flight job so hydrate never paints Indexing.
    if (input.health === 'starting' || input.health === 'restoring') {
        return { health: input.health, stats: null, job: null };
    }
    const job = input.job && input.job.total > 0 ? input.job : null;
    if (job) return { health: 'indexing', stats: input.stats ?? null, job };
    return { health: input.health, stats: input.stats ?? null, job: null };
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
    },
): HTMLElement {
    const model = indexWaitCardModel(opts);
    const card = parent.createDiv({ cls: 'seek-status-card' });
    const st = INDEX_STATUS_HEALTH[model.health];

    const health = card.createDiv({ cls: 'seek-status-health' });
    renderIndexStatusBadge(health, { health: model.health, remaining: jobRemaining(model.job) });
    health.createSpan({ cls: 'seek-status-label', text: st.label });

    card.createDiv({ cls: 'seek-status-sep' });

    const metric = (value: string, label: string) => {
        const m = card.createDiv({ cls: 'seek-status-metric' });
        m.createDiv({ cls: 'seek-status-value', text: value });
        m.createDiv({ cls: 'seek-status-mlabel', text: label });
    };

    if (model.job) {
        const remaining = jobRemaining(model.job) ?? 0;
        const pct = indexPercent(model.job.done, model.job.total);
        metric(fmtCount(remaining), 'remaining');
        const job = card.createDiv({ cls: 'seek-status-metric seek-status-job' });
        const progressLine = `${fmtCount(model.job.done)} / ${fmtCount(model.job.total)} · ${pct}%`;
        job.createDiv({ cls: 'seek-status-value', text: opts.eta ? `${progressLine} · ${opts.eta} left` : progressLine });
        job.createDiv({
            cls: 'seek-status-mlabel',
            text: model.job.paused ? 'paused this pass' : 'this pass',
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
