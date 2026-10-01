// Injected-script source builders for the sandboxed iframe runtime.
// Everything below is emitted as STRINGS that run inside the srcdoc iframe
// (or the nested dedicated worker it spawns): the Chromium power-preference
// console filter, the T8 worker probe, the real embed worker, and the child
// RPC template. Extracted from iframe-runner.ts so the class file stays about
// lifecycle/RPC, not embedded source text.
//
// The builders are called lazily (never at module init), so importing the
// warmup-grid constants from iframe-runner.ts is cycle-safe.

import { WARMUP_BATCH_SIZES, SEQ_BUCKETS, QUERY_SEQ_BUCKETS } from './iframe-runner';
import { ACTIVE_MODEL_SPEC } from './model-registry';

const WEBGPU_POWER_PREFERENCE_WARN_FILTER = [
    '// Chromium on Windows warns when requestAdapter is passed powerPreference',
    '// (crbug.com/369219127). Blink logs it; console.warn wrapping does not help.',
    '// Strip the option on this realm and on Workers ORT creates.',
    '(function () {',
    '    function stripPref(options) {',
    "        if (!options || typeof options !== 'object') return options;",
    "        if (!('powerPreference' in options)) return options;",
    '        var next = {};',
    '        for (var k in options) {',
    "            if (Object.prototype.hasOwnProperty.call(options, k) && k !== 'powerPreference') next[k] = options[k];",
    '        }',
    '        return next;',
    '    }',
    '    function wrapAdapter(fn) {',
    '        if (!fn || fn._seekNoPowerPref) return fn;',
    '        function wrapped(options) { return fn.call(this, stripPref(options)); }',
    '        wrapped._seekNoPowerPref = true;',
    '        return wrapped;',
    '    }',
    '    function patchGpu(gpu) {',
    '        if (!gpu || typeof gpu.requestAdapter !== \'function\') return;',
    '        try { gpu.requestAdapter = wrapAdapter(gpu.requestAdapter.bind(gpu)); } catch (e1) {}',
    '        try {',
    '            var proto = Object.getPrototypeOf(gpu);',
    '            if (proto && typeof proto.requestAdapter === \'function\') proto.requestAdapter = wrapAdapter(proto.requestAdapter);',
    '        } catch (e2) {}',
    '    }',
    '    function install() {',
    '        try { if (typeof navigator !== \'undefined\') patchGpu(navigator.gpu); } catch (e3) {}',
    '        try {',
    '            if (typeof GPU !== \'undefined\' && GPU.prototype && typeof GPU.prototype.requestAdapter === \'function\') {',
    '                GPU.prototype.requestAdapter = wrapAdapter(GPU.prototype.requestAdapter);',
    '            }',
    '        } catch (e4) {}',
    '    }',
    '    install();',
    '    var origWarn = console.warn;',
    '    console.warn = function () {',
    "        var msg = Array.prototype.map.call(arguments, function (a) { return String(a); }).join(' ');",
    "        if (msg.indexOf('powerPreference') >= 0 && msg.indexOf('requestAdapter') >= 0) return;",
    '        return origWarn.apply(console, arguments);',
    '    };',
    '    try {',
    '        var OrigWorker = typeof Worker !== \'undefined\' ? Worker : null;',
    '        if (OrigWorker) {',
    "            var hook = '(function(){' +",
    "                'function s(o){if(!o||typeof o!==\"object\")return o;if(!(\"powerPreference\"in o))return o;var n={};for(var k in o){if(k!==\"powerPreference\")n[k]=o[k];}return n;}' +",
    "                'function w(f){if(!f||f._seekNoPowerPref)return f;function g(o){return f.call(this,s(o));}g._seekNoPowerPref=true;return g;}' +",
    "                'try{if(navigator.gpu)navigator.gpu.requestAdapter=w(navigator.gpu.requestAdapter.bind(navigator.gpu));}catch(e){}' +",
    "                'try{if(typeof GPU!==\"undefined\"&&GPU.prototype)GPU.prototype.requestAdapter=w(GPU.prototype.requestAdapter);}catch(e){}' +",
    "            '})();';",
    '            function SeekWorker(url, opts) {',
    '                try {',
    '                    var isModule = opts && opts.type === \'module\';',
    '                    var src = isModule',
    "                        ? hook + 'import(' + JSON.stringify(String(url)) + ');'",
    "                        : hook + 'importScripts(' + JSON.stringify(String(url)) + ');';",
    '                    var blob = new Blob([src], { type: \'text/javascript\' });',
    '                    return new OrigWorker(URL.createObjectURL(blob), opts);',
    '                } catch (e5) {',
    '                    return new OrigWorker(url, opts);',
    '                }',
    '            }',
    '            SeekWorker.prototype = OrigWorker.prototype;',
    '            self.Worker = SeekWorker;',
    '        }',
    '    } catch (e6) {}',
    '})();',
].join('\n');

// T8 spike — source of the DEDICATED WORKER the iframe spawns for the probe.
// Runs in a nested dedicated-worker realm inside the srcdoc iframe. Answers the
// spike questions with hard evidence:
//   1. spawn        — proven by the child receiving our reply at all.
//   2. CDN import() — dynamic import of the transformers.js URL. This is the ONE
//      thing no precedent covers (worker plugins bundle ORT locally; only Seek's
//      iframe must CDN-import under Obsidian's CSP).
//   3. process shim — Electron worker realms expose a Node-like `process` which
//      makes transformers pick the (externalized, dead) onnxruntime-node branch
//      and ORT's glue `require('worker_threads')` (smart-related-notes fought
//      exactly this). Report what this realm actually shows BEFORE flipping, so
//      the eventual embed-worker knows which shim layers it needs.
//   4. WebGPU       — navigator.gpu in dedicated workers is the documented
//      Chromium position, but ORT needs a device AND a real dispatch, so run one
//      compute pass on a GPUBuffer instead of trusting requestAdapter alone.
//
// Constraints mirrored from the child template: this body is concatenated into
// the iframe's own script string, so NO backticks anywhere below.
const WORKER_PROBE_BODY = [
    "const id = " + "'__PROBE_ID__'" + ";",
    // process shim report (no flip — evidence only, see comment above).
    "let proc = null;",
    "try { proc = typeof process !== 'undefined' ? process : null; } catch (e0) {}",
    "const procInfo = {",
    "    seen: !!proc,",
    "    versionsNode: proc && proc.versions ? String(proc.versions.node || '') : null,",
    "    type: proc ? String(proc.type || '') : null,",
    "};",
    "async function probeWebgpu() {",
    "    const out = { api: false, adapter: false, device: false, computePass: false, error: null };",
    "    try {",
    "        if (typeof navigator === 'undefined' || !navigator.gpu) { out.error = 'navigator.gpu missing'; return out; }",
    "        out.api = true;",
    "        const adapter = await navigator.gpu.requestAdapter();",
    "        if (!adapter) { out.error = 'requestAdapter returned null'; return out; }",
    "        out.adapter = true;",
    "        const device = await adapter.requestDevice();",
    "        out.device = true;",
    "        const buf = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });",
    "        const enc = device.createCommandEncoder();",
    "        const pass = enc.beginComputePass();",
    "        pass.dispatchWorkgroups(1);",
    "        pass.end();",
    "        device.queue.submit([enc.finish()]);",
    "        await device.queue.onSubmittedWorkDone();",
    "        out.computePass = true;",
    "        try { buf.destroy(); } catch (e1) {}",
    "        try { device.destroy(); } catch (e2) {}",
    "    } catch (e3) {",
    "        out.error = String(e3 && e3.message ? e3.message : e3);",
    "    }",
    "    return out;",
    "}",
    "async function run() {",
    "    const t0 = Date.now();",
    "    let importOk = false, importError = null;",
    "    try {",
    "        await import(" + "'__CDN_URL__'" + ");",
    "        importOk = true;",
    "    } catch (e4) {",
    "        importError = String(e4 && e4.message ? e4.message : e4);",
    "    }",
    "    const webgpu = await probeWebgpu();",
    "    const result = {",
    "        probeId: id,",
    "        importOk: importOk,",
    "        importError: importError,",
    "        importMs: importOk ? Date.now() - t0 : null,",
    "        process: procInfo,",
    "        webgpu: webgpu,",
    "    };",
    "    self.postMessage({ __workerProbeResult: true, id: id, result: result });",
    "}",
    "try { run(); } catch (e5) {",
    "    self.postMessage({ __workerProbeResult: true, id: id, result: null, fatal: String(e5) });",
    "}",
].join('\n');

// Exported for testing only — same rationale as buildChildScript.
export function buildWorkerProbeScript(cdnUrl: string): string {
    return WORKER_PROBE_BODY
        .replace("'__PROBE_ID__'", JSON.stringify('wp-' + Math.random().toString(36).slice(2)))
        .replace("'__CDN_URL__'", JSON.stringify(cdnUrl));
}

// ── T8 spike: the REAL embed worker ─────────────────────────────────────
// A functional nested worker that loads the actual model (same repo/revision/
// dtype as the iframe pipeline) and answers 'embed' RPCs with 384-d vectors.
// This is the architectural proof for moving the whole runtime off the shared
// renderer main thread. Design decisions, carried over from the research phase
// (smart-related-notes precedent + our probe measurements):
//
//  - ORT/transformers NODE-branch shim: Electron worker realms expose a Node-like
//    `process` (our probe measured versions.node=24.x, type='worker'). transformers
//    reads `process.release.name === 'node'` ONCE at import to pick onnxruntime-node
//    (externalized → dead in-realm); ORT's glue checks `process.type !=
//    'renderer'` at session-create and would require('worker_threads'). We set
//    process.type='renderer' persistently and flip release.name around the
//    transformers import (restore on the next microtask — the exact ort-shim
//    choreography from smart-related-notes). With type already 'renderer', the
//    glue's own check is false, so its node branch never runs and the glue text
//    needs no patching — tx.js loads it from the CDN itself.
//  - No pthread pool: numThreads=1 (cross-origin isolation is absent in the
//    srcdoc realm, so threaded wasm isn't available; ORT also latches wasm-init
//    per realm, so a failed threaded bring-up would be unrecoverable in-realm).
//  - dtype pinned q4 = the iframe's WEBGPU_DTYPE_LADDER[0]; device pinned webgpu
//    (the probe proved adapter+device+compute in this realm). No ladder: this is
//    a spike — a real load failure surfaces as the error string.
//  - Padding: fixed 128 cap, single-text spike (not the bucketed index path).
//    CLS-pooled + L2-normalized in-worker, same math as sliceAndRenormalize.
//  - Reply TRANSFERS the vector buffer (zero-copy), like the child's embed RPC.
//  - The ~250 MB model load reuses the browser Cache API (a blob: worker
//    inherits the iframe origin = the same cache the iframe pipeline populated).
//
// Constraints mirrored from the child template: NO backticks (this body is
// concatenated into the iframe's script string).
const EMBED_WORKER_BODY = [
    "const CDN_URL = " + "'__CDN_URL__'" + ";",
    "const MODEL_ID = " + "'__MODEL_ID__'" + ";",
    "const REVISION = " + "'__REVISION__'" + ";",
    "const DTYPE = 'q4';",
    "const EMBED_DIM = " + "'__DIM__'" + ";",
    "const SEQ_CAP = 128;",
    // ── ORT/transformers node-branch shim (evidence from runWorkerProbe) ──
    // process.type is flipped PERSISTENTLY (ORT's glue re-checks it at
    // session-create). release.name must be flipped around the DYNAMIC import
    // of transformers (see ensurePipeline) — NOT at worker startup: IS_NODE_ENV
    // is captured during module evaluation, which happens when the import runs,
    // long after this top-level code. (The smart-related-notes shim restores on
    // a microtask only because its static import chain evaluates transformers
    // in the same tick.)
    "const proc = (typeof process !== 'undefined') ? process : null;",
    "if (proc && proc.type !== 'renderer') {",
    "    try { proc.type = 'renderer'; } catch (e0) {",
    "        try { Object.defineProperty(proc, 'type', { value: 'renderer', configurable: true, writable: true }); } catch (e1) {}",
    "    }",
    "}",
    "const release = proc && proc.release ? proc.release : null;",
    "function flipReleaseNameForImport() {",
    "    if (!release || release.name === 'node') {",
    "        let flipped = false;",
    "        try { if (release) { release.name = 'obsidian-iframe-worker'; flipped = true; } } catch (e2) {",
    "            try { Object.defineProperty(release, 'name', { value: 'obsidian-iframe-worker', configurable: true, writable: true }); flipped = true; } catch (e3) {}",
    "        }",
    "        return () => { try { if (flipped && release) release.name = 'node'; } catch (e4) {} };",
    "    }",
    "    return () => {};",
    "}",
    "",
    "let tx = null;          // transformers module namespace",
    "let pipe = null;        // feature-extraction pipeline",
    "let loadingPromise = null;",
    "",
    "async function ensurePipeline() {",
    "    if (pipe) return pipe;",
    "    if (loadingPromise) return loadingPromise;",
    "    loadingPromise = (async () => {",
    "        const restore = flipReleaseNameForImport();",
    "        try {",
    "            if (!tx) tx = await import(CDN_URL);",
    "        } finally {",
    "            restore();",
    "        }",
    "        const { pipeline: createPipeline, env } = tx;",
    "        env.allowLocalModels = false;",
    "        env.allowRemoteModels = true;",
    "        env.useBrowserCache = true;",
    "        const onnx = env.backends && env.backends.onnx ? env.backends.onnx : null;",
    "        const setFlags = (o) => {",
    "            if (!o) return;",
    "            o.numThreads = 1;",
    "            o.proxy = false;",
    "        };",
    "        setFlags(onnx ? onnx.wasm : null);",
    "        setFlags(onnx && onnx.env ? onnx.env.wasm : null);",
    "        pipe = await createPipeline('feature-extraction', MODEL_ID, {",
    "            device: 'webgpu',",
    "            dtype: DTYPE,",
    "            ...(REVISION ? { revision: REVISION } : {}),",
    "        });",
    "        return pipe;",
    "    })();",
    "    try { await loadingPromise; }",
    "    catch (e) { loadingPromise = null; pipe = null; throw e; }",
    "    return loadingPromise;",
    "}",
    "",
    "function norm(v) {",
    "    let n = 0;",
    "    for (let i = 0; i < v.length; i++) n += v[i] * v[i];",
    "    n = Math.sqrt(n);",
    "    if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;",
    "    return v;",
    "}",
    "",
    "async function embedOne(text) {",
    "    await ensurePipeline();",
    "    const out = await pipe(text, {",
    "        pooling: 'cls', normalize: true,",
    "        padding: 'max_length', truncation: true, max_length: SEQ_CAP,",
    "    });",
    "    const d = out.dims;",
    "    const dim = d[d.length - 1];",
    "    if (dim < EMBED_DIM) throw new Error('model dim ' + dim + ' < EMBED_DIM ' + EMBED_DIM);",
    "    const vec = new Float32Array(EMBED_DIM);",
    "    vec.set(new Float32Array(out.data.buffer, out.data.byteOffset, EMBED_DIM));",
    "    if (typeof out.dispose === 'function') out.dispose();",
    "    return norm(vec);",
    "}",
    "async function handleEmbed(req) {",
    "    const t0 = Date.now();",
    "    const vector = await embedOne(req.text);",
    "    self.postMessage({ __embedWorkerReply: true, id: req.id, ok: true,",
    "        vector: vector, latencyMs: Date.now() - t0, dim: vector.length }, [vector.buffer]);",
    "}",
    // Batch path for the production route (indexer). Sequential forwards on
    // the worker's own pipeline — each row transfers independently; the batch
    // reply fails whole on any error (the caller treats it as one rejection).
    "async function handleBatch(req) {",
    "    const t0 = Date.now();",
    "    const vectors = [];",
    "    for (const text of req.texts) {",
    "        vectors.push(await embedOne(text));",
    "    }",
    "    const transfers = vectors.map(v => v.buffer);",
    "    self.postMessage({ __embedWorkerReply: true, id: req.id, ok: true,",
    "        vectors: vectors, latencyMs: Date.now() - t0 }, transfers);",
    "}",
    "",
    "self.onmessage = async (e) => {",
    "    const req = e.data;",
    "    if (!req || typeof req !== 'object' || !req.id) return;",
    "    try {",
    "        if (req.type === 'embed') await handleEmbed(req);",
    "        else if (req.type === 'embed-batch') await handleBatch(req);",
    "        else if (req.type === 'load') await ensurePipeline().then(",
    "            () => self.postMessage({ __embedWorkerReply: true, id: req.id, ok: true, ready: true }),",
    "            (err) => self.postMessage({ __embedWorkerReply: true, id: req.id, ok: false, error: String(err) }));",
    "        else self.postMessage({ __embedWorkerReply: true, id: req.id, ok: false, error: 'unknown type ' + req.type });",
    '    } catch (err) {',
    "        self.postMessage({ __embedWorkerReply: true, id: req.id, ok: false, error: String(err) });",
    '    }',
    "};",
    "",
    "self.postMessage({ __embedWorkerReply: true, id: '__ready', ok: true, ready: true });",
].join('\n');

// Exported for testing only — same rationale as buildChildScript. dim rides
// along so tests can assert the contract without importing the registry.
export function buildEmbedWorkerScript(cdnUrl: string, modelId: string, revision: string | null, dim: number): string {
    return EMBED_WORKER_BODY
        .replace("'__CDN_URL__'", JSON.stringify(cdnUrl))
        .replace("'__MODEL_ID__'", JSON.stringify(modelId))
        .replace("'__REVISION__'", JSON.stringify(revision ?? ''))
        .replace("'__DIM__'", JSON.stringify(dim));
}

// Exported for testing only — the string content of the RPC dispatch handler
// (e.g. the source-origin check) can't be exercised via a real srcdoc iframe
// in the node test env, so tests assert on the emitted script text instead.
export function buildChildScript(cdnUrl: string, outputDim: number): string {
    // Script body runs INSIDE the iframe. It imports transformers.js from CDN,
    // owns pipeline state, and responds to postMessage RPCs from the parent.
    // The ${...} substitutions below pin the warmup grid AND the output dimension
    // to the parent's exported constants so the localStorage fingerprint cache and
    // the vector width stay accurate by construction. NOTE: the child body is a
    // template literal in the parent — code inside it must NOT use backticks or
    // ${} (single-quote concatenation only), or the parent will eval it.
    return `
const CDN_URL = ${JSON.stringify(cdnUrl)};
${WEBGPU_POWER_PREFERENCE_WARN_FILTER}
const WARMUP_BATCH_SIZES = ${JSON.stringify(WARMUP_BATCH_SIZES)};
const SEQ_BUCKETS = ${JSON.stringify(SEQ_BUCKETS)};
const QUERY_SEQ_BUCKETS = ${JSON.stringify(QUERY_SEQ_BUCKETS)};
// T8 spike — the REAL embed worker's full source (from buildEmbedWorkerScript),
// inlined at build time so the child can spawn it from a blob without a
// network fetch. JSON.stringify makes it a safe JS string literal.
const __EMBED_WORKER_SOURCE__ = ${JSON.stringify(buildEmbedWorkerScript(cdnUrl, ACTIVE_MODEL_SPEC.repo, ACTIVE_MODEL_SPEC.revision, outputDim))};
let pipeline = null;
// Standalone tokenizer (no model weights) for the sidecar hydrate's chunk-id
// reproduction. Independent of pipeline — survives recycle.
let standaloneTokenizer = null;
// EP of the loaded pipeline ('webgpu' | 'wasm'). Drives the padding mode:
// bucket-padding exists ONLY for Dawn's shape-keyed shader cache (one WGSL
// compile per tensor shape, SafeInt-overflow discipline). The CPU EP has no
// fixed-shape constraint, so on wasm we pad to the LONGEST SEQUENCE IN THE
// BATCH instead of the bucket rung — at the measured ~85% bucket efficiency
// that's ~15% of all CPU forward work spent multiplying padding, for free
// (2026-06-11 iPhone WASM run analysis).
let currentDevice = null;

// ── wasm Memory.maximum clamp (2026-06-14, WebKit-only) ──────────────────
// Probe B (experiments/lazyrelease-probe.html) confirmed the ort-wasm glue
// instantiates WebAssembly.Memory with maximum=65536 pages (4 GiB), shared. On
// a memory-pressured iPhone that 4 GiB reservation OOMs at INSTANTIATION
// (RangeError: Out of memory -> "no available backend found"), before a single
// embed runs -- observed 2026-06-14 the first time we forced WebGPU on the
// phone (the heavier asyncify glue + the 4 GiB shared max tipped a pressured
// WebContent over; the failed attempt then took the WASM fallback down too).
// Clamp the maximum so the reservation is a fraction of the ~1.5 GiB WebContent
// budget while leaving generous headroom over the working set (WebGPU mode
// keeps activations on the GPU; the wasm heap holds tokenizer + I/O staging,
// and use_ort_model_bytes_directly avoids a model copy). EXPERIMENT: if iOS
// only reserves address space this is a no-op; if it pre-charges the maximum
// against jetsam (the investigation's read) it is the fix. Risk: a growth-OOM
// mid-run if the heap genuinely needs more than the cap -> watch for a LATER
// RangeError and raise WASM_MAX_PAGES if so. WebKit-only: desktop/Electron keep
// the 4 GiB default (memory is ample there). Must run before any wasm
// instantiation; isWebKit is a hoisted function declaration below. This block
// lives inside the iframe srcdoc template literal -- no backticks here. REVERT:
// delete this block.
const WASM_MAX_PAGES = 8192; // 512 MiB (page = 64 KiB); 65536 = the 4 GiB default. 2026-06-14: 16384 (1 GiB) loaded WebGPU but the reservation ate steady-state headroom (foreground kill at ~9.5k tokens / 8 files, EARLIER than the un-capped 12-22k); 512 MiB leaves the pool more room. Raise if model load growth-OOMs; lower toward 6144 if steady-state still dies early.
if (typeof isWebKit === 'function' && isWebKit() && typeof WebAssembly !== 'undefined' && WebAssembly.Memory) {
    const OrigMemory = WebAssembly.Memory;
    const ClampedMemory = function (desc) {
        if (desc && typeof desc === 'object' && typeof desc.maximum === 'number' && desc.maximum > WASM_MAX_PAGES) {
            desc = Object.assign({}, desc, { maximum: WASM_MAX_PAGES });
        }
        return new OrigMemory(desc);
    };
    ClampedMemory.prototype = OrigMemory.prototype;
    try { WebAssembly.Memory = ClampedMemory; } catch (_) { /* frozen global -- leave default */ }
}

// ── WebGPU loss diagnostics (2026-06-11) ────────────────────────────────
// Three iPhone WebGPU-reindex deaths left ZERO OS-side forensics (no
// JetsamEvent, no crash .ips) — so the kill is likely WebKit-internal, and
// the only remaining discriminator is in-page: GPUDevice.lost resolves when
// the GPU process dies (the page SURVIVES and sees it), while a WebContent
// process kill gives JS nothing at all. Absence of a device-lost breadcrumb
// before a crash-detected verdict therefore reads as "WebContent died
// directly". ORT-Web requests its device internally — we never see the call
// — so hook GPUAdapter.prototype.requestDevice and instrument every device
// created in this realm. Events post to the parent, which writes them to
// the SYNCHRONOUS forensics ring before the async NDJSON append; the
// breadcrumb must win the race against a death that may follow within ms.
let deviceSeq = 0;
let gpuEventBudget = 12; // lifetime cap — a crash-looping device must not flood the ring
function postGpuEvent(event) {
    if (gpuEventBudget <= 0) return;
    gpuEventBudget--;
    try { window.parent.postMessage({ id: '__event', event }, '*'); } catch (_) {}
}
if (navigator.gpu && typeof GPUAdapter !== 'undefined') {
    const origRequestDevice = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (desc) {
        const device = await origRequestDevice.call(this, desc);
        const seq = ++deviceSeq;
        try {
            postGpuEvent({
                kind: 'webgpu-device-created',
                deviceSeq: seq,
                // What ORT asked for — never observed before this hook.
                requiredFeatures: desc && desc.requiredFeatures ? Array.from(desc.requiredFeatures).map(String).join(',') : '',
                requiredLimitCount: desc && desc.requiredLimits ? Object.keys(desc.requiredLimits).length : 0,
            });
            device.lost.then((info) => {
                postGpuEvent({
                    kind: 'webgpu-device-lost',
                    deviceSeq: seq,
                    reason: String((info && info.reason) || 'unknown'),
                    message: String((info && info.message) || '').slice(0, 300),
                });
            }, () => {});
            device.addEventListener('uncapturederror', (e) => {
                const err = e && e.error;
                postGpuEvent({
                    kind: 'webgpu-uncaptured-error',
                    deviceSeq: seq,
                    error: String((err && err.message) || err).slice(0, 300),
                });
            });
        } catch (_) { /* diagnostics must never break the load path */ }
        return device;
    };
}

// OUTPUT_DIM is INJECTED from the parent (ACTIVE_MODEL_SPEC.dim) so it can never
// drift from embedder.EMBEDDING_DIM or the sidecar record stride. granite-r2
// outputs a 384-d CLS-pooled vector natively (NOT MRL), so sliceAndRenormalize is
// a pass-through; a Matryoshka model injects a smaller dim and the slice truncates
// to it. The embed guards below fail loud if the model's real width < OUTPUT_DIM
// (sliceAndRenormalize would otherwise silently emit a too-short vector).
const OUTPUT_DIM = ${JSON.stringify(outputDim)};

// Dtype ladder for WebGPU. tryWebgpu walks this in order and accepts the
// first dtype whose shaders compile.
//
// q4-only (q8 dropped). q4 ≈ q8 quality on this vault (fused NDCG@10
// Δ=0.0005) and, on the pinned v4 runtime, q4 is also the *fastest and
// lightest* config (20.6 ch/s, ~103 MB heap vs q8's 13.2 ch/s, ~380 MB —
// see the TRANSFORMERS_VERSION floor comment). So q8 is strictly dominated;
// no q8 rung.
//
// History, corrected: on the old 3.8.0 ORT-Web q8 genuinely *was* ~2×
// faster than q4 (13.2 vs 6.7 ch/s) — NOT a fusion confound. Op-histogram
// diff of the onnx-community protos confirmed v3 q4 was fully fused (24×
// MultiHeadAttention, 48× RotaryEmbedding, identical to q8) and still 6.7
// ch/s. The entire gap was one op: q8 decomposes to ORT-Web's golden
// MatMul + DequantizeLinear; q4 uses MatMulNBits, whose 3.8.0-era WebGPU
// kernel ran a slow generic path for M>1 (every embedding call is
// M=seq_len). v4's 1.26-dev ORT-Web optimizes that kernel — which is the
// whole reason v4 is a hard floor, not an upgrade-when-convenient.
//
// tryWebgpu prefers the model_no_gather_q4 variant when reachable (leaner
// 1333-node graph, better-coalesced memory access vs plain model_q4's
// GatherBlockQuantized embedding-table path), falling back transparently.
// fp32 last: weight size ~6× heavier (1.23 GB) but always works if it fits
// in maxBufferSize — the lifeboat rung if q4 shaders ever fail to compile.
//
// q4f16 is intentionally absent. Gemma's LayerNorm shader fails to compile
// on Dawn with half-precision activations (ORT #26732 — observed bricking a
// full reindex in May 2026 with Invalid ShaderModule errors across all files).
const WEBGPU_DTYPE_LADDER = ['q4', 'fp32'];

// SEQ_BUCKETS is injected from the parent (see template substitution above).
// Kept as a single source of truth so the parent-side fingerprint cache
// can't drift from what the iframe actually warms.
function selectQueryBucket(tokenCount) {
    for (const b of QUERY_SEQ_BUCKETS) { if (tokenCount <= b) return b; }
    return QUERY_SEQ_BUCKETS[QUERY_SEQ_BUCKETS.length - 1];
}

function selectBucket(charCount) {
    const est = Math.ceil(charCount / 4.5);
    for (const b of SEQ_BUCKETS) { if (est <= b) return b; }
    return 512;
}

// WebKit JSEP guard. ORT #26827: Safari/WebKit's WASM compiler enters an
// infinite loop through parseAndCompileOMG → GraphColoringStackAllocator
// when JSEP (WebGPU) mode is active, pinning CPU at 400%+ and growing memory
// to 14 GB+ before the process dies. Triggered once iOS 26 / visionOS 26
// expose WebGPU in WKWebView. Electron's UA also contains "Safari" because
// of its WebKit lineage, so explicitly exclude it.
function isWebKit() {
    const ua = navigator.userAgent;
    return /Safari/.test(ua) && !/Chrome/.test(ua) && !/Electron/.test(ua);
}

function sliceAndRenormalize(vec, targetDim) {
    if (vec.length <= targetDim) return vec;
    const sliced = new Float32Array(targetDim);
    for (let i = 0; i < targetDim; i++) sliced[i] = vec[i];
    let norm = 0;
    for (let i = 0; i < targetDim; i++) norm += sliced[i] * sliced[i];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < targetDim; i++) sliced[i] /= norm;
    return sliced;
}

// tx.js 4.x serializes every session creation through a module-level
// promise chain with NO rejection handler (src/backends/onnx.js:
// webInitChain = webInitChain.then(load) — still true in 4.3.0). One
// rejected createPipeline poisons the chain for the module instance's
// lifetime: every later attempt SKIPS its load() and re-throws the FIRST
// error verbatim. That's why the 2026-06-10 iPad failure surfaced the raw
// "[webgpu] webgpuInit is not a function" error with no ladder/fallback
// wrapping — the wasm fallback never ran. Fix: give each load attempt a
// fresh module instance via a fragment-suffixed dynamic import. The module
// map keys on the full URL (fragment included) so '#seek-gen-2' is a
// distinct instance, while fetch strips the fragment — same HTTP cache
// entry, no re-download.
let importGen = 0;
async function freshTransformers(modelId) {
    importGen++;
    const mod = await import(CDN_URL + (importGen > 1 ? '#seek-gen-' + importGen : ''));
    const { pipeline: createPipeline, env, AutoTokenizer } = mod;
    // Phase-5 local-model override: a model id with a URL scheme
    // (app://local/..., capacitor://..., http(s)://) that isn't the HF
    // hub means load LOCAL weights. transformers.js then path-joins the
    // base with /onnx/model_*.onnx (plus the .onnx_data sidecar) and
    // fetch()es it from the vault resource URL instead of the HF CDN.
    const isLocalBase = modelId.includes('://') && !modelId.includes('huggingface.co');
    env.allowLocalModels = isLocalBase;
    env.allowRemoteModels = !isLocalBase;
    env.useBrowserCache = !isLocalBase;
    return { createPipeline, env, AutoTokenizer };
}

// Tokenizer-only load (no ONNX session) for the sidecar hydrate. Reuses
// freshTransformers' env wiring (CDN/local + browser cache) so the tokenizer
// files resolve identically to a full load. No webInitChain risk: AutoTokenizer
// never creates an ORT session. Idempotent — a second call no-ops.
async function loadTokenizer(modelId, revision) {
    if (standaloneTokenizer) return { ok: true, cached: true };
    const { AutoTokenizer } = await freshTransformers(modelId);
    if (!AutoTokenizer) throw new Error('transformers.js export missing AutoTokenizer — API changed?');
    standaloneTokenizer = await AutoTokenizer.from_pretrained(modelId, revision ? { revision } : {});
    return { ok: true, cached: false };
}

// tx.js 4.2.0 pinned anything Safari-detected — WKWebView included — to the
// PLAIN wasm glue (ort-wasm-simd-threaded.mjs), the dist variant compiled
// WITHOUT the webgpuInit entry point. So on WebKit the webgpu EP init was
// structurally guaranteed to throw "De().webgpuInit is not a function"
// regardless of what the GPU supports — this, not a WKWebView capability
// gap, was the 2026-06-02/06-10 iOS failure. 4.3.0 (#1700) changed the pin:
// Safari 26+ (and older Safari with navigator.gpu) get asyncify; only
// Safari <26 without WebGPU stays on the plain glue. The pin only applies
// when wasmPaths is unset, so rewriting wasmPaths right after import (before
// the first createPipeline caches it via ensureWasmLoaded) restores a
// WebGPU-capable glue on the remaining plain-pin path: jspi when the engine
// has JSPI (14.5 MB, no asyncify transform), else asyncify (23.6 MB). No-op
// when wasmPaths is already asyncify (Safari 26+ / desktop) or off WebKit.
// ⚠️ tx.js presumably pinned older Safari to the plain glue for a reason
// (ORT #26827-class WASM-compile hangs are the suspect), so this runs only
// on the WebGPU attempt path, which mobile only reaches on the 'auto'
// device (iPad by default, or a forced-WebGPU override — see platform.ts
// resolveDevice; iPhone + Android stay on WASM).
function overrideWebkitGlueForWebgpu(env) {
    const wp = env.backends.onnx.wasm.wasmPaths;
    if (!wp || typeof wp !== 'object' || !wp.mjs) return null;
    if (!String(wp.mjs).includes('ort-wasm-simd-threaded.mjs')) return null; // not the Safari plain pin
    const variant = typeof WebAssembly.Suspending === 'function' ? 'jspi' : 'asyncify';
    wp.mjs = String(wp.mjs).replace('ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.' + variant + '.mjs');
    wp.wasm = String(wp.wasm).replace('ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.' + variant + '.wasm');
    return variant;
}

// The mirror image, for the pure-WASM path on NON-WebKit engines. tx.js pins
// the ORT glue by ENGINE, not by requested device: WebKit gets the plain
// ort-wasm-simd-threaded build, everything else (Electron desktop, Android
// WebView) gets the asyncify WebGPU-native build — for device:'wasm' sessions
// too. Those builds do NOT carry the same CPU kernel set: the asyncify/jspi
// binaries register GatherBlockQuantized only on the webgpu EP, so a CPU-only
// session cannot place the GBQ4 model's quantized embedding-table node and
// session creation dies with "Could not find an implementation for
// GatherBlockQuantized" (r/ObsidianMD report, 2026-07-03) — the wasm fallback
// was dead-on-arrival on every Chromium machine, and with it "Force CPU" and
// all of Android. The plain build carries the full CPU kernel set (it is the
// binary every WebKit device has been running q4 on in production), so pin it
// for wasm sessions here. No-op on WebKit (already plain) and when wasmPaths
// is unset. Bonus: plain is 12.9 MB vs asyncify's 23.6 MB.
function overrideGlueForWasm(env) {
    const wp = env.backends.onnx.wasm.wasmPaths;
    if (!wp || typeof wp !== 'object' || !wp.mjs) return null;
    if (!String(wp.mjs).includes('ort-wasm-simd-threaded.asyncify.mjs')) return null; // already plain
    wp.mjs = String(wp.mjs).replace('ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.mjs');
    wp.wasm = String(wp.wasm).replace('ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.wasm');
    return 'plain';
}

async function tryWebgpu(modelId, preferredDtype, revision) {
    const order = [preferredDtype, ...WEBGPU_DTYPE_LADDER.filter(d => d !== preferredDtype)];
    const errors = [];
    for (const d of order) {
        // granite-r2's 50k vocab has no 256k-Gather hotspot, so the Gemma-era
        // model_no_gather_q4 variant doesn't exist (and isn't needed). Load the
        // stock onnx-community file per dtype: model_q4.onnx / model.onnx (fp32).
        try {
            const { createPipeline, env } = await freshTransformers(modelId);
            const glue = overrideWebkitGlueForWebgpu(env);
            try {
                // storageBufferCacheMode (2026-06-14, proven reachable via
                // experiments/lazyrelease-probe.html — ORT TraceSessionOptions
                // shows ep.webgpuExecutionProvider.storageBufferCacheMode set to
                // lazyRelease landing in the EP config_options, contradicting
                // the "extra is unreachable" prediction in Seek Mobile WebGPU
                // Investigation). ORT-Web's default bucket mode is the
                // cumulative-growth root cause of the iPhone steady-state kill:
                // a bucketed storage-buffer freelist that retains every distinct
                // size ever requested, with no global cap and no trim trigger.
                // lazyRelease frees storage buffers at onRunEnd, capping the
                // pool near working-set WITHOUT an iframe recycle. Gated to
                // (NOTE: this whole function body is inside the iframe srcdoc
                // template literal — no backticks permitted in comments here.)
                // WebKit: desktop/Electron keep bucket (memory is ample,
                // re-alloc-per-run would only cost throughput); the
                // memory-constrained iOS/iPadOS path opts into the release cost.
                // REVERT: delete the session_options branch. On-device efficacy
                // (does the iPhone now finish a reindex) is the real test, still
                // pending — reachability was the blocker, and it's cleared.
                const opts = isWebKit()
                    ? { device: 'webgpu', dtype: d, session_options: { extra: { 'ep.webgpuExecutionProvider.storageBufferCacheMode': 'lazyRelease' } } }
                    : { device: 'webgpu', dtype: d };
                if (revision) opts.revision = revision;   // F10: pin the model commit
                const p = await createPipeline('feature-extraction', modelId, opts);
                // glue is non-null only when the WebKit override rewrote the
                // Safari plain pin (jspi/asyncify) — i.e. exactly the iOS path
                // under investigation. Surfacing it on SUCCESS closes the "we
                // never log which glue actually ran" gap (it was only ever
                // recorded on failure, inside the error string).
                return { pipeline: p, dtype: d, errors, glue };
            } catch (e) {
                errors.push(d + (glue ? ' (glue:' + glue + ')' : '') + ': ' + String(e));
            }
        } catch (e) {
            errors.push(d + ': import failed: ' + String(e));
        }
    }
    throw new Error('all WebGPU dtypes failed: ' + errors.join(' | '));
}

async function loadModel(modelId, requestedDevice, requestedDtype, skipWarmup, revision) {
    const t0 = performance.now();

    let webgpuAttempted = false;
    let webgpuError = null;

    if (requestedDevice === 'webgpu' || requestedDevice === 'auto') {
        webgpuAttempted = true;
        if (!navigator.gpu) {
            webgpuError = 'navigator.gpu not present';
        } else {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    webgpuError = 'requestAdapter returned null';
                } else {
                    try {
                        const r = await tryWebgpu(modelId, requestedDtype, revision);
                        pipeline = r.pipeline;
                        // Warmup: one forward pass per (batch_size, seq_len_bucket) pair
                        // forces Dawn to compile all WGSL shaders upfront. Dawn encodes
                        // batch_size into the dispatch grid, so (1,64) and (2,64) are
                        // distinct compiled pipelines. [1..8] is the exact set the
                        // rolling-buffer indexer dispatches (fixed flush size 8 +
                        // partial-drain remainders 1..7); no shape outside the warmed
                        // grid is ever requested, which is what keeps the ORT-Web
                        // WebGPU pool off the SafeInt-overflow path the reverted
                        // arbitrary-coalescer hit. 8 batch sizes × 9 seq buckets =
                        // 72 passes × ~50 ms ≈ 3.6 s on first cold-start; Dawn
                        // persists to disk cache so later sessions pay only inference
                        // time. Keep WARMUP_BATCH_SIZES/SEQ_BUCKETS in sync with the
                        // indexer's ROLLING_BATCH + selectBucket (search.ts).
                        // Warmup skip: if the parent's localStorage fingerprint
                        // says we've already warmed this exact (model, dtype,
                        // transformers_version, grid) combo, skip the 40
                        // forced dispatches. On desktop measurements
                        // (2026-05-19) the warmup costs ~1020 ms locked across
                        // consecutive reloads with the Dawn shader cache hot,
                        // so this is the largest single warm-reload lever.
                        // The actual first-use compile (if any shape isn't
                        // in Dawn's cache) is paid lazily by the live call
                        // — same behavior as the try/catch around each
                        // warmup dispatch already implies.
                        let warmupMs = null;
                        if (!skipWarmup) {
                            const warmupStart = performance.now();
                            for (const n of WARMUP_BATCH_SIZES) {
                                const batch = Array(n).fill('warmup');
                                for (const bucket of SEQ_BUCKETS) {
                                    try {
                                        await pipeline(batch, {
                                            pooling: 'cls', normalize: true,
                                            padding: 'max_length', truncation: true, max_length: bucket,
                                        });
                                    } catch (_) { /* non-fatal — live call compiles on first use */ }
                                }
                            }
                            // Query path is batch=1 on QUERY_SEQ_BUCKETS; the loop
                            // above already warmed every (1 × SEQ_BUCKETS) shape, so
                            // only the query-only floors (8, 16) need compiling here.
                            for (const bucket of QUERY_SEQ_BUCKETS) {
                                if (SEQ_BUCKETS.includes(bucket)) continue;
                                try {
                                    await pipeline(['warmup'], {
                                        pooling: 'cls', normalize: true,
                                        padding: 'max_length', truncation: true, max_length: bucket,
                                    });
                                } catch (_) { /* non-fatal — live call compiles on first use */ }
                            }
                            warmupMs = performance.now() - warmupStart;
                        }
                        return {
                            device: 'webgpu', dtype: r.dtype,
                            coldStartMs: performance.now() - t0,
                            warmupMs,
                            warmupSkipped: !!skipWarmup,
                            webgpuAttempted, webgpuError: null,
                            glue: r.glue ?? null,
                            // The proxy worker is wasm-EP-only (the webgpu EP
                            // needs its device on the creating thread).
                            proxy: false, proxyAttempted: false, proxyError: null,
                        };
                    } catch (e) {
                        webgpuError = String(e);
                    }
                }
            } catch (e) {
                webgpuError = 'requestAdapter threw: ' + String(e);
            }
        }
        if (requestedDevice === 'webgpu') {
            throw new Error('WebGPU requested but failed: ' + webgpuError);
        }
    }

    // WASM fallback — always on a FRESH module instance (a failed WebGPU
    // attempt above poisoned the previous instance's webInitChain; see
    // freshTransformers). Glue: on WebKit the wasm EP rides tx.js's Safari
    // plain-glue pin (the known-good mobile path); on every OTHER engine
    // overrideGlueForWasm rewrites tx.js's asyncify pin back to the same
    // plain build, because asyncify has no CPU GatherBlockQuantized kernel
    // and a q4 session can never be created on it (see the function comment).
    //
    // Both-fail rethrow: if WebGPU was attempted and the wasm leg ALSO dies,
    // throwing only the wasm error strands the WebGPU failure cause —
    // loadModel throws before returning the LoadResult, so webgpuAttempted /
    // webgpuError never reach the log and the diagnostic report shows only
    // the terminal wasm session error, not the WebGPU init failure that
    // forced the fallback (exactly the blind spot in the r/ObsidianMD
    // report). Combine both causes so 'why did WebGPU fail' is answerable.
    const wasmFail = function (e) {
        if (webgpuAttempted && webgpuError) {
            const combined = new Error('model load failed on both paths — webgpu: ' + webgpuError + ' || wasm: ' + String(e));
            // Keep the terminal wasm throw-site stack: the child handler posts
            // e.stack to the parent, and without this the combined error's
            // stack points HERE instead of into ORT — degrading the forensic
            // channel this rethrow exists to protect.
            if (e && e.stack) combined.stack = combined.stack + '\\ncaused by (wasm): ' + e.stack;
            return combined;
        }
        return e;
    };
    // Proxy-worker first (issue #5): host the ENTIRE wasm backend — binary
    // compile, session init (the coldStartMs >= 5000 block), and every
    // session.run — in ort-web's own proxy worker, so CPU inference stops
    // sharing the app's main thread. Same glue, same single-threaded kernels
    // (no crossOriginIsolated either way), so vectors and throughput are
    // identical; only which thread burns changes. ANY failure — Worker
    // blocked by CSP, the glue import failing inside the worker, session
    // create — falls through to the exact pre-proxy ladder below, so the
    // worst case is precisely the old behavior. proxyError rides the
    // LoadResult so a fleet-wide silent fallback is visible in reports.
    let wasmGlue = null;
    let proxyAttempted = false;
    let proxyError = null;
    if (typeof Worker === 'function') {
        proxyAttempted = true;
        try {
            const { createPipeline, env } = await freshTransformers(modelId);
            wasmGlue = overrideGlueForWasm(env);
            env.backends.onnx.wasm.proxy = true;
            pipeline = await createPipeline('feature-extraction', modelId, { device: 'wasm', dtype: requestedDtype, ...(revision ? { revision } : {}) });
            return {
                device: 'wasm', dtype: requestedDtype,
                coldStartMs: performance.now() - t0,
                warmupMs: null,
                warmupSkipped: false,
                webgpuAttempted, webgpuError,
                glue: wasmGlue,
                proxy: true, proxyAttempted, proxyError: null,
            };
        } catch (e) {
            proxyError = String(e);
        }
    }
    // SIMD retry: transformers.js v3+ requires SIMD in sandboxed iframe /
    // WKWebView contexts; auto-detection can silently report "no available
    // backend" instead of falling back. Catch that case and retry — again on
    // a fresh instance, since the failure just poisoned this one — with SIMD
    // + multithread explicitly disabled (the conservative path the runtime
    // would have picked if detection had worked).
    try {
        const { createPipeline, env } = await freshTransformers(modelId);
        wasmGlue = overrideGlueForWasm(env);
        pipeline = await createPipeline('feature-extraction', modelId, { device: 'wasm', dtype: requestedDtype, ...(revision ? { revision } : {}) });
    } catch (e) {
        if (!String(e).includes('no available backend')) throw wasmFail(e);
        try {
            const { createPipeline, env } = await freshTransformers(modelId);
            wasmGlue = overrideGlueForWasm(env);
            env.backends.onnx.wasm.simd = false;
            env.backends.onnx.wasm.numThreads = 1;
            pipeline = await createPipeline('feature-extraction', modelId, { device: 'wasm', dtype: requestedDtype, ...(revision ? { revision } : {}) });
        } catch (e2) {
            throw wasmFail(e2);
        }
    }
    return {
        device: 'wasm', dtype: requestedDtype,
        coldStartMs: performance.now() - t0,
        // WASM path has no shader-compile warmup loop — kernels are JIT'd
        // on first call. null distinguishes "didn't run" from "ran in 0 ms".
        warmupMs: null,
        // warmupSkipped only ever true on the WebGPU success path; WASM
        // means "warmup didn't apply at all", which is different from
        // "warmup was skipped because we knew the shaders were cached".
        warmupSkipped: false,
        webgpuAttempted, webgpuError,
        glue: wasmGlue,
        proxy: false, proxyAttempted, proxyError,
    };
}

async function embedText(text) {
    if (!pipeline) throw new Error('Model not loaded');
    const t0 = performance.now();
    // QUERY path (single-embed is query-only; indexing uses embedBatch below).
    // Tokenize the cleaned query and bucket off its EXACT token length on the
    // small-floor, top-trimmed query ladder (QUERY_SEQ_BUCKETS). Because the
    // bucket is ≥ the real token count, max_length never truncates — the whole
    // query is always embedded. Double-tokenization (here + inside pipeline) is
    // ~µs on a handful of tokens, negligible vs the ~20 ms forward. Fallback to
    // the char estimate only if the tokenizer accessor ever changes shape.
    let bucket;
    try {
        const dims = (await pipeline.tokenizer(text)).input_ids.dims;
        bucket = selectQueryBucket(dims[dims.length - 1]);
    } catch (_) {
        bucket = selectQueryBucket(Math.ceil(text.length / 4.5));
    }
    // wasm: padding:true on a single text = zero padding (exact length); the
    // bucket survives only as the truncation safety cap. webgpu: pad to the
    // warmed bucket shape as always.
    const output = await pipeline(text, {
        pooling: 'cls', normalize: true,
        padding: currentDevice === 'wasm' ? true : 'max_length',
        truncation: true, max_length: bucket,
    });
    // Fail loud on a model/dim misconfig: if the model's real output width is
    // SMALLER than OUTPUT_DIM, sliceAndRenormalize returns the short vector
    // unchanged (vec.length <= targetDim), which would silently corrupt the index.
    const outDim = output.dims[output.dims.length - 1];
    if (outDim < OUTPUT_DIM) throw new Error('embed: model output dim ' + outDim + ' < OUTPUT_DIM ' + OUTPUT_DIM + ' - model/dim misconfig');
    const vector = sliceAndRenormalize(output.data, OUTPUT_DIM);
    // Release the tensor's backing buffer (incl. WebGPU readback) — sliceAndRenormalize
    // already returned a fresh Float32Array, so the output is detached from the tensor.
    // See 2026-05-19 bog-down diagnosis: undisposed tensors accumulated ~600-800 MB
    // between V8 major-GC sweeps and were the iOS sustained-loop killer.
    if (typeof output.dispose === 'function') output.dispose();
    return { vector, latencyMs: performance.now() - t0 };
}

async function embedBatch(texts, explicitBucket) {
    if (!pipeline) throw new Error('Model not loaded');
    const t0 = performance.now();
    // INDEX path. The parent routes chunks into per-bucket buffers by EXACT
    // token count (token-counts RPC + selectIndexBucket) and passes the bucket
    // here, so max_length always holds every input — truncation:true below is
    // a pure safety cap that the token-budget packer keeps unreachable.
    // Fallback to the char estimate only for legacy callers that omit the
    // bucket (the estimate under-buckets dense text — see selectBucket).
    let bucket = explicitBucket;
    if (!bucket || !SEQ_BUCKETS.includes(bucket)) {
        const maxChars = texts.reduce((m, t) => Math.max(m, t.length), 0);
        bucket = selectBucket(maxChars);
    }
    // wasm: pad to the longest sequence in the batch (HF padding:true), not
    // the bucket rung — chunks in a buffer share a bucket so the intra-batch
    // spread is bounded by it, and every pad column saved is CPU work saved.
    // webgpu: 'max_length' (= the bucket) is load-bearing — Dawn's shader
    // cache and the SafeInt discipline are keyed to the warmed shape set.
    const output = await pipeline(texts, {
        pooling: 'cls', normalize: true,
        padding: currentDevice === 'wasm' ? true : 'max_length',
        truncation: true, max_length: bucket,
    });
    const dims = output.dims;
    const dim = dims[dims.length - 1];
    // Fail loud on a model/dim misconfig (see embedText): a model narrower than
    // OUTPUT_DIM would have sliceAndRenormalize emit short vectors per row.
    if (dim < OUTPUT_DIM) throw new Error('embedBatch: model output dim ' + dim + ' < OUTPUT_DIM ' + OUTPUT_DIM + ' - model/dim misconfig');
    const data = output.data;
    const vectors = [];
    for (let i = 0; i < texts.length; i++) {
        const row = new Float32Array(data.buffer, data.byteOffset + i * dim * 4, dim);
        vectors.push(sliceAndRenormalize(row, OUTPUT_DIM));
    }
    // Dispose AFTER the loop — each row above is a view into output.data.buffer,
    // not a copy; sliceAndRenormalize materializes a fresh OUTPUT_DIM-wide Float32Array per row,
    // so by the time we get here the tensor's storage is no longer referenced.
    // Releases the WebGPU readback buffer that would otherwise stay alive until V8 GC.
    if (typeof output.dispose === 'function') output.dispose();
    return { vectors, latencyMs: performance.now() - t0 };
}

// Exact token counts for the parent's index-path bucket routing and the
// token-budget packer. Counted one text at a time (no padding involved), same
// accessor the query path uses (embedText above), specials included — so
// "count <= bucket" is exactly "the forward pass sees every token". Tokenizer
// only; never touches the model, so it is safe on both WebGPU and WASM and
// adds no GPU-session pressure (no recycle interplay).
async function tokenCounts(texts) {
    // Prefer the full pipeline's tokenizer; fall back to a standalone tokenizer
    // loaded via load-tokenizer (hydrate path, no model). Same AutoTokenizer +
    // modelId either way, so counts are identical.
    const tokenizer = (pipeline && pipeline.tokenizer) || standaloneTokenizer;
    if (!tokenizer) throw new Error('no tokenizer available — load the model or call load-tokenizer first');
    const counts = [];
    for (const t of texts) {
        const enc = await tokenizer(t);
        const dims = enc.input_ids.dims;
        counts.push(dims[dims.length - 1]);
    }
    return counts;
}

// ── T8 spike: nested dedicated-worker probe ─────────────────────────────
// Spawn a module Worker from a blob INSIDE this iframe realm, run
// buildWorkerProbeScript() in it (CDN import + process-shim report + a real
// WebGPU compute dispatch), relay the result to the parent, and terminate.
// Diagnostic only — no pipeline state is touched, and every failure is data
// (same philosophy as app-local-fetch): the reply is a structured WorkerProbe
//Result, never a rejection. Hard 12 s inner deadline: the worker is
// terminated on expiry so a wedged spawn can never trip the parent's RPC
// timeout instead of reporting.
const WORKER_PROBE_TIMEOUT_MS = 12000;
function trySpawnWorker(source) {
    try {
        const blob = new Blob([source], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        let w = null;
        try {
            w = new Worker(url, { type: 'module' });
        } catch (e) {
            try { URL.revokeObjectURL(url); } catch (e2) {}
            return { worker: null, url: url, error: String(e && e.message ? e.message : e) };
        }
        return { worker: w, url: url, error: null };
    } catch (e3) {
        return { worker: null, url: null, error: String(e3 && e3.message ? e3.message : e3) };
    }
}
async function runWorkerProbe() {
    const t0 = Date.now();
    const result = {
        spawnOk: false, spawnError: null, workerType: null,
        importOk: false, importError: null, importMs: null,
        processSeen: false, processVersionsNode: null, processType: null,
        webgpu: { api: false, adapter: false, device: false, computePass: false, error: null },
        durationMs: 0,
    };
    if (typeof Worker !== 'function') {
        result.spawnError = "Worker constructor missing";
        result.durationMs = Date.now() - t0;
        return result;
    }
    const workerProbeScript = ${JSON.stringify(buildWorkerProbeScript(cdnUrl))};
    const spawned = trySpawnWorker(workerProbeScript);
    result.workerType = 'module';
    if (!spawned.worker) {
        result.spawnError = spawned.error;
        result.durationMs = Date.now() - t0;
        return result;
    }
    result.spawnOk = true;
    const w = spawned.worker;
    await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            try { w.terminate(); } catch (e) {}
            try { URL.revokeObjectURL(spawned.url); } catch (e) {}
            resolve();
        };
        w.onmessage = (ev) => {
            const d = ev && ev.data;
            if (!d || d.__workerProbeResult !== true) return;
            const r = d.result;
            if (r) {
                result.importOk = !!r.importOk;
                result.importError = r.importError || null;
                result.importMs = typeof r.importMs === 'number' ? r.importMs : null;
                if (r.process) {
                    result.processSeen = !!r.process.seen;
                    result.processVersionsNode = r.process.versionsNode || null;
                    result.processType = r.process.type || null;
                }
                if (r.webgpu) result.webgpu = r.webgpu;
            } else {
                result.spawnError = "worker fatal: " + String(d.fatal || 'unknown');
            }
            finish();
        };
        w.onerror = (e) => {
            result.spawnError = "worker onerror: " + String(e && e.message ? e.message : e);
            finish();
        };
        const timer = window.setTimeout(finish, WORKER_PROBE_TIMEOUT_MS);
    });
    result.durationMs = Date.now() - t0;
    return result;
}

// ── T8 spike: REAL embed worker lifecycle (iframe child side) ───────────
// Hosts a long-lived dedicated worker running buildEmbedWorkerScript's body
// (injected below via __EMBED_WORKER_SOURCE__). Unlike the probe worker, this
// one STAYS ALIVE across RPCs (spawning it cold per embed would pay the model
// load every time) and is explicitly restarted by 'embed-worker-kill'. Reply
// routing mirrors the parent: __embedWorkerReply messages resolve pending
// worker promises; anything else is the unsolicited __ready handshake.
const embedWorkerPending = new Map();
let embedWorker = null;
let embedWorkerReady = null;
function killEmbedWorker(reason) {
    if (embedWorkerReady) { const r = embedWorkerReady; embedWorkerReady = null; r(); }
    const w = embedWorker;
    embedWorker = null;
    for (const [, p] of embedWorkerPending) {
        try { p.reject(new Error('embed worker killed: ' + reason)); } catch (e) {}
    }
    embedWorkerPending.clear();
    if (w) { try { w.terminate(); } catch (e2) {} }
}
function getEmbedWorker() {
    if (embedWorker) return embedWorkerReady;
    const source = __EMBED_WORKER_SOURCE__;
    let blobUrl = null;
    embedWorkerReady = new Promise((resolve, reject) => {
        try {
            blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            const w = new Worker(blobUrl, { type: 'module' });
            embedWorker = w;
            w.onerror = (e) => {
                const err = 'embed worker onerror: ' + String(e && e.message ? e.message : e);
                killEmbedWorker(err);
                reject(new Error(err));
            };
            w.onmessage = (ev) => {
                const d = ev && ev.data;
                if (!d || d.__embedWorkerReply !== true) return;
                if (d.id === '__ready') { resolve(w); return; }
                const p = embedWorkerPending.get(d.id);
                if (!p) return;
                embedWorkerPending.delete(d.id);
                if (d.ok) p.resolve(d);
                else p.reject(new Error(d.error || 'embed worker error'));
            };
        } catch (e) {
            embedWorker = null;
            embedWorkerReady = null;
            reject(e);
        }
    });
    return embedWorkerReady;
}
function embedWorkerRpc(req, timeoutMs) {
    return getEmbedWorker().then((w) => new Promise((resolve, reject) => {
        const id = req.id;
        const timer = window.setTimeout(() => {
            embedWorkerPending.delete(id);
            reject(new Error("embed worker RPC '" + req.type + "' timed out after " + timeoutMs + 'ms'));
        }, timeoutMs);
        embedWorkerPending.set(id, {
            resolve: (d) => { window.clearTimeout(timer); resolve(d); },
            reject: (e) => { window.clearTimeout(timer); reject(e); },
        });
        w.postMessage(req);
    }));
}
// Functional-spike result: worker vs iframe pipeline on the SAME text. The
// cosine is the correctness gate — same model, same pooling math, so the two
// realms must produce near-identical vectors.
async function runWorkerEmbedTest(text) {
    const t0 = Date.now();
    const out = { loadOk: false, loadError: null, loadMs: 0, embedOk: false, embedError: null, embedMs: 0, dim: 0, cosine: 0, workerKilled: false };
    if (typeof Worker !== 'function') { out.loadError = 'Worker constructor missing'; return out; }
    try {
        const wt0 = Date.now();
        await embedWorkerRpc({ id: 'wtest-load', type: 'load' }, 180000);
        out.loadOk = true;
        out.loadMs = Date.now() - wt0;
    } catch (e) {
        out.loadError = String(e && e.message ? e.message : e);
        out.workerKilled = embedWorker === null;
        return out;
    }
    try {
        const et0 = Date.now();
        const reply = await embedWorkerRpc({ id: 'wtest-embed', type: 'embed', text: String(text) }, 60000);
        out.embedOk = true;
        out.embedMs = Date.now() - et0;
        out.dim = reply.dim || 0;
        if (!pipeline) {
            out.cosine = -1;
        } else {
            const ref = await embedText(String(text));
            const a = reply.vector, b = ref.vector;
            let dot = 0, na = 0, nb = 0;
            for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
            out.cosine = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
        }
    } catch (e) {
        out.embedError = String(e && e.message ? e.message : e);
        out.workerKilled = embedWorker === null;
    }
    out.durationMs = Date.now() - t0;
    return out;
}

// Pseudo-natural text of ~targetTokens length (chunker estimates 4.5 ch/tok).
// Timing of forward/post is shape-bound, not content-bound, but tokenizer
// cost IS content-sensitive — so use a realistic sentence, not a repeated
// single token (which would under-measure the tokenize step).
const PROFILE_SENTENCE =
    'The quarterly review covered retrieval relevance, embedding throughput, ' +
    'and the mobile memory budget; follow-ups were assigned across the team. ';
function makeProfileText(targetTokens) {
    const targetChars = Math.ceil(targetTokens * 4.5);
    let s = '';
    while (s.length < targetChars) s += PROFILE_SENTENCE;
    return s.slice(0, targetChars);
}

// Unrolled, timed twin of the embed path. Reaches into pipeline.tokenizer /
// pipeline.model (standard transformers.js FeatureExtractionPipeline surface)
// to put a clock between the stages. Deliberately does NOT dispose the output
// tensor — this harness is a NON-disposing baseline for diagnostic comparison
// against the production embedText/embedBatch paths (which DO dispose, see
// 2026-05-19 bog-down diagnosis). The heap delta the parent records around
// this run is the cost of a single embed's tensors NOT being released.
// (No backticks anywhere in this child block: it lives inside a template
// literal, so a stray backtick would terminate the script string.)
async function profileRuntime(batchSizes, seqBuckets, reps) {
    if (!pipeline) throw new Error('Model not loaded');
    const tokenizer = pipeline.tokenizer;
    const model = pipeline.model;
    if (!tokenizer || !model) {
        throw new Error('pipeline missing tokenizer/model — transformers.js API changed?');
    }
    const cells = [];
    for (const bs of batchSizes) {
        for (const bucket of seqBuckets) {
            const texts = Array(bs).fill(makeProfileText(bucket));
            const opts = {
                pooling: 'cls', normalize: true,
                padding: 'max_length', truncation: true, max_length: bucket,
            };
            const tokOpts = { padding: 'max_length', truncation: true, max_length: bucket };
            // Warm THIS exact (bs,bucket) shape once. load() already warms the
            // matrix, but a profile cell the warmup list missed would otherwise
            // fold a one-time WGSL compile into rep 0 and skew the p50.
            try { await pipeline(texts, opts); } catch (_) { /* compiled on first real use below */ }
            const tokenize = [], forward = [], post = [], pipe = [];
            for (let r = 0; r < reps; r++) {
                const a = performance.now();
                const inputs = await tokenizer(texts, tokOpts);
                const b = performance.now();
                const out = await model(inputs);
                const c = performance.now();
                // Force the GPU→CPU materialization. For a WebGPU-resident
                // tensor, touching .data is what actually pays the readback —
                // the sync stall the "per-inference serialization" hypothesis
                // points at. Measured separately from forward on purpose.
                const lhs = out.last_hidden_state || out.logits
                    || out.token_embeddings || out.sentence_embedding;
                const len = lhs && lhs.data ? lhs.data.length : 0;
                const d = performance.now();
                void len;
                // Production pipeline() total on identical inputs — the
                // decomposition sanity check (tokenize+forward+post ≈ pipe).
                const e = performance.now();
                await pipeline(texts, opts);
                const f = performance.now();
                tokenize.push(b - a);
                forward.push(c - b);
                post.push(d - c);
                pipe.push(f - e);
            }
            cells.push({ batchSize: bs, seqBucket: bucket, reps, tokenize, forward, post, pipe });
        }
    }
    return { cells };
}

// Collect the unique ArrayBuffers behind an embed result so the reply can
// TRANSFER them (zero-copy) instead of letting structured-clone deep-copy
// every vector. The reply round-trip is the heavy hop: result.vectors is
// batch x 384 x 4 bytes, paid once per dispatch (1245 dispatches @ budget 512).
//
// MUST dedup: at 384-d sliceAndRenormalize is a pass-through, so every row in
// a batch is a view into the SAME tensor buffer (embedBatch above) — adding
// that buffer once per row would transfer it N times and throw DataCloneError.
// A Set also covers the future MRL case where each sliced row owns its buffer
// (then the Set simply holds N distinct buffers). Strings (the request payload)
// aren't transferable, so this only optimizes the parent-bound direction.
function collectTransfer(result) {
    if (!result || typeof result !== 'object') return [];
    const bufs = new Set();
    if (result.vector && result.vector.buffer) bufs.add(result.vector.buffer);
    if (Array.isArray(result.vectors)) {
        for (const v of result.vectors) { if (v && v.buffer) bufs.add(v.buffer); }
    }
    return [...bufs];
}

window.addEventListener('message', async (event) => {
    // Mirror the parent-side source check (buildIframe()'s listener): only
    // dispatch RPCs that actually came from the window that embedded us.
    // Currently unreachable (no other frame holds a reference to post from),
    // but cheap to harden so a future embedding context can't slip messages
    // straight into the RPC dispatcher.
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || !data.id || !data.type) return;
    try {
        let result;
        if (data.type === 'load') {
            result = await loadModel(
                data.payload.modelId,
                data.payload.device,
                data.payload.dtype,
                data.payload.skipWarmup,
                data.payload.revision,
            );
            currentDevice = result.device;
        } else if (data.type === 'embed') {
            result = await embedText(data.payload.text);
        } else if (data.type === 'embed-batch') {
            result = await embedBatch(data.payload.texts, data.payload.bucket);
        } else if (data.type === 'token-counts') {
            result = await tokenCounts(data.payload.texts);
        } else if (data.type === 'load-tokenizer') {
            result = await loadTokenizer(data.payload.modelId, data.payload.revision);
        } else if (data.type === 'embed-profile') {
            result = await profileRuntime(
                data.payload.batchSizes, data.payload.seqBuckets, data.payload.reps);
        } else if (data.type === 'worker-probe') {
            // T8 spike — nested dedicated-worker probe. Never throws (failures
            // ARE the data); see runWorkerProbe above.
            result = await runWorkerProbe();
        } else if (data.type === 'embed-worker-test') {
            // T8 spike — functional embed-worker test (load + embed + cosine
            // vs the iframe pipeline). Structured result, never a rejection.
            result = await runWorkerEmbedTest(data.payload.text);
        } else if (data.type === 'embed-worker-kill') {
            killEmbedWorker(String(data.payload && data.payload.reason || 'parent request'));
            result = { killed: true };
        } else if (data.type === 'embed-worker-embed') {
            // T8 production route — single embed via the long-lived worker.
            const t0 = Date.now();
            const reply = await embedWorkerRpc({ id: 'prod-' + Date.now() + '-' + Math.random().toString(36).slice(2), type: 'embed', text: String(data.payload.text) }, 60000);
            result = { vector: reply.vector, latencyMs: reply.latencyMs != null ? reply.latencyMs : (Date.now() - t0) };
        } else if (data.type === 'embed-worker-batch') {
            // T8 production route — batch via the long-lived worker.
            const t0 = Date.now();
            const reply = await embedWorkerRpc({ id: 'prodb-' + Date.now() + '-' + Math.random().toString(36).slice(2), type: 'embed-batch', texts: data.payload.texts }, 60000);
            result = { vectors: reply.vectors, latencyMs: reply.latencyMs != null ? reply.latencyMs : (Date.now() - t0) };
        } else if (data.type === 'app-local-fetch') {
            // Probe — never throws to the parent; the failure cases ARE the data.
            // We want { ok: false, error } back, not a rejected RPC.
            const url = data.payload.url;
            try {
                const res = await fetch(url);
                let body = null;
                try { body = await res.text(); } catch (_) { /* body unreadable; status alone is signal */ }
                result = { ok: res.ok, status: res.status, body, error: null };
            } catch (e) {
                result = { ok: false, status: null, body: null, error: String(e) };
            }
        } else {
            throw new Error('unknown type: ' + data.type);
        }
        // Transfer the vector buffers (embed/embed-batch) so the parent gets
        // them by move, not copy. Other RPCs (load/profile/fetch) carry no
        // large buffers, so collectTransfer returns [] and this is a no-op.
        // After transfer the buffers are detached here — safe because the
        // tensor was already disposed and we never touch result again.
        window.parent.postMessage(
            { id: data.id, ok: true, result }, '*', collectTransfer(result));
    } catch (e) {
        window.parent.postMessage({
            id: data.id, ok: false,
            error: String(e),
            stack: e && e.stack ? e.stack : null,
        }, '*');
    }
});

try {
    window.parent.postMessage({ id: '__ready' }, '*');
} catch (e) {
    window.parent.postMessage({ id: '__error', error: String(e) }, '*');
}
`;
}
