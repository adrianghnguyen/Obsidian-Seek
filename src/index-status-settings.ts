// Settings-only extensions to the shared index status card — startup latency
// breakdown. Status-bar hover keeps calling renderIndexStatusCard without these.

import {
    buildStartupTimingRows,
    fmtLatency,
    type StartupTimingView,
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
    },
): HTMLElement {
    const card = renderIndexStatusCard(parent, {
        health: opts.health,
        stats: opts.stats,
        job: opts.job,
    });

    const booting = opts.health === 'starting' || opts.health === 'restoring';
    const startup = opts.startup;
    const showStartup = booting || (startup?.bootComplete ?? false);
    if (!showStartup && opts.liveElapsedMs == null) return card;

    const block = card.createDiv({ cls: 'seek-status-startup' });
    if (booting && opts.liveElapsedMs != null) {
        block.createDiv({ cls: 'seek-status-startup-head', text: 'startup' });
        const live = block.createDiv({ cls: 'seek-status-startup-live' });
        live.createDiv({ cls: 'seek-status-value', text: fmtLatency(opts.liveElapsedMs) });
        live.createDiv({ cls: 'seek-status-mlabel', text: 'elapsed from start' });
        return card;
    }

    if (startup?.bootComplete) {
        block.createDiv({ cls: 'seek-status-startup-head', text: 'last startup' });
        const rows = block.createDiv({ cls: 'seek-status-startup-rows' });
        for (const row of buildStartupTimingRows(startup)) {
            const line = rows.createDiv({ cls: 'seek-status-startup-row' });
            line.createSpan({ cls: 'seek-status-startup-label', text: row.label });
            line.createSpan({ cls: 'seek-status-startup-phase', text: row.phase });
            line.createSpan({ cls: 'seek-status-startup-sep', text: '·' });
            line.createSpan({ cls: 'seek-status-startup-from', text: row.fromStart });
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
