// Shared Index status card: Settings tab and the status-bar hover panel.
// Inventory metrics (files/chunks/stamps) come from getIndexStats(); an optional
// `job` row is the current pass (done/total files in flight), not vault size.

export interface IndexStatusCardStats {
    files: number;
    chunks: number;
    lastFullAt: string | null;
    lastFullDurationMs: number | null;
    lastUpdatedAt: string | null;
}

export type IndexStatusHealth = 'none' | 'starting' | 'restoring' | 'ok' | 'indexing' | 'error';

export interface IndexStatusJob {
    done: number;
    total: number;
    paused?: boolean;
}

export const INDEX_STATUS_HEALTH: Record<IndexStatusHealth, { tone: string; label: string; compact: string }> = {
    none: { tone: 'mid', label: 'No index', compact: 'None' },
    starting: { tone: 'info', label: 'Starting up…', compact: 'Starting' },
    restoring: { tone: 'info', label: 'Restoring…', compact: 'Restoring' },
    ok: { tone: 'good', label: 'Up to date', compact: 'Ready' },
    indexing: { tone: 'accent', label: 'Indexing…', compact: 'Indexing' },
    error: { tone: 'bad', label: 'Index error', compact: 'Error' },
};

export function fmtIndexStamp(iso: string): string {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderIndexStatusCard(
    parent: HTMLElement,
    opts: {
        health: IndexStatusHealth;
        stats: IndexStatusCardStats | null;
        job?: IndexStatusJob | null;
    },
): HTMLElement {
    const card = parent.createDiv({ cls: 'seek-status-card' });
    const st = INDEX_STATUS_HEALTH[opts.health];

    const health = card.createDiv({ cls: 'seek-status-health' });
    health.createSpan({ cls: `seek-dot seek-dot-${st.tone}` });
    health.createSpan({ cls: 'seek-status-label', text: st.label });

    card.createDiv({ cls: 'seek-status-sep' });

    const metric = (value: string, label: string) => {
        const m = card.createDiv({ cls: 'seek-status-metric' });
        m.createDiv({ cls: 'seek-status-value', text: value });
        m.createDiv({ cls: 'seek-status-mlabel', text: label });
    };
    const n = (x: number) => x.toLocaleString();

    if (opts.job && opts.job.total > 0) {
        const job = card.createDiv({ cls: 'seek-status-metric seek-status-job' });
        job.createDiv({ cls: 'seek-status-value', text: `${n(opts.job.done)} / ${n(opts.job.total)}` });
        job.createDiv({
            cls: 'seek-status-mlabel',
            text: opts.job.paused ? 'paused this pass' : 'this pass',
        });
        const remaining = Math.max(0, opts.job.total - opts.job.done);
        metric(n(remaining), 'remaining');
    }

    if (opts.stats) {
        metric(n(opts.stats.files), 'files');
        metric(n(opts.stats.chunks), 'chunks');
        const last = card.createDiv({ cls: 'seek-status-metric seek-status-last' });
        if (opts.stats.lastFullAt) {
            const dur = opts.stats.lastFullDurationMs != null
                ? ` · ${(opts.stats.lastFullDurationMs / 1000).toFixed(1)}s` : '';
            last.createDiv({ cls: 'seek-status-mlabel', text: 'last full index' });
            last.createDiv({
                cls: 'seek-status-value seek-status-stamp',
                text: `${fmtIndexStamp(opts.stats.lastFullAt)}${dur}`,
            });
            if (opts.stats.lastUpdatedAt && opts.stats.lastUpdatedAt > opts.stats.lastFullAt) {
                last.createDiv({ cls: 'seek-status-updated', text: `updated ${fmtIndexStamp(opts.stats.lastUpdatedAt)}` });
            }
        } else if (opts.stats.lastUpdatedAt) {
            last.createDiv({ cls: 'seek-status-mlabel', text: 'last updated' });
            last.createDiv({
                cls: 'seek-status-value seek-status-stamp',
                text: fmtIndexStamp(opts.stats.lastUpdatedAt),
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
