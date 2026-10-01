// Sandboxed iframe that owns the transformers.js pipeline.
//
// Why an iframe at all? Obsidian's renderer applies a strict CSP that blocks
// `import()` of remote ES modules — but iframes with srcdoc inherit a more
// permissive CSP and can dynamically import from jsdelivr. The iframe also
// quarantines the ~250 MB model heap; on plugin teardown we just unmount
// the DOM node and the runtime reclaims everything.
//
// Lifted from the embeddinggemmaiostest spike with one adjustment for v0:
//   - Model id is the onnx-community fused PTQ export, run at q4 (see
//     embedder.ts header — the QAT workstream is killed).

import type { Device, RequestedDevice, Dtype } from '../types/types';
import { ACTIVE_MODEL_SPEC } from './model-registry';
import { buildChildScript } from './iframe-scripts';

declare const __BUILD_TS__: string;

// HARD FLOOR — do not downgrade below 4.x. v4 bundles ORT-Web 1.26-dev+,
// whose WebGPU MatMulNBits kernels are what make q4 viable on this stack.
// Measured on the Personal vault (2075 files / ~3950 chunks, WebGPU, same
// fused PTQ q4 model, 2026-05-17):
//   tx.js 3.8.0  q4  →   6.7 ch/s,  heap Δ ~186 MB
//   tx.js 3.8.0  q8  →  13.2 ch/s,  heap Δ ~380 MB
//   tx.js 4.2.0  q4  →  20.6 ch/s,  heap Δ ~103 MB   ← 4.2.0 baseline
// i.e. v4 q4 is ~3× faster than v3 q4 AND ~1.6× faster than v3 q8 at ~¼
// the heap. The q4 throughput penalty was never a fusion confound (op
// histograms confirmed v3 q4 was fully fused, 24× MultiHeadAttention, and
// still 6.7 ch/s) — it was ORT-Web's immature MatMulNBits/WebGPU kernel for
// M>1 (prefill), which 1.26-dev finally optimizes. Re-bench before any
// version bump; the model-load path is API-sensitive across major versions.
// 2026-06-02: bumped 3.8.0 -> 4.2.0. granite-r2 is a ModernBERT (RoPE); its
// WebGPU rotary kernel ("k_rotary/term2_mul: Can't perform binary op") is
// BROKEN on 3.8.0's ORT-Web and only works on 4.x's ORT-Web 1.26. 3.8.0 was
// pinned for iOS (v4 ORT-Web can't init WebGPU in iOS WKWebView) — under 4.2,
// iOS will fail the WebGPU load and fall back to WASM at load time (iOS is
// query-only anyway). Desktop indexing needs 4.2+ for granite WebGPU.
// 2026-09-17: bumped 4.2.0 -> 4.3.0. Bundled ORT-Web jumps 1.26.0-dev.20260416
// → 1.31.0-dev.20260914. tx.js #1700 enables WebGPU on Safari 26+ (asyncify
// glue by default); Safari <26 without navigator.gpu still gets the plain
// WASM pin. overrideWebkitGlueForWebgpu remains: it no-ops when wasmPaths is
// already asyncify, and still rewrites the plain pin if a WebGPU attempt
// lands on older WKWebView. webInitChain still has no rejection handler in
// 4.3.0 — keep the fragment-suffixed freshTransformers() workaround.
export const TRANSFORMERS_VERSION = '4.3.0';
const CDN_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`;

// Warmup grid constants — exported so the parent can compose a fingerprint
// for the localStorage skip-warmup cache. Single source of truth: defined
// here, injected into the iframe script body via JSON.stringify substitution.
// If you change either array, the next load on every install will recompute
// (the fingerprint won't match) — that's the intended behavior, no manual
// cache bust required.
//
// WARMUP_BATCH_SIZES: the indexer uses a per-bucket rolling buffer that flushes
// at a FIXED warmed size of 8 (ROLLING_BATCH in search.ts), so the only batch
// counts ever dispatched are 8 and the partial-drain remainders 1..7. We warm
// exactly that set [1..8] — no 32 (the old within-file ceiling, never dispatched
// now). All warmed on both device classes so a vault sync between desktop+mobile
// never eats a multi-second WGSL compile stall mid-reindex.
//
// SEQ_BUCKETS: padding ladder. Caps unique tensor shapes Dawn sees to O(buckets)
// instead of O(unique token lengths). Nine LOG-SPACED buckets (the offline
// padding sim, 2026-06-03: log spacing beat linear-dense 85% vs 82% at equal
// count, because chunk lengths are log-distributed). vs the old 5-bucket ladder
// this lifts rolling-buffer efficiency 72%→85% (content ÷ padded positions) for
// ~16 extra warmup shapes. Single source of truth: injected into the iframe
// template AND mirrored by the exported selectBucket() below — keep in sync.
export const WARMUP_BATCH_SIZES = [1, 2, 3, 4, 5, 6, 7, 8];
export const SEQ_BUCKETS = [32, 48, 64, 96, 128, 192, 256, 384, 512];

// QUERY_SEQ_BUCKETS: the SINGLE-embed (query) path uses its own ladder, NOT the
// index ladder above. A query is a handful of tokens (live logs 2026-06-09:
// p50=3, p90=7, max=11 — 100% landed in the old seq=32 floor, so the median
// query did ~91% of its forward on padding). So:
//   - lower floor (8, 16): a 3-token query runs an 8-wide tensor, not 32-wide.
//   - capped at 128: ~90-100 words, longer than any link/path/NL question. There
//     is no dense-relevance case past this — a single CLS-pooled vector over 100+
//     tokens averages too many concepts to discriminate (regresses to centroid),
//     and BM25 (which is NOT bucketed — see MultiFieldBM25, full query) already
//     covers the only real long-input case, a literal text paste. A >128-token
//     query truncates to 128 on the dense side only; lexical recall is intact.
// The INDEX path keeps SEQ_BUCKETS unchanged (chunks are long; 256/512 matter).
// Experiment scaffold: shrinking seq cuts compute ~linearly but per-layer WebGPU
// dispatch overhead is seq-INDEPENDENT, so the floor win must be MEASURED from
// live iframeEmbedMs, not assumed.
export const QUERY_SEQ_BUCKETS = [8, 16, 32, 48, 64, 96, 128];

// Parent-side CHAR-ESTIMATE bucket selector — legacy fallback only. The
// ceil(chars/4.5) estimate under-buckets dense text (URLs, paths, numbers,
// code run ~3.6 chars/token), silently truncating BELOW the 512 cap — the
// WS2.2/WS2.3 "dense-invisible" finding (21-26% of corpus tokens). The index
// path now routes with selectIndexBucket (exact token counts via the
// token-counts RPC) and passes the bucket explicitly to embed-batch; this
// estimator remains only as the iframe-side fallback when no bucket is given.
// Keep identical to the template copy near WEBGPU_DTYPE_LADDER.
export function selectBucket(charCount: number): number {
    const est = Math.ceil(charCount / 4.5);
    for (const b of SEQ_BUCKETS) if (est <= b) return b;
    return SEQ_BUCKETS[SEQ_BUCKETS.length - 1];
}

// Token-exact index-path bucket selector (WS2.3 — the index-side twin of
// selectQueryBucket below). Takes the EXACT token count of the embed input,
// counted by the model's own tokenizer via the token-counts RPC, so the bucket
// always holds the whole input and truncation cannot drop tokens. Only inputs
// the token-budget packer could not reduce under the cap (pathological
// >512-token titles — see token-budget.ts) ever hit the last rung oversized.
export function selectIndexBucket(tokenCount: number): number {
    for (const b of SEQ_BUCKETS) if (tokenCount <= b) return b;
    return SEQ_BUCKETS[SEQ_BUCKETS.length - 1];
}

// Query-path bucket selector (mirrored in the template). Takes the EXACT token
// count of the cleaned query — the iframe tokenizes it (see embedText), so we
// don't guess from chars like the indexer's selectBucket does. The bucket is the
// smallest one ≥ the real token length, so it always holds the whole query and
// truncation cannot drop tokens. Only a >128-token query (no dense-relevance
// case — see QUERY_SEQ_BUCKETS) hits the cap and truncates the dense side; BM25
// still sees the full query.
export function selectQueryBucket(tokenCount: number): number {
    for (const b of QUERY_SEQ_BUCKETS) if (tokenCount <= b) return b;
    return QUERY_SEQ_BUCKETS[QUERY_SEQ_BUCKETS.length - 1];
}
const IFRAME_ID = 'seek-runtime-iframe';
const READY_TIMEOUT_MS = 30_000;
// Grace period before removing the srcdoc iframe from the DOM. Blank the document
// first so WebGPU/ORT teardown runs inside the frame; a hard removeChild while
// GPU callbacks are still unwinding triggers Electron "Uncaught illegal access"
// noise (index.html:1 in DevTools). Capped so plugin unload/recycle never hangs.
export const SOFT_DISPOSE_MS = 50;

// Per-RPC timeout. The iframe WebContent process can be jetsam-killed mid-RPC on
// mobile (the documented reindex-hang failure) or its WebGPU device lost; the
// child then never replies and the parent promise would hang FOREVER — which
// also strands the embed catch's recycle+retry net behind an await that never
// returns (search.ts embedOneBatch). The timeout converts a hang into a
// RECOVERABLE rejection (tagged 'TIMEOUT', distinct from teardown's 'DISPOSED')
// so the existing recovery path fires. Two tiers: embed/token RPCs settle in
// ms–seconds (60 s is a vast ceiling even for a pathological iPhone WASM batch);
// a cold load() can stream ~60 MB of model bytes from the CDN on first install,
// so it gets a far longer budget before we call it dead.
const RPC_TIMEOUT_MS = 60_000;
const LOAD_RPC_TIMEOUT_MS = 180_000;
// T8 spike — dedicated-worker probe. The child races its own 12 s inner timeout
// (spawn + CDN import + WebGPU adapter/device/compute) before terminating the
// nested worker; this outer budget only has to cover the RPC round trip.
export const WORKER_PROBE_TIMEOUT_MS = 20_000;

export interface IframeInit {
    buildTimestamp: string;
    cdnUrl: string;
    transformersVersion: string;
    ready: boolean;
    error: string | null;
    // Wall time of buildIframe() (DOM create + srcdoc parse + __ready handshake).
    // 0 on the idempotent early-return path (iframe already live).
    initMs: number;
}

export interface LoadResult {
    device: Device;
    dtype: Dtype;
    coldStartMs: number;
    // Wall-time of the WebGPU warmup loop only (40 forced dispatches that
    // compile WGSL shaders for the (batch_size × seq_len) grid the indexer
    // and query path will hit). NULL when:
    //   - WASM fallback path (no warmup applies)
    //   - WebGPU warmup was SKIPPED by the parent-side fingerprint cache
    //     (warmupSkipped=true distinguishes this from the WASM case)
    // Subtract from coldStartMs to get "pre-warmup load" (Cache API read +
    // ONNX parse + WebGPU device init + first pipeline construction).
    // Measurement on desktop (2026-05-19): warmup is locked at ~1020 ms
    // across consecutive warm reloads (Dawn shader cache hot), so skipping
    // it on warm reload recovers the full ~50% of warm-reload wall time.
    warmupMs: number | null;
    // True iff the parent passed skipWarmup=true AND we took the skip path
    // (WebGPU success path only — never true for WASM).
    warmupSkipped: boolean;
    webgpuAttempted: boolean;
    webgpuError: string | null;
    // Which ort-wasm glue variant an override actually selected: 'jspi' |
    // 'asyncify' (WebKit WebGPU attempt) or 'plain' (non-WebKit wasm pin —
    // the only build carrying the CPU GatherBlockQuantized kernel). null when
    // no override applied (WebKit wasm rides tx.js's own plain pin untouched).
    // Closes the diagnostics gap where the running glue was only ever visible
    // in failure strings.
    glue: string | null;
    // WASM sessions only: whether the pipeline landed in ort-web's proxy
    // worker (off-main-thread inference — issue #5). Always false on the
    // webgpu path (the webgpu EP can't ride the proxy).
    proxy: boolean;
    proxyAttempted: boolean;
    proxyError: string | null;
}

// Unsolicited iframe→parent push (not an RPC reply): WebGPU device lifecycle
// events from the requestDevice prototype hook. Routed to IframeRunner.onEvent.
export type IframeEvent = Record<string, string | number | boolean | null>;

export interface EmbedResult {
    vector: Float32Array;
    latencyMs: number;
}

// Raw per-cell timing arrays from the child's unrolled path. The child stays
// dumb (returns raw samples); distributionStats + share math happen parent-
// side in TS where the existing helper lives. tokenize/forward/post are the
// unrolled decomposition; pipe is the production pipeline() total on the same
// inputs (decomposition sanity check).
export interface RawProfileCell {
    batchSize: number;
    seqBucket: number;
    reps: number;
    tokenize: number[];
    forward: number[];
    post: number[];
    pipe: number[];
}

export interface RawProfile {
    cells: RawProfileCell[];
}

export interface AppLocalFetchResult {
    // ok=true: HTTP fetch succeeded AND body matched (when expectedBody set)
    // ok=false: fetch threw, non-2xx response, or body mismatch
    ok: boolean;
    status: number | null;
    body: string | null;
    error: string | null;
}

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    // Per-RPC timeout handle, cleared when the reply lands (or on dispose).
    // number is window.setTimeout's DOM return (clearTimeout takes it).
    timer?: number;
}

// A send() that is waiting for the single-flight pump. `start` posts the RPC;
// until then the Promise lives only here, so dispose/failInflight must reject
// it explicitly — clearing the array alone would leave callers hanging.
interface QueuedRpc {
    start: () => void;
    reject: (error: Error) => void;
    cleanupAbort: () => void;
    started: boolean;
}

function rejectQueued(queue: QueuedRpc[], error: Error): void {
    for (const item of queue) {
        if (item.started) continue;
        item.cleanupAbort();
        item.reject(error);
    }
}

// T8 spike — result of the nested dedicated-worker probe. Spawned inside the
// iframe realm; answers the four spike questions the research phase left open:
//   spawnOk   — can this srcdoc iframe create a module Worker at all?
//   importOk  — can that worker dynamically import() the transformers.js CDN URL?
//   process.* — Electron worker realms expose a Node-like process; did the shim
//               flip it so transformers would take the web (not node) branch?
//   webgpu    — adapter/device availability + one REAL GPUBuffer passing a
//               compute pass (not just requestAdapter; ORT needs dispatch).
export interface WorkerProbeResult {
    spawnOk: boolean;
    spawnError: string | null;
    workerType: 'module' | null;
    importOk: boolean;
    importError: string | null;
    importMs: number | null;
    processSeen: boolean;
    processVersionsNode: string | null;
    processType: string | null;
    webgpu: {
        api: boolean;
        adapter: boolean;
        device: boolean;
        computePass: boolean;
        error: string | null;
    };
    durationMs: number;
}

// T8 spike — functional embed-worker test result. The worker loads the REAL
// model (same repo/revision/q4 as the iframe pipeline), embeds the probe text
// in the worker realm, and the child embeds the SAME text on the iframe
// pipeline to compute a cosine. cosine ≥ ~0.999 = the two realms produce the
// same vectors = the worker architecture is functionally correct.
export interface WorkerEmbedTestResult {
    loadOk: boolean;
    loadError: string | null;
    loadMs: number;
    embedOk: boolean;
    embedError: string | null;
    embedMs: number;
    dim: number;
    cosine: number;
    workerKilled: boolean;
    durationMs?: number;
}

// Shape of an iframe→parent postMessage payload: RPC replies plus the bootstrap
// control messages (__ready / __error / __event). event.data is structurally
// untyped (any), so we narrow it to this before reading fields.
interface IframeMsg {
    id: string;
    ok?: boolean;
    result?: unknown;
    error?: string;
    event?: IframeEvent;
}

function queryAbortError(): Error {
    return Object.assign(new Error('Query superseded'), { name: 'AbortError', code: 'ABORTED' });
}

export class IframeRunner {
    private iframe: HTMLIFrameElement | null = null;
    private pending = new Map<string, Pending>();
    private listener: ((e: MessageEvent) => void) | null = null;
    // Receiver for unsolicited '__event' pushes (WebGPU device lifecycle).
    // Survives recycle (same runner instance rebuilds the iframe); the
    // embedder re-wires it across teardown() which swaps the runner.
    onEvent: ((event: IframeEvent) => void) | null = null;

    // Single-flight RPC pump with query priority. The child pipeline is not safe
    // for concurrent forwards: an in-flight embed-batch (catch-up) + a query
    // embed used to contend and hang seek:search for 30s+ (G_catchup_ux). Queue
    // model RPCs one-at-a-time; `embed` jumps ahead of index traffic.
    private rpcBusy = false;
    private queryRpcQueue: QueuedRpc[] = [];
    private indexRpcQueue: QueuedRpc[] = [];
    // buildIframe() READY_TIMEOUT_MS handle. Cleared on __ready / __error and
    // on dispose so a mid-init teardown cannot reject 30s later.
    private readyTimeout: number | null = null;

    async init(): Promise<IframeInit> {
        const result: IframeInit = {
            buildTimestamp: __BUILD_TS__,
            cdnUrl: CDN_URL,
            transformersVersion: TRANSFORMERS_VERSION,
            ready: false,
            error: null,
            initMs: 0,
        };
        // Idempotency guard for SEQUENTIAL re-entry (recycle/teardown-then-init,
        // the Unload command). buildIframe() does an unconditional
        // document.createElement(iframe) — calling init() twice on a live runner
        // would append a second #seek-runtime-iframe and leak the first listener.
        // contentWindow is non-null only after the srcdoc document attaches, so an
        // in-progress build still reads as "not live" here; CONCURRENT callers are
        // serialized one layer up by LocalEmbedder's memoized _initPromise.
        if (this.iframe?.contentWindow) {
            result.ready = true;
            return result;
        }
        const t0 = performance.now();
        try {
            await this.buildIframe();
            result.ready = true;
        } catch (e) {
            result.error = String(e);
            // A failed bootstrap (__error or the ready-timeout) still leaves the
            // iframe ELEMENT attached with a live contentWindow — buildIframe()
            // doesn't unwind. Left as-is, the idempotency guard above (and send()'s
            // 'iframe not initialized' check) would read that dead iframe as usable,
            // so a retry would short-circuit to a false-ready and load() would hang
            // posting to an iframe that never answers. dispose() unwinds to a clean
            // no-iframe state (also removing the leaked message listener) so the next
            // init() genuinely rebuilds.
            await this.dispose();
        }
        result.initMs = parseFloat((performance.now() - t0).toFixed(2));
        return result;
    }

    private buildIframe(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.readyTimeout = window.setTimeout(
                () => {
                    this.readyTimeout = null;
                    reject(new Error(`iframe ready timeout after ${READY_TIMEOUT_MS}ms`));
                },
                READY_TIMEOUT_MS,
            );

            this.listener = (event: MessageEvent) => {
                if (!this.iframe || event.source !== this.iframe.contentWindow) return;
                const data = event.data as IframeMsg | undefined;
                if (!data || typeof data !== 'object') return;

                if (data.id === '__ready') {
                    if (this.readyTimeout != null) window.clearTimeout(this.readyTimeout);
                    this.readyTimeout = null;
                    resolve();
                    return;
                }
                if (data.id === '__error') {
                    if (this.readyTimeout != null) window.clearTimeout(this.readyTimeout);
                    this.readyTimeout = null;
                    reject(new Error(`iframe bootstrap failed: ${data.error}`));
                    return;
                }
                if (data.id === '__event') {
                    // Unsolicited push, not an RPC reply. Handler errors must
                    // never poison the RPC dispatch below it.
                    try { this.onEvent?.(data.event as IframeEvent); } catch { /* swallow */ }
                    return;
                }
                const p = this.pending.get(data.id);
                if (!p) return;
                this.pending.delete(data.id);
                if (p.timer) window.clearTimeout(p.timer);
                if (data.ok) p.resolve(data.result);
                else p.reject(new Error(data.error ?? 'iframe error'));
            };
            window.addEventListener('message', this.listener);

            // Anchor the hidden compute iframe to `window.document` (the main
            // window's document), NOT activeDocument: it is display:none (no
            // popout-render benefit), must outlive any popout (anchoring it to the
            // window focused at first embed would orphan it when that popout
            // closes), and its contentWindow postMessage must reach the `window`
            // message listener bound above.
            this.iframe = window.document.createElement('iframe');
            this.iframe.id = IFRAME_ID;
            this.iframe.addClass('seek-hidden');
            // LOAD-BEARING: no `sandbox` attribute. A srcdoc iframe with no sandbox
            // inherits Obsidian's real origin (`capacitor://localhost` on iOS,
            // `app://obsidian.md` on desktop). That real origin is what lets the
            // child's transformers.js fetch() pull the model from the HF CDN —
            // HF returns `access-control-allow-origin: *`, so the cross-origin
            // request passes — and share the parent's Cache-API partition (so the
            // parent-side eviction in model-registry.ts can see the cache). Adding
            // a `sandbox` attribute would give the iframe an opaque `null` origin
            // and break BOTH on iOS. Do not add one without first moving the model
            // fetch out of the iframe (e.g. parent requestUrl → resource URL).
            window.document.body.appendChild(this.iframe);

            const childScript = buildChildScript(CDN_URL, ACTIVE_MODEL_SPEC.dim);
            this.iframe.srcdoc =
                `<!DOCTYPE html><html><body><script type="module">${childScript}</script></body></html>`;
        });
    }

    private send<T>(
        type: string,
        payload: unknown,
        timeoutMs: number = RPC_TIMEOUT_MS,
        signal?: AbortSignal,
    ): Promise<T> {
        if (!this.iframe?.contentWindow) {
            return Promise.reject(new Error('iframe not initialized'));
        }
        if (signal?.aborted) return Promise.reject(queryAbortError());
        const priority: 'query' | 'index' = type === 'embed' ? 'query' : 'index';
        return new Promise<T>((resolve, reject) => {
            let started = false;
            let aborted = false;
            const queue = priority === 'query' ? this.queryRpcQueue : this.indexRpcQueue;
            const cleanupAbort = (): void => signal?.removeEventListener('abort', onAbort);
            const rejectAborted = (): void => {
                cleanupAbort();
                reject(queryAbortError());
            };
            let queued: QueuedRpc;
            const start = () => {
                started = true;
                queued.started = true;
                const id = (crypto as { randomUUID?: () => string }).randomUUID
                    ? (crypto as { randomUUID: () => string }).randomUUID()
                    : `id-${Date.now()}-${Math.random()}`;
                const timer = window.setTimeout(() => {
                    if (!this.pending.delete(id)) return;
                    this.rpcBusy = false;
                    this.pumpRpc();
                    cleanupAbort();
                    if (aborted) reject(queryAbortError());
                    else {
                        reject(Object.assign(
                            new Error(`iframe RPC '${type}' timed out after ${timeoutMs}ms`),
                            { code: 'TIMEOUT' },
                        ));
                    }
                }, timeoutMs);
                this.pending.set(id, {
                    resolve: (v: unknown) => {
                        this.rpcBusy = false;
                        this.pumpRpc();
                        cleanupAbort();
                        if (aborted) reject(queryAbortError());
                        else resolve(v as T);
                    },
                    reject: (e: Error) => {
                        this.rpcBusy = false;
                        this.pumpRpc();
                        cleanupAbort();
                        if (aborted) reject(queryAbortError());
                        else reject(e);
                    },
                    timer,
                });
                this.iframe!.contentWindow!.postMessage({ id, type, payload }, '*');
            };
            const onAbort = (): void => {
                aborted = true;
                if (started) return;
                const queuedAt = queue.indexOf(queued);
                if (queuedAt === -1) return;
                queue.splice(queuedAt, 1);
                rejectAborted();
            };
            queued = {
                start,
                reject: (error: Error) => { reject(error); },
                cleanupAbort,
                started: false,
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            queue.push(queued);
            this.pumpRpc();
        });
    }

    private pumpRpc(): void {
        if (this.rpcBusy) return;
        const next = this.queryRpcQueue.shift() ?? this.indexRpcQueue.shift();
        if (!next) return;
        this.rpcBusy = true;
        next.start();
    }

    // skipWarmup: parent decision based on the localStorage fingerprint cache
    // (see embedder.ts). If true AND the WebGPU path succeeds, the iframe
    // bypasses the 40-dispatch shader-compile loop entirely. Always pay the
    // warmup on the WASM path or on a fingerprint miss.
    load(modelId: string, device: RequestedDevice, dtype: Dtype, skipWarmup: boolean, revision?: string | null): Promise<LoadResult> {
        return this.send<LoadResult>('load', { modelId, device, dtype, skipWarmup, revision: revision ?? null }, LOAD_RPC_TIMEOUT_MS);
    }

    embed(text: string, signal?: AbortSignal): Promise<EmbedResult> {
        return this.send<EmbedResult>('embed', { text }, RPC_TIMEOUT_MS, signal);
    }

    // bucket: the seq-ladder rung this batch was routed into by the parent's
    // token-exact selectIndexBucket. The iframe uses it verbatim as max_length,
    // so parent routing and iframe padding agree by construction (no second
    // char-estimate derivation). Omitting it falls back to the legacy char
    // estimate inside the iframe — kept only for back-compat callers.
    embedBatch(texts: string[], bucket?: number): Promise<{ vectors: Float32Array[]; latencyMs: number }> {
        return this.send<{ vectors: Float32Array[]; latencyMs: number }>('embed-batch', { texts, bucket });
    }

    // Exact token counts (specials included — the same count the forward pass
    // sees) for each text, from the iframe pipeline's own tokenizer. Tokenizer
    // only, no model forward: cheap (~µs-ms per text) and device-independent.
    // The single source of tokenizer truth stays inside the iframe; the parent
    // never re-implements or approximates it.
    tokenCounts(texts: string[]): Promise<number[]> {
        return this.send<number[]>('token-counts', { texts });
    }

    // Load ONLY the tokenizer (vocab/merges JSON, a few MB) — no ONNX model
    // weights. Lets the sidecar hydrate reproduce the token-budget chunk splits
    // (and therefore exact chunk_ids) without the ~250 MB model load it exists
    // to avoid on mobile. Idempotent in the child; tokenCounts() then works
    // against either the full pipeline or this standalone tokenizer.
    loadTokenizer(modelId: string, revision?: string | null): Promise<{ ok: boolean; cached: boolean }> {
        return this.send<{ ok: boolean; cached: boolean }>('load-tokenizer', { modelId, revision: revision ?? null }, LOAD_RPC_TIMEOUT_MS);
    }

    // Diagnostic only. Runs the UNROLLED tokenizer→model→readback path with
    // timing boundaries across a (batchSize × seqBucket) matrix so we can see
    // where wall time actually goes on the v4 runtime. Never used in the
    // production embed path — that stays the opaque pipeline() call for
    // correctness; this is the measurement twin.
    profile(batchSizes: number[], seqBuckets: number[], reps: number): Promise<RawProfile> {
        // Diagnostic only; a full (batch × seq) matrix can run minutes — give it
        // a generous ceiling so the per-RPC timeout never trips a real profile.
        return this.send<RawProfile>('embed-profile', { batchSizes, seqBuckets, reps }, 600_000);
    }

    // Probe whether the iframe (srcdoc + sandboxed) can fetch a vault
    // resource via Obsidian's runtime URL scheme. Gates the Phase 3 shard
    // streaming pattern; see seek-dataadapter-rearchitecture-plan §Phase 1.
    appLocalFetch(url: string): Promise<AppLocalFetchResult> {
        return this.send<AppLocalFetchResult>('app-local-fetch', { url });
    }

    // T8 spike — spawn a dedicated module worker INSIDE the iframe and report
    // what it can do. Diagnostic only: no pipeline state is touched, the worker
    // is terminated by the child before replying, and a probe failure never
    // throws to the parent (failures ARE the data, like app-local-fetch).
    workerProbe(): Promise<WorkerProbeResult> {
        return this.send<WorkerProbeResult>('worker-probe', {}, WORKER_PROBE_TIMEOUT_MS);
    }

    // T8 spike — functional test of the REAL embed worker: load the model in a
    // long-lived nested worker, embed the probe text there, and compare against
    // the iframe pipeline's own embedding via cosine. The load RPC gets the
    // LOAD-class budget (cold load can stream ~60 MB from the CDN); embed gets
    // the standard budget. Structured result, never a rejection.
    workerEmbedTest(text: string): Promise<WorkerEmbedTestResult> {
        return this.send<WorkerEmbedTestResult>('embed-worker-test', { text }, LOAD_RPC_TIMEOUT_MS);
    }

    // T8 spike — terminate the iframe's long-lived embed worker (frees its
    // realm: wasm heap + GPU state). The next embed-worker test respawns fresh.
    killEmbedWorker(reason: string): Promise<{ killed: boolean }> {
        return this.send<{ killed: boolean }>('embed-worker-kill', { reason });
    }

    // T8 production route — one embed through the long-lived nested worker.
    // Same RPC the functional test uses, but addressed directly (no cosine
    // comparison, no test bookkeeping).
    workerEmbed(text: string, signal?: AbortSignal): Promise<{ vector: Float32Array; latencyMs: number }> {
        return this.send<{ vector: Float32Array; latencyMs: number }>('embed-worker-embed', { text }, RPC_TIMEOUT_MS, signal);
    }

    // T8 production route — a batch through the nested worker. The worker
    // forwards each text to its pipeline; a batch failure rejects whole so
    // the indexer's per-file error accounting sees one rejection.
    workerBatch(texts: string[]): Promise<{ vectors: Float32Array[]; latencyMs: number }> {
        return this.send<{ vectors: Float32Array[]; latencyMs: number }>('embed-worker-batch', { texts }, RPC_TIMEOUT_MS);
    }

    async dispose(): Promise<void> {
        if (this.listener) {
            window.removeEventListener('message', this.listener);
            this.listener = null;
        }
        if (this.readyTimeout != null) {
            window.clearTimeout(this.readyTimeout);
            this.readyTimeout = null;
        }
        // Tag the rejection 'DISPOSED' so the embed catch can distinguish an
        // intentional teardown (plugin unloading → must NOT recycle, or it
        // resurrects a zombie iframe + reloads ~250 MB into a dead plugin) from
        // a recoverable error (SafeInt overflow / TIMEOUT → recycle+retry).
        // Reject queued starters first (they never entered `pending`); clearing
        // the arrays alone would leave those Promises hanging. Then reject
        // in-flight pending. Clear each pending timer so a timeout can't fire
        // post-rejection.
        const disposed = Object.assign(new Error('iframe disposed'), { code: 'DISPOSED' });
        rejectQueued(this.queryRpcQueue, disposed);
        rejectQueued(this.indexRpcQueue, disposed);
        this.queryRpcQueue = [];
        this.indexRpcQueue = [];
        this.rpcBusy = false;
        for (const [, p] of this.pending) {
            if (p.timer) window.clearTimeout(p.timer);
            p.reject(Object.assign(new Error('iframe disposed'), { code: 'DISPOSED' }));
        }
        this.pending.clear();

        const iframe = this.iframe;
        this.iframe = null;
        if (!iframe) return;

        try {
            iframe.removeAttribute('srcdoc');
            iframe.src = 'about:blank';
        } catch { /* swallow — frame may already be detached */ }

        await new Promise<void>((resolve) => window.setTimeout(resolve, SOFT_DISPOSE_MS));

        try {
            if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        } catch { /* swallow — frame may already be gone */ }
    }

    // Reject every in-flight RPC with a RECOVERABLE error (NOT 'DISPOSED'),
    // leaving the iframe attached. Used on WebGPU device-lost: the device is
    // dead, so a hung embedBatch must reject to let the caller's recycle+retry
    // fire — but this is recovery, not teardown, so the embed catch must not see
    // 'DISPOSED' (which would unwind the reindex). The caller's recycle() then
    // replaces the now-dead-device iframe.
    failInflight(message: string): void {
        rejectQueued(this.queryRpcQueue, new Error(message));
        rejectQueued(this.indexRpcQueue, new Error(message));
        this.queryRpcQueue = [];
        this.indexRpcQueue = [];
        this.rpcBusy = false;
        for (const [, p] of this.pending) {
            if (p.timer) window.clearTimeout(p.timer);
            p.reject(new Error(message));
        }
        this.pending.clear();
    }
}

// Chromium on Windows ignores GPUAdapterOptions.powerPreference and warns
// (crbug.com/369219127). transformers.js and ORT-Web each pass the hint, so
// a WebGPU load logs it twice. Blink emits that from requestAdapter itself —
// wrapping console.warn does not catch it. Strip the option in this realm and
// in Workers ORT spawns. Keep the iframe IIFE in sync with stripGpuPowerPreference().
export function isChromiumPowerPreferenceAdapterWarning(message: string): boolean {
    return message.includes('powerPreference') && message.includes('requestAdapter');
}

export function stripGpuPowerPreference(options: unknown): unknown {
    if (!options || typeof options !== 'object') return options;
    if (!('powerPreference' in options)) return options;
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(options as Record<string, unknown>)) {
        if (key !== 'powerPreference') next[key] = (options as Record<string, unknown>)[key];
    }
    return next;
}


// Script builders now live in iframe-scripts.ts; re-exported so existing
// `from ./iframe-runner` imports (tests, embedder) are unchanged.
export { buildWorkerProbeScript, buildEmbedWorkerScript, buildChildScript } from './iframe-scripts';
