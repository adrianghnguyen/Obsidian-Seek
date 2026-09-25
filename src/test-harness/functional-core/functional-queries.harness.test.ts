import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scenario } from '../scenario';
import type { FunctionalQueriesFixture } from '../functional-telemetry/types';
import { assertQueryCase } from './assert-query-case';
import { loadSeekFunctionalVault } from './load-seek-functional-vault';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixturePath = join(
    repoRoot,
    '.cursor/skills/seek-playbook-catalog/fixtures/minimal/functional-queries.json',
);

describe('functional queries harness (F3 minimal parity)', () => {
    let active: Scenario | null = null;
    afterEach(async () => {
        await active?.teardown();
        active = null;
    });

    it('runs non-sequence query cases against seek-functional fixture vault', async () => {
        const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as FunctionalQueriesFixture;
        const s = new Scenario();
        await s.boot();
        active = s;
        loadSeekFunctionalVault(s);
        await s.coldStart();

        const failures: string[] = [];
        for (const c of fx.queryCases) {
            if (c.expected.sequence === true) continue;
            // Fake embedder still returns lexical/BM25 hits for OOV strings; real-vault F3 asserts maxCount 0.
            if (c.intent === 'no_answers_possible') continue;
            const { results } = await s.orch.search(c.query, 10);
            const reasons = assertQueryCase(c, { results, count: results.length });
            if (reasons.length) {
                failures.push(`${c.id}: ${reasons.join('; ')}`);
            }
        }
        expect(failures, failures.join('\n')).toEqual([]);
    }, 120_000);
});
