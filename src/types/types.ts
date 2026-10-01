// Core types for Seek. Mirrors the verbose-logging schema from the iOS spike
// so the same generator/reader code can be reused with minimal changes.

export type Device = 'webgpu' | 'wasm';
export type RequestedDevice = Device | 'auto';
export type Dtype = 'q4f16' | 'q4' | 'q8' | 'fp32';

// Bumped whenever any LogEntry shape changes incompatibly. The report
// renderer keys off this to detect old logs and skip fields that aren't
// present. Append-only NDJSON files outlive plugin versions, so the schema
// version is the only thing keeping the report parser honest.
// v6: added EmbedProfileEntry (runtime wall-time decomposition harness —
// tokenize / forward / readback split, to settle the I/O-binding,
// worker, and WASM-tokenizer questions on the v4 runtime).
// v7: SearchEntry gained two-stage telemetry — binary candidate-gen + fp32
// exact rerank. New fields: binaryMs, selectFetchMs, candidateUnionSize,
// per-arm contribution counts (binaryCount/bm25Count/recencyCount), the
// stage-1 caps (binaryTopN/bm25TopM/recencyTopK). Existing min-max hybrid
// fields are unchanged — the rerank runs the same scorer over a subset.
// v8: SearchEntry gained inline-filter telemetry — `cleanedQuery` (residual
// text after stripping operators) and `filters` (structured QueryFilters or
// null). Additive/optional in practice; v7 logs still parse (the new fields
// are simply absent and read as undefined by the report renderer).
// v9: every entry is stamped (in logger.append) with `deviceId` (per-install,
// localStorage-backed) and `sessionId` (per plugin load). This is what lets the
// report attribute Platform/Init/Loads to the device that actually generated
// them — previously a shared iCloud-synced log made `at(-1)` cross-device.
// Each device also writes its OWN log file (seek-log-<deviceId>.ndjson) so
// concurrent appends from desktop + phone can't clobber each other under
// iCloud's whole-file last-writer-wins sync. Both fields optional → v8 logs
// (and the legacy seek-log.ndjson) still parse, attributed to deviceId 'legacy'.
// v10: crash forensics. Synchronous localStorage breadcrumbs survive process
// death (async NDJSON appends lose that race — proven by the 2026-06-11 iPhone
// reindex jetsam kill that left zero log entries); on boot, an unclosed prior
// session is promoted into the log as a crash-detected entry.
// v11: InitEntry.initMs — real iframe-build wall time. Was never measured
// (the startup-deferral tradeoff rested on an estimate). Additive/forward-only:
// older logs simply lack the field; no migration. initMs=0 means the idempotent
// init early-returned (iframe already live), not a zero-cost build.
// v12: ModelDeliveryEntry — per-load record of the active model spec, storage
// persistence, and stale-model cache eviction (production model-delivery layer).
// v13: PlatformEntry.gpuIsFallbackAdapter — distinguishes a real GPU from a
// software (SwiftShader-class) fallback adapter. Additive/forward-only. The
// r/ObsidianMD triage showed "GPU yes" is ambiguous without it: requestAdapter
// can hand back a software adapter when hardware acceleration is off, which
// then fails ORT's WebGPU init while the report still reads as GPU-capable.
// Also LoadEntry.glue — which ort-wasm glue variant actually loaded
// (previously only recoverable from the `checks` strings).
// v14: IndexCompleteEntry.filesQuarantined / chunksFailedEmbed — embed-failure
// quarantine accounting (issue #4): files committed WITH a failure marker
// (deterministically-failing chunks omitted, healthy chunks searchable) vs the
// old whole-file skip. Additive/forward-only.
// v15: LongTaskEntry.culprit / container* — WHICH FRAME a stall ran in.
// Issue #5 produced a cluster of 14-15 s stalls on an exact hourly period that
// no Seek phase overlapped (context 'idle'), and the existing `attribution`
// field could not narrow it: it read TaskAttributionTiming.name, which the spec
// hard-codes to the literal 'unknown'. The discriminating fields were one level
// up all along. Additive/forward-only; `attribution` is retained so pre-v15
// rows still parse (they carry 'unknown' and nothing else).
// v16 (issue #5): + delta-apply entry (incremental-patch outcome: fallback
// reason, patch cost, mutex hold), + IndexCompleteEntry.paceWaitMs.
// v17: startup trace infra — rechunk-live (filesWalked, tokenCountsRpc),
// startup-span (boot/hydrate phase boundaries), startup-gate (search gate release).
export const LOG_SCHEMA_VERSION = 18;

// ---- chunk model ----

export interface ChunkMetadata {
    tags: string[];
    aliases: string[];
    created: string | null;
    modified: string | null;
    // All frontmatter values, keyed by frontmatter key — the generic backing
    // store for `[key:value]` inline filters (context, status, pageType, …) AND
    // the searchable-properties BM25 field. Scalars are string-coerced; LIST
    // values (relatedPages-style) are kept as string[] (v10, audit R2 #3: the
    // suggester offered list-prop pills the scalar-only store could never
    // match). The matcher treats a list as any-element-matches (Obsidian's own
    // list-property semantics); the BM25 properties field folds each list item
    // in too, per-element, through the same type-drop gates as a scalar value
    // (extractPropertiesText, audit R2 batch2 #3).
    // tags/aliases are NOT duplicated here (dedicated fields + operators).
    // Populated on (re)index.
    properties: Record<string, string | string[]>;
}

// Structured filters extracted from a raw query string by parseQuery()
// (src/query-parser.ts). A null QueryFilters means the query had no inline
// operators — a plain semantic/lexical search. Mirrors the predecessor's
// Python SearchFilters; `tagsMatchAll` is reserved for a later version
// (always OR in v1).
export interface QueryFilters {
    tags: string[] | null;
    tagsMatchAll: boolean;
    frontmatter: Record<string, string> | null;
    includePaths: string[] | null;
    // Numeric comparison filters (`[price>50]` / `[price<200]` / `[price=160]`),
    // value already coerced to a finite number at parse time. Keyed off a
    // property's DECLARED type (Number), not its name — see FilterContext below
    // and [[Seek Typed-Value Filters Design]]. All operators are value-INCLUSIVE:
    // `>`/`<` keep on/above and on/below the bound, `=` is exact. Null = none.
    numeric: Array<{ key: string; op: '<' | '>' | '='; value: number }> | null;
    // Date-range filters (`after:D` / `before:D`), both day-inclusive. These read
    // the SINGLE date field the user selected for Recency (resolved per-chunk via
    // FilterContext.dateField), so they only bind when Recency is ON. Raw date
    // strings (parseDateMs-able); the inclusive bounds are computed in the matcher.
    dateAfter: string | null;
    dateBefore: string | null;
    // Keys where a comparison operator was used on a property that is NOT declared
    // Number (e.g. `[pageType<notes]`). Such a clause CANNOT be honored numerically,
    // so the whole query is unsatisfiable → the matcher returns 0 results rather
    // than silently substring-matching (Decision D3). Carried for diagnostics; the
    // search UI separately flags the offending pill red. Null = no mismatch.
    numericTypeMismatch: string[] | null;
    // Bare-word negation (`-term`, Obsidian `-` semantics). Normalized lowercase
    // tokens; a note is excluded if ANY of these appears in its title/content.
    // Unlike the metadata filters above, this is applied note-level in search()
    // (compileMatcher is metadata-only and can't see content), not in the matcher.
    exclude: string[] | null;
}

// Vault-specific facts the PURE parser/matcher (query-parser.ts) can't read for
// themselves — they import only types + a date helper, never `obsidian`. The call
// site (search.ts, which has `app` + `settings`) resolves this once and threads it
// through parseQuery()/compileMatcher(). Optional/defaulted everywhere so existing
// tests and ad-hoc callers keep working (no ctx ⇒ permissive: any key may compare,
// dates use `created`). See [[Seek Typed-Value Filters Design]] §Architecture.
export interface FilterContext {
    // The date field `before:`/`after:` target — the user's Recency selection.
    // null when Recency is OFF, which is how the parser knows to leave a typed
    // `before:`/`after:` as plain search text instead of binding a date filter.
    dateField: { key: RecencyKeyChoice; createdProp: string } | null;
    // Properties declared Number in Obsidian's type registry. A comparison on a
    // key outside this set is a type mismatch (Decision D3); a key inside it is a
    // numeric filter (and reaches the `[` autocomplete past the cardinality gate).
    numericKeys: Set<string>;
}

export interface Chunk {
    chunk_id: string;
    title: string;            // hierarchical: "Note Title > H1 > H2"
    content: string;
    note_path: string;
    heading_path: string[];
    metadata: ChunkMetadata;
    // 1-based line numbers into the RAW note file, FRONTMATTER INCLUDED — usable
    // directly against the on-disk text (editor.setCursor / scrollIntoView and a
    // raw-content offset walk for the in-note highlight; see search-modal.ts). The
    // chunker counts these against the frontmatter-stripped body and shifts them
    // back to file coordinates before emitting (chunker.ts return site).
    start_line: number;
    end_line: number;
    // Lexical-only chunk: present (true) ONLY on the title-only fallback emitted
    // for a body-LESS note (chunker.ts) — a note whose entire embed string would
    // be "<title>\n\n" with no body. Such a chunk has no semantic content to
    // offer the dense channel; its vector is just the title (often a bare date),
    // which makes it a universal near-neighbor for any content-free / OOV query
    // (e.g. an opaque ID). The ranker floors its dense score before min-max so it
    // can never be a spurious semantic hit, while BM25's 3.0x title boost keeps
    // it findable by name. Absent (undefined) for every normal chunk and for
    // short-but-non-empty fallbacks (which DO carry embeddable content).
    lexicalOnly?: boolean;
    // Human-facing title for an oversized section that was hard-split into
    // multiple parts: `"<title> (part N)"`. Present ONLY on split parts; absent
    // for every single-part chunk. The `(part N)` marker must NOT live in
    // `title`, because `title` is what gets embedded (search.ts: `title\n\ncontent`),
    // indexed in the 3.0x-boosted BM25 title field, and hashed into chunk_id —
    // a per-part suffix there poisons the dense vector and the title boost and
    // splinters otherwise-identical titles. Display surfaces read `displayTitle`
    // (falling back to `title`) so the part marker stays visible without leaking
    // into the index. Optional → pre-existing chunks read it as undefined.
    displayTitle?: string;
    // Note-level frontmatter VALUES folded into the DENSE channel only. Appended
    // to the EMBED input by token-budget.ts embedInput (`title\n\ncontent\n\n
    // denseSuffix`) and to NOTHING else — bm25.ts's `content` field stays the raw
    // body, the validated dense-only decoupling (+0.0031 dense-only vs +0.0010
    // both-channels; tags already have their own BM25 field, so injecting there
    // just dilutes). Built once per note (chunker.ts buildDenseSuffix: keys
    // dropped, wikilinks→basename, aliases excluded, date/number/boolean values
    // type-dropped) and carried on EVERY chunk of the note — the same convention
    // by which aliases are hoisted into every chunk's title. Folded into chunk_id
    // (chunkIdFor's 4th arg) so the hashed bytes still equal the embedded bytes;
    // a CHUNKER_VERSION bump rides with it. Absent (undefined) when the note has
    // no qualifying values. See [[Seek Domain Agnostic LoRA]] (locked 2026-06-18).
    denseSuffix?: string;
    // Lexical reclamation (v10, 2026-07-02): the raw substrings cleanDenseBody
    // DROPPED from this chunk's section — wikilink targets behind aliases,
    // markdown-link/autolink URLs, bare-URL scheme+TLD forms (dense-clean.ts
    // extractLinkTerms). Folded into the BM25 `content` field at doc-build time
    // (bm25.ts buildDoc) and into NOTHING else: not the embed input, not the
    // snippet body, and NOT chunk_id — ids and vectors are byte-identical with
    // or without it (the CHUNKER_VERSION 10 bump exists only to backfill this
    // field into stored records fleet-wide). Restores the pre-v8 query symmetry
    // where `theverge.com` lexically matched a clipping that links its source.
    // Absent when the section dropped nothing. Split parts share the section's
    // whole value (token-budget.ts `...chunk` spread) — a minor tf inflation on
    // oversized sections, accepted for wiring simplicity.
    link_terms?: string;
}

// One synthetic search document extracted from a `.base` file (Obsidian Bases).
// A base is modelled as a document whose VIEWS are its sections: `extractBaseDocs`
// returns one BaseView per indexable view plus a base-level entry, and the chunker
// (`chunkBase`) turns each into a Chunk that reuses the whole note pipeline (title,
// heading_path, chunk_id, dense + BM25, dedup, nav). See base-extractor.ts.
export interface BaseView {
    // The view's display name, or null for the base-level entry. Drives the chunk
    // title (`"<base> > <viewName>"` vs bare `"<base>"`) and heading_path, so the
    // view name earns the 3.0x BM25 headings field and the dense channel.
    viewName: string | null;
    // Synthetic searchable text: base name + inherited top-level filter literals +
    // this view's own filter literals + the view name, deduped. Never empty (the
    // base name is always present), so no chunk needs the lexicalOnly stub flag.
    content: string;
}

// A chunk's metadata — everything except the body text. This is what the v8
// `chunk_meta` IDB store holds and what the resident search frame keeps in RAM;
// the body lives in `chunk_body` keyed by chunk_id and is fetched lazily for
// the ≤topK results (snippets / hydration), `-term` negation, and BM25 (re)fit.
// See docs/seek-scaling.md §B1. Omit (not a hand-listed interface) so it tracks
// Chunk automatically as fields are added.
export type ChunkMeta = Omit<Chunk, 'content'>;

// User-tunable settings (persisted via Plugin.saveData). Read live by the
// orchestrator (it holds the same object ref), so changes take effect on the
// next search without a rebuild.
export interface SeekSettings {
    // Dense weight in the TM2C2 hybrid: hybrid = w·dense_norm + (1−w)·bm25_norm
    // (ranker.ts hybridFusion over TM2C2-normalized channels). w=1 is pure
    // semantic, w=0 pure lexical. Default 0.80 — the BOUND-NORMALIZED scale
    // (2026-06-09: BM25 is divided by its per-query theoretical bound, not its
    // empirical max — fusion.ts theoreticalNormBm25). NOT comparable to either
    // earlier scale (min-max ~0.5–0.7; empirical-max TM2C2 0.90–0.95): the bound
    // compresses the lexical channel, so the optimum sits lower. 0.70–0.85 is a
    // flat plateau on BOTH the 482-q personal eval and the D&D OOV slice — the
    // first scale where one global weight is optimal across domains, which is
    // the point of the bound (query-invariant channel scale). The empirical-max
    // era's "saturated single-term hit" captures are handled by the norm now
    // (a weak best match no longer gets a forced 1.0), not by this weight.
    // Single biggest relevance lever; applied per-search — no reindex. NOTE:
    // a data.json persisted before the bound switch carries an old-scale value
    // (0.92) — the settingsRev<2 migration in main.ts onload drops it so the
    // bound-norm default takes over (no manual data.json surgery needed).
    denseWeight: number;

    // Known-item boost: additive title/alias COVERAGE boost (fusion.ts
    // titleMatchBoost). Fires when every query token is in the title and scales
    // by precision (|q∩t|/|t|). The 2026-06-02 study found the dense gap is
    // largely RANKING (the entity page buried under pages that mention it);
    // coverage generalizes the old exact-match boost to the common subset case
    // ("alex 1x1" vs `Alex 1x1 2026-05-19`). The swept knee is 0.8 (knee on the
    // 482-q old-log eval, nDCG@10 0.8143→0.8677); the SHIPPED default softened to
    // 0.5 in the 2026-06-19 settings ratification (the Title-bonus "Default" stage),
    // with the 0.8 knee one click away as "High" (segmented Off=0/Default=0.5/High=0.8).
    // NOT comparable to the old exact-only 0.025; precision-scaling makes high values safe.
    navTitleBoost: number;

    // Which per-chunk date "recent" means, vault-wide — the GLOBAL definition
    // behind the recency ε-tiebreaker (ranker.ts), the S1 recency candidate arm,
    // the filter-only browse sort, AND the before:/after: date filter (all read
    // it through fusion.ts recencyDate, so they cannot disagree). 'modified'
    // (DEFAULT) = file mtime as of indexing: the ONLY date every note is
    // guaranteed to carry, so it's the only generic default we can bank on
    // across vaults — at the cost of being edit-recency, silently churned by
    // vault copies, iCloud sync, and bulk plugin edits. 'created' = a frontmatter
    // date property (createdProp, with filename-date then mtime fallback) —
    // copy-proof and matches the dated-instance semantics episodic queries want,
    // but it assumes the vault carries such a property, so it's an explicit
    // opt-in via the date-field picker, not the default. Applied per-search (no
    // reindex, both dates are already in the index). [[Seek Rel]] §Recency Plan
    // 2026-06-11. (Replaces `recencyWeight`, the parked blend weight deleted
    // 2026-06-11 with the rest of the zombie recency machinery; a stale persisted
    // value is inert.)
    recencyKey: RecencyKeyChoice;

    // Which frontmatter property holds a note's creation date. `created` is
    // THIS vault's convention, not an Obsidian builtin — other vaults use
    // `date created` (Linter), `dateCreated`, `created_at`, … so the name is a
    // setting. In the UI it is a PICKER over the vault's Date / Date & time
    // typed properties (Obsidian's property-type registry, .obsidian/types.json
    // via main.ts enumerateDatePropertyNames) — never free text, so a typo'd
    // ("craated") or non-date (tags…) choice is unselectable by construction.
    // Resolved READ-side: all scalar frontmatter is already indexed per chunk
    // (metadata.properties), so changing this needs no reindex. Notes without
    // the property fall back to a YYYY-MM-DD in the filename (daily notes /
    // dated series notes), then mtime — fusion.ts recencyDate ladder.
    createdProp: string;

    // Recency WEIGHT (ε): the magnitude of the additive recency term in
    // final = hybrid + ε·recency + titleBoost (ranker.ts). recency ∈ [0,1] from
    // the half-life decay below, so ε is literally the maximum score a
    // brand-new note can gain. The shipped DEFAULT is now 0 — recency ships Off
    // (2026-06-19 settings ratification). The Recency segmented control maps
    // Off=0 / Default=0.04·180d / High=0.1·90d; the old 0.02 always-on tiebreaker
    // is retired. A non-zero ε ("Default"/"High") is a deliberate recency lean: raising it past
    // ~0.1 lets a fresh note leapfrog a moderately-better older one. CAUTION,
    // not a free lever: the 06-04 click study found 50% of episodic clicks
    // target a note >90d old, and a recency term strong enough to reorder real
    // gaps scored WORSE (MRR 0.242 vs 0.310) — so high values trade known-item
    // precision for recency. Additive on top of uncontested relevance; applied
    // per-search (no reindex). Default 0 (Off).
    recencyEpsilon: number;

    // Recency HALF-LIFE in days: the width of the decay 0.5^(daysOld/halfLife)
    // (fusion.ts computeRecencyScore) — the age at which a note's recency signal
    // halves. This is the time CONSTANT, orthogonal to the weight above: it
    // reshapes the curve, it does not change how hard recency hits. Shipped
    // DEFAULT 180 (the 06-04 operating point — wide enough that an 83-day-old
    // median episodic target still carries ~0.73). The Recency "High" stage
    // SHORTENS it to 90 (settings-tab.ts RECENCY_VALUE), which is what actually
    // makes High a lean: ε sets the budget, the half-life decides how much of it
    // is spent inside the age band a query spans. 90 ≈ the 83d median episodic
    // click target, i.e. the knee sits on the click mass.
    // Do NOT chase a shorter one (7–30) for a "browse by date" feel: it wins the
    // dated-series case but zeroes the far field, and an ε that no longer decays
    // gently stops behaving like a tiebreaker — on a flat no-opinion pool it is
    // the only live signal and orders the whole result set by date. That is
    // exactly the two-stage 30d-cutoff bug this smooth decay replaced. The fix
    // for genuine browse intent is a conditional regime (detecting that the pool
    // is a tied set of equivalent dated siblings, not merely flat), NOT a smaller
    // constant — a scalar cannot separate the two: measured spreads are 0.032
    // (dated siblings) vs 0.011 (nothing matched), only 3× apart.
    // Undated notes score 0 (neutral — never penalized). Applied per-search
    // (no reindex). Default 180.
    recencyHalfLifeDays: number;

    // Optional per-field BM25 boost overrides (Settings → Relevance → Advanced).
    // Score-time only — merged over DEFAULT_FIELD_BOOSTS via resolveBm25FieldBoosts
    // (bm25-boosts.ts) and passed to getScoresWithCoverage({ boosts }). Absent /
    // empty ⇒ shipped defaults. Does NOT trigger embedding reindex or BM25
    // index-shape refit. Re-exposed after the 2026-06-08 removal (aggregate hybrid
    // nDCG ~+0.004) because lexical-first paths (vault-lex, Keyword-focused) are
    // not diluted by dense fusion — e.g. headings 3→5 meaningfully lifts
    // section-title-only matches. See bm25-boosts.ts.
    bm25FieldBoostOverrides?: Partial<Record<'title' | 'aliases' | 'tags' | 'content' | 'properties' | 'headings', number>>;

    // Fuzzy lexical matching toggle. ON by default (2026-06-09): MiniSearch
    // fuzzy with an absolute max edit distance of 1 (one insertion/deletion/
    // substitution). The D&D typo eval (typo_fuzzy_eval.py) priced both sides:
    // +3–4/40 gold@1 on misspelled entity queries (typo rescue doesn't exist at
    // all without it — every norm scores 34/40 with fuzzy off), at an ns ~0.002
    // nDCG cost on clean personal queries. Interacts with the theoretical BM25
    // bound: derived terms can exceed it (fusion clips) and a fully-OOV typo
    // query has bound 0 (fusion falls back to /max) — see fusion.ts. Off =
    // exact terms only. Applied per-search (no reindex).
    fuzzyEnabled: boolean;

    // Prefix matching on the LAST query token (≥3 chars). ON by default
    // (2026-06-10): the final token of a query is the one plausibly still
    // being typed ("amster", "roadmap for concep", "lr ac rearch"), and
    // neither exact, fuzzy (edit-1), nor any scorer change can reach
    // "rearchitecture" from "rearch" — only expansion can. Eval
    // (~/seek-eval-pack prefix_arm.py, α=0.80): personal 483q
    // 0.8666→0.8730 bin nDCG@10, gold@1 +1.1pt with the wins concentrated
    // on truncated/typeahead queries; D&D and code stress sets exactly
    // unchanged; capture cap-004 target rank 5→2. Expanding ALL tokens was
    // rejected (D&D desc −0.0149, ~1813 derived terms/q on code). Derived
    // terms are numerator-only vs the theoretical bound (fusion clips),
    // same contract as fuzzy. Applied per-search (no reindex).
    prefixLastToken: boolean;

    // EXPERIMENTAL, default OFF: query-side synonym expansion from the
    // vault's own frontmatter aliases (synonyms.ts). Each note's single-token
    // name + aliases form an equivalence class ("Lr" ↔ "Lightroom"); a query
    // term in a class also queries its classmates at a discount, so "lr
    // roadmap" can reach a note that only ever spells out "Lightroom".
    // Guards: ambiguous tokens (shared by >1 class) neither trigger NOR get
    // injected (symmetric — 4 pages aliased "rohit" disable that bridge
    // entirely), and tokens matching >5% of chunks are refused (junk-alias
    // ceiling). Eval (~/seek-eval-pack, 2026-06-10): personal +0.0015 bin
    // nDCG@10 over the prefix baseline at w=0.8. The native-attribution gate
    // showed MiniSearch's raw ×quality double-credit ERASES that gain at
    // every weight (it doubles alias hub/sibling pages), so bm25.ts rescales
    // each result back to source-attribution semantics exactly — +0.0015 is
    // what ships. ON by default as of the 2026-06-19 settings ratification
    // (the always-on dogfood now IS the live smoke test; plan note "Seek
    // Synonym Expansion Plan"). Known
    // precision tax even under source semantics: the alias OWNER page
    // also climbs on expanded queries (cap-004 owner rank 5→3). English-only
    // posture: dictionary tokens run through the English analyzer. Dictionary
    // rebuilds with the BM25 cache (per dataGeneration); no reindex.
    synonymExpansion: boolean;

    // Searchable properties — index frontmatter property VALUES as a 6th BM25
    // field (boost 2.0, bm25.ts) so plain query words match structured
    // metadata: "san francisco restaurants" finds notes whose body never says
    // either but whose placeLoc/placeType do. Values are wikilink-unwrapped
    // and date/number values dropped (extractPropertiesText); machinery keys
    // (icon, cssclasses, dates, …) are excluded, list-valued props fold in
    // per-item (audit R2 batch2 #3); terms then run the standard analyzer.
    // Harness gate 2026-06-11
    // (props_field_arm): captures +0.059 at boost 2 (clean-SF 0.58→0.77,
    // "swiss hotel" crater 0.0→0.19), personal 483-q net-zero — churn is
    // symmetric on person-name/link-valued props, which is why the boost
    // stays modest. Toggle refits the BM25 cache on the next search (index
    // shape change) but needs NO embedding reindex — chunks already store
    // metadata.properties, the same backing store [key:value] filters read.
    searchableProperties: boolean;

    // Headings field — index the section heading path (chunk heading_path) as
    // a BM25 field (boost 3.0, bm25.ts). The lexical mirror of what the dense
    // channel already reads via embedInput's hierarchical title; without it
    // heading words are BM25-invisible (extractNoteName strips the path from
    // `title`, the chunker drops the heading line from section content).
    // Harness gate 2026-06-12 (headings_field_arm) was a WASH with recency
    // OFF: heading-only topical wins (+0.5 nDCG) cancelled by dated-series
    // near-tie reorders — the class the live ε-recency tiebreaker re-orders,
    // which the harness convention can't model. ON by default as of the
    // 2026-06-19 settings ratification (the live A/B is now the shipped default).
    // Same cache contract as searchableProperties: refit on toggle,
    // NO embedding reindex.
    headingsField: boolean;

    // "Boosted BM25" preset — legacy hidden switch (aliases 6→9, tags 3→2,
    // headings →4). Still applied by resolveBm25FieldBoosts when there are NO
    // bm25FieldBoostOverrides; any custom override supersedes this preset.
    // Flipping this ALSO forces the heading field on in ensureBm25() (index-
    // shape) so the headings boost is not inert. Prefer the Advanced sliders
    // for new tuning; this key is kept for persisted installs.
    boostedBm25: boolean;

    // BM25 coverage weighting — the SOFT-AND fix for OR's looseness. MiniSearch
    // combines query terms with OR, so a doc that saturates ONE query term (a
    // short hub/entity page whose title IS that term — the "Switzerland" country
    // page on "switzerland hotel", a person page on "alex …") can out-score a doc
    // that matches the WHOLE query. On (default) we scale each doc's raw BM25 by
    // the fraction of DISTINCT query terms it matched (|matched|/|query terms|)
    // BEFORE TM2C2 normalization, so a 1-of-2 match keeps half its lexical weight
    // and a 2-of-2 match keeps all of it. Only bites multi-term queries (single
    // term ⇒ factor 1, a no-op). Unlike hard AND it never zeroes a partial match,
    // so recall is intact (hard AND wiped ALL lexical signal for 19% of relevant
    // notes on the 482-q eval and LOST nDCG; coverage was +0.005, monotone ≥ OR
    // at every alpha — ~/seek-personal-eval/and_coverage_eval.py, 2026-06-09).
    // Applied per-search (no reindex).
    bm25Coverage: boolean;

    // (blendMode + rrfK deleted 2026-06-11: the opt-in RRF fusion is gone —
    // linear TM2C2 is the only blend. Stale persisted keys are inert.)

    // Whether incremental indexing + full reindex honor Obsidian's "Excluded
    // files" setting (metadataCache.isUserIgnored). On (default) a note in an
    // ignored folder — e.g. Archive — is treated as out-of-index: moving a note
    // INTO it is a soft-delete (its chunks are dropped), moving OUT re-indexes it.
    // Off indexes ignored folders too. Independent of EXCLUDED_PREFIXES, which
    // always excludes Seek's own machine output regardless of this flag. A change
    // (toggle, Obsidian's Excluded files, or additional folders) arms catch-up
    // immediately so newly included notes are backfilled and newly excluded notes
    // are soft-deleted — no manual reindex.
    honorIgnoredFolders: boolean;

    // Folder paths (vault-relative) Seek always excludes from indexing, in
    // addition to Obsidian's Excluded files when honorIgnoredFolders is on.
    // Always applied when non-empty (independent of honorIgnoredFolders).
    // Prefix match: the folder itself and anything under it. Add/remove triggers
    // the same exclusion-change backfill / soft-delete as Obsidian's list.
    customExcludedFolders: string[];

    // Whether `.base` files (Obsidian Bases — saved query/view definitions) are
    // indexed alongside markdown notes. ON (default) collects every `.base` file
    // and feeds it through extractBaseDocs → chunkBase → a base-level chunk plus
    // one per non-generic view, so a Base (and the right VIEW) surfaces in search
    // like any note section. OFF restricts the index to `.md`
    // only. Applied at index time: collection (search.ts indexableFiles) and the
    // create/rename/delete watcher (main.ts isIndexableFile) both gate on it, so
    // a change takes effect on the next reindex/delta — toggling OFF drops
    // already-indexed Bases on the next sweep, not retroactively.
    indexBases: boolean;

    // Desktop catch-up: max notes indexed per background burst. Mobile uses a
    // fixed cap (see catchup.ts). Read live on each drain — no reload required.
    catchUpBurstMaxFiles: number;

    // Per-result score line in the search modal. ON shows each result's
    // "Matching %" (the calibrated match strength) plus its recency and
    // title-boost bonuses. Requires a CALIBRATED corpus: the line is hidden — and
    // the "Display scores" settings toggle disabled — until the vault has at least
    // MATCH_STRENGTH_MIN_NOTES notes AND a full-corpus pass has produced dense
    // background stats (without which match strength is null). Pure presentation;
    // applies to the next time the search modal opens.
    showScores: boolean;

    // Diagnostic-only knob (no settings UI; set via data.json or an `obsidian eval`
    // settings inject). When false — the default — each search row persists only the
    // top-10 ranking trace the report actually renders; when true it keeps the full
    // 50-deep tail for offline pandas/eval. Bounds the size of the append-only log.
    verboseTrace: boolean;

    // Replace note paths, note titles, and query text in the generated diagnostic
    // report with salted tokens (see redact.ts). ON by default: the report exists
    // to be pasted into a public GitHub issue, and the safe default for a file
    // whose purpose is to be shared is the one that doesn't disclose a user's
    // folder tree. Correlation survives redaction, so the diagnostics that matter
    // for crashes, stalls, and indexing all still read; turn it OFF when
    // investigating a RELEVANCE problem, where the actual query and the notes it
    // matched are the evidence.
    redactReport: boolean;

    // Search-modal footer affordance. ON (default) shows the keyboard-hint bar
    // along the bottom of the modal (↑↓ navigate results · ↵ open · ⌘↵ open in
    // new tab · ⌘⌥↵ open in split pane · ⌥↵ insert link · tab fill autosuggest ·
    // esc close). OFF removes the whole footer for a minimal "full results only"
    // modal — just the query field and results. Pure presentation; applies to the
    // next time the search modal opens.
    showHotkeyHints: boolean;

    // Search progression stages indicator in modal footer. ON: show the 3-stage
    // progression (Name match → Lexical BM25 → Hybrid semantic) in the search
    // modal footer bar. OFF (default): hide the stage indicator.
    showSearchStages: boolean;

    // Keep the search modal open after opening a result in a new tab, split, or
    // window (fan-out). OFF (default): dismiss after any open, like Quick Switcher.
    // ON: open the leaf with active:false and refocus the query field so more
    // results can be opened. Plain Enter/click always dismisses. See
    // shouldKeepModalOpen in open-target.ts / openResult in search-modal.ts.
    keepSearchOpenOnTabSplit: boolean;

    // Insert-link subpath from section hits (Alt+Enter / Alt+Shift+Enter / seek:insert-link).
    // ON: include #heading for section results ([[Note#Section|…]]). OFF (default): link to the
    // note only ([[Note|…]]). See insert-link.ts resolveInsertLinkSubpath.
    insertLinkIncludeHeading: boolean;

    // Search-result alias display. ON (default): show frontmatter aliases on each
    // result row's meta line, with optional truncation (resultAliasLimit). OFF:
    // created + tags only. See result-aliases.ts / search-modal applyRow.
    showResultAliases: boolean;

    // Max aliases shown per result row before a "+N more" control. 0 = show all
    // (no truncation). Default 3. Ignored when showResultAliases is OFF.
    resultAliasLimit: number;

    // Default snippet preview per result row (lines + surrounding-text window).
    // Ctrl/Cmd+Shift+E toggles the expanded preset while the modal is open.
    // Applied on next modal open — see snippet.ts.
    snippetPreview: SnippetPreview;

    // Search modal width on desktop/tablet (phones keep full-width). Applied on
    // next open via CSS vars — see search-modal-size.ts.
    searchModalWidth: SearchModalWidth;

    // Search modal height on desktop (mobile/tablet use keyboard-aware sizing).
    // Applied on next open via CSS vars — see search-modal-size.ts.
    searchModalHeight: SearchModalHeight;

    // Upstream alt-open destination (tab/split/window). Kept in the schema for
    // synced data.json compatibility; this fork uses modifier-based OpenTarget
    // (⌘/Ctrl+Enter = tab, ⌘/Ctrl+Alt+Enter = split) instead of a setting.
    altOpenLocation: AltOpenLocation;

    // NOTE: the compute backend (WebGPU vs WASM) is deliberately NOT a setting.
    // It is a property of the DEVICE, not the vault, and data.json syncs across
    // devices (iCloud / Obsidian Sync) — a toggle here would be shared, so the
    // iPad's WebGPU choice would leak onto the iPhone on the next sync. The
    // choice lives in per-device localStorage instead (origin-scoped, never
    // synced); see platform.ts resolveDevice / getBackendOverride. The old
    // `experimentalMobileWebgpu` boolean was removed 2026-06-12 for this reason
    // — a stale value persisted in data.json is now an ignored extra key.
    // Same rule for startup cache warm (see platform.ts getStartupWarm): it is a
    // per-device app-open cost, not a vault preference, so it is not a field here.

    // Persist the vector index to vault files (`<pluginDir>/index/` or vault-root
    // Seek Index/) so it survives iOS IndexedDB eviction and flows between devices
    // via iCloud / Obsidian Sync, which carry vault files but never a WebView's IDB.
    // Desktop writes a per-device sidecar that an evicted/fresh mobile device hydrates
    // WITHOUT re-embedding (re-chunk locally + copy the saved vectors). Live search
    // always uses this device's IndexedDB; this flag only controls vault sidecar
    // write/hydrate. ON by default (Settings → Index advanced → Sync index across
    // devices). OFF = this device only. Seeds on the next reindex when turned on.
    // Writes ~MBs of synced index files. See sidecar.ts / sidecar-sync.ts. Obsidian
    // Sync users must also enable "Installed plugins / sync plugin files"; iCloud
    // carries it free.
    sidecarEnabled: boolean;

    // Where the sidecar index folder lives. 'config' (default) = the LITERAL
    // '.obsidian/plugins/seek/index' — hardcoded to the default config-folder
    // name, NOT the device's active Override Config Folder (vault.configDir).
    // The CRITICAL config-folder bug was that the path resolved against the
    // active override, which is per-device and never synced: a split-config
    // setup (desktop '.obsidian' + phone '.obsidian-mobile') made producer and
    // consumer read different paths → silent zero results. The literal path is
    // identical on every device, so iCloud/Syncthing/Dropbox carry it even
    // under split config, and Obsidian Sync's "sync plugin files" carries it
    // under uniform config. 'visible' = a vault-root 'Seek Index/' folder — the
    // one location that survives Obsidian Sync + a *renamed* config folder
    // (the renamed-config device never receives '.obsidian/' over Sync), at the
    // cost of showing in the file-explorer pane. See the Sidecar Integration
    // Plan §config-folder CRITICAL. Per-device-relevant but kept in synced
    // data.json so the choice is explicit; the steer-notice only fires on the
    // device whose config is actually renamed.
    sidecarIndexLocation: SidecarIndexLocation;

    // Settings-schema revision, persisted in data.json so onload can run
    // one-time migrations. Rev 2 = the 2026-06-09 bound-norm switch: persisted
    // pre-bound denseWeight values (0.90/0.92, empirical-max scale) are on a
    // DIFFERENT scale than the bound-norm default (0.80) and must not carry
    // over — see the migration in main.ts onload. Rev 3 = sidecarEnabled added
    // (defaults to false on existing installs; no behavior change on upgrade).
    // Rev 4 = sidecarIndexLocation added + sidecar path pinned to the literal
    // '.obsidian'; the migration moves any index sitting under a non-'.obsidian'
    // active-override dir into the literal path (see main.ts onload).
    // A data.json without the key is treated as rev 1 (pre-bound).
    settingsRev: number;

    // Debug-only model override (testing arbitrary HF repos before promoting one
    // into model-registry.ts). Both optional + absent by default, so no migration
    // / settingsRev bump is needed (Object.assign backfills them as undefined).
    // When modelRepoOverride is set, activeModelSpec() loads that repo instead of
    // the shipped default; the override repo becomes the index drift-identity, so
    // switching it routes to a full reindex exactly like a real model swap.
    modelRepoOverride?: string;
    modelRevisionOverride?: string;
}

// Vault-global definition of "recent" — see SeekSettings.recencyKey above and
// fusion.ts recencyDate (the single accessor all recency consumers read through).
export type RecencyKeyChoice = 'created' | 'modified';

// Alt-open destination (⌘/Ctrl+Enter / ⌘/Ctrl+click) — see
// SeekSettings.altOpenLocation. Values mirror workspace.getLeaf()'s PaneType.
export type AltOpenLocation = 'tab' | 'split' | 'window';

// Sidecar index folder placement — see SeekSettings.sidecarIndexLocation.
// 'config'  = hidden literal '.obsidian/plugins/seek/index' (default; covers
//             iCloud/Syncthing at any config naming + Obsidian Sync uniform config)
// 'visible' = vault-root 'Seek Index/' (the Obsidian-Sync-renamed-config carve-out)
export type SidecarIndexLocation = 'config' | 'visible';

// Search modal dimension presets — see SeekSettings.searchModalWidth/Height.
export type SearchModalWidth = 'default' | 'wide' | 'extra-wide';
export type SearchModalHeight = 'default' | 'tall' | 'extra-tall';
export type SnippetPreview = 'compact' | 'standard' | 'expanded';

export const DEFAULT_SETTINGS: SeekSettings = {
    denseWeight: 0.85,         // BOUND-NORM scale dense weight; mirrors DEFAULT_RANKING_CONFIG.alpha. Raised 0.80→0.85 (2026-06-27 re-eval): de-franken made BM25 more assertive, so a fixed α=0.80 over-weighted lexical; 0.85 is a cross-corpus win (Example Vault flat-to-+, BEIR +0.01–0.02). Migrated via rev 8. (NOT the 0.92 empirical-max point)
    navTitleBoost: 0.5,        // Title-bonus "Default" stage (segmented 0=Off / 0.5=Default / 0.8=High); softened from the 0.8 swept knee per the 2026-06-19 settings ratification — see field comment
    recencyKey: 'modified',    // global definition of "recent" (ε-tiebreaker + recency arm + browse sort + before:/after:); mtime is the only universally-present date → the generic default; 'created' (a frontmatter date prop, see createdProp) is an opt-in for true creation-recency
    createdProp: 'created',    // frontmatter property holding the creation date (vault convention; falls back to filename date, then mtime)
    recencyEpsilon: 0,         // ships Off (Recency segmented Off=ε0 / Default=ε0.04·180d / High=ε0.1·90d); was a 0.02 tiebreaker pre-2026-06-19 ratification — additive ε in final = hybrid + ε·recency + titleBoost (see field comment)
    recencyHalfLifeDays: 180,  // recency decay HALF-LIFE in days (0.5^(daysOld/HL)); 180 = 06-04 operating point. Do NOT shorten to 7–30: it hijacks flat no-opinion pools (see the field comment above — that advice was measured wrong and reversed 2026-07-16). The Recency High stage is the supported lean, at 90.
    fuzzyEnabled: true,        // typo tolerance ON by default (edit dist scales by term length, ≤3 exact; see bm25.ts FUZZY_BY_LENGTH); +3–4/40 gold@1 on typo'd entity queries, ns cost on clean
    prefixLastToken: true,     // last-token prefix expansion ON by default; +0.0064 personal nDCG, stress sets clean; see field comment
    synonymExpansion: true,    // ON (hidden) per the 2026-06-19 ratification; alias-dictionary query expansion (Lr↔Lightroom); BM25-dict refit, no reindex — see field comment
    searchableProperties: true, // frontmatter values as a BM25 field; ON as of 2026-06-25 — My-Vault channel eval measured +0.05 nDCG@10 (place-note recall: austin 22→3, zurich 33→7; combo_eval). Migrated on via rev 7; see field comment
    headingsField: true,       // ON (hidden) per the 2026-06-19 ratification; heading path as a BM25 field; BM25 refit, no reindex — see field comment
    boostedBm25: false,        // "Boosted BM25" preset (aliases 9 / tags 2 / headings 4); OFF — superseded by bm25FieldBoostOverrides when set; see field comment
    // bm25FieldBoostOverrides omitted — absent ⇒ DEFAULT_FIELD_BOOSTS (bm25-boosts.ts)
    bm25Coverage: true,        // soft-AND: scale BM25 by matched-query-term fraction (multi-term only); see field comment
    honorIgnoredFolders: true, // Archive et al. are soft-deletes by default
    customExcludedFolders: [], // additional Seek-only folder excludes (additive with Obsidian's list)
    indexBases: true,          // ON: index .base files (Obsidian Bases) as synthetic docs; preserves the feature's unconditional pre-toggle behavior
    catchUpBurstMaxFiles: 30,  // desktop catch-up burst cap; clamped 1–40 in startup-drain.ts
    showScores: false,         // OFF by default: per-result score line (Matching % · recency · title); opt-in via Display settings. (Also auto-hidden until the corpus is calibrated — ≥200 notes + full pass.) Default-only flip, no migration: installs that already persisted showScores keep their choice.
    verboseTrace: false,       // OFF: persist only the top-10 ranking trace per search (what the report shows); ON = full 50-deep tail for offline eval. Diagnostic-only, no UI
    redactReport: true,        // ON: salted tokens for paths/titles/queries in the generated report — the share-safe default for a file made to be pasted into a public issue; see field comment
    showHotkeyHints: true,     // ON: footer keyboard-hint bar, query-bar Tab hint, result keycaps; OFF = full-results-only modal
    showSearchStages: false,   // OFF by default: show the 3-stage progression (Name match → Lexical BM25 → Hybrid semantic) in the modal footer bar; opt-in via Display settings
    keepSearchOpenOnTabSplit: false, // OFF: dismiss after tab/split/window open (Quick Switcher-like); ON: fan-out keep modal focused
    insertLinkIncludeHeading: false, // OFF (default): note-only links; ON adds #heading for section hits
    showResultAliases: true,   // ON: show frontmatter aliases on result rows (truncated per resultAliasLimit)
    resultAliasLimit: 3,       // max aliases before "+N more"; 0 = show all
    snippetPreview: 'compact', // 1-line / 200-char window; standard=3/400, expanded=6/800
    searchModalWidth: 'default',   // desktop/tablet modal width preset
    searchModalHeight: 'default',  // desktop modal height preset
    altOpenLocation: 'tab',    // schema compat with upstream; fork open UX uses OpenTarget modifiers
    sidecarEnabled: true,      // ON by default; user-facing under Index advanced → Sync index across devices; vault-file index for iOS-eviction survival + Sync hydrate; OFF = this device only — see field comment
    sidecarIndexLocation: 'config', // hidden literal '.obsidian/plugins/seek/index'; 'visible' = vault-root 'Seek Index/' for split-config Obsidian Sync; see field comment
    settingsRev: 9,            // current schema rev; bump alongside a migration in main.ts onload (rev 9 = 2026-07-16 Recency High half-life 270→90)
};

// One-time settings migrations, keyed on the persisted settingsRev. Applied to the
// raw data.json object BEFORE it is merged over DEFAULT_SETTINGS in main.ts onload —
// without this, Object.assign(settings, DEFAULT_SETTINGS, raw) lets a stale persisted
// key silently win over a new default on every existing install. Mutates and returns
// `raw`; pure + exported so it is unit-testable without booting the plugin.
//
// (The rev-4 sidecar FILE move is NOT here — it does disk I/O and needs the plugin's
// resolved paths, so it stays in onload, gated on a `migrateSidecarPath` flag captured
// from the original settingsRev before this runs.)
export function migrateSettings(raw: Partial<SeekSettings>): Partial<SeekSettings> {
    const fromRev = raw.settingsRev ?? 1; // a data.json without the key is pre-bound (rev 1)
    // Rev 2 (2026-06-09 bound-norm switch): a denseWeight persisted on the old
    // empirical-max scale (0.90/0.92) is mis-calibrated under the theoretical-bound
    // normalization (the optimum moved to 0.80). Drop the key so the rev-2 default
    // takes over; a user who re-tunes afterwards persists a rev-2 value that survives.
    if (raw.denseWeight !== undefined && fromRev < 2) delete raw.denseWeight;
    // Rev 5 (2026-06-19 settings-redesign ratification): several validated-OFF debug
    // toggles become silent ON-defaults, navTitleBoost softens 0.8→0.5, and recency
    // ships fully Off (ε 0.02→0). The booleans flip UNCONDITIONALLY — their UI toggles
    // are removed, so the new baseline is for everyone. The two numeric defaults move
    // ONLY a user still on the exact old default, preserving any hand-tuned value.
    // CRITICAL for navTitleBoost: a persisted 0.8 (the old default) would otherwise
    // read as the new "High" segmented stage and silently promote every upgrader.
    if (fromRev < 5) {
        raw.synonymExpansion = true;
        raw.headingsField = true;
        raw.sidecarEnabled = true;
        if (raw.navTitleBoost === undefined || raw.navTitleBoost === 0.8) raw.navTitleBoost = 0.5;
        if (raw.recencyEpsilon === undefined || raw.recencyEpsilon === 0.02) raw.recencyEpsilon = 0;
    }
    // Rev 6 (2026-06-21 results-UI polish): the debug toggle `debugMode` was renamed
    // `showScores` (it now gates the calibrated "Matching %" line). Carry the user's
    // explicit choice across the rename — WITHOUT this, an upgrader who turned the old
    // per-row score line OFF would silently get it back ON (showScores falls through to
    // its `true` default, since the persisted `debugMode` key is an orphan Object.assign
    // ignores). Read the old key only when showScores wasn't already persisted, then drop
    // the orphan. Note: current installs sit at rev 5, so this MUST be a rev-6 bump — a
    // `fromRev < 5` gate would never fire for them.
    if (fromRev < 6) {
        const legacy = raw as { debugMode?: boolean };
        if (raw.showScores === undefined && legacy.debugMode !== undefined) raw.showScores = legacy.debugMode;
        delete legacy.debugMode;
    }
    // Rev 7 (2026-06-25 searchableProperties default ON): the BM25 frontmatter-values
    // field flips OFF→ON after the My-Vault channel eval measured +0.05 nDCG@10 (place-
    // note recall). Installs created under the old default persisted `false`, so a bare
    // DEFAULT_SETTINGS flip would be a silent no-op on them — migrate them. The toggle
    // still exists, so move only an install still on the old default; a deliberate post-
    // rev-7 `false` is indistinguishable from the default here (true was never persistable
    // before), which is acceptable — the new baseline is ON for everyone pre-rev-7. Refit-
    // only (search.ts bm25CacheProps mismatch → BM25 cache rebuild on next search), NO
    // embedding reindex: chunks already store metadata.properties.
    if (fromRev < 7 && (raw.searchableProperties === undefined || raw.searchableProperties === false)) {
        raw.searchableProperties = true;
    }
    // Rev 8 (2026-06-27 field-weight re-eval): denseWeight default moves 0.80 → 0.85.
    // The de-franken BM25 (more assertive lexical) made a fixed α=0.80 over-weight the
    // lexical channel; the cross-corpus re-sweep (Example Vault + enriched BEIR) put the knee
    // at ~0.85. Move ONLY an install still on the exact old default 0.80 — a hand-tuned
    // value survives, and an undefined falls through to the new DEFAULT_SETTINGS (0.85),
    // so a pre-bound install whose 0.92 the rev-2 surgery already dropped lands on 0.85
    // too. Score-time only: no reindex/refit (the dense weight is applied at fusion).
    if (fromRev < 8 && raw.denseWeight === 0.80) raw.denseWeight = 0.85;
    // Rev 9 (2026-07-16 High half-life fix): the Recency "High" stage's half-life moves
    // 270 → 90. High LENGTHENED the decay past Default's 180, which made it inert at the
    // episodic-browse case it exists for (measured: newest dated sibling at rank 9 of its
    // own series; rank 3 at 90). The stage is a value map in settings-tab.ts, so the fix
    // only reaches an existing High user through their PERSISTED value — recencyStageOf()
    // snaps the segmented pill on ε alone, so ε=0.1 keeps rendering as "High" while the
    // stale 270 silently keeps ranking. Without this they'd have to re-pick High to get it.
    // Gate on the exact 270: settings-tab.ts is the only site that persists this key and
    // only the High stage ever wrote 270 (Off/Default and DEFAULT_SETTINGS are all 180),
    // so this is a precise "picked High" signature, not a default-collision. A value hand-
    // tuned to exactly 270 under an older build that exposed the raw knob is indistinguish-
    // able and gets moved — same accepted trade as rev 7. Score-time only: no reindex, no
    // BM25 refit (the half-life is applied at fusion).
    if (fromRev < 9 && raw.recencyHalfLifeDays === 270) raw.recencyHalfLifeDays = 90;
    // Never DOWNGRADE the stamp: a data.json synced from a device running a newer
    // Seek (rev 10+) must keep its rev, or this older build stamps it back to 9 and
    // the newer device re-runs its migrations on next load (conditional default
    // moves misfire on second application).
    raw.settingsRev = Math.max(fromRev, 9);
    return raw;
}

// Vault size below which match-strength scores aren't meaningful (too few notes to
// calibrate the dense-cosine background). Both the settings Display chips toggle and
// the search-modal score read gate on this, so it lives here as one source of truth.
export const MATCH_STRENGTH_MIN_NOTES = 200;

export interface ScoredChunk extends Chunk {
    score: number;
    ranking_signals: {
        dense: number;
        bm25: number;
        hybrid: number;
        recency: number;
        title_boost: number;
        // Raw cosine similarity (query · chunk), BEFORE the lexical-only floor and
        // the per-query min-max that produce `dense`. This is the ABSOLUTE dense
        // match quality — instrumentation for the fusion confidence gate: `dense`
        // (normalized) always crowns a winner at 1.00 even for an OOV/ID query
        // where the best real cosine is weak, so the raw value is what tells us
        // "did the dense channel actually find anything." Logged in captures +
        // search telemetry so the gate's LO/HI thresholds can be set from real
        // numbers per embedding model rather than guessed.
        denseRaw: number;
        // Display-only confidence in [0,1]: denseRaw expressed relative to the
        // corpus dense-cosine background (dense-stats.ts calibratedConfidence).
        // Present only when the index carries bg stats (a full reindex on the
        // 2026-06-16+ build); never a ranking input. Rendered in the debug line.
        confidence?: number;
    };
    snippet?: string;
}

// Memory helpers and the NDJSON log schema live in dedicated modules;
// re-exported here so existing `./types` imports keep working.
export * from './memory';
export * from './log';
