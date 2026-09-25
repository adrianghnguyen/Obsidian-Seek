import { describe, it, expect } from 'vitest';
import { triageDiff, labelActionForDecision } from './e2e-triage-lib.mjs';

describe('e2e-triage-lib', () => {
    it('requires E2E for hot path touch', () => {
        const r = triageDiff({ files: ['src/search.ts'], lineCounts: { 'src/search.ts': 10 } });
        expect(r.decision).toBe('require');
        expect(r.matchedRules).toContain('hot-path');
    });

    it('skips docs-only', () => {
        const r = triageDiff({ files: ['docs/ARCHITECTURE.md', 'CHANGELOG.md'] });
        expect(r.decision).toBe('skip');
    });

    it('honors needs-e2e label', () => {
        const r = triageDiff({ files: ['README.md'], labels: ['needs-e2e'] });
        expect(r.decision).toBe('require');
    });

    it('honors skip-e2e label', () => {
        const r = triageDiff({ files: ['src/search.ts'], labels: ['skip-e2e'] });
        expect(r.decision).toBe('skip');
    });

    it('review on gray src touch', () => {
        const r = triageDiff({ files: ['src/logger.ts'], lineCounts: { 'src/logger.ts': 5 } });
        expect(r.decision).toBe('review');
    });

    it('fail-closed label for review', () => {
        expect(labelActionForDecision('review')).toBe('needs-e2e');
    });

    it('requires for workflow change', () => {
        const r = triageDiff({ files: ['.github/workflows/ci.yml'] });
        expect(r.decision).toBe('require');
    });
});
