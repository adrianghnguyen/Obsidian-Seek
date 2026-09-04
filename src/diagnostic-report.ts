import type { App } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import type {
    LogEntry, LogMeta, InitEntry, PlatformEntry,
    IndexCompleteEntry, SearchEntry, ErrorEntry,
    CrashDetectedEntry, DeltaApplyEntry, LoadEntry, LongTaskEntry, RechunkLiveEntry,
} from './types';
import { LOG_SCHEMA_VERSION } from './types';
import { redactEntries } from './redact';
import { detectPeriodicStalls, describePeriodicStalls } from './stall-pattern';

// The report is the only shared (single-writer-at-a-time, full-overwrite) file,
// and the only one kept at the vault ROOT — it must stay a real vault file so the
// "Generate logging report" command can open it (getAbstractFileByPath only
// resolves files outside the config folder). Safe under iCloud because it's never
// appended to from two devices at once.
export const REPORT_PATH = 'seek-report.md';

// Full structured diagnostic — kept under a hidden artifacts dir so the vault
// root stays a single human-readable summary (.md). Safe under iCloud because
// report generation is single-writer-at-a-time, full-overwrite.
export const REPORT_ARTIFACTS_DIR = '.seek-artifacts';
export const REPORT_JSON_PATH = `${REPORT_ARTIFACTS_DIR}/seek-report.json`;
export const LEGACY_REPORT_JSON_PATH = 'seek-report.json';

// Per-type recency caps for the generated report (NOT the raw NDJSON, which keeps
// everything and is bounded separately by rotateIfOversize). The report is a recent-
// activity snapshot kept small enough to email + parse fast; high-volume types keep
// their most recent N, while types ABSENT here (crash-detected, init, platform, reset,
// model-*, webgpu-event) are kept in full — rare and diagnostically critical. Without
// this the report is the entire history across every device (15+ MB after two weeks,
// ~82% of it search traces). entryCount vs includedCount + the `caps` field make any
// truncation explicit — no silent capping.
export const REPORT_CAPS: Record<string, number> = {
    search: 150,
    error: 300,
    'index-progress': 50,
    'index-complete': 100,
    'delta-apply': 100,
    'sidecar-hydrate': 50,
    'rechunk-live': 20,
    'startup-span': 50,
    'startup-gate': 20,
    'memory-pressure': 100,
    'long-task': 100,
    'storage-snapshot': 50,
    'app-local-fetch': 50,
    click: 100,
    load: 50,
};

export interface ReportData {
    generated: string;
    schemaVersion: number;
    thisDevice: string;
    thisSession: string;
    entryCount: number;
    includedCount: number;
    firstTimestamp: string | null;
    lastTimestamp: string | null;
    devices: Array<{ id: string; count: number }>;
    caps: Record<string, number>;
    // Whether note paths, queries, and titles were replaced by salted tokens
    // (see redact.ts). Recorded so a reader knows whether `note-3f9a21c4.md` is
    // a redaction or a genuinely odd filename, and so a reporter can prove which
    // mode they shared in.
    redacted: boolean;
    entries: LogEntry[];
}

export interface DiagnosticLoggerHost {
    app: App;
    readonly deviceId: string;
    readonly sessionId: string;
    flushErrorAggregates(): Promise<void>;
    readAllDevices(): Promise<LogEntry[]>;
    appendError(context: string, error: unknown): Promise<void>;
}

function randReportSalt(): string {
    const c = crypto as { randomUUID?: () => string };
    if (c.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
        const r = (Math.random() * 16) | 0;
        return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

export function filterByType<T extends LogEntry>(entries: LogEntry[], type: T['type']): T[] {
    return entries.filter((e): e is T => e.type === type);
}

export function fmtMB(v: number | null): string { return v == null ? 'unknown' : `${v.toFixed(0)} MB`; }

// this only ever creates the leaf '.seek-artifacts'. Called before every report write.
export async function ensureArtifactsDir(app: App): Promise<void> {
    const adapter = app.vault.adapter;
    if (await adapter.exists(REPORT_ARTIFACTS_DIR).catch(() => false)) return;
    await adapter.mkdir(REPORT_ARTIFACTS_DIR).catch(() => {});
}

// One-time move of seek-report.json off the vault root (pre-artifacts-dir builds).
export async function migrateLegacyReportJson(app: App): Promise<void> {
    const adapter = app.vault.adapter;
    if (!(await adapter.exists(LEGACY_REPORT_JSON_PATH).catch(() => false))) return;
    await ensureArtifactsDir(app);
    if (!(await adapter.exists(REPORT_JSON_PATH).catch(() => false))) {
        try {
            await adapter.rename(LEGACY_REPORT_JSON_PATH, REPORT_JSON_PATH);
            return;
        } catch { /* fall through to remove stale root copy */ }
    }
    await adapter.remove(LEGACY_REPORT_JSON_PATH).catch(() => {});
}

/**
 * Build the full diagnostic dataset: every device's stream merged + sorted by
 * timestamp (readAllDevices), plus a small metadata header. Serialized verbatim to
 * seek-report.json — the parse target. One flat, type-tagged `entries` array is the
 * most parse-friendly shape (filter by `.type` in jq / pandas) and needs no per-type
 * schema here; searches already carry the trimmed top-10 trace (see verboseTrace).
 * Persist the exact final tally for any message whose count has advanced past its
 * last milestone write. Called when building a report (so the artifact reflects an
 * in-flight storm) and safe anytime. Per-device: only this device's pending counts.
 */
export async function buildReportData(logger: DiagnosticLoggerHost, redact = false): Promise<ReportData> {
    await logger.flushErrorAggregates();   // surface any in-flight suppressed-error tails
    const entries = await logger.readAllDevices();
    const byDevice = new Map<string, number>();
    for (const e of entries) byDevice.set(e.deviceId ?? 'legacy', (byDevice.get(e.deviceId ?? 'legacy') ?? 0) + 1);
    // Recency-cap: walk newest?oldest keeping up to REPORT_CAPS[type] of each
    // high-volume type (uncapped types kept in full). Then restore ascending order.
    const kept: LogEntry[] = [];
    const perType = new Map<string, number>();
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const cap = REPORT_CAPS[e.type];
        if (cap !== undefined) {
            const n = perType.get(e.type) ?? 0;
            if (n >= cap) continue;
            perType.set(e.type, n + 1);
        }
        kept.push(e);
    }
    kept.reverse();
    // Defensively trim any historical 50-row search trace to the 10 the report uses
    // (pre-verboseTrace entries; new ones are already =10) so they don't bloat it.
    const trimmed = kept.map(e => {
        if (e.type !== 'search') return e;
        const s = e as SearchEntry;
        return s.fusedTop50 && s.fusedTop50.length > 10 ? { ...s, fusedTop50: s.fusedTop50.slice(0, 10) } : e;
    });
    // Redact LAST, over the already-capped set, and only into the report copy —
    // the on-disk NDJSON keeps its real paths, because the local log is the
    // user's own diagnostic and hashing it would break every future report.
    // A fresh salt per report: tokens correlate within this file and nowhere
    // else, so two reports from the same vault can't be cross-matched.
    const reported = redact ? redactEntries(trimmed, randReportSalt()) : trimmed;
    return {
        generated: new Date().toISOString(),
        schemaVersion: LOG_SCHEMA_VERSION,
        thisDevice: logger.deviceId,
        thisSession: logger.sessionId,
        entryCount: entries.length,
        includedCount: trimmed.length,
        firstTimestamp: entries[0]?.timestamp ?? null,
        lastTimestamp: entries.at(-1)?.timestamp ?? null,
        devices: [...byDevice.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
        caps: REPORT_CAPS,
        redacted: redact,
        entries: reported,
    };
}

// ~20-line human glance rendered from the already-built data (no second file read).
// The full detail lives in seek-report.json; this surfaces the headline facts a
// person needs before sharing, plus the privacy note, and points at the JSON.
export function summarizeReport(d: ReportData): string {
    const lines: string[] = [];
    lines.push('# Seek Diagnostic Report');
    lines.push(`\n_Generated ${d.generated} · log schema v${d.schemaVersion}_`);
    if (d.entryCount === 0) {
        lines.push('\nNo data recorded yet. Run a search or reindex to populate the log.');
        return lines.join('\n') + '\n';
    }
    const searches = filterByType<SearchEntry>(d.entries, 'search');
    const indexes = filterByType<IndexCompleteEntry>(d.entries, 'index-complete');
    const errors = filterByType<ErrorEntry>(d.entries, 'error');
    const crashes = filterByType<CrashDetectedEntry & LogMeta>(d.entries, 'crash-detected');
    const lastInit = filterByType<InitEntry>(d.entries, 'init').at(-1);
    const lastPlatform = filterByType<PlatformEntry>(d.entries, 'platform').at(-1);
    const lastLoad = filterByType<LoadEntry>(d.entries, 'load').at(-1);

    // The share-safety banner is the first thing a reporter reads, so it has to
    // state which mode actually produced the file rather than describe the
    // feature in the abstract. Redacted mode still says "review" — the sweep is
    // thorough but it is not a promise, and a user pasting into a public issue
    // deserves to be told to look.
    lines.push(d.redacted
        ? '\n> [!info] Redacted report — note paths, titles, and query text were replaced by salted tokens (`note-3f9a21c4.md`). Identical tokens mean the identical note, so the diagnostics still read. Please still skim before sharing.'
        : '\n> [!warning] Review before sharing — this report includes your recent search queries and matching note paths (but **not** note contents). Turn on **Redact report** in Seek settings to replace them with anonymous tokens.');
    lines.push(`\n**Full data:** \`${REPORT_JSON_PATH}\` — parse that for analysis; this \`.md\` is a human summary.`);
    lines.push('\n## At a Glance');
    lines.push(`- This device: \`${d.thisDevice}\` · session \`${d.thisSession}\``);
    lines.push(`- Events: ${d.includedCount} in report${d.includedCount < d.entryCount ? ` of ${d.entryCount} total (older high-volume entries capped — see \`caps\` in the JSON)` : ''} · ${d.firstTimestamp} → ${d.lastTimestamp}`);
    lines.push(`- Devices: ${d.devices.map(x => `\`${x.id}\` (${x.count})`).join(', ')}`);
    if (lastInit) lines.push(`- Last init: v${lastInit.pluginVersion}, iframe ${lastInit.iframeReady ? '✅' : '❌'}${lastInit.error ? ` · ⚠️ \`${lastInit.error}\`` : ''}`);
    if (lastPlatform) {
        // "GPU yes" alone is ambiguous: requestAdapter can return a
        // SOFTWARE fallback adapter (e.g. hardware acceleration off) that
        // then fails ORT's WebGPU init. Print the adapter description and
        // flag fallbacks so a report reader can tell the two apart —
        // the r/ObsidianMD triage had to ask for the JSON to know.
        let gpu = lastPlatform.gpuAvailable ? 'yes' : 'no';
        if (lastPlatform.gpuAvailable && (lastPlatform.gpuAdapterDescription || lastPlatform.gpuIsFallbackAdapter)) {
            const parts = [];
            if (lastPlatform.gpuAdapterDescription) parts.push(lastPlatform.gpuAdapterDescription);
            if (lastPlatform.gpuIsFallbackAdapter) parts.push('⚠️ SOFTWARE FALLBACK');
            gpu += ` (${parts.join(', ')})`;
        }
        lines.push(`- Platform: ${lastPlatform.isMobile ? 'mobile' : 'desktop'} · GPU ${gpu} · storage ${fmtMB(lastPlatform.storageUsedMB)} / ${fmtMB(lastPlatform.storageQuotaMB)}`);
    }
    // Which EP/dtype actually served the last successful model load — the
    // first question of any embed-failure triage, previously only in the
    // JSON. Absent entirely when no load ever succeeded (itself a signal).
    if (lastLoad) {
        // webgpuError carries raw ORT/Dawn output — Tint shader-compile
        // diagnostics are multiline and can contain backticks. Flatten +
        // cap so a hostile payload can't split this list item mid-code-span
        // and corrupt the rest of the section.
        const errText = lastLoad.webgpuError ? lastLoad.webgpuError.replace(/[`\n\r]/g, ' ').slice(0, 300) : null;
        const webgpuNote = errText ? ` · webgpu fell back: \`${errText}\`` : '';
        // === true guards: rows written by older plugin versions predate the
        // proxy fields, and undefined must read as "not attempted", not falsy-false.
        const proxyNote = lastLoad.proxy === true ? ' · proxy worker'
            : (lastLoad.proxyAttempted === true ? ' · ⚠️ proxy fell back to main thread' : '');
        lines.push(`- Last model load: ${lastLoad.actualDevice} (dtype=${lastLoad.dtype})${lastLoad.glue ? ` · glue ${lastLoad.glue}` : ''}${proxyNote}${webgpuNote}`);
    }
    lines.push(`- Searches ${searches.length} · index runs ${indexes.length} · errors ${errors.length} · crashes ${crashes.length}`);
    // Main-thread stall rollup by phase (issue #5): the question every jank
    // triage starts with — WHAT was Seek doing during the stalls — answered
    // in the summary instead of via hand-grepping the JSON. 'idle' here
    // means genuinely outside every Seek phase (pre-1.0.7 rows: unknown).
    const longTasks = filterByType<LongTaskEntry>(d.entries, 'long-task');
    if (longTasks.length > 0) {
        const byCtx = new Map<string, { n: number; totalMs: number; maxMs: number }>();
        for (const t of longTasks) {
            const s = byCtx.get(t.context) ?? { n: 0, totalMs: 0, maxMs: 0 };
            s.n++; s.totalMs += t.durationMs; s.maxMs = Math.max(s.maxMs, t.durationMs);
            byCtx.set(t.context, s);
        }
        const parts = [...byCtx.entries()]
            .sort((a, b) => b[1].totalMs - a[1].totalMs)
            .map(([ctx, s]) => `\`${ctx}\` ${s.n}× (${(s.totalMs / 1000).toFixed(1)} s total · max ${(s.maxMs / 1000).toFixed(1)} s)`);
        lines.push('\n## Main-Thread Stalls (long tasks ≥250 ms, capped sample)');
        for (const p of parts) lines.push(`- ${p}`);

        // WHICH FRAME ran the unattributed stalls. 'idle' means no Seek phase
        // overlapped them, which by itself only says "not us, probably" — the
        // culprit split says whether they ran in this window or in an iframe,
        // and that is the difference between a Seek bug and a bystander one.
        // Absent on pre-v15 rows, so the whole block is conditional.
        const idle = longTasks.filter(t => t.context === 'idle' && t.culprit);
        if (idle.length > 0) {
            const byFrame = new Map<string, number>();
            for (const t of idle) {
                const frame = t.containerSrc || t.containerId || t.containerName || t.culprit || 'unknown';
                byFrame.set(frame, (byFrame.get(frame) ?? 0) + 1);
            }
            const split = [...byFrame.entries()].sort((a, b) => b[1] - a[1])
                .map(([f, n]) => `\`${f}\` ${n}×`).join(', ');
            lines.push(`- ↳ unattributed (\`idle\`) stalls by frame: ${split} — \`self\` = this window (Obsidian core, another plugin, or Seek's own main thread), a descendant = an iframe.`);
        }

        // Turn the raw rows into the inference a human would otherwise have to
        // derive by hand from startTimeMs (issue #5 — see stall-pattern.ts).
        const periodic = detectPeriodicStalls(longTasks);
        if (periodic) lines.push(`- ${describePeriodicStalls(periodic)}`);
    }
    // Incremental-patch rollup (v16, issue #5): whether each delta rode the
    // cheap in-place patch, why the ones that didn't fell back (each decline
    // is a full O(corpus) cache rebuild), and how long the write mutex was
    // held — the wait a search issued mid-commit sits behind. This was the
    // triage question the wlo2 reports could not answer without live probes.
    const deltas = filterByType<DeltaApplyEntry>(d.entries, 'delta-apply');
    if (deltas.length > 0) {
        const applied = deltas.filter(x => x.appliedIncrementally).length;
        const byReason = new Map<string, number>();
        for (const x of deltas) {
            const r = x.fallbackReason ?? x.skippedBecause;
            if (!x.appliedIncrementally && r) byReason.set(r, (byReason.get(r) ?? 0) + 1);
        }
        const holds = deltas.map(x => x.mutexHoldMs).sort((a, b) => a - b);
        const maxHold = holds[holds.length - 1];
        const p95Hold = holds[Math.min(holds.length - 1, Math.floor(holds.length * 0.95))];
        lines.push('\n## Incremental Patches (delta-apply)');
        lines.push(`- ${applied}/${deltas.length} applied in place · mutex hold p95 ${p95Hold.toFixed(0)} ms · max ${maxHold.toFixed(0)} ms`);
        if (byReason.size > 0) {
            const parts = [...byReason.entries()].sort((a, b) => b[1] - a[1])
                .map(([r, n]) => `\`${r}\` ${n}×`).join(', ');
            lines.push(`- fallbacks (full cache rebuild): ${parts}`);
        }
    }
    const rechunks = filterByType<RechunkLiveEntry>(d.entries, 'rechunk-live');
    if (rechunks.length > 0) {
        const last = rechunks[rechunks.length - 1];
        lines.push('\n## reChunkLive (hydrate oracle)');
        lines.push(`- Last pass: ${last.filesWalked} files walked · ${last.tokenCountsRpc} tokenizer RPCs · ${(last.durationMs / 1000).toFixed(1)} s · complete=${last.complete}`);
        const hydratingMs = longTasks.filter(t => t.context === 'hydrating').reduce((s, t) => s + t.durationMs, 0);
        if (hydratingMs > 0) {
            lines.push(`- Long tasks attributed to \`hydrating\`: ${(hydratingMs / 1000).toFixed(1)} s`);
        }
    }
    if (crashes.length > 0) {
        const c = crashes[crashes.length - 1];
        lines.push('\n## ⚠️ Last Crash');
        lines.push(`- ${c.timestamp} · \`${c.deviceId ?? '?'}\` · **${c.verdict}**`);
    }
    if (errors.length > 0) {
        lines.push('\n## Recent Errors');
        for (const e of errors.slice(-5)) lines.push(`- \`${e.context}\` — ${e.message}`);
    }
    return lines.join('\n') + '\n';
}

/**
 * Write the summary to the vault root and the full JSON under .seek-artifacts/.
 * Returns the .md path — that's what opens in Obsidian.
 */
export async function writeDiagnosticReport(logger: DiagnosticLoggerHost, redact = false): Promise<string> {
    const data = await buildReportData(logger, redact);
    await migrateLegacyReportJson(logger.app);
    await ensureArtifactsDir(logger.app);
    const adapter = logger.app.vault.adapter;
    await adapter.write(REPORT_JSON_PATH, JSON.stringify(data, null, 2));
    await adapter.write(REPORT_PATH, summarizeReport(data));
    return REPORT_PATH;
}

/**
 * User-facing debug affordance: writes the report and opens the summary markdown file in an Obsidian leaf.
 */
export async function openDiagnosticReport(params: {
    app: App;
    logger: DiagnosticLoggerHost;
    redactReport: boolean;
}): Promise<string | null> {
    try {
        const path = await writeDiagnosticReport(params.logger, params.redactReport);
        const file = params.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await params.app.workspace.getLeaf(false).openFile(file);
        new Notice(`Seek: report written — ${path} (summary; full JSON in ${REPORT_ARTIFACTS_DIR}/)`, 6000);
        return path;
    } catch (e) {
        await params.logger.appendError('generate-log', e);
        new Notice('Seek: could not write the logging report — see the developer console.', 6000);
        return null;
    }
}
