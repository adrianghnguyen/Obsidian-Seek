// Desktop status-bar widget for index inventory + in-flight remaining files.
// Replaces the sticky Indexing Notice: no show-delay, no min-visible, no Notice.
// Indexing chrome is the numbered remaining-files badge shared with the search modal.

import { Platform, setTooltip } from 'obsidian';
import {
    renderIndexStatusCard,
    renderIndexStatusBadge,
    type IndexStatusCardStats,
    type IndexStatusHealth,
    type IndexStatusJob,
    type IndexJobKind,
    type IndexJobSpeedView,
} from './index-status-card';
import { IDLE_PROGRESS, type IndexStatusReport } from './index-status-report';
import {
    indexChunksPerSec,
    indexFilesPerSec,
    indexTokensPerSec,
} from './index-eta';
import { formatStableFileFraction } from './index-progress-format';
import { buildIndexProgressSnapshot, type IndexProgressSnapshot } from './index-progress-snapshot';

export type { IndexJobSpeedView };
export { indexChunksPerSec, indexFilesPerSec, indexTokensPerSec };

export function parseIndexedProgress(msg: string): { files: number; chunks: number | null; tokens: number | null } | null {
    const m = msg.match(
        /Indexed\s+([\d,]+)\s+files(?:\s*·\s*([\d,]+)\s+chunks)?(?:\s*·\s*([\d,]+)\s+tokens)?/i,
    );
    if (!m) return null;
    const files = parseInt(m[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(files)) return null;
    const chunks = m[2] != null ? parseInt(m[2].replace(/,/g, ''), 10) : null;
    const tokens = m[3] != null ? parseInt(m[3].replace(/,/g, ''), 10) : null;
    if (chunks != null && !Number.isFinite(chunks)) return { files, chunks: null, tokens: null };
    if (tokens != null && !Number.isFinite(tokens)) return { files, chunks, tokens: null };
    return { files, chunks, tokens };
}

/** Canonical progress line from embedAndCommitFiles — keep in sync with search.ts onProgress. */
export function formatIndexedProgress(files: number, chunks: number, tokens?: number): string {
    const base = `Indexed ${files} files · ${chunks} chunks`;
    return tokens != null && tokens >= 0 ? `${base} · ${tokens} tokens` : base;
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
    getReport: () => IndexStatusReport;
    /** Plugin snapshot — same object Settings Index and folder coverage read. */
    getSnapshot?: () => IndexProgressSnapshot;
    onOpenSettings: () => void;
    /** One-click recovery for a wedged startup (stuck/locked) — retries the index. */
    onRecover: () => void;
}

export class IndexStatusBar {
    private root: HTMLElement | null = null;
    private chromeEl: HTMLElement | null = null;
    private labelEl: HTMLElement | null = null;
    private filesEl: HTMLElement | null = null;
    private chunksEl: HTMLElement | null = null;
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
    private chunksDone = 0;
    private tokensDone = 0;
    private label = '';
    private aligningExclusions = false;
    private jobStartedAt = 0;
    /** Encode-active time only — catch-up pauses between bursts must not dilute ch/s. */
    private elapsedAccumMs = 0;
    private elapsedTicking = false;
    private paintedDone = -1;
    private paintedTotal = -1;
    private paintedChunks = -1;
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
        this.labelEl = el.createSpan({ cls: 'seek-status-bar-label' });
        this.filesEl = this.labelEl.createSpan({ cls: 'seek-status-bar-files', text: 'Seek' });
        this.chunksEl = this.labelEl.createSpan({ cls: 'seek-status-bar-chunks is-hidden' });
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

    show(total: number, label: string, opts?: { id?: number; kind?: IndexJobKind; aligningExclusions?: boolean }): void {
        this.jobActive = true;
        this.jobPaused = /paused/i.test(label);
        this.jobGen += 1;
        this.jobId = opts?.id ?? this.jobGen;
        this.jobKind = opts?.kind ?? null;
        this.aligningExclusions = !!opts?.aligningExclusions || /aligning with exclusions/i.test(label);
        this.total = Math.max(0, total);
        this.done = 0;
        this.chunksDone = 0;
        this.tokensDone = 0;
        this.label = label;
        this.jobStartedAt = performance.now();
        this.elapsedAccumMs = 0;
        this.elapsedTicking = true;
        this.paintedDone = -1;
        this.paintedTotal = -1;
        this.paintedChunks = -1;
        this.paintedPercent = -1;
        this.schedulePaintJob(true);
    }

    updateFromProgress(msg: string, id?: number): void {
        // Job id is checked before any field write. A stale pass (the bar was
        // stolen by a later beginIndexJob) must not paint its chunk counts onto
        // the new job while leaving the file counter at 0.
        if (id != null && this.jobId !== id) return;
        const parsed = parseIndexedProgress(msg);
        if (parsed) {
            if (parsed.chunks != null) this.chunksDone = parsed.chunks;
            if (parsed.tokens != null) this.tokensDone = parsed.tokens;
            this.update(parsed.files, this.total, msg, id);
        } else this.update(this.done, this.total, msg, id);
    }

    update(done: number, total: number, label?: string, id?: number, chunksDone?: number, tokensDone?: number): void {
        if (id != null && this.jobId !== id) return;
        const nextTotal = Math.max(0, total);
        this.total = nextTotal;
        this.done = Math.min(nextTotal, Math.max(0, done));
        if (label) {
            this.label = label;
            this.jobPaused = /paused/i.test(label);
            if (/aligning with exclusions/i.test(label)) this.aligningExclusions = true;
        }
        if (chunksDone != null) {
            this.chunksDone = Math.max(0, chunksDone);
        } else if (label) {
            const parsed = parseIndexedProgress(label);
            if (parsed?.chunks != null) this.chunksDone = parsed.chunks;
            if (parsed?.tokens != null) this.tokensDone = parsed.tokens;
        }
        if (tokensDone != null) this.tokensDone = Math.max(0, tokensDone);
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
        this.aligningExclusions = false;
        this.done = 0;
        this.chunksDone = 0;
        this.tokensDone = 0;
        this.total = 0;
        this.label = '';
        this.jobStartedAt = 0;
        this.elapsedAccumMs = 0;
        this.elapsedTicking = false;
        this.paintedDone = -1;
        this.paintedTotal = -1;
        this.paintedChunks = -1;
        this.paintedPercent = -1;
        this.paintIdle();
        this.hideHover();
    }

    /** Repaint the idle chrome from getReport() — e.g. after boot or catch-up. */
    refreshIdle(): void {
        if (this.jobActive) {
            this.schedulePaintJob(true);
            return;
        }
        this.paintIdle();
    }

    job(): IndexStatusJob | null {
        if (!this.jobActive || this.total <= 0) return null;
        return {
            id: this.jobId,
            kind: this.jobKind ?? undefined,
            done: this.done,
            total: this.total,
            paused: this.jobPaused,
            aligningExclusions: this.aligningExclusions || undefined,
        };
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

    /** Stop the encode clock while catch-up waits for the next burst. */
    pauseElapsed(): void {
        if (!this.jobActive || !this.elapsedTicking) return;
        this.elapsedAccumMs += Math.max(0, performance.now() - this.jobStartedAt);
        this.elapsedTicking = false;
        this.jobPaused = true;
        this.schedulePaintJob(true);
    }

    /** Resume the encode clock when a catch-up burst starts encoding again. */
    resumeElapsed(): void {
        if (!this.jobActive || this.elapsedTicking) return;
        this.jobStartedAt = performance.now();
        this.elapsedTicking = true;
        this.jobPaused = /paused/i.test(this.label);
        this.schedulePaintJob(true);
    }

    private liveElapsedMs(): number {
        if (!this.jobActive) return 0;
        const extra = this.elapsedTicking ? Math.max(0, performance.now() - this.jobStartedAt) : 0;
        return this.elapsedAccumMs + extra;
    }

    /** Live encode-speed inputs for Settings — status bar no longer shows ch/s. */
    jobSpeedView(): IndexJobSpeedView | null {
        if (!this.jobActive || this.total <= 0) return null;
        return {
            chunksDone: this.chunksDone,
            tokensDone: this.tokensDone,
            done: this.done,
            total: this.total,
            elapsedMs: this.liveElapsedMs(),
            paused: this.jobPaused,
            kind: this.jobKind ?? undefined,
        };
    }

    /** Same snapshot Settings Index and folder coverage consume. */
    progressSnapshot(): IndexProgressSnapshot {
        if (this.hooks?.getSnapshot) return this.hooks.getSnapshot();
        const report = this.hooks?.getReport() ?? {
            mode: 'ok' as const,
            health: 'ok' as const,
            label: 'Up to date',
            compact: 'Ready',
            tone: 'good',
            hydrateProgress: null,
            progress: IDLE_PROGRESS,
        };
        return buildIndexProgressSnapshot({
            report,
            job: this.job(),
            speed: this.jobSpeedView(),
        });
    }

    private jobTooltipFromSnapshot(snap: IndexProgressSnapshot): string {
        const pct = snap.percent;
        const eta = snap.eta;
        const files = `${snap.filesDone.toLocaleString()} / ${snap.filesTotal.toLocaleString()} files · ${pct}%`;
        const tail = eta ? ` · ${eta} left` : '';
        const verb = snap.aligningExclusions
            ? 'Aligning with exclusions'
            : (snap.mode === 'full-reindex' || snap.mode === 'indexing'
                ? snap.report.compact
                : 'Indexing');
        return `Seek: ${verb} ${files}${tail}`;
    }

    private paintMeter(opts: { hidden: boolean; determinate: boolean; percent: number }): void {
        if (!this.progressEl) return;
        if (opts.hidden) {
            this.progressEl.addClass('is-hidden');
            this.progressEl.removeClass('is-indeterminate');
            return;
        }
        this.progressEl.removeClass('is-hidden');
        if (!opts.determinate) {
            this.progressEl.addClass('is-indeterminate');
            if (typeof this.progressEl.removeAttribute === 'function') this.progressEl.removeAttribute('value');
            return;
        }
        this.progressEl.removeClass('is-indeterminate');
        this.progressEl.max = 100;
        this.progressEl.value = opts.percent;
    }

    private paintCounts(snap: IndexProgressSnapshot, remaining: number | null, label: string): void {
        const units = snap.indicator.units;
        const determinate = units ? units.determinate : snap.filesTotal > 0;
        const pct = determinate ? snap.percent : 0;
        this.paintedDone = snap.filesDone;
        this.paintedTotal = snap.filesTotal;
        this.paintedChunks = snap.chunksDone;
        this.paintedPercent = determinate ? pct : -2;
        this.labelEl?.removeClass('is-hidden');
        if (snap.filesTotal > 0) {
            this.filesEl?.setText(formatStableFileFraction(snap.filesDone, snap.filesTotal));
        } else {
            this.filesEl?.setText(snap.report.compact);
        }
        this.chunksEl?.addClass('is-hidden');
        this.paintMeter({ hidden: false, determinate, percent: pct });
        const chromeHealth = snap.phase === 'embed' ? 'indexing' : snap.health;
        this.paintChrome(chromeHealth, remaining);
        this.setStatusLabel(label);
    }

    private paintBare(snap: IndexProgressSnapshot): void {
        this.paintedDone = -1;
        this.paintedTotal = -1;
        this.paintedChunks = -1;
        this.paintedPercent = -1;
        this.labelEl?.removeClass('is-hidden');
        this.filesEl?.setText('Seek');
        this.chunksEl?.addClass('is-hidden');
        this.paintMeter({ hidden: true, determinate: true, percent: 0 });
        this.paintChrome(snap.health, null);
        this.setStatusLabel(`Seek: ${snap.report.compact}`);
    }

    private paintNamedWork(snap: IndexProgressSnapshot): void {
        this.paintedDone = snap.filesDone;
        this.paintedTotal = snap.filesTotal;
        this.paintedChunks = snap.chunksDone;
        this.paintedPercent = -2;
        this.labelEl?.removeClass('is-hidden');
        this.filesEl?.setText(snap.filesTotal > 0
            ? formatStableFileFraction(snap.filesDone, snap.filesTotal)
            : snap.report.compact);
        this.chunksEl?.addClass('is-hidden');
        this.paintMeter({ hidden: false, determinate: false, percent: 0 });
        this.paintChrome(snap.health, null);
        this.setStatusLabel(`Seek: ${snap.report.compact}`);
    }

    /** Coverage counts without a live-walk meter — idle Ready must not look like a pass. */
    private paintIdleCoverage(snap: IndexProgressSnapshot): void {
        this.paintedDone = snap.filesDone;
        this.paintedTotal = snap.filesTotal;
        this.paintedChunks = snap.chunksDone;
        this.paintedPercent = -1;
        this.labelEl?.removeClass('is-hidden');
        this.filesEl?.setText(formatStableFileFraction(snap.filesDone, snap.filesTotal));
        this.chunksEl?.addClass('is-hidden');
        this.paintMeter({ hidden: true, determinate: true, percent: 0 });
        this.paintChrome(snap.health, null);
        this.setStatusLabel(`Seek: ${snap.report.compact}`);
    }

    private paintFromSnapshot(snap: IndexProgressSnapshot, force: boolean): void {
        if (snap.health === 'updating') {
            this.paintBare(snap);
            return;
        }
        if (snap.phase === 'stuck' || snap.phase === 'locked' || snap.phase === 'error') {
            this.paintBare(snap);
            return;
        }
        if (snap.phase === 'verify') {
            if (snap.filesTotal > 0 && snap.indicator.units?.determinate) {
                this.paintCounts(snap, null, `Seek: ${snap.report.compact}`);
            } else {
                this.paintNamedWork(snap);
            }
            return;
        }
        if (snap.phase === 'hydrate' && snap.filesTotal > 0) {
            this.paintCounts(snap, snap.health === 'indexing' ? snap.remaining : null, `Seek: ${snap.report.compact}`);
            return;
        }
        if (snap.phase === 'hydrate' || snap.phase === 'starting') {
            if (snap.filesTotal > 0 && (snap.hydrate || snap.indicator.units?.determinate)) {
                this.paintCounts(snap, null, `Seek: ${snap.report.compact}`);
                return;
            }
            this.paintNamedWork(snap);
            return;
        }
        if (snap.phase === 'embed' && snap.filesTotal > 0) {
            if (!force && snap.filesDone === this.paintedDone && snap.filesTotal === this.paintedTotal
                && snap.chunksDone === this.paintedChunks && snap.percent === this.paintedPercent) return;
            this.paintCounts(snap, snap.remaining ?? 0, this.jobTooltipFromSnapshot(snap));
            return;
        }
        if (snap.phase === 'embed') {
            this.paintNamedWork(snap);
            return;
        }
        if (snap.filesTotal > 0) {
            // Fully indexed Ready is the green dot + "Seek" — not 3,854/3,854.
            if (snap.health === 'ok' && snap.filesDone >= snap.filesTotal) {
                this.paintBare(snap);
                return;
            }
            this.paintIdleCoverage(snap);
            return;
        }
        this.paintBare(snap);
    }

    private paintJob(force: boolean): void {
        if (!this.root) return;
        this.paintFromSnapshot(this.progressSnapshot(), force);
    }

    private paintIdle(): void {
        if (!this.root) return;
        this.paintFromSnapshot(this.progressSnapshot(), true);
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
        const snap = this.progressSnapshot();
        renderIndexStatusCard(hover, {
            health: snap.health,
            mode: snap.mode,
            label: snap.report.label,
            hydrateProgress: snap.hydrate,
            progress: snap.indicator,
            stats,
            job: snap.job,
            percent: snap.percent,
            remaining: snap.remaining,
            eta: snap.eta,
        });
        const health = snap.health;
        // One-click recovery lives on the hover card so a wedged startup is fixable
        // without opening Settings. Destructive rebuild stays in Settings; this is the
        // non-destructive Retry (same action as the command palette / Settings row).
        if (health === 'stuck' || health === 'locked') {
            this.renderHoverRecovery(hover, health);
        }
    }

    private renderHoverRecovery(hover: HTMLElement, health: IndexStatusHealth): void {
        const wrap = hover.createDiv({ cls: 'seek-index-hover-recovery' });
        wrap.createDiv({
            cls: 'seek-index-hover-recovery-msg',
            text: health === 'locked'
                ? 'The index database is locked.'
                : 'Startup is taking too long.',
        });
        const btn = wrap.createEl('button', { cls: 'seek-index-hover-recovery-btn mod-cta', text: 'Retry search index' });
        // Stop the click from bubbling to the root handler (which opens Settings) and
        // keep the popover from closing under the pointer mid-click.
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.hooks?.onRecover();
            this.hideHover();
        });
        wrap.createDiv({ cls: 'seek-index-hover-recovery-hint', text: 'Still stuck? Rebuild from Settings → Index.' });
    }

    private hideHover(): void {
        this.hoverGen++;
        this.hoverEl?.addClass('is-hidden');
        this.hoverEl?.empty();
    }
}
