// Production model delivery — the content-addressed registry of shippable
// embedding models plus the pure helpers main.ts uses to (a) pick the active
// model (honouring a debug override) and (b) evict a previous model's bytes from
// the transformers.js Cache API on a switch.
//
// WHY a registry. The ~100 MB ONNX model is fetched at runtime by transformers.js
// inside the embed iframe (marketplace plugins ship only main.js/manifest/css, so
// the model can't be bundled). transformers.js streams it from the HF CDN and
// caches it in the browser Cache API ('transformers-cache') — per-device, never
// synced, outside the vault: the Smart Connections pattern, and on iOS the only
// store that can hold 100 MB (requestUrl can't stream that on mobile, and a plugin
// can't write outside the vault sandbox). The registry adds the missing management
// layer: versioning, multi-repo support, and eviction of the old model on a switch.
//
// IDENTITY == repo. embedder.MODEL_ID is derived from the active spec's `repo` and
// remains the index's drift-identity stamp, so pointing ACTIVE_MODEL_KEY at a
// different repo fires the EXISTING reindex machinery (warnOnModelIndexDrift) for
// free — no churn to the drift / sidecar-version-gate code. `revision` is now
// threaded into the transformers.js load (createPipeline/from_pretrained both take
// a `revision` option, verified against tx.js 4.2.0 and still present in 4.3.0) AND into the sidecar version
// gate, so a pinned commit sha makes embeddings reproducible across devices/time
// and refuses cross-revision sidecar hydration (F10). Eviction still matches on
// repo alone (a revision bump's stale bytes are reclaimed by the OS / next switch).

import type { Dtype, SeekSettings } from '../types/types';

// How the feature-extraction pipeline reduces token vectors to one embedding.
// Granite is CLS. EmbeddingGemma 2 is mean (then L2-normalized).
export type EmbeddingPooling = 'cls' | 'mean';

export interface ModelSpec {
    // Stable identity for the index drift-stamp + storage namespacing. For shipped
    // models this equals `repo`, so MODEL_ID === repo === identity and a switch
    // needs no special drift handling.
    key: string;
    // Short label for Settings. The repo id stays the index identity.
    label: string;
    // HF hub id (or a full base URL). The string handed to embedder.load() as the
    // load base on the remote path → transformers.js streams it from the CDN.
    repo: string;
    // Pinned commit sha/tag. Threaded into the transformers.js fetch so a moving
    // `main` cannot mix vector spaces. null = track main.
    revision: string | null;
    // Relative paths transformers.js requests under the repo root. The download
    // probe treats an `.onnx_data` entry (when present) as the weight canary.
    files: string[];
    // Effective stored width. For a Matryoshka model this is the truncated width
    // the user picked; otherwise the model's native width.
    dim: number;
    // Width the ONNX graph emits before Matryoshka truncation. Equals `dim` when
    // the model is not truncatable.
    nativeDim: number;
    // Recommended truncation widths, longest first. null = do not truncate.
    mrlDims: readonly number[] | null;
    dtype: Dtype;
    pooling: EmbeddingPooling;
    // Prepended to queries / indexed note text. Empty for models trained without
    // task instructions (Granite). Applied in the embedder, not as a user toggle:
    // a wrong prefix silently degrades ranking.
    queryPrefix: string;
    documentPrefix: string;
    // When true, the load nulls vision_config and audio_config so transformers.js
    // does not fetch those encoders. Seek indexes note text.
    textOnly: boolean;
    // Approximate weight download, for the settings status line.
    approxDownloadMB: number;
}

// The ml97 GBQ-int4 model shipped today (mirrors the legacy embedder.MODEL_ID
// string exactly, so deriving MODEL_ID from this is a no-op for the index identity).
export const ML97_GBQ4: ModelSpec = {
    key: 'tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX',
    label: 'Granite multilingual',
    repo: 'tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX',
    // Pinned to an immutable commit sha (F10): transformers.js fetches resolve/<sha>
    // and the sidecar gate refuses cross-revision hydration, so two devices can't mix
    // vector spaces if the repo's `main` ever moves. Bump this when shipping a new
    // build (fires model-vs-index drift → full reindex). NOTE: changing it re-fetches
    // the model bytes once — the resolve URL, and thus the Cache-API key, changes.
    revision: '54db88c5667bd79b4aea24ea6027a7ef45a7bbb5',
    files: [
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'special_tokens_map.json',
        'onnx/model_q4.onnx',
    ],
    dim: 384,
    nativeDim: 384,
    mrlDims: null,
    dtype: 'q4',
    pooling: 'cls',
    queryPrefix: '',
    documentPrefix: '',
    textOnly: false,
    approxDownloadMB: 100,
};

// EmbeddingGemma 2 (Oct 2026). Text path is the ONNX community export that
// transformers.js 4.3.1 loads as feature-extraction. Native output is 768-d
// mean-pooled; Matryoshka keeps the leading 512 / 256 / 128 dims (re-normalized
// in the iframe). Vision and audio encoders stay unloaded — Seek embeds notes.
// q4 only: the model card says float16 activations overflow to NaN, and q4f16
// is already off Seek's dtype ladder.
export const EMBEDDINGGEMMA_2: ModelSpec = {
    key: 'onnx-community/embeddinggemma-2-ONNX',
    label: 'EmbeddingGemma 2',
    repo: 'onnx-community/embeddinggemma-2-ONNX',
    revision: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0',
    files: [
        'config.json',
        'tokenizer.json',
        'tokenizer_config.json',
        'onnx/model_q4.onnx',
        'onnx/model_q4.onnx_data',
    ],
    dim: 768,
    nativeDim: 768,
    mrlDims: [768, 512, 256, 128],
    dtype: 'q4',
    pooling: 'mean',
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
    textOnly: true,
    approxDownloadMB: 175,
};

export const MODEL_REGISTRY: Record<string, ModelSpec> = {
    [ML97_GBQ4.key]: ML97_GBQ4,
    [EMBEDDINGGEMMA_2.key]: EMBEDDINGGEMMA_2,
};

// Settings dropdown order. The empty-key default resolves to Granite so an
// older data.json (no embeddingModelKey) stays on the index it already built.
export const EMBEDDING_MODEL_CHOICES: readonly { key: string; label: string }[] = [
    { key: ML97_GBQ4.key, label: `${ML97_GBQ4.label} · 384 dimensions` },
    { key: EMBEDDINGGEMMA_2.key, label: `${EMBEDDINGGEMMA_2.label} · text` },
];

// The model Seek ships with by default. A code-level model switch = point this at
// a different registered key (and add its ModelSpec) — MODEL_ID follows, and the
// existing model-vs-index drift check routes every device to a full reindex.
export const ACTIVE_MODEL_KEY = ML97_GBQ4.key;

// The default active spec (no settings override). embedder.MODEL_ID derives from
// this so the index identity stamp stays a plain module constant.
export const ACTIVE_MODEL_SPEC = MODEL_REGISTRY[ACTIVE_MODEL_KEY];

// Build a one-off spec from the debug-only settings override (testing arbitrary
// repos). Returns null when no override is set. Identity/key = the override repo,
// so an override load drifts vs the stored index (→ reindex), same as a real swap.
export function resolveOverrideSpec(settings: SeekSettings): ModelSpec | null {
    const repo = settings.modelRepoOverride?.trim();
    if (!repo) return null;
    return {
        key: repo,
        label: repo,
        repo,
        revision: settings.modelRevisionOverride?.trim() || null,
        files: ML97_GBQ4.files, // assume the standard transformers.js repo layout
        dim: ML97_GBQ4.dim,
        nativeDim: ML97_GBQ4.nativeDim,
        mrlDims: null,
        dtype: ML97_GBQ4.dtype,
        pooling: ML97_GBQ4.pooling,
        queryPrefix: '',
        documentPrefix: '',
        textOnly: false,
        approxDownloadMB: ML97_GBQ4.approxDownloadMB,
    };
}

// Honor a Matryoshka width only when this model lists it. 0 / missing / unknown
// keeps the spec's own dim (native, for EmbeddingGemma 2).
export function withOutputDim(spec: ModelSpec, requested: number | undefined): ModelSpec {
    if (!spec.mrlDims || requested == null || requested === 0) return spec;
    if (!spec.mrlDims.includes(requested) || requested === spec.dim) return spec;
    return { ...spec, dim: requested };
}

// The model to load right now: debug override wins, else the settings choice,
// else the shipped default. The settings choice is a registry key; an empty or
// unknown key stays on the default so a typo cannot point the index at nothing.
export function activeModelSpec(settings: SeekSettings): ModelSpec {
    const override = resolveOverrideSpec(settings);
    if (override) return override;
    const key = settings.embeddingModelKey?.trim() ?? '';
    const base = (key && MODEL_REGISTRY[key]) ? MODEL_REGISTRY[key] : ACTIVE_MODEL_SPEC;
    return withOutputDim(base, settings.embeddingOutputDim);
}

// Bound at plugin load and on every settings save. Identity, the sidecar stride,
// and the iframe script read this so a model change is one place. Defaults to
// the shipped spec so module init (and tests that never bind) stay on Granite.
let boundModelSpec: ModelSpec = ACTIVE_MODEL_SPEC;

export function bindLiveModel(settings: SeekSettings): ModelSpec {
    boundModelSpec = activeModelSpec(settings);
    return boundModelSpec;
}

export function currentModelSpec(): ModelSpec {
    return boundModelSpec;
}

// Task prefixes. Idempotent so a recycle retry cannot stack them.
export function formatQueryText(text: string, spec: ModelSpec = currentModelSpec()): string {
    const prefix = spec.queryPrefix;
    if (!prefix || text.startsWith(prefix)) return text;
    return prefix + text;
}

export function formatDocumentText(text: string, spec: ModelSpec = currentModelSpec()): string {
    const prefix = spec.documentPrefix;
    if (!prefix || text.startsWith(prefix)) return text;
    return prefix + text;
}

// ---- Cache-API eviction (parent-side; orchestrated from main.ts) --------------
// transformers.js caches model files in caches.open('transformers-cache') keyed by
// the HF resolve URL `https://huggingface.co/<repo>/resolve/<rev>/<file>` (verified
// against the shipped @huggingface/transformers@4.3.0 bundle). On a model switch we
// delete every cached HF model request that is NOT the active repo, reclaiming the
// old model's ~100 MB. Pure predicate below is unit-tested; the orchestration that
// opens `caches` lives in main.ts (and is benign if the cache is absent).

export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

// True if `url` is a transformers HF model fetch for some repo OTHER than keepRepo.
// Matches the repo as a path segment (`/<repo>/resolve/`) so a repo that is a prefix
// of another (…/granite vs …/granite-2) is not mistakenly kept or evicted.
export function shouldEvictCacheUrl(url: string, keepRepo: string): boolean {
    if (!url.includes('huggingface.co') || !url.includes('/resolve/')) return false;
    return !url.includes(`/${keepRepo}/resolve/`);
}

export interface EvictionResult { seen: number; deleted: number }

// True if `url` is a transformers HF model fetch FOR `repo` — the entries a user-invoked
// "Delete model" removes. The mirror of shouldEvictCacheUrl: same HF/resolve guard and
// same path-segment match (`/<repo>/resolve/`, prefix-safe), but the predicate is
// inverted from "every repo but this one" to "exactly this one".
export function isCacheUrlForRepo(url: string, repo: string): boolean {
    if (!url.includes('huggingface.co') || !url.includes('/resolve/')) return false;
    return url.includes(`/${repo}/resolve/`);
}

// Delete the ACTIVE model's cached bytes (settings "Delete model"). The inverse of
// evictStaleModelCaches — there we drop every repo EXCEPT keepRepo; here we drop exactly
// the entries for `repo`, leaving the jsdelivr runtime and any other repo untouched.
// Best-effort + benign + parent-side, with the same iPhone visibility caveat as eviction
// (seen === 0 → the parent can't reach the iframe's cache; the bytes stay until reload).
export async function deleteModelCaches(
    caches: CacheStorage,
    repo: string,
): Promise<EvictionResult> {
    if (!(await caches.has(TRANSFORMERS_CACHE_NAME))) return { seen: 0, deleted: 0 };
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const reqs = await cache.keys();
    let deleted = 0;
    for (const req of reqs) {
        if (isCacheUrlForRepo(req.url, repo)) {
            // Best-effort per entry: a single rejected delete (rare) must not abort the
            // sweep and strand the rest of the model's bytes half-removed. Worst case we
            // under-count `deleted`; the next delete / search retries the leftovers.
            try { if (await cache.delete(req)) deleted++; } catch { /* skip this key */ }
        }
    }
    return { seen: reqs.length, deleted };
}

// Open the transformers cache and delete stale-repo entries. Best-effort + benign:
// if the cache is absent (never populated, or — should not happen with our
// non-sandboxed, same-origin iframe — partitioned away from the parent) it returns
// {0,0} and the old bytes are left for the OS to reclaim. The caller logs the
// result so `seen === 0` is visible (the signal to move eviction into an iframe RPC
// if it ever shows up on a real device). Typed against the DOM `CacheStorage`; unit
// tests inject a structural fake via `as unknown as CacheStorage`.
export async function evictStaleModelCaches(
    caches: CacheStorage,
    keepRepo: string,
): Promise<EvictionResult> {
    if (!(await caches.has(TRANSFORMERS_CACHE_NAME))) return { seen: 0, deleted: 0 };
    const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
    const reqs = await cache.keys();
    let deleted = 0;
    for (const req of reqs) {
        if (shouldEvictCacheUrl(req.url, keepRepo)) {
            if (await cache.delete(req)) deleted++;
        }
    }
    return { seen: reqs.length, deleted };
}

// ---- Cache-API download probe (read-only; for the settings model status) -------
export interface ModelCacheStatus {
    // The model's ~100 MB ONNX weights are present in the Cache API (vs. an aborted
    // fetch that left only the small JSON configs, or nothing). This is the
    // "Downloaded — survives reloads, evictable by iOS" state the settings tab shows,
    // distinct from "loaded into runtime memory" (which the search modal signals).
    downloaded: boolean;
    // navigator.storage persistence: true = persistent-storage granted, so the cache
    // won't be silently evicted under pressure ("stored permanently"); false = "may be
    // evicted"; null = the API is unavailable (don't render the nuance).
    persisted: boolean | null;
}

// Read-only probe of whether the active model is cached on disk. Matches the ONNX
// weight file by repo + filename FRAGMENTS in the cache keys, rather than rebuilding
// the exact resolve URL — the revision segment is `main` vs a pinned sha depending on
// the load path, and fragment-matching is robust to either (same approach as
// shouldEvictCacheUrl). Best-effort and NEVER throws: any failure (no Cache API,
// origin-partitioned cache, rejected open) resolves to { downloaded:false } so it can
// never blank the settings tab. NOTE the parent-side-visibility caveat — on a real
// iPhone the parent may not see the iframe's cache (the `cacheSeen` canary in the
// model-delivery log); the caller falls back to that log when this returns false.
export async function probeModelDownloaded(
    caches: CacheStorage,
    spec: ModelSpec,
): Promise<ModelCacheStatus> {
    let persisted: boolean | null = null;
    try {
        if (typeof navigator !== 'undefined' && navigator.storage?.persisted) {
            persisted = await navigator.storage.persisted();
        }
    } catch { /* unsupported / private mode */ }
    try {
        if (!(await caches.has(TRANSFORMERS_CACHE_NAME))) return { downloaded: false, persisted };
        const cache = await caches.open(TRANSFORMERS_CACHE_NAME);
        const reqs = await cache.keys();
        // The largest file is the ONNX weights; its presence is the download canary
        // (the small JSON configs alone = a partial/aborted fetch). Fall back to the
        // last declared file if a spec ever ships without an .onnx entry.
        // External-data ONNX (EmbeddingGemma 2) keeps the graph in a small .onnx
        // and the weights in .onnx_data. The data file is the download canary;
        // a spec without one (Granite) falls back to the .onnx graph.
        const weightFile = spec.files.find(f => f.endsWith('.onnx_data'))
            ?? spec.files.find(f => f.endsWith('.onnx'))
            ?? spec.files[spec.files.length - 1];
        const weightName = weightFile.split('/').pop() ?? weightFile;
        const downloaded = reqs.some(r => {
            if (!r.url.includes(`/${spec.repo}/resolve/`)) return false;
            if (r.url.includes(weightFile)) return true;
            try {
                if (decodeURIComponent(r.url).includes(weightFile)) return true;
            } catch { /* malformed cache key */ }
            return r.url.includes(weightName);
        });
        return { downloaded, persisted };
    } catch {
        return { downloaded: false, persisted };
    }
}
