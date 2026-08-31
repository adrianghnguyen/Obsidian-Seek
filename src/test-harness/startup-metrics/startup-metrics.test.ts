import {
    mkdtempSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const PARSER = join(ROOT, '.cursor/skills/seek-cli-startup-debug/scripts/parse-startup-trace.mjs');
const TRACE_PROBE = join(ROOT, '.cursor/skills/seek-cli-startup-debug/scripts/startup-trace-probe.ps1');
const CATCHUP_PROBE = join(ROOT, '.cursor/skills/seek-cli-startup-debug/scripts/run-catchup-ux-probe.ps1');
const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const temporaryDirectories: string[] = [];

interface ParsedScorecard {
    git_sha: string | null;
    metrics: Record<string, number | boolean | null>;
}

function parseFixture(): ParsedScorecard {
    const dir = mkdtempSync(join(tmpdir(), 'seek-startup-metrics-'));
    temporaryDirectories.push(dir);
    const output = join(dir, 'scorecard.json');
    execFileSync(process.execPath, [
        PARSER,
        '--jsonl', join(FIXTURES, 'mixed-trace.jsonl'),
        '--report', join(FIXTURES, 'mixed-report.json'),
        '--path', 'track-a',
        '--run', 'cold-restart',
        '--output', output,
    ], { stdio: 'ignore' });
    return JSON.parse(readFileSync(output, 'utf8')) as ParsedScorecard;
}

afterEach(() => {
    for (const dir of temporaryDirectories.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe('startup metric parser fixtures', () => {
    it('uses report.thisSession instead of the newest peer init row', () => {
        const scorecard = parseFixture();

        expect(scorecard.metrics.T_start_ms).toBe(3200);
        expect(scorecard.metrics.long_task_hydrating_p50_ms).toBe(430);
    });

    it('reports actual eval latency p50, p95, max, and sample count', () => {
        const scorecard = parseFixture();

        expect(scorecard.metrics.T_eval_p50_ms).toBe(300);
        expect(scorecard.metrics.T_eval_p95_ms).toBe(500);
        expect(scorecard.metrics.T_eval_max_ms).toBe(500);
        expect(scorecard.metrics.T_eval_n).toBe(5);
    });

    it('scopes gate tests, first searches, and git metadata to the selected run', () => {
        const scorecard = parseFixture();

        expect(scorecard.git_sha).toBe('coldsha');
        expect(scorecard.metrics.T_gate_test_ms).toBe(1500);
        expect(scorecard.metrics.T_first_search_ms).toBeNull();
    });
});

describe('startup probe measurement contracts', () => {
    it('records each gate eval duration and aborts an invalid Run B precheck', () => {
        const source = readFileSync(TRACE_PROBE, 'utf8');

        expect(source).toContain('eval_ms');
        expect(source).toMatch(
            /if \(\$pre -notmatch 'ok\.:true'\) \{[\s\S]*?exit 1[\s\S]*?\}/,
        );
    });

    it('times completed catch-up searches and preserves artifacts before verdict', () => {
        const source = readFileSync(CATCHUP_PROBE, 'utf8');

        expect(source).toContain('$searchDurationMs');
        expect(source).toContain('search_duration_ms = $searchDurationMs');
        expect(source).toContain('format=json');
        expect(source).not.toContain("$snippet -match '\\d\\.\\d'");
        expect(source).not.toMatch(
            /if \(\$firstHitMs -le \$FirstHitSloMs\) \{[\s\S]{0,300}?exit 0/,
        );
        expect(source.indexOf('openLoggingReport()')).toBeLessThan(
            source.lastIndexOf("if ($verdict -ne 'pass')"),
        );
    });

    it('does not treat core IndexedDB boot noise as a Seek failure before onLayoutReady', () => {
        const skill = readFileSync(join(ROOT, '.cursor/skills/seek-cli-startup-debug/SKILL.md'), 'utf8');
        expect(skill).toContain('onLayoutReady');
        expect(skill).toContain('File Recovery failed to connect to IndexedDB');
        expect(skill).toContain('Failed to load cache, unable to open IndexedDB');
        expect(skill).toContain('Failed to load sync data');
        expect(skill).toContain('Internal error opening backing store for indexedDB.open');
        expect(skill).toMatch(/Unexpected token/);
    });
});
