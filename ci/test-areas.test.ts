import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CI_TEST_AREAS, FUNCTIONAL_FIXTURES_ONLY } from './test-areas.mts';

function allTestFiles(dir: string, acc: string[] = []): string[] {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) allTestFiles(p, acc);
        else if (ent.name.endsWith('.test.ts')) acc.push(p.replace(/\\/g, '/'));
    }
    return acc;
}

describe('CI test area partition', () => {
    it('assigns every src test file exactly once across areas or functional-fixtures', () => {
        const root = join(import.meta.dirname, '..');
        const srcTests = allTestFiles(join(root, 'src')).map((p) =>
            p.replace(`${root.replace(/\\/g, '/')}/`, ''),
        );
        const assigned = new Set<string>();
        for (const files of Object.values(CI_TEST_AREAS)) {
            for (const f of files) {
                expect(assigned.has(f), `duplicate assignment: ${f}`).toBe(false);
                assigned.add(f);
                if (f.startsWith('src/')) {
                    expect(srcTests, `unknown src test in manifest: ${f}`).toContain(f);
                }
            }
        }
        for (const f of FUNCTIONAL_FIXTURES_ONLY) {
            expect(assigned.has(f), `functional fixture file must not be in area: ${f}`).toBe(false);
            expect(srcTests).toContain(f);
        }
        for (const f of srcTests) {
            const covered = assigned.has(f) || (FUNCTIONAL_FIXTURES_ONLY as readonly string[]).includes(f);
            expect(covered, `unassigned test file: ${f}`).toBe(true);
        }
    });
});
