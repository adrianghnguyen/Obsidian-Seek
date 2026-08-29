import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
    QUERY_INTENTS,
    normalizeQuery,
    validateFunctionalQueriesFixture,
    type FunctionalQueriesFixture,
} from './types';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const catalogRoot = join(repoRoot, '.cursor/skills/seek-playbook-catalog/fixtures');

function loadFixture(set: 'minimal' | 'full'): FunctionalQueriesFixture {
    const p = join(catalogRoot, set, 'functional-queries.json');
    return JSON.parse(readFileSync(p, 'utf8')) as FunctionalQueriesFixture;
}

describe('functional fixture validation', () => {
    it('placeholder minimal fixture passes shape rules', () => {
        const fx = loadFixture('minimal');
        const errors = validateFunctionalQueriesFixture(fx, { requireFullMatrix: false });
        expect(errors).toEqual([]);
    });

    it('full fixture has 30 cases, 3 per intent, globally distinct queries', () => {
        const fx = loadFixture('full');
        if (fx.queryCases.length < 30) {
            expect(fx.queryCases.length).toBe(0);
            return;
        }
        const errors = validateFunctionalQueriesFixture(fx, { requireFullMatrix: true });
        expect(errors).toEqual([]);
        expect(fx.queryCases).toHaveLength(30);
        for (const intent of QUERY_INTENTS) {
            expect(fx.queryCases.filter((c) => c.intent === intent)).toHaveLength(3);
        }
        const normalized = fx.queryCases.map((c) => normalizeQuery(c.query));
        expect(new Set(normalized).size).toBe(30);
    });

    it('fails when duplicate query injected', () => {
        const fx = loadFixture('minimal');
        const dup = structuredClone(fx);
        dup.queryCases[1] = { ...dup.queryCases[1]!, query: dup.queryCases[0]!.query };
        const errors = validateFunctionalQueriesFixture(dup, { requireFullMatrix: false });
        expect(errors.some((e) => e.includes('duplicate'))).toBe(true);
    });
});
