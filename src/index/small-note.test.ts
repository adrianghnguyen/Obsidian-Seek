// Small-note collapse (small-note.ts, CHUNKER_VERSION 11).
//
// Two layers:
//   1. PARITY with the 1.3 harness mirror fixture (small-note-parity.json).
//   2. Unit contracts the fixture cannot express: ids, line spans, link_terms,
//      pass-through identity, .base exemption, the token boundary, packChunks
//      == collapse-then-budget, and batched token-counter id stability.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { MarkdownChunker, chunkIdFor } from './chunker';
import { embedInput, type CountTokens, createBatchedTokenCounter, TOKEN_COUNTS_BATCH, enforceTokenBudget } from './token-budget';
import {
    collapseSmallNotes, collapsedBody, packChunks, SMALL_NOTE_TOKENS, SMALL_NOTE_MAX_CHARS,
} from './small-note';
import type { BaseView } from '../types/types';

const chunker = new MarkdownChunker();

const fakeCount: CountTokens = async texts =>
    texts.map(t => t.split(/\s+/).filter(Boolean).length + 2);

interface ParityCase {
    name: string;
    path: string;
    markdown: string;
    expected: Array<{ title: string; content: string; heading_path: string[] }>;
}
const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/small-note-parity.json', import.meta.url), 'utf8'),
) as { cases: ParityCase[] };

describe('small-note collapse: parity with the harness mirror', () => {
    for (const c of fixture.cases) {
        it(c.name, async () => {
            const out = await collapseSmallNotes(chunker.chunkContent(c.markdown, c.path), fakeCount);
            expect(out.map(x => ({ title: x.title, content: x.content, heading_path: x.heading_path })))
                .toEqual(c.expected);
        });
    }
});

const THREE = `---
aliases: [Daily sync]
pageType: meetings
---
## Yesterday
Shipped the tokenizer fix and closed two review threads.

## Today
Pairing on the sidecar compaction path with [[Jordan Rivera|Jordan]].

## Blockers
Waiting on the eval harness rerun before promoting.
`;
const PATH = 'Notes/Standup.md';

describe('small-note collapse: contracts', () => {
    it('three one-line H2s become one chunk titled by the note, headings inlined', async () => {
        const src = chunker.chunkContent(THREE, PATH);
        expect(src).toHaveLength(3);
        const out = await collapseSmallNotes(src, fakeCount);
        expect(out).toHaveLength(1);
        const c = out[0];
        expect(c.title).toBe('Standup | Daily sync');
        expect(c.heading_path).toEqual([]);
        expect(c.content).toBe(
            'Yesterday\nShipped the tokenizer fix and closed two review threads.\n\n'
            + 'Today\nPairing on the sidecar compaction path with Jordan.\n\n'
            + 'Blockers\nWaiting on the eval harness rerun before promoting.');
        expect(c.lexicalOnly).toBeUndefined();
    });

    it('re-derives the path-salted id, spans the whole note, keeps metadata and link_terms', async () => {
        const src = chunker.chunkContent(THREE, PATH);
        const [c] = await collapseSmallNotes(src, fakeCount);
        expect(c.chunk_id).toBe(chunkIdFor(PATH, c.title, c.content, c.denseSuffix));
        expect(src.map(s => s.chunk_id)).not.toContain(c.chunk_id);
        expect(c.denseSuffix).toBe(src[0].denseSuffix);
        expect(c.metadata).toBe(src[0].metadata);
        expect(c.start_line).toBe(Math.min(...src.map(s => s.start_line)));
        expect(c.end_line).toBe(Math.max(...src.map(s => s.end_line)));
        expect(c.link_terms).toContain('Jordan Rivera');
    });

    it('composes through embedInput with no breadcrumb and an intact suffix', async () => {
        const [c] = await collapseSmallNotes(chunker.chunkContent(THREE, PATH), fakeCount);
        expect(c.title).toBe('Standup | Daily sync');
        expect(c.heading_path).toEqual([]);
        const expected = c.denseSuffix
            ? `${c.title}\n\n${c.content}\n\n${c.denseSuffix}`
            : `${c.title}\n\n${c.content}`;
        expect(embedInput(c)).toBe(expected);
    });

    it('token boundary: collapses at exactly the limit, not one over', async () => {
        const src = chunker.chunkContent(THREE, PATH);
        const at: CountTokens = async ts => ts.map(() => SMALL_NOTE_TOKENS);
        const over: CountTokens = async ts => ts.map(() => SMALL_NOTE_TOKENS + 1);
        expect(await collapseSmallNotes(src, at)).toHaveLength(1);
        const kept = await collapseSmallNotes(src, over);
        expect(kept).toBe(src);
    });

    it('never asks the tokenizer about single-chunk notes, .base files or long bodies', async () => {
        let calls = 0;
        const spy: CountTokens = async ts => { calls++; return ts.map(() => 1); };
        const single = chunker.chunkContent('## Only\nOne section that clears the minimum chunk size easily.\n', 'A.md');
        expect(await collapseSmallNotes(single, spy)).toBe(single);

        const views: BaseView[] = [
            { viewName: null, content: 'Tasks' },
            { viewName: 'Open', content: 'Tasks Open view' },
        ];
        const base = chunker.chunkBase(views, 'Tasks.base');
        expect(await collapseSmallNotes(base, spy)).toBe(base);

        const filler = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
        const long = chunker.chunkContent(`## A\n${filler}\n\n## B\n${filler}\n`, 'Long.md');
        expect(collapsedBody(long).length).toBeGreaterThan(SMALL_NOTE_MAX_CHARS);
        expect(await collapseSmallNotes(long, spy)).toBe(long);
        expect(calls).toBe(0);
    });

    it('a batch of notes: only the small one collapses, order and the others are preserved', async () => {
        const filler = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
        const big = chunker.chunkContent(
            `## Summary\nOne line summary of the design goes right here today.\n\n## Detail\n${filler}\n`, 'Big.md');
        const small = chunker.chunkContent(THREE, PATH);
        const out = await collapseSmallNotes([...big, ...small], fakeCount);
        expect(out.slice(0, big.length)).toEqual(big);
        expect(out).toHaveLength(big.length + 1);
        expect(out[out.length - 1].note_path).toBe(PATH);
    });

    it('packChunks = collapse then token budget, with exact counts for bucket routing', async () => {
        const r = await packChunks(chunker.chunkContent(THREE, PATH), fakeCount);
        expect(r.chunks).toHaveLength(1);
        expect(r.counts).toHaveLength(1);
        expect(r.splits).toBe(0);
        expect(r.counts[0]).toBe((await fakeCount([embedInput(r.chunks[0])]))[0]);
    });

    it('long notes still split through the token budget after packChunks', async () => {
        const body = Array.from({ length: 40 }, (_, i) =>
            Array.from({ length: 40 }, (_, j) => `p${i}w${j}`).join(' ')).join('\n\n');
        const src = chunker.chunkContent(`## Only\n\n${body}`, 'Notes/Long.md');
        expect(src).toHaveLength(1);
        const packed = await packChunks(src, fakeCount);
        const budgetOnly = await enforceTokenBudget(src, fakeCount);
        expect(packed.chunks.length).toBeGreaterThan(1);
        expect(packed.chunks.map(c => c.chunk_id)).toEqual(budgetOnly.chunks.map(c => c.chunk_id));
    });

    it('createBatchedTokenCounter preserves packChunks ids vs a direct counter', async () => {
        const batcher = createBatchedTokenCounter(fakeCount, TOKEN_COUNTS_BATCH);
        const src = chunker.chunkContent(THREE, PATH);
        const direct = await packChunks(src, fakeCount);
        const batched = await packChunks(src, batcher.countTokens);
        await batcher.flush();
        expect(batched.chunks.map(c => c.chunk_id)).toEqual(direct.chunks.map(c => c.chunk_id));
        expect(batcher.getRpcCount()).toBeGreaterThan(0);
    });
});
