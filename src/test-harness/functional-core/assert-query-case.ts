import type { QueryCase } from '../functional-telemetry/types';
import type { ScoredChunk } from '../../types';

export type SearchOutcome = {
    results: ScoredChunk[];
    count: number;
    error?: string;
};

export function assertQueryCase(caseRow: QueryCase, outcome: SearchOutcome): string[] {
    if (caseRow.expected.sequence === true) {
        return [];
    }

    const reasons: string[] = [];
    const count = outcome.count ?? outcome.results.length;
    const rank1 = outcome.results[0];
    const rank1Path = rank1?.note_path;

    if (outcome.error && caseRow.expected.ready !== false) {
        reasons.push(`error: ${outcome.error}`);
    }
    if (caseRow.expected.minCount != null && count < caseRow.expected.minCount) {
        reasons.push(`count ${count} below minCount ${caseRow.expected.minCount}`);
    }
    if (caseRow.expected.maxCount != null && count > caseRow.expected.maxCount) {
        reasons.push(`count ${count} above maxCount ${caseRow.expected.maxCount}`);
    }
    if (caseRow.expected.rank1Path && rank1Path !== caseRow.expected.rank1Path) {
        reasons.push(`rank1Path ${rank1Path} != ${caseRow.expected.rank1Path}`);
    }
    if (caseRow.expected.rank1Contains) {
        const needle = caseRow.expected.rank1Contains;
        const inPath = rank1Path?.includes(needle);
        const inTitle = rank1?.title?.includes(needle);
        if (!inPath && !inTitle) {
            reasons.push(`rank1 missing contains ${needle}`);
        }
    }
    return reasons;
}
