#!/usr/bin/env node
/**
 * E2E triage CLI — emits triage.json and optionally applies labels via gh.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { triageDiff, labelActionForDecision } from './e2e-triage-lib.mjs';

const { values, positionals } = parseArgs({
    options: {
        'json-only': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'apply-without-agent': { type: 'boolean', default: false },
        'output': { type: 'string', default: 'triage.json' },
        base: { type: 'string' },
        'files-json': { type: 'string' },
    },
    allowPositionals: true,
});

function gitDiffFiles(baseRef) {
    const base = baseRef || process.env.GITHUB_BASE_REF || 'origin/main';
    const mergeBase = execSync(`git merge-base HEAD ${base}`, { encoding: 'utf8' }).trim();
    const names = execSync(`git diff --name-only ${mergeBase}...HEAD`, { encoding: 'utf8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    const lineCounts = {};
    const numstat = execSync(`git diff --numstat ${mergeBase}...HEAD`, { encoding: 'utf8' });
    for (const line of numstat.split('\n')) {
        const m = line.match(/^(\d+)\t(\d+)\t(.+)$/);
        if (!m) continue;
        lineCounts[m[3]] = Number(m[1]) + Number(m[2]);
    }
    return { files: names, lineCounts };
}

function fetchPrLabels() {
    const n = process.env.GITHUB_EVENT_NUMBER || process.env.PR_NUMBER;
    if (!n) return [];
    try {
        const raw = execSync(`gh pr view ${n} --json labels -q '.labels.[].name'`, { encoding: 'utf8' });
        return raw.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
        return [];
    }
}

function applyLabel(label) {
    const n = process.env.GITHUB_EVENT_NUMBER || process.env.PR_NUMBER;
    if (!n) {
        console.warn('No PR number — skip label apply');
        return;
    }
    const opposite = label === 'needs-e2e' ? 'skip-e2e' : 'needs-e2e';
    execSync(`gh label create "${label}" --force 2>/dev/null || true`, { stdio: 'ignore' });
    execSync(`gh label create "${opposite}" --force 2>/dev/null || true`, { stdio: 'ignore' });
    execSync(`gh pr edit ${n} --remove-label "${opposite}" 2>/dev/null || true`, { stdio: 'ignore' });
    execSync(`gh pr edit ${n} --add-label "${label}"`, { stdio: 'inherit' });
}

let files = [];
let lineCounts = {};
if (values['files-json']) {
    const payload = JSON.parse(readFileSync(values['files-json'], 'utf8'));
    files = payload.files ?? [];
    lineCounts = payload.lineCounts ?? {};
} else if (positionals.length) {
    files = positionals;
} else {
    ({ files, lineCounts } = gitDiffFiles(values.base));
}

const labels = fetchPrLabels();
const result = triageDiff({ files, lineCounts, labels });

writeFileSync(values.output, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));

const shouldApply =
    values['apply-without-agent'] ||
    (result.confidence === 'high' && result.decision !== 'review');

if (shouldApply && !values['dry-run'] && !values['json-only']) {
    const label = labelActionForDecision(result.decision);
    applyLabel(label);
}

if (values['apply-without-agent'] && values['dry-run']) {
    console.log(`Would apply label: ${labelActionForDecision(result.decision)}`);
}
