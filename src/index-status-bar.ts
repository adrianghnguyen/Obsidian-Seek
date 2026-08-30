// Desktop status-bar widget for index inventory + in-flight remaining files.
// Replaces the sticky Indexing Notice: no show-delay, no min-visible, no Notice.
// Indexing chrome is the numbered remaining-files badge shared with the search modal.

import { Platform, setTooltip } from 'obsidian';
import {
    renderIndexStatusCard,
    renderIndexStatusBadge,
    INDEX_STATUS_HEALTH,
    jobRemaining,
    type IndexStatusCardStats,
    type IndexStatusHealth,
    type IndexStatusJob,
    type IndexJobKind,
} from './index-status-card';
import { formatRoughEta, indexPercent } from './index-eta';

export function parseIndexedProgress(msg: string): { files: number } | null {
    const m = msg.match(/Indexed\s+([\d,]+)\s+files/i);
    if (!m) return null;
    const files = parseInt(m[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(files)) return null;
    return { files };
}

export function quantizePercent(done: number, total: number, step = 5): number {
    if (total <= 0) return 0;
    if (done >= total) return 100;
    const raw = (Math.max(0, done) / total) * 100;
    return Math.min(100, Math.floor(raw / step) * step);
}

/** Grow a catch-up pass total when new edits arrive mid-drain — keeps committed progress. */
export function extendIndexPassTotal(committed: number, passTotal: number, dirtyCount: number): number {
    return Math.max(passTotal, committed + Math.max(0, dirtyCount));
}

export interface IndexStatusBarHooks {
    getStats: () => Promise<IndexStatusCardStats>;
    getHealth: () => IndexStatusHealth;
    onOpenSettings: () => void;
}

export class IndexStatusBar {
    private root: HTMLElement | null = null;
    private chromeEl: HTMLElement | null = null;
    private labelEl: HTMLElement | null = null;
    private progressEl: HTMLProgressElement | null = null;
    private hoverEl: HTMLElement | null = null;
    private hooks: IndexStatusBarHooks | null = null;
    private jobActive = false;
    private jobPaused = false;
    private jobId = 0;
    private jobKind: IndexJobKind | null = null;
    private jobGen = 0;
    private total = 0;
    private done = 0;
    private label = '';
    private jobStartedAt = 0;
    private paintedDone = -1;
    private paintedTotal = -1;
    private paintedPercent = -1;
    private paintScheduled = false;
    private paintQueued = false;
    private paintForce = false;
    private hoverGen = 0;

    mount(el: HTMLElement, hooks: IndexStatusBarHooks): void {
        if (Platform.isMobile) return;
        this.root = el;
        this.hooks = hooks;
        el.addClass('seek-status-bar');
        el.setAttr('role', 'button');
        el.setAttr('tabindex', '0');
        this.chromeEl = el.createSpan({ cls: 'seek-status-bar-chrome' });
        this.labelEl = el.createSpan({ cls: 'seek-status-bar-label', text: 'Seek' });
        this.progressEl = el.createEl('progress', { cls: 'seek-status-bar-progress is-hidden' }) as HTMLProgressElement;
        this.progressEl.max = 100;
        this.progressEl.value = 0;
        this.hoverEl = el.createDiv({ cls: 'seek-index-hover is-hidden' });
        el.addEventListener('mouseenter', () => void this.onHover());
        el.addEventListener('mouseleave', () => this.hideHover());
        el.addEventListener('click', () => this.hooks?.onOpenSettings());
        el.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.hooks?.onOpenSettings();
            }
        });
        this.paintIdle();
    }

    show(total: number, label: string, opts?: { id?: number; kind?: IndexJobKind }): void {
        this.jobActive = true;
        this.jobPaused = /paused/i.test(label);
        this.jobGen += 1;
        this.jobId = opts?.id ?? this.jobGen;
        this.jobKind = opts?.kind ?? null;
        this.total = Math.max(0, total);
        this.done = 0;
        this.label = label;
        this.jobStartedAt = performance.now();
        this.paintedDone = -1;
        this.paintedTotal = -1;
        this.paintedPercent = -1;
        this.schedulePaintJob(true);
    }

    updateFromProgress(msg: string, id?: number): void {
        const parsed = parseIndexedProgress(msg);
        if (parsed) this.update(parsed.files, this.total, msg, id);
        else this.update(this.done, this.total, msg, id);
    }

    update(done: number, total: number, label?: string, id?: number): void {
        if (id != null && this.jobId !== id) return;
        const nextTotal = Math.max(0, total);
        this.total = nextTotal;
        this.done = Math.min(nextTotal, Math.max(0, done));
        if (label) {
            this.label = label;
            this.jobPaused = /paused/i.test(label);
        }
        this.schedulePaintJob(false);
    }

    hide(id?: number): void {
        if (id != null && this.jobId !== id) return;
        this.paintScheduled = false;
        this.paintQueued = false;
        this.paintForce = false;
        this.jobActive = false;
        this.jobPaused = false;
        this.jobKind = null;
        this.done = 0;
        this.total = 0;
        this.label = '';
        this.jobStartedAt = 0;
        this.paintedDone = -1;
        this.paintedTotal = -1;
        this.paintedPercent = -1;
        this.paintIdle();
        this.hideHover();
    }

    /** Repaint the idle chrome from getHealth() — e.g. after boot or catch-up. */
    refreshIdle(): void {
        if (this.jobActive) {
            this.schedulePaintJob(true);
            return;
        }
        this.paintIdle();
    }

    job(): IndexStatusJob | null {
        if (!this.jobActive || this.total <= 0) return null;
        return { id: this.jobId, kind: this.jobKind ?? undefined, done: this.done, total: this.total, paused: this.jobPaused };
    }

    private schedulePaintJob(force: boolean): void {
        if (force) this.paintForce = true;
        this.paintQueued = true;
        if (this.paintScheduled) return;
        this.paintScheduled = true;
        requestAnimationFrame(() => {
            this.paintScheduled = false;
            if (!this.paintQueued) return;
            this.paintQueued = false;
            const runForce = this.paintForce;
            this.paintForce = false;
            this.paintJob(runForce);
        });
    }

    private jobTooltip(): string {
        const pct = indexPercent(this.done, this.total);
        const eta = formatRoughEta(this.done, this.total, performance.now() - this.jobStartedAt);
        const counts = `${this.done.toLocaleString()} / ${this.total.toLocaleString()} · ${pct}%`;
        return eta ? `Seek: Indexing ${counts} · ${eta} left` : `Seek: Indexing ${counts}`;
    }

    private paintJob(force: boolean): void {
        if (!this.root) return;
        const canonical = this.hooks?.getHealth();
        if (canonical === 'starting' || canonical === 'restoring') {
            this.paintedDone = -1;
            this.paintedTotal = -1;
            this.paintedPercent = -1;
            this.labelEl?.removeClass('is-hidden');
            this.labelEl?.setText('Seek');
            this.progressEl?.addClass('is-hidden');
            this.paintChrome(canonical, null);
            this.setStatusLabel(`Seek: ${INDEX_STATUS_HEALTH[canonical].compact}`);
            return;
        }
        const pct = indexPercent(this.done, this.total);
        if (!force && this.done === this.paintedDone && this.total === this.paintedTotal && pct === this.paintedPercent) return;
        this.paintedDone = this.done;
        this.paintedTotal = this.total;
        this.paintedPercent = pct;
        const remaining = jobRemaining(this.job()) ?? 0;
        this.paintChrome('indexing', remaining);
        this.labelEl?.removeClass('is-hidden');
        this.labelEl?.setText(`${pct}%`);
        if (this.progressEl) {
            this.progressEl.removeClass('is-hidden');
            this.progressEl.max = 100;
            this.progressEl.value = pct;
        }
        this.setStatusLabel(this.jobTooltip());
    }

    private paintIdle(): void {
        if (!this.root) return;
        this.labelEl?.removeClass('is-hidden');
        this.labelEl?.setText('Seek');
        this.progressEl?.addClass('is-hidden');
        const health = this.hooks?.getHealth() ?? 'ok';
        this.paintChrome(health, null);
        this.setStatusLabel(`Seek: ${INDEX_STATUS_HEALTH[health].compact}`);
    }

    private paintChrome(health: IndexStatusHealth, remaining: number | null): void {
        if (!this.chromeEl) return;
        this.chromeEl.empty();
        renderIndexStatusBadge(this.chromeEl, { health, remaining });
    }

    private setStatusLabel(text: string): void {
        if (!this.root) return;
        this.root.setAttr('aria-label', text);
        setTooltip(this.root, text);
    }

    private async onHover(): Promise<void> {
        const hover = this.hoverEl;
        const hooks = this.hooks;
        if (!hover || !hooks) return;
        const gen = ++this.hoverGen;
        hover.empty();
        hover.removeClass('is-hidden');
        const stats = await hooks.getStats();
        if (gen !== this.hoverGen) return;
        hover.empty();
        let health = hooks.getHealth();
        if (health === 'starting' || health === 'restoring' || health === 'locked') {
            /* keep canonical hydrate/lock labels even if a job is queued */
        } else if (this.jobActive) health = 'indexing';
        else if (health !== 'error' && health !== 'indexing' && stats.files === 0 && stats.chunks === 0) health = 'none';
        renderIndexStatusCard(hover, {
            health,
            stats,
            job: this.job(),
            eta: this.jobActive ? formatRoughEta(this.done, this.total, performance.now() - this.jobStartedAt) : null,
        });
    }

    private hideHover(): void {
        this.hoverGen++;
        this.hoverEl?.addClass('is-hidden');
        this.hoverEl?.empty();
    }
}
