// Telemetry for Settings → Seek: startup phase timings (filled in progressively
// during boot, persisted per-device for a boot-over-boot trend) and a rolling
// window of recent modal search latencies. Recent searches are session-only.

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
    value: string;
}

const RECENT_SEARCH_MAX = 5;
const CONSOLE_QUERY_MAX = 48;

/** Format sub-second as ms, otherwise one decimal second. */
export function fmtLatency(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms)}ms`;
}

// One number per stage: gate time, warm duration, total. Rows fill in as the
// boot progresses — Searchable clocks live until the gate releases, Cache warm
// shows queued → live clock → final delta, Fully ready opens when warm ends.
export function buildStartupTimingRows(
    view: StartupTimingView,
    liveBootMs: number | null = null,
    liveWarmMs: number | null = null,
): StartupTimingRow[] {
    const searchable = view.searchableMs != null
        ? fmtLatency(view.searchableMs)
        : (liveBootMs != null ? fmtLatency(liveBootMs) : '…');
    const warm = view.warmSkipped
        ? 'skipped'
        : (view.warmPhaseMs != null
            ? fmtLatency(view.warmPhaseMs)
            : (liveWarmMs != null
                ? fmtLatency(liveWarmMs)
                : (view.searchableMs != null ? 'queued' : '…')));
    const ready = view.readyFromStartMs != null ? fmtLatency(view.readyFromStartMs) : '…';
    return [
        { label: 'Searchable', value: searchable },
        { label: 'Cache warm', value: warm },
        { label: 'Fully ready', value: ready },
    ];
}

// ── Per-boot history (device-local) ────────────────────────────────────────
// Completed boots are snapshotted to localStorage (never synced via data.json —
// boot cost is a device trait, same reasoning as the startup warm toggle) so the
// Settings card can trend this boot against the previous one.

export interface StoredStartupBoot {
    searchableMs: number | null;
    warmPhaseMs: number | null;
    readyFromStartMs: number | null;
    warmSkipped: boolean;
    /** Epoch ms when the boot completed. */
    at: number;
}

export interface StartupTrend {
    direction: 'faster' | 'slower' | 'flat';
    text: string;
}

/** The subset of a stored boot the Settings card trends against. */
export interface StartupTrendBaseline {
    readyFromStartMs: number | null;
    warmSkipped: boolean;
}

/** Compare this boot's ready time with the previous recorded boot. */
export function startupTrend(
    current: StartupTimingView,
    prev: StartupTrendBaseline | null,
): StartupTrend | null {
    // Warm-skipped boots aren't comparable with warm-completed ones.
    if (!prev || prev.warmSkipped || current.warmSkipped) return null;
    if (current.readyFromStartMs == null || prev.readyFromStartMs == null) return null;
    const delta = current.readyFromStartMs - prev.readyFromStartMs;
    if (Math.abs(delta) < 500) return { direction: 'flat', text: '≈ last boot' };
    return delta < 0
        ? { direction: 'faster', text: `▼ ${fmtLatency(-delta)} vs last boot` }
        : { direction: 'slower', text: `▲ ${fmtLatency(delta)} vs last boot` };
}

const STARTUP_HISTORY_KEY = 'seek-startup-history';
const STARTUP_HISTORY_MAX = 8;

export class StartupBootHistory {
    private readonly loadStorage: () => Storage | null;

    constructor(loadStorage: () => Storage | null) {
        this.loadStorage = loadStorage;
    }

    private read(): StoredStartupBoot[] {
        const storage = this.loadStorage();
        if (!storage) return [];
        try {
            const raw = storage.getItem(STARTUP_HISTORY_KEY);
            if (!raw) return [];
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed.filter(isStoredBoot);
        } catch {
            return [];
        }
    }

    private write(entries: StoredStartupBoot[]): void {
        const storage = this.loadStorage();
        if (!storage) return;
        try {
            storage.setItem(STARTUP_HISTORY_KEY, JSON.stringify(entries));
        } catch { /* best-effort */ }
    }

    /** Most recent stored boot, or null when history is empty. */
    previous(): StoredStartupBoot | null {
        return this.read()[0] ?? null;
    }

    all(): readonly StoredStartupBoot[] {
        return this.read();
    }

    record(view: StartupTimingView): void {
        if (!view.bootComplete || view.readyFromStartMs == null) return;
        const entries = this.read();
        entries.unshift({
            searchableMs: view.searchableMs,
            warmPhaseMs: view.warmPhaseMs,
            readyFromStartMs: view.readyFromStartMs,
            warmSkipped: view.warmSkipped,
            at: Date.now(),
        });
        this.write(entries.slice(0, STARTUP_HISTORY_MAX));
    }
}

function isStoredBoot(v: unknown): v is StoredStartupBoot {
    if (typeof v !== 'object' || v == null) return false;
    const b = v as Record<string, unknown>;
    return 'readyFromStartMs' in b && 'warmSkipped' in b && 'at' in b;
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
