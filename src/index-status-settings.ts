// Settings-only extensions to the shared index status card — startup latency
// breakdown. The block always renders and fills in as the boot progresses:
// Searchable clocks live until the gate releases, Cache warm shows queued →
// live clock → final duration, Fully ready opens when warm ends (or carries the
// last boot's total plus a trend while this boot is still working). Status-bar
// hover keeps calling renderIndexStatusCard without these.

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
} from './index-status-card';

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
    },
): HTMLElement {
    const card = renderIndexStatusCard(parent, {
        health: opts.health,
        stats: opts.stats,
        job: opts.job,
    });

    const startup = opts.startup;
    const booting = opts.health === 'starting' || opts.health === 'restoring';
    const warmRunning = !!startup && !startup.warmSkipped && startup.warmPhaseMs == null
        && startup.searchableMs != null && opts.liveElapsedMs != null;
    const liveWarmMs = warmRunning && opts.liveElapsedMs != null && startup?.searchableMs != null
        ? opts.liveElapsedMs - startup.searchableMs
        : null;
    const showTrendWhileWorking = !!startup && startup.readyFromStartMs == null
        && opts.prevBoot && !opts.prevBoot.warmSkipped && opts.prevBoot.readyFromStartMs != null;

    const block = card.createDiv({ cls: 'seek-status-startup' });
    block.createDiv({ cls: 'seek-status-startup-head', text: 'startup' });

    const rows = block.createDiv({ cls: 'seek-status-startup-rows' });
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
        const foot = block.createDiv({
            cls: `seek-status-startup-trend is-${trend.direction}`,
            text: trend.text,
        });
        foot.setAttr('aria-label', 'Fully ready time compared with the previous boot on this device');
    } else if (showTrendWhileWorking && opts.prevBoot?.readyFromStartMs != null) {
        block.createDiv({
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
