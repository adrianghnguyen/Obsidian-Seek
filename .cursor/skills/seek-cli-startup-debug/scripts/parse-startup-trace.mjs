#!/usr/bin/env node
/**
 * Merge gate-trace.jsonl + seek-report.json into a startup scorecard.
 *
 * Usage:
 *   node parse-startup-trace.mjs --jsonl .cursor/gate-trace.jsonl --report C:/Obsidian/seek-report.json
 *   node parse-startup-trace.mjs --jsonl .cursor/gate-trace.jsonl --report seek-report.json --path baseline --run cold-restart
 *   node parse-startup-trace.mjs ... --baseline .cursor/baseline-cold/
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../..');

function parseArgs(argv) {
    const out = {
        jsonl: join(repoRoot, '.cursor/gate-trace.jsonl'),
        report: join('C:/Obsidian', '.seek-artifacts/seek-report.json'),
        path: 'baseline',
        run: null,
        baseline: null,
        output: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--jsonl') out.jsonl = resolve(argv[++i]);
        else if (a === '--report') out.report = resolve(argv[++i]);
        else if (a === '--path') out.path = argv[++i];
        else if (a === '--run') out.run = argv[++i];
        else if (a === '--baseline') out.baseline = resolve(argv[++i]);
        else if (a === '--output') out.output = resolve(argv[++i]);
    }
    return out;
}

function readJsonl(path) {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
}

function percentile(nums, quantile) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const index = Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * quantile) - 1));
    return s[index];
}

function p50(nums) {
    return percentile(nums, 0.5);
}

function pctDelta(base, val) {
    if (base == null || val == null || base === 0) return null;
    return Math.round(((val - base) / base) * 1000) / 10;
}

function latestSessionId(report) {
    const inits = (report.entries ?? []).filter(e => e.type === 'init');
    return inits.at(-1)?.sessionId ?? null;
}

function selectedSessionId(report) {
    return report.thisSession ?? latestSessionId(report);
}

function sessionEntries(report) {
    const sid = selectedSessionId(report);
    if (!sid) return report.entries ?? [];
    const scoped = (report.entries ?? []).filter(e => e.sessionId === sid);
    // Legacy reports predate session stamping. Fall back only when there are no
    // rows for the report's declared session; never mix sessionless/peer rows
    // into a modern report.
    return scoped.length > 0
        ? scoped
        : (report.entries ?? []).filter(e => !e.sessionId);
}

function extractFromReport(report) {
    const entries = sessionEntries(report);
    const byType = t => entries.filter(e => e.type === t);
    const sidecar = byType('sidecar-hydrate');
    const hydrateResult = sidecar.filter(e => e.phase === 'sidecar-hydrate').at(-1);
    const hydrateScan = sidecar.filter(e => e.phase === 'sidecar-hydrate-scan').at(-1);
    const rechunks = byType('rechunk-live');
    const lastRechunk = rechunks.at(-1);
    const gates = byType('startup-gate').filter(e => e.event === 'released');
    const lastGate = gates.at(-1);
    const spans = byType('startup-span');
    const bootEnd = spans.filter(e => e.span === 'boot-ifi' && e.phase === 'end').at(-1);
    const hydrateSpan = spans.filter(e => e.span === 'sidecar-hydrate' && e.phase === 'end').at(-1);
    const longTasks = byType('long-task');
    const longTaskHydratingP50 = (() => {
        const hydrating = longTasks.filter(t => t.context === 'hydrating').map(t => t.durationMs);
        return p50(hydrating);
    })();
    const indexes = byType('index-complete');
    const lastIndex = indexes.at(-1);
    const deltas = byType('delta-apply');
    const lastDelta = deltas.at(-1);

    let T_hydrate_ms = null;
    if (hydrateScan && hydrateResult) {
        const t0 = Date.parse(hydrateScan.timestamp);
        const t1 = Date.parse(hydrateResult.timestamp);
        if (Number.isFinite(t0) && Number.isFinite(t1)) T_hydrate_ms = t1 - t0;
    }

    return {
        T_start_ms: lastGate?.elapsedMs ?? bootEnd?.durationMs ?? null,
        T_hydrate_ms,
        T_gate_ms: lastGate?.elapsedMs ?? null,
        needed: hydrateResult?.needed ?? null,
        scanned: hydrateResult?.scanned ?? hydrateScan?.producerFilesFound ?? null,
        hydrated: hydrateResult?.hydrated ?? null,
        files_walked: lastRechunk?.filesWalked ?? null,
        token_counts_rpc: lastRechunk?.tokenCountsRpc ?? null,
        rechunk_duration_ms: lastRechunk?.durationMs ?? null,
        long_task_hydrating_p50_ms: longTaskHydratingP50,
        mutex_hold_ms: lastDelta?.mutexHoldMs ?? null,
        delta_incremental: lastDelta?.appliedIncrementally ?? null,
        chunk_ms: lastIndex?.chunkDurationMs ?? null,
        embed_ms: lastIndex?.embedDurationMs ?? null,
        files_indexed: lastIndex?.filesIndexed ?? null,
    };
}

function extractFromJsonl(lines, runFilter, pathFilter) {
    const scoped = lines.filter(l =>
        (!runFilter || l.run === runFilter)
        && (!pathFilter || l.path_id === pathFilter));
    const polls = scoped.filter(l => l.event === 'poll');
    const gateTest = scoped.find(l => l.event === 'gate-test');
    const firstSearch = scoped.find(l => l.event === 'first-search');
    const startPoll = polls.find(p => p.gate?.warmPhase === 'starting' || p.gate?.uiHealth === 'starting');
    const endPoll = [...polls].reverse().find(p => p.gate?.warmPhase == null && p.gate?.uiHealth === 'ok');
    const evalMs = polls.map(p => p.eval_ms).filter(v => typeof v === 'number');
    const T_start_s = endPoll?.elapsed_s ?? null;
    const T_gate_test_s = gateTest?.elapsed_s ?? null;
    const T_first_search_s = firstSearch?.elapsed_s ?? null;
    const jobFirst = polls.find(p => p.gate?.job?.total > 0);
    return {
        T_start_s,
        T_gate_test_s,
        T_first_search_s,
        job_total: jobFirst?.gate?.job?.total ?? null,
        job_remaining_first: jobFirst?.gate?.job?.remaining ?? null,
        eval_p50_ms: percentile(evalMs, 0.5),
        eval_p95_ms: percentile(evalMs, 0.95),
        eval_max_ms: evalMs.length ? Math.max(...evalMs) : null,
        eval_n: evalMs.length,
        git_sha: scoped[0]?.git_sha ?? null,
        path_id: scoped[0]?.path_id ?? null,
        run: scoped[0]?.run ?? null,
    };
}

function loadBaseline(dir) {
    if (!dir || !existsSync(dir)) return null;
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const cards = files.map(f => {
        try {
            return JSON.parse(readFileSync(join(dir, f), 'utf8'));
        } catch { return null; }
    }).filter(Boolean);
    if (!cards.length) return null;
    const metrics = cards.map(c => c.metrics ?? c);
    const avg = key => {
        const vals = metrics.map(m => m[key]).filter(v => typeof v === 'number');
        return vals.length ? p50(vals) : null;
    };
    return {
        T_start_ms: avg('T_start_ms'),
        T_hydrate_ms: avg('T_hydrate_ms'),
        files_walked: avg('files_walked'),
        token_counts_rpc: avg('token_counts_rpc'),
    };
}

function main() {
    const args = parseArgs(process.argv);
    const lines = readJsonl(args.jsonl);
    const runFilter = args.run ?? lines[0]?.run ?? 'cold-restart';
    const report = existsSync(args.report)
        ? JSON.parse(readFileSync(args.report, 'utf8'))
        : { entries: [] };

    const fromReport = extractFromReport(report);
    const fromJsonl = extractFromJsonl(lines, runFilter, args.path);

    const metrics = {
        T_start_ms: fromReport.T_start_ms ?? (fromJsonl.T_start_s != null ? Math.round(fromJsonl.T_start_s * 1000) : null),
        T_hydrate_ms: fromReport.T_hydrate_ms,
        T_gate_test_ms: fromJsonl.T_gate_test_s != null ? Math.round(fromJsonl.T_gate_test_s * 1000) : null,
        T_first_search_ms: fromJsonl.T_first_search_s != null ? Math.round(fromJsonl.T_first_search_s * 1000) : null,
        needed: fromReport.needed,
        scanned: fromReport.scanned,
        hydrated: fromReport.hydrated,
        files_walked: fromReport.files_walked,
        token_counts_rpc: fromReport.token_counts_rpc,
        rechunk_duration_ms: fromReport.rechunk_duration_ms,
        T_eval_p50_ms: fromJsonl.eval_p50_ms,
        T_eval_p95_ms: fromJsonl.eval_p95_ms,
        T_eval_max_ms: fromJsonl.eval_max_ms,
        T_eval_n: fromJsonl.eval_n,
        long_task_hydrating_p50_ms: fromReport.long_task_hydrating_p50_ms,
        mutex_hold_ms: fromReport.mutex_hold_ms,
        T_chunk_ms: fromReport.chunk_ms,
        T_embed_ms: fromReport.embed_ms,
        job_total: fromJsonl.job_total,
    };

    const baseline = loadBaseline(args.baseline);
    const vs_baseline_pct = {};
    if (baseline) {
        for (const k of ['T_start_ms', 'T_hydrate_ms', 'files_walked', 'token_counts_rpc']) {
            const d = pctDelta(baseline[k], metrics[k]);
            if (d != null) vs_baseline_pct[k] = d;
        }
    }

    const scorecard = {
        path_id: args.path,
        git_sha: fromJsonl.git_sha,
        run: runFilter,
        scenario: 'default',
        session_id: selectedSessionId(report),
        metrics,
        vs_baseline_pct,
        goals: {},
        sources: {
            jsonl: args.jsonl,
            report: args.report,
        },
    };

    const outPath = args.output ?? join(repoRoot, '.cursor', 'scorecards', `${args.path}-${runFilter}-parsed.json`);
    writeFileSync(outPath, JSON.stringify(scorecard, null, 2));
    console.log(JSON.stringify(scorecard, null, 2));
    console.error(`Wrote ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main();
}

export {
    extractFromJsonl,
    extractFromReport,
    p50,
    percentile,
    selectedSessionId,
    sessionEntries,
};
