export const DAY_MS = 86_400_000;
export const FIXTURE_NOW_MS = Date.UTC(2026, 7, 29, 12);

export interface StartupNoteFixture {
    path: string;
    body: string;
    ageDays: number;
    chunkId: string;
}

export interface StartupResponseFixture {
    notes: StartupNoteFixture[];
    query: string;
    expectedFirstPath: string;
}

export const SMALL_PEER_DELTA_FIXTURE: StartupResponseFixture = {
    notes: [
        {
            path: 'recent/apollo-today.md',
            body: 'Apollo launch checklist and telemetry review.',
            ageDays: 0.25,
            chunkId: 'apollo-today',
        },
        {
            path: 'recent/banana-yesterday.md',
            body: 'Banana bread notes from yesterday.',
            ageDays: 1,
            chunkId: 'banana-yesterday',
        },
        {
            path: 'archive/cedar-last-month.md',
            body: 'Cedar archive retained for old searches.',
            ageDays: 30,
            chunkId: 'cedar-last-month',
        },
    ],
    query: 'apollo telemetry',
    expectedFirstPath: 'recent/apollo-today.md',
};

export function mtimeMs(note: StartupNoteFixture, nowMs = FIXTURE_NOW_MS): number {
    return nowMs - note.ageDays * DAY_MS;
}

export function recentFixturePaths(
    fixture: StartupResponseFixture,
    days = 3,
): string[] {
    return fixture.notes
        .filter(note => note.ageDays <= days)
        .sort((a, b) => a.ageDays - b.ageDays)
        .map(note => note.path);
}
