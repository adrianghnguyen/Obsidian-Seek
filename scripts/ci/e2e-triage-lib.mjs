/**
 * Deterministic E2E triage — shared by CLI and Vitest.
 */

export const HOT_PATH_GLOBS = [
    /^src\/main\.ts$/,
    /^src\/embedder\.ts$/,
    /^src\/search\.ts$/,
    /^src\/index-store\.ts$/,
    /^src\/index-coordinator\.ts$/,
    /^src\/cli-handlers\.ts$/,
    /^src\/search-modal[^/]*\.ts$/,
    /^src\/settings-tab\.ts$/,
    /^styles\.css$/,
    /^manifest\.json$/,
    /^src\/iframe-runner\.ts$/,
    /^src\/binary-worker\.ts$/,
    /^src\/embed-worker\.ts$/,
];

export const FUNCTIONAL_PATH_RE =
    /^src\/test-harness\/functional-core\//;

export const PLAYBOOK_FIXTURE_RE =
    /^\.cursor\/skills\/seek-playbook-catalog\/(fixtures|scripts\/drivers)\//;

export const WORKFLOW_RE = /^\.github\/workflows\//;

export const DOCS_ONLY_RE = /^(docs\/|README\.md$|CHANGELOG\.md$|\.cursor\/plans\/|\.cursor\/skills\/)/;

export const THRESHOLDS = { srcFileCount: 8, hotPathLineCount: 150 };

/**
 * @param {object} input
 * @param {string[]} input.files — changed paths (posix)
 * @param {Record<string, number>} [input.lineCounts] — path → added+deleted lines
 * @param {string[]} [input.labels]
 */
export function triageDiff(input) {
    const files = input.files ?? [];
    const lineCounts = input.lineCounts ?? {};
    const labels = new Set((input.labels ?? []).map((l) => l.toLowerCase()));

    const matchedRules = [];
    const reasons = [];

    const hasNeedsE2e = labels.has('needs-e2e');
    const hasSkipE2e = labels.has('skip-e2e');

    if (hasSkipE2e) {
        return pack({
            decision: 'skip',
            confidence: 'high',
            matchedRules: ['label-skip-e2e'],
            reasons: ['Maintainer skip-e2e label present'],
            files,
            labels: { hasNeedsE2e, hasSkipE2e },
            diffStats: stats(files, lineCounts),
        });
    }

    if (hasNeedsE2e) {
        return pack({
            decision: 'require',
            confidence: 'high',
            matchedRules: ['label-needs-e2e'],
            reasons: ['Author or triage applied needs-e2e'],
            files,
            labels: { hasNeedsE2e, hasSkipE2e },
            diffStats: stats(files, lineCounts),
        });
    }

    const srcFiles = files.filter((f) => f.startsWith('src/'));
    let hotPathLineCount = 0;
    for (const f of files) {
        if (HOT_PATH_GLOBS.some((re) => re.test(f))) {
            hotPathLineCount += lineCounts[f] ?? 1;
        }
    }

    for (const f of files) {
        if (HOT_PATH_GLOBS.some((re) => re.test(f))) {
            matchedRules.push('hot-path');
            reasons.push(`Hot path: ${f}`);
        }
        if (FUNCTIONAL_PATH_RE.test(f) || PLAYBOOK_FIXTURE_RE.test(f)) {
            matchedRules.push('functional-fixture');
            reasons.push(`Functional harness/fixture: ${f}`);
        }
        if (WORKFLOW_RE.test(f)) {
            matchedRules.push('workflow');
            reasons.push(`CI workflow change: ${f}`);
        }
    }

    if (srcFiles.length >= THRESHOLDS.srcFileCount) {
        matchedRules.push('large-src-file-count');
        reasons.push(`${srcFiles.length} files under src/ (threshold ${THRESHOLDS.srcFileCount})`);
    }
    if (hotPathLineCount >= THRESHOLDS.hotPathLineCount) {
        matchedRules.push('large-hot-path-diff');
        reasons.push(`${hotPathLineCount} lines in hot paths (threshold ${THRESHOLDS.hotPathLineCount})`);
    }

    const requireRules = matchedRules.filter((r) =>
        ['hot-path', 'functional-fixture', 'workflow', 'large-src-file-count', 'large-hot-path-diff'].includes(r),
    );

    if (requireRules.length > 0) {
        return pack({
            decision: 'require',
            confidence: 'high',
            matchedRules: [...new Set(matchedRules)],
            reasons,
            files,
            labels: { hasNeedsE2e, hasSkipE2e },
            diffStats: stats(files, lineCounts),
        });
    }

    const nonDoc = files.filter((f) => !DOCS_ONLY_RE.test(f));
    const onlyTests =
        nonDoc.length > 0 &&
        nonDoc.every(
            (f) =>
                f.endsWith('.test.ts') ||
                f.startsWith('ci/') ||
                f.startsWith('scripts/ci/'),
        );
    const docsOnly = nonDoc.length === 0;

    if (docsOnly || onlyTests) {
        return pack({
            decision: 'skip',
            confidence: 'high',
            matchedRules: docsOnly ? ['docs-only'] : ['tests-only'],
            reasons: docsOnly
                ? ['Documentation-only change']
                : ['Unit-test-only change outside hot paths'],
            files,
            labels: { hasNeedsE2e, hasSkipE2e },
            diffStats: stats(files, lineCounts),
        });
    }

    if (srcFiles.length > 0) {
        return pack({
            decision: 'review',
            confidence: 'low',
            matchedRules: ['gray-src-touch'],
            reasons: ['Touches src/ without matching hot-path rules — agent should decide'],
            files,
            labels: { hasNeedsE2e, hasSkipE2e },
            diffStats: stats(files, lineCounts),
        });
    }

    return pack({
        decision: 'skip',
        confidence: 'high',
        matchedRules: ['no-runtime-src'],
        reasons: ['No src/ runtime changes detected'],
        files,
        labels: { hasNeedsE2e, hasSkipE2e },
        diffStats: stats(files, lineCounts),
    });
}

function stats(files, lineCounts) {
    const srcFileCount = files.filter((f) => f.startsWith('src/')).length;
    let hotPathLineCount = 0;
    for (const f of files) {
        if (HOT_PATH_GLOBS.some((re) => re.test(f))) {
            hotPathLineCount += lineCounts[f] ?? 0;
        }
    }
    return { fileCount: files.length, srcFileCount, hotPathLineCount };
}

function pack(partial) {
    return {
        version: 1,
        confidence: partial.confidence,
        decision: partial.decision,
        matchedRules: partial.matchedRules,
        reasons: partial.reasons,
        files: partial.files,
        labels: partial.labels,
        diffStats: partial.diffStats,
    };
}

/** Map triage decision to label action for timeout / apply-without-agent */
export function labelActionForDecision(decision) {
    if (decision === 'require') return 'needs-e2e';
    if (decision === 'skip') return 'skip-e2e';
    return 'needs-e2e'; // review → fail closed
}
