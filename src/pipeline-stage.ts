// Progressive search pipeline stage machine.
//
// The orchestrator streams results through three promise-ordered stages:
//   name (basename/alias prefix paint) → lexical (BM25 + recency + title) →
//   hybrid (dense embed + fusion, in-place replacement of the lexical set).
// The search modal footer mirrors this ladder so the user can see which stage
// a query is in.
//
// Keeping the transitions in a pure reducer makes the promise ordering
// testable without the DOM: a stage only becomes active once the PREVIOUS
// stage's own production resolved (its onPartial fired). A stage that never
// painted anything (e.g. a topical query with no name coverage) is inferred
// resolved when a LATER stage completes, so the ladder always converges to
// the final hybrid result without wedging on a skipped rung.

export type PipelineStageId = 'name' | 'lexical' | 'hybrid';

export type PipelineStagePhase = 'pending' | 'active' | 'done';

/** Per-stage phase for the current search. */
export type PipelineStageState = Record<PipelineStageId, PipelineStagePhase>;

export type PipelineStages = PipelineStageState;

export type PipelineStageEvent =
    | { type: 'query' }        // a new query started → name is the active stage
    | { type: 'name-done' }    // name onPartial resolved
    | { type: 'lexical-done' } // lexical onPartial resolved
    | { type: 'final' }        // search() returned → all stages complete
    | { type: 'clear' };       // reset to idle (empty query / error / modal close)

// Display order — this is also the order labels appear in the footer.
export const PIPELINE_STAGE_ORDER: readonly PipelineStageId[] = ['name', 'lexical', 'hybrid'];

export function initialPipelineStageState(): PipelineStages {
    return { name: 'pending', lexical: 'pending', hybrid: 'pending' };
}

export function nextPipelineStage(state: PipelineStages, event: PipelineStageEvent): PipelineStages {
    switch (event.type) {
        case 'query':
            return { name: 'active', lexical: 'pending', hybrid: 'pending' };
        case 'name-done': {
            // Idempotent: the cold-start double pass (lexical while the model
            // loads, then the full hybrid search) re-fires the name partial.
            if (state.name === 'done') return state;
            // Without a live query (name never became active) a stray event
            // must not light up the ladder — the modal guards staleness by
            // search id anyway; this is belt-and-braces for the pure reducer.
            if (state.name !== 'active') return state;
            return { name: 'done', lexical: 'active', hybrid: state.hybrid };
        }
        case 'lexical-done': {
            // Advancing past lexical implies the name stage has resolved even
            // when it never painted (topical query with no name coverage).
            const queryRunning = state.name === 'active' || state.lexical === 'active';
            if (!queryRunning) return state; // idle — no query to advance
            const next: PipelineStages = { ...state };
            if (next.name === 'active') next.name = 'done';
            next.lexical = 'done';
            if (next.hybrid === 'pending') next.hybrid = 'active';
            return next;
        }
        case 'final':
            return { name: 'done', lexical: 'done', hybrid: 'done' };
        case 'clear':
            return initialPipelineStageState();
    }
}