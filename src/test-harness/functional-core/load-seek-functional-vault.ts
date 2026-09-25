import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario } from '../scenario';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/seek-functional');

export function loadSeekFunctionalVault(s: Scenario): void {
    const walk = (rel: string): void => {
        const abs = join(FIXTURE_ROOT, rel);
        for (const ent of readdirSync(abs)) {
            const child = rel ? `${rel}/${ent}` : ent;
            const childAbs = join(abs, ent);
            if (statSync(childAbs).isDirectory()) {
                walk(child);
            } else if (ent.endsWith('.md')) {
                const body = readFileSync(childAbs, 'utf8');
                s.vault.write(child, body, 1_700_000_000_000);
            }
        }
    };
    walk('');
}
