// Note-level name prefilter for early search paint.
//
// Walks the resident frame once, one row per note (aliases live on every chunk
// of the same file), and scores basename + frontmatter aliases with
// matchNamePrefix. The hit set is what the modal can paint before query embed
// and the O(corpus) binary scan finish. A topical query with no name coverage
// returns no hits and must not flash a first page.

import type { ChunkMeta } from './types';
import { matchNamePrefix } from './fusion';

export const NAME_EARLY_MAX_HITS = 20;
export const NAME_EARLY_MIN_SCORE = 0.15;
export const NAME_EARLY_STRONG_SCORE = 0.45;

export interface NameHit {
    index: number;
    notePath: string;
    score: number;
    bestAlias: string | null;
}

export function noteBasename(notePath: string): string {
    let basename = notePath.split('/').pop() ?? '';
    if (basename.toLowerCase().endsWith('.md')) basename = basename.slice(0, -3);
    return basename;
}

export function collectNameHits(
    chunks: ChunkMeta[],
    query: string,
    mask?: boolean[] | null,
): NameHit[] {
    const q = query.trim();
    if (!q) return [];
    const seen = new Set<string>();
    const hits: NameHit[] = [];
    for (let i = 0; i < chunks.length; i++) {
        if (mask && !mask[i]) continue;
        const notePath = chunks[i].note_path ?? '';
        if (!notePath || seen.has(notePath)) continue;
        seen.add(notePath);
        const m = matchNamePrefix(q, noteBasename(notePath), chunks[i].metadata?.aliases ?? []);
        if (m.score <= 0) continue;
        hits.push({ index: i, notePath, score: m.score, bestAlias: m.bestAlias });
    }
    hits.sort((a, b) => b.score - a.score || a.index - b.index);
    return hits;
}

export function shouldEarlyPaint(hits: NameHit[]): boolean {
    if (hits.length === 0) return false;
    const best = hits[0].score;
    if (best >= NAME_EARLY_STRONG_SCORE) return true;
    if (hits.length > NAME_EARLY_MAX_HITS) return false;
    return best >= NAME_EARLY_MIN_SCORE;
}
