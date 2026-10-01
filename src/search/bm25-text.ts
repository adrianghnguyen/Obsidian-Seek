// BM25 analysis layer: the stateless text pipeline that decides what tokens
// land in the index and how query terms are matched — stopword handling,
// plural/diacritic normalization, and per-field text extraction. Extracted
// from bm25.ts; the MiniSearch wrapper (MultiFieldBM25) stays there.
// NOTE: esbuild hashes bm25.ts + tokenize.ts + prop-normalize.ts for the
// persisted-index stamp — splitting these functions out leaves those bytes
// (and the stamp) unchanged.

import type { ChunkMeta } from '../index/chunker';
import { seekTokenize, hasCjk } from './tokenize';
import { toDisplayForm } from './prop-normalize';

// Lucene/Elasticsearch default English stoplist (the 33-word `_english_` set).
// Matched deliberately: it's the analyzer lineage of the Anserini BM25 baseline
// the BEIR study compared against (see [[Seek notes]] Relevance, 2026-06-03 —
// Seek's lexical channel scored ~0.23-0.29 nDCG@10 on CQADupstack vs Anserini's
// ~0.38, the gap being the missing English analyzer). IDF already discounts these
// terms, so the win is modest and mostly removes match noise (stemming would be
// the larger lever); the bigger relevance lever is raising the dense fusion
// weight, tracked separately.
export const ENGLISH_STOPWORDS = new Set<string>([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'if', 'in',
    'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the',
    'their', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'will', 'with',
]);

// Exception tables for depluralize (audit 2026-06-09 §5). These are the kStem
// PRINCIPLE — only emit a stem that is a real word — applied at the scale of a
// plural-only normalizer instead of bundling a 30k-word lexicon. Each table
// fixes one verified bug class where the singular and plural landed on
// DIFFERENT stems (silent never-co-match), or a reduction collided with a
// proper name (alias->alia "Alia", lens->len "Len").
//
// A Map, NOT an object literal: keys are raw user tokens, and an object lookup
// would resolve tokens like "constructor" to Object.prototype members.
const IRREGULAR_PLURALS = new Map<string, string>([
    // Greek/Latin -is plurals: the -ses rule gave analyses->analys while the
    // -is exclusion (correctly) kept analysis intact — two different stems.
    ['analyses', 'analysis'],
    ['theses', 'thesis'],          // -ses rule gave "these", a stopword: indexed docs lost the term entirely
    ['crises', 'crisis'],
    ['diagnoses', 'diagnosis'],    // noun reading chosen over verb ("she diagnoses"); notes skew noun
    ['prognoses', 'prognosis'],
    ['hypotheses', 'hypothesis'],
    ['parentheses', 'parenthesis'],
    ['syntheses', 'synthesis'],
    ['emphases', 'emphasis'],
    ['oases', 'oasis'],
    ['neuroses', 'neurosis'],
    ['psychoses', 'psychosis'],
    // "axes"/"bases" are deliberately ABSENT: axe/axis and base/basis are both
    // live; either mapping breaks the other word, so they keep the old
    // (symmetric, self-consistent) behavior.
    ['lenses', 'lens'],            // -ses rule gave "lense"; singular guard below keeps lens (vs name "Len")
]);

// s-final singulars the generic -s rule must not strip. Their plurals already
// reduce correctly via the -ses rule (aliases->alias, biases->bias), so guarding
// the singular side restores co-match AND removes the name collisions in one
// move. We can't just add "-as" to the suffix exclusions — that would stop
// bananas/ideas/sofas from reducing.
const S_FINAL_SINGULARS = new Set<string>([
    'alias', 'bias', 'atlas', 'canvas', 'lens',
    'news', // no plural; stripping gave "new", a high-frequency cross-word collision
]);

// -ie nouns whose plural the -ies rule mangled (movies->movy vs movie). If the
// word minus its final "s" is here, strip only the "s".
const IE_NOUNS = new Set<string>([
    'movie', 'cookie', 'zombie', 'calorie', 'genie', 'pixie', 'sortie',
    'selfie', 'smoothie', 'hoodie', 'newbie', 'rookie', 'goalie', 'veggie',
    'birdie', 'foodie', 'freebie', 'indie', 'junkie', 'oldie', 'quickie',
    'talkie', 'townie', 'yuppie',
]);

// Light plural -> singular normalizer, applied symmetrically at index AND query
// time (inside processTerm) so "cuisines" matches "cuisine", "cars" matches "car".
// Deliberately NOT a full stemmer: Porter2 was tested and rejected on CQADupstack
// (net -0.0019), but this plural-only normalizer scored +0.0276 nDCG@10 on the
// DBpedia BM25 channel (2026-06-07 study). The rule set is intentionally simple;
// because it runs on both sides, even an imperfect stem (e.g. "series"->"sery")
// still matches itself. The exception tables above handle the verified cases
// where symmetry was NOT enough — singular and plural reducing to different
// stems — plus the proper-name collisions (audit 2026-06-09 §5).
export function depluralize(w: string): string {
    if (w.length <= 3) return w;
    const irregular = IRREGULAR_PLURALS.get(w);
    if (irregular !== undefined) return irregular;
    if (S_FINAL_SINGULARS.has(w)) return w;
    if (w.endsWith('ies') && w.length > 4) {
        const ie = w.slice(0, -1);                                            // movies -> movie
        if (IE_NOUNS.has(ie)) return ie;
        return w.slice(0, -3) + 'y';                                          // countries -> country
    }
    if (w.endsWith('sses')) return w.slice(0, -2);                            // classes -> class
    if ((w.endsWith('ches') || w.endsWith('shes') || w.endsWith('xes')
        || w.endsWith('zes') || w.endsWith('ses')) && w.length > 4) {
        return w.slice(0, -2);                                                // boxes->box, dishes->dish, aliases->alias
    }
    if (w.endsWith('s') && w.length > 3
        && !(w.endsWith('ss') || w.endsWith('us') || w.endsWith('is') || w.endsWith('os'))) {
        return w.slice(0, -1);                                                // cars -> car
    }
    return w;
}

// S2 per-field stopword exemption (Three-Lens S2, 2026-06-10): title and
// aliases are NAME fields — "Will", "The Saloon", "By Yu" are identifiers, not
// function words. Dropping stopwords there killed the 10×-boosted title
// channel for exactly the highest-frequency query class in a People-page
// vault (person lookup). MiniSearch passes the field name as processTerm's
// 2nd argument AT INDEX TIME (verified in dist v7.2.0: `processTerm(term,
// field)` in addDocument), so exempting these fields keeps their stopword
// terms indexed. Content/tags keep the stoplist — prose stopwords are still
// noise.
const STOPWORD_EXEMPT_FIELDS = new Set(['title', 'aliases']);

// Latin diacritic fold (audit 2026-06-18 §4): decompose to NFD and strip the
// combining marks (\p{M}) so "café"/"josé"/"zürich"/"naïve"/"pokémon"/"andrés"
// co-match their unaccented spellings — the single clearest miss for non-English
// names/loanwords, which every Seek eval corpus under-samples (so it scores
// ~0.000 on the ASCII harness and only helps the real population). Called INSIDE
// processTerm, so it is symmetric across index and query like the stoplist and
// depluralizer. GUARDED on !hasCjk: NFD DECOMPOSES precomposed Hangul into
// conjoining jamo (mangles the match key) and splits a precomposed dakuten kana
// (ガ U+30AC → カ + U+3099, so stripping the mark turns GA into KA — a different
// word); the CJK channel owns its own term space (tokenize.ts) and must never be
// folded. Marks-ONLY: stroke/bar letters (ł, ø, đ, ħ) have no canonical
// decomposition and pass through unchanged — the same miss as today, not a
// regression. Pure-ASCII-inert (NFD is a no-op on ASCII and \p{M} matches
// nothing), so every English eval term is byte-identical, and idempotent.
export function foldDiacritics(t: string): string {
    if (hasCjk(t)) return t;
    return t.normalize('NFD').replace(/\p{M}+/gu, '');
}

// MiniSearch's `processTerm` runs at BOTH index and query time, so the stoplist
// (and now the depluralizer) stay symmetric across the two with no chance of drift.
// It replaces MiniSearch's default processor (which only lowercases), so we lowercase
// here too. Stopwords are matched on the raw lowercased term BEFORE depluralization
// (mirrors the eval). Returning null drops the term from both index and query.
//
// At QUERY time MiniSearch calls this with no fieldName → stopwords drop from
// queries by default; the all-stopword fallback (keepStopwordsProcessTerm,
// applied per-call in getScoresWithCoverage) is the query-side complement —
// without it the exempt index terms would be unreachable ("will" indexed but
// never queried).
export function processTerm(term: string, fieldName?: string): string | null {
    // Fold right after lowercase — BEFORE the stopword check (so an accented
    // stopword spelling like "às"/"öf" drops consistently on both sides) and
    // BEFORE depluralize (so the exception tables only ever see ASCII).
    const t = foldDiacritics(term.toLowerCase());
    if (ENGLISH_STOPWORDS.has(t)
        && !(fieldName !== undefined && STOPWORD_EXEMPT_FIELDS.has(fieldName))) {
        return null;
    }
    return depluralize(t);
}

// Query-side term processing, exported for synonyms.ts: a synonym class
// member must land in the SAME term space queries are matched in (lowercase,
// stoplist, depluralize), or trigger lookups would silently never fire.
// Stopword members drop (no field exemption): conservative — never inject a
// stopword as a mate, even though title/aliases index them (S2).
export function processQueryTerm(term: string): string | null {
    return processTerm(term);
}

// Query-side fallback processor: stoplist OFF (lowercase + depluralize only).
// Used when the WHOLE query is stopwords — mirrors fusion.ts titleMatchBoost's
// all-stopword fallback, so the two channels agree on when a stopword is a
// name. A query with ≥1 content word keeps the shipped drop behavior
// unchanged (zero effect on existing prose queries).
export function keepStopwordsProcessTerm(term: string): string {
    // MUST fold too (audit §4): the index is ALWAYS built via processTerm (which
    // folds), so an all-stopword query routed through this fallback would query a
    // different term space than the index unless it folds identically.
    return depluralize(foldDiacritics(term.toLowerCase()));
}

// Tokenization is the shared seekTokenize (tokenize.ts): MiniSearch's default
// space/punct split + CJK dictionary segmentation. It is passed to MiniSearch
// as the `tokenize` option in fit() AND used to enumerate the DISTINCT
// processed query terms feeding the coverage denominator — the actual matching
// is still done by MiniSearch, through the same function, so they cannot
// drift. NOTE (corrected 2026-06-09 review): under the theoretical BOUND
// normalization the denominator does NOT cancel — that was only true of
// the old per-query max-division, where a constant-across-docs factor washed
// out. Dividing by the bound is dividing by a query-level constant the coverage
// factor is NOT part of, so 1/totalTerms scales the whole lexical channel
// against dense. Faithfulness to the indexed split IS load-bearing.

export function distinctQueryTerms(query: string): Set<string> {
    const out = new Set<string>();
    for (const raw of seekTokenize(query)) {
        const t = processTerm(raw);
        if (t) out.add(t);
    }
    if (out.size > 0) return out;
    // All-stopword fallback (S2): keep the literal terms so the coverage
    // denominator matches what the fallback search actually queries.
    for (const raw of seekTokenize(query)) {
        out.add(keepStopwordsProcessTerm(raw));
    }
    return out;
}

// True when drop-mode processing leaves NOTHING of a non-empty query — the
// trigger for the all-stopword fallback across search, coverage, and bound.
export function isAllStopwordQuery(query: string): boolean {
    let sawToken = false;
    for (const raw of seekTokenize(query)) {
        sawToken = true;
        if (processTerm(raw) !== null) return false;
    }
    return sawToken;
}

export function extractNoteName(chunk: ChunkMeta): string {
    let t = chunk.title;
    if (t.includes(' > ')) t = t.split(' > ')[0];
    if (t.includes(' | ')) t = t.split(' | ')[0];
    return t.trim();
}

export function extractAliasesText(chunk: ChunkMeta): string {
    const aliases = chunk.metadata?.aliases;
    if (Array.isArray(aliases) && aliases.length > 0) return aliases.join(' ');
    let t = chunk.title;
    if (t.includes(' > ')) t = t.split(' > ')[0];
    const parts = t.split(' | ');
    return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

export function extractTagsText(chunk: ChunkMeta): string {
    const tags = chunk.metadata?.tags;
    if (Array.isArray(tags)) return tags.join(' ');
    return '';
}

// Section heading path -> plain text for the `headings` field. The WS3
// chunker is the only writer of heading_path, so this is the full ancestor
// chain ("H1 H2 H3"), per chunk — the lexical mirror of what embedInput's
// hierarchical title already gives the dense channel. Without this field,
// heading words are BM25-invisible: extractNoteName strips the path from
// `title` and the chunker excludes the heading line from section content.
// (?? [] guards chunks indexed before heading_path existed.)
export function extractHeadingsText(chunk: ChunkMeta): string {
    return (chunk.heading_path ?? []).join(' ');
}

// Pure machinery frontmatter keys — identity/UI/plumbing whose VALUES are junk
// for ANY semantic surface. Exported and SHARED with chunker's buildDenseSuffix
// so the two "leftover" surfaces (this properties field + the dense suffix) can
// never drift on what counts as machinery. Relevance Quality Audit 2026-06-29
// finding #2: text-valued keys like `icon`/`cssclasses` had been leaking into
// the dense suffix because only THIS field name-excluded them.
export const MACHINERY_KEYS = new Set([
    'icon', 'coordinates', 'cssclasses', 'cssclass', 'protected',
    'version', 'completed', 'completeddate', 'position', 'banner', 'banner_y',
]);

// Keys excluded from the searchable-properties field = machinery (above) PLUS
// keys already carried by a dedicated field (tags/aliases → own fields;
// created/modified/datelink → date filters) so they aren't double-indexed into
// this catch-all. Everything else (placeLoc, placeType, context, status,
// pageType, …) is in — the harness gate measured the generic
// everything-but-machinery posture, not a curated allowlist. `pageType` used to
// be excluded here (it had a dedicated `page_type` field); that field is gone,
// so it now flows through this catch-all by name like any other scalar prop.
// Compared lowercased against every key, scalar or list-valued alike —
// extractPropertiesText below folds a list value's items in per-element (audit
// R2 batch2 #3), so a list-valued key excluded here (e.g. a future dedicated
// field) is excluded the same way a scalar one would be.
const PROPERTY_EXCLUDE_KEYS = new Set([
    'tags', 'aliases', 'alias', 'created', 'modified', 'datelink',
    ...MACHINERY_KEYS,
]);
// Anchored BOTH ends (audit R2 batch2 #1): a bare date or ISO date+time is
// inert (dates are queryable via [key:value] filters, which read the same
// backing store untouched) but a date-PREFIXED value that carries trailing
// free text ("2026-06-29 Milan departure") is not — the old prefix-only test
// (no trailing `$`) matched on the date alone and dropped the whole value,
// silently swallowing "Milan departure" out of the lexical channel.
const PROPERTY_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
const PROPERTY_NUM_RE = /^-?[\d., ]+$/;

// Property VALUES -> plain text for the `properties` field. Not a custom
// analyzer — just a normalizer in front of the standard pipeline (the field's
// terms then run through seekTokenize + processTerm like any other field).
// Wikilinks collapse to their DISPLAY form — the target basename, NOT the
// matcher-style path+alias unwrap ("[[Notes/.../Zurich|Zurich]]" -> "Zurich",
// not the "Notes Personal Places Zurich Zurich" keyword-stuffing that inflated
// a boosted field with folder tokens and doubled names; see [[Seek Index
// Processing Audit]] and toDisplayForm). Date/number-only values are dropped
// (they'd only feed the index junk terms; dates are queryable via [key:value]
// filters, which read the same backing store untouched).
export function extractPropertiesText(chunk: ChunkMeta): string {
    const props = chunk.metadata?.properties;
    if (!props) return '';
    const vals: string[] = [];
    for (const [key, raw] of Object.entries(props)) {
        if (PROPERTY_EXCLUDE_KEYS.has(key.toLowerCase())) continue;
        // List values (stored as string[] since v10 for the FILTER matcher) used
        // to be skipped here entirely, leaving them dense-suffix-only — a
        // relatedPages-style list was BM25-invisible even with a scalar sibling
        // property fully indexed (audit R2 batch2 #3). Folded in per-item through
        // the SAME normalize/type-drop gates as a scalar value, joined with the
        // rest — consistent with how the scalar half of this field is built.
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
            const v = toDisplayForm(String(item).replace(/^["']|["']$/g, ''));
            if (!v || PROPERTY_DATE_RE.test(v) || PROPERTY_NUM_RE.test(v)) continue;
            vals.push(v);
        }
    }
    return vals.join(' ');
}
