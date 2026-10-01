// Progressive pipeline stage machine — pure reducer, no DOM.
//
// The search modal footer mirrors the orchestrator's streaming stages
// (name → lexical → hybrid). The key invariant these tests pin down:
// a stage's label must not indicate "active" until the PREVIOUS stage's
// promise-ordered production resolved (its onPartial fired), so the UI
// stays in sync with the actual search() call sequence.

import { describe, it, expect } from 'vitest';
import {
    nextPipelineStage,
    initialPipelineStageState,
    PIPELINE_STAGE_ORDER,
} from './pipeline-stage';
import type { PipelineStages, PipelineStageEvent } from './pipeline-stage';

// Fold a script of events through the machine, asserting the final state.
function fold(events: PipelineStageEvent[]): PipelineStages {
    let s = initialPipelineStageState();
    for (const e of events) s = nextPipelineStage(s, e);
    return s;
}

const query = { type: 'query' } as const;

describe('pipeline stage machine', () => {
    it('recognizes exactly the three stages in display order', () => {
        expect(PIPELINE_STAGE_ORDER).toEqual(['name', 'lexical', 'hybrid']);
    });

    it('starts fully pending', () => {
        expect(initialPipelineStageState()).toEqual({
            name: 'pending', lexical: 'pending', hybrid: 'pending',
        });
    });

    it('a new query makes name active and the rest pending', () => {
        expect(nextPipelineStage(initialPipelineStageState(), query)).toEqual({
            name: 'active', lexical: 'pending', hybrid: 'pending',
        });
    });

    it('query → name-done advances lexical to active (promise order held)', () => {
        expect(fold([query, { type: 'name-done' }])).toEqual({
            name: 'done', lexical: 'active', hybrid: 'pending',
        });
    });

    it('partial events on an idle machine are ignored entirely', () => {
        // Guard against the machine "lighting up" without a live query: with
        // no query event the state is fully pending, and name-done / lexical-
        // done on it must not advance anything, so nothing shows spuriously.
        expect(fold([{ type: 'name-done' }])).toEqual(initialPipelineStageState());
        expect(fold([{ type: 'name-done' }, { type: 'lexical-done' }])).toEqual(initialPipelineStageState());
    });

    it('full sequence reaches all-done only after the final event', () => {
        expect(fold([query, { type: 'name-done' }, { type: 'lexical-done' }, { type: 'final' }])).toEqual({
            name: 'done', lexical: 'done', hybrid: 'done',
        });
    });

    it('hybrid becomes active on lexical-done (before the final return)', () => {
        expect(fold([query, { type: 'name-done' }, { type: 'lexical-done' }])).toEqual({
            name: 'done', lexical: 'done', hybrid: 'active',
        });
    });

    it('a query with no name paint reaches hybrid via the lexical rung', () => {
        // Topical query: the name partial never fires (no name coverage) but
        // the lexical partial does. Advancing past lexical implies name is
        // resolved — the ladder always converges rather than wedging on a
        // skipped rung.
        expect(fold([query, { type: 'lexical-done' }])).toEqual({
            name: 'done', lexical: 'done', hybrid: 'active',
        });
    });

    it('clear resets to fully pending regardless of current state', () => {
        expect(fold([query, { type: 'name-done' }, { type: 'lexical-done' }, { type: 'clear' }])).toEqual({
            name: 'pending', lexical: 'pending', hybrid: 'pending',
        });
    });

    it('a later final always collapses the ladder to done', () => {
        expect(fold([{ type: 'final' }])).toEqual({
            name: 'done', lexical: 'done', hybrid: 'done',
        });
    });

    it('name-done is idempotent after the cold-start double pass', () => {
        // Cold start fires the lexical-only search (name + lexical partials)
        // and then the full hybrid search re-fires the name partial. The
        // duplicated name-done must not regress lexical back to pending.
        const afterFirst = fold([query, { type: 'name-done' }, { type: 'lexical-done' }]);
        const afterDup = nextPipelineStage(afterFirst, { type: 'name-done' });
        expect(afterDup).toEqual({ name: 'done', lexical: 'done', hybrid: 'active' });
    });
});