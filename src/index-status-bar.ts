// Desktop status-bar widget for index inventory + in-flight pass percent.
// Replaces the sticky Indexing Notice: no show-delay, no min-visible, no Notice.

import { Platform, setTooltip } from 'obsidian';
import {
    renderIndexStatusCard,
    INDEX_STATUS_HEALTH,
    type IndexStatusCardStats,
    type IndexStatusHealth,
} from './index-status-card';

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

export interface IndexStatusBarHooks {
    getStats: () => Promise<IndexStatusCardStats>;
    getHealth: () => IndexStatusHealth;
    onOpenSettings: () => void;
}

export class IndexStatusBar {
    private root: HTMLElement | null = null;
    private dotEl: HTMLElement | null = null;
    private labelEl: HTMLElement | null = null;
    private progressEl: HTMLProgressElement | null = null;
    private hoverEl: HTMLElement | null = null;
    private hooks: IndexStatusBarHooks | null = null;
    private jobActive = false;
    private jobPaused = false;
    private total = 0;
    private done = 0;
    private label = '';
    private paintedPct: number | null = null;
    private hoverGen = 0;

    mount(el: HTMLElement, hooks: IndexStatusBarHooks): void {
        if (Platform.isMobile) return;
        this.root = el;
        this.hooks = hooks;
        el.addClass('seek-status-bar');
        el.setAttr('role', 'button');
        el.setAttr('tabindex', '0');
        this.dotEl = el.createSpan({ cls: 'seek-dot seek-dot-mid' });
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

    show(total: number, label: string): void {
        this.jobActive = true;
        this.jobPaused = /paused/i.test(label);
        this.total = Math.max(0, total);
        this.done = 0;
        this.label = label;
        this.paintedPct = null;
        this.paintJob(true);
    }

    updateFromProgress(msg: string): void {
        const parsed = parseIndexedProgress(msg);
        if (parsed) this.update(parsed.files, this.total, msg);
        else this.update(this.done, this.total, msg);
    }

    update(done: number, total: number, label?: string): void {
        this.done = Math.max(0, done);
        this.total = Math.max(0, total);
        if (label) {
            this.label = label;
            this.jobPaused = /paused/i.test(label);
        }
        this.paintJob(false);
    }

    hide(): void {
        this.jobActive = false;
        this.jobPaused = false;
        this.done = 0;
        this.total = 0;
        this.label = '';
        this.paintedPct = null;
        this.paintIdle();
        this.hideHover();
    }

    /** Repaint the idle dot/label from getHealth() — e.g. after boot or catch-up. */
    refreshIdle(): void {
        if (this.jobActive) return;
        this.paintIdle();
    }

    private paintJob(force: boolean): void {
        if (!this.root) return;
        const pct = quantizePercent(this.done, this.total);
        if (!force && pct === this.paintedPct) return;
        this.paintedPct = pct;
        this.labelEl?.setText(`Seek ${pct}%`);
        if (this.progressEl) {
            this.progressEl.removeClass('is-hidden');
            this.progressEl.max = 100;
            this.progressEl.value = pct;
        }
        this.setDot('indexing');
        this.setStatusLabel(`${this.label} ${pct}%`);
    }

    private paintIdle(): void {
        if (!this.root) return;
        this.labelEl?.setText('Seek');
        this.progressEl?.addClass('is-hidden');
        const health = this.hooks?.getHealth() ?? 'ok';
        this.setDot(health);
        this.setStatusLabel(`Seek: ${INDEX_STATUS_HEALTH[health].compact}`);
    }

    private setStatusLabel(text: string): void {
        if (!this.root) return;
        this.root.setAttr('aria-label', text);
        setTooltip(this.root, text);
    }

    private setDot(health: IndexStatusHealth): void {
        if (!this.dotEl) return;
        this.dotEl.className = `seek-dot seek-dot-${INDEX_STATUS_HEALTH[health].tone}`;
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
        if (this.jobActive) health = 'indexing';
        else if (health !== 'error' && health !== 'indexing' && health !== 'starting' && health !== 'restoring' && stats.files === 0) health = 'none';
        renderIndexStatusCard(hover, {
            health,
            stats,
            job: this.jobActive ? { done: this.done, total: this.total, paused: this.jobPaused } : null,
        });
    }

    private hideHover(): void {
        this.hoverGen++;
        this.hoverEl?.addClass('is-hidden');
        this.hoverEl?.empty();
    }
}
