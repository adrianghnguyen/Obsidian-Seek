// Telemetry for Settings → Seek: startup phase timings (filled in progressively
// during boot, persisted on disk for a boot-over-boot trend) and a rolling
// window of recent modal search latencies. Recent searches are session-only.

import type { DataAdapter } from 'obsidian';

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

// ── Per-boot history (device-local, on disk) ─────────────────────────────
// Completed boots are snapshotted to a JSON file in the plugin folder (never
// synced via data.json — boot cost is a device trait, same reasoning as the
// startup warm toggle). The file survives plugin reloads and manifest deploys
// because it lives beside main.js, not in the replaced artifacts.

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

export const STARTUP_HISTORY_FILE = 'startup-history.json';
export const STARTUP_HISTORY_MAX = 5;
const LEGACY_STARTUP_HISTORY_KEY = 'seek-startup-history';

export interface StartupBootHistoryBackend {
    readRaw(): Promise<string | null>;
    writeRaw(json: string): Promise<void>;
    readLegacyLocalStorage(): StoredStartupBoot[];
    clearLegacyLocalStorage(): void;
}

/** Disk-backed store in the plugin folder; migrates one-time from localStorage. */
export class StartupBootHistory {
    private entries: StoredStartupBoot[] = [];
    private saveChain = Promise.resolve();

    constructor(private readonly backend: StartupBootHistoryBackend) {}

    static forPlugin(adapter: DataAdapter, pluginDir: string): StartupBootHistory {
        const path = `${pluginDir}/${STARTUP_HISTORY_FILE}`;
        return new StartupBootHistory({
            readRaw: async () => {
                try {
                    if (!(await adapter.exists(path))) return null;
                    return await adapter.read(path);
                } catch {
                    return null;
                }
            },
            writeRaw: async (json) => {
                try {
                    await adapter.write(path, json);
                } catch { /* best-effort */ }
            },
            readLegacyLocalStorage: () => readLegacyStartupHistory(),
            clearLegacyLocalStorage: () => clearLegacyStartupHistory(),
        });
    }

    /** Load from disk (and migrate legacy localStorage when disk is empty). */
    async load(): Promise<void> {
        let entries = parseStoredBoots(await this.backend.readRaw());
        if (entries.length === 0) {
            entries = this.backend.readLegacyLocalStorage();
            if (entries.length > 0) {
                entries = entries.slice(0, STARTUP_HISTORY_MAX);
                await this.persist(entries);
            }
            this.backend.clearLegacyLocalStorage();
        } else if (entries.length > STARTUP_HISTORY_MAX) {
            entries = entries.slice(0, STARTUP_HISTORY_MAX);
            await this.persist(entries);
        }
        this.entries = entries;
    }

    /** Most recent stored boot, or null when history is empty. */
    previous(): StoredStartupBoot | null {
        return this.entries[0] ?? null;
    }

    all(): readonly StoredStartupBoot[] {
        return this.entries;
    }

    record(view: StartupTimingView): void {
        if (!view.bootComplete || view.readyFromStartMs == null) return;
        this.entries.unshift({
            searchableMs: view.searchableMs,
            warmPhaseMs: view.warmPhaseMs,
            readyFromStartMs: view.readyFromStartMs,
            warmSkipped: view.warmSkipped,
            at: Date.now(),
        });
        this.entries = this.entries.slice(0, STARTUP_HISTORY_MAX);
        void this.enqueueSave();
    }

    private async persist(entries: StoredStartupBoot[]): Promise<void> {
        await this.backend.writeRaw(JSON.stringify(entries));
    }

    private enqueueSave(): void {
        const snapshot = this.entries.slice();
        this.saveChain = this.saveChain
            .then(() => this.persist(snapshot))
            .catch(() => {});
    }
}

function parseStoredBoots(raw: string | null): StoredStartupBoot[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isStoredBoot);
    } catch {
        return [];
    }
}

function readLegacyStartupHistory(): StoredStartupBoot[] {
    try {
        const raw = window.localStorage.getItem(LEGACY_STARTUP_HISTORY_KEY);
        return parseStoredBoots(raw);
    } catch {
        return [];
    }
}

function clearLegacyStartupHistory(): void {
    try {
        window.localStorage.removeItem(LEGACY_STARTUP_HISTORY_KEY);
    } catch { /* best-effort */ }
}

/** Compact relative time for a stored boot row in Settings. */
export function formatBootAge(atMs: number, nowMs = Date.now()): string {
    const delta = nowMs - atMs;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
    if (delta < 7 * 86_400_000) return `${Math.round(delta / 86_400_000)}d ago`;
    return new Date(atMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One-line summary for a stored boot in the Settings history list. */
export function formatStoredBootLine(boot: StoredStartupBoot): string {
    if (boot.readyFromStartMs == null) return '—';
    const searchable = boot.searchableMs != null ? fmtLatency(boot.searchableMs) : '—';
    const ready = fmtLatency(boot.readyFromStartMs);
    if (boot.warmSkipped) return `${searchable} searchable · warm skipped · ${ready} ready`;
    const warm = boot.warmPhaseMs != null ? fmtLatency(boot.warmPhaseMs) : '—';
    return `${searchable} searchable · ${warm} warm · ${ready} ready`;
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
