// Session-only telemetry for Settings → Seek: startup phase timings and a
// rolling window of recent modal search latencies. Not persisted across restarts.

export interface StartupTimingView {
    /** Wall ms boot → searchable gate. */
    searchableMs: number | null;
    /** Wall ms gate → warm done; null when warm skipped or still running. */
    warmPhaseMs: number | null;
    /** Wall ms boot → fully ready (warm end, or searchable when warm skipped). */
    readyFromStartMs: number | null;
    warmSkipped: boolean;
    /** True once warm finished or was skipped — boot timeline is complete. */
    bootComplete: boolean;
}

export interface RecentSearchEntry {
    query: string;
    ms: number;
    at: number;
}

export interface StartupTimingRow {
    label: string;
    phase: string;
    fromStart: string;
}

const RECENT_SEARCH_MAX = 5;
const CONSOLE_QUERY_MAX = 48;

/** Format sub-second as ms, otherwise one decimal second. */
export function fmtLatency(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms)}ms`;
}

export function buildStartupTimingRows(view: StartupTimingView): StartupTimingRow[] {
    const searchable = view.searchableMs;
    const warmPhase = view.warmPhaseMs;
    const ready = view.readyFromStartMs;

    return [
        {
            label: 'Searchable',
            phase: searchable != null ? fmtLatency(searchable) : '—',
            fromStart: searchable != null ? `${fmtLatency(searchable)} from start` : '—',
        },
        {
            label: 'Cache warm',
            phase: view.warmSkipped ? '—' : (warmPhase != null ? fmtLatency(warmPhase) : '—'),
            fromStart: view.warmSkipped
                ? '—'
                : (ready != null ? `${fmtLatency(ready)} from start` : '—'),
        },
        {
            label: 'Fully ready',
            phase: '—',
            fromStart: ready != null ? `${fmtLatency(ready)} from start` : '—',
        },
    ];
}

export class StartupSessionTracker {
    private bootStartMs = 0;
    private searchableMs: number | null = null;
    private warmStartPerf = 0;
    private warmPhaseMs: number | null = null;
    private readyFromStartMs: number | null = null;
    private warmSkipped = false;
    private bootComplete = false;

    beginBoot(startMs: number): void {
        this.bootStartMs = startMs;
        this.searchableMs = null;
        this.warmStartPerf = 0;
        this.warmPhaseMs = null;
        this.readyFromStartMs = null;
        this.warmSkipped = false;
        this.bootComplete = false;
    }

    markSearchable(): void {
        if (this.searchableMs != null) return;
        this.searchableMs = Math.round(performance.now() - this.bootStartMs);
    }

    beginWarm(): void {
        if (this.warmSkipped || this.warmStartPerf > 0) return;
        this.warmStartPerf = performance.now();
    }

    endWarm(): void {
        if (this.bootComplete || this.warmSkipped) return;
        if (this.warmStartPerf <= 0) {
            this.markWarmSkipped();
            return;
        }
        const end = performance.now();
        this.warmPhaseMs = Math.round(end - this.warmStartPerf);
        this.readyFromStartMs = Math.round(end - this.bootStartMs);
        this.bootComplete = true;
    }

    markWarmSkipped(): void {
        if (this.bootComplete) return;
        this.warmSkipped = true;
        this.warmPhaseMs = null;
        this.readyFromStartMs = this.searchableMs;
        this.bootComplete = true;
    }

    liveElapsedMs(): number | null {
        if (this.bootStartMs <= 0) return null;
        return Math.round(performance.now() - this.bootStartMs);
    }

    view(): StartupTimingView {
        return {
            searchableMs: this.searchableMs,
            warmPhaseMs: this.warmPhaseMs,
            readyFromStartMs: this.readyFromStartMs,
            warmSkipped: this.warmSkipped,
            bootComplete: this.bootComplete,
        };
    }
}

export class RecentSearchRing {
    private readonly entries: RecentSearchEntry[] = [];

    push(query: string, ms: number): void {
        const trimmed = query.trim();
        if (!trimmed) return;
        this.entries.unshift({ query: trimmed, ms: Math.round(ms), at: Date.now() });
        if (this.entries.length > RECENT_SEARCH_MAX) this.entries.length = RECENT_SEARCH_MAX;
    }

    snapshot(): readonly RecentSearchEntry[] {
        return this.entries;
    }
}

export function formatRecentSearchLine(entry: RecentSearchEntry): string {
    const q = truncateConsoleQuery(entry.query);
    return `[${q}] ${fmtLatency(entry.ms)}`;
}

export function truncateConsoleQuery(query: string, max = CONSOLE_QUERY_MAX): string {
    if (query.length <= max) return query;
    return `${query.slice(0, max - 1)}…`;
}

export function formatRecentSearchConsole(entries: readonly RecentSearchEntry[]): string {
    if (entries.length === 0) return 'No searches this session';
    return entries.map(formatRecentSearchLine).join('\n');
}
