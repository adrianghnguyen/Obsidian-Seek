/** Functional telemetry fixture types — shared by Vitest validators and playbook docs */

export const QUERY_INTENTS = [
    'many_answers_possible',
    'no_answers_possible',
    'one_ambiguous_query',
    'known_item_name_paint',
    'alias_prefix',
    'needle_in_haystack',
    'filter_only_browse',
    'gate_blocked',
    'superseded_query',
    'section_hit',
] as const;

export type QueryIntent = (typeof QUERY_INTENTS)[number];

export type QueryExpected = {
    minCount?: number;
    maxCount?: number;
    rank1Path?: string;
    rank1Contains?: string;
    nameEarlyPainted?: boolean;
    gateBlocked?: boolean;
    ready?: boolean;
    sequence?: boolean;
};

export type QueryCase = {
    id: string;
    intent: QueryIntent;
    query: string;
    sourcePath?: string;
    sourceNoteId?: string;
    synthetic?: boolean;
    expected: QueryExpected;
};

export type FunctionalQueriesFixture = {
    version: number;
    vault: string;
    queryCases: QueryCase[];
};

export type VaultManifestNote = {
    path: string;
    title?: string;
    aliases?: string[];
    probeToken?: string;
};

export type FunctionalVaultManifest = {
    version: number;
    vault: string;
    notes: VaultManifestNote[];
};

export const TOKEN_OVERLAP_EXEMPT_INTENTS: QueryIntent[] = [
    'gate_blocked',
    'superseded_query',
];

export function normalizeQuery(q: string): string {
    return q.trim().toLowerCase();
}

export function primaryTokens(query: string): string[] {
    return normalizeQuery(query)
        .replace(/path:[^\s]+/g, '')
        .replace(/#/g, '')
        .split(/\s+/)
        .filter((t) => t.length >= 3);
}

export function validateFunctionalQueriesFixture(
    fixture: FunctionalQueriesFixture,
    options: { requireFullMatrix?: boolean } = {},
): string[] {
    const errors: string[] = [];
    const cases = fixture.queryCases ?? [];
    const requireFull = options.requireFullMatrix ?? cases.length >= 30;

    if (cases.length === 0) {
        errors.push('queryCases must not be empty');
        return errors;
    }

    const ids = new Set<string>();
    const queries = new Set<string>();

    for (const c of cases) {
        if (!c.id || !c.query || !c.intent) {
            errors.push(`case missing id/query/intent: ${JSON.stringify(c)}`);
            continue;
        }
        if (!QUERY_INTENTS.includes(c.intent)) {
            errors.push(`invalid intent for ${c.id}: ${c.intent}`);
        }
        if (ids.has(c.id)) errors.push(`duplicate id: ${c.id}`);
        ids.add(c.id);

        const nq = normalizeQuery(c.query);
        if (queries.has(nq)) errors.push(`duplicate query strings detected: ${c.query}`);
        queries.add(nq);

        if (!c.expected || typeof c.expected !== 'object') {
            errors.push(`case ${c.id}: missing expected block`);
        }
        if (!c.synthetic && !c.sourcePath && !c.sourceNoteId && requireFull) {
            errors.push(`${c.id}: non-synthetic case needs sourcePath or sourceNoteId`);
        }
    }

    if (requireFull) {
        if (cases.length !== 30) {
            errors.push(`expected 30 query cases, got ${cases.length}`);
        }
        for (const intent of QUERY_INTENTS) {
            const forIntent = cases.filter((c) => c.intent === intent);
            if (forIntent.length !== 3) {
                errors.push(`intent ${intent}: expected 3 cases, got ${forIntent.length}`);
            }
        }

        const tokenOwners = new Map<string, string>();
        for (const c of cases) {
            if (TOKEN_OVERLAP_EXEMPT_INTENTS.includes(c.intent)) continue;
            for (const tok of primaryTokens(c.query)) {
                const owner = tokenOwners.get(tok);
                if (owner && owner !== c.intent) {
                    errors.push(`token "${tok}" shared across intents ${owner} and ${c.intent}`);
                } else {
                    tokenOwners.set(tok, c.intent);
                }
            }
        }
    }

    return errors;
}
