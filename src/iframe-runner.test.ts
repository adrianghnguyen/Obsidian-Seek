import { describe, it, expect, vi, afterEach } from 'vitest';
import { IframeRunner, buildChildScript, buildWorkerProbeScript, buildEmbedWorkerScript, isChromiumPowerPreferenceAdapterWarning, stripGpuPowerPreference, SOFT_DISPOSE_MS, WORKER_PROBE_TIMEOUT_MS } from './iframe-runner';

// F5 — per-RPC timeout. A jetsam-killed iframe child never replies; without the
// timeout the parent promise hangs forever, stranding the embed catch's
// recycle+retry (search.ts embedOneBatch). We can't build a real srcdoc iframe in
// the node test env, so inject a live-looking iframe whose contentWindow.postMessage
// is a no-op (the child never answers) and drive the timer with fake timers.
afterEach(() => { vi.useRealTimers(); });

describe('IframeRunner soft dispose', () => {
    it('blanks srcdoc, waits SOFT_DISPOSE_MS, then removes the iframe', async () => {
        vi.useFakeTimers();
        const r = new IframeRunner();
        let removed = false;
        const iframe = {
            id: 'seek-runtime-iframe',
            srcdoc: '<!DOCTYPE html><html><body>x</body></html>',
            src: '',
            removeAttribute: vi.fn(function (this: { srcdoc?: string }, name: string) {
                if (name === 'srcdoc') delete this.srcdoc;
            }),
            hasAttribute: vi.fn(function (this: { srcdoc?: string }, name: string) {
                return name === 'srcdoc' && this.srcdoc != null;
            }),
            parentNode: {
                removeChild: vi.fn(() => { removed = true; }),
            },
        };
        (r as unknown as { iframe: typeof iframe }).iframe = iframe;

        const disposeP = r.dispose();
        await Promise.resolve();
        expect(iframe.src).toBe('about:blank');
        expect(iframe.hasAttribute('srcdoc')).toBe(false);
        expect(removed).toBe(false);

        await vi.advanceTimersByTimeAsync(SOFT_DISPOSE_MS);
        await disposeP;
        expect(iframe.parentNode.removeChild).toHaveBeenCalledWith(iframe);
        expect(removed).toBe(true);
    });
});

function withDeadIframe(): IframeRunner {
    const r = new IframeRunner();
    (r as unknown as { iframe: { contentWindow: { postMessage: () => void } } }).iframe = {
        contentWindow: { postMessage: () => { /* child never replies */ } },
    };
    return r;
}

describe('IframeRunner query-priority RPC queue (G_catchup_ux)', () => {
    it('runs a query embed ahead of a queued index embedBatch', async () => {
        const r = new IframeRunner();
        const order: string[] = [];
        const replies = new Map<string, { resolve: (v: unknown) => void }>();
        (r as unknown as { iframe: { contentWindow: { postMessage: (msg: { id: string; type: string }) => void } } }).iframe = {
            contentWindow: {
                postMessage: (msg) => {
                    order.push(msg.type);
                    // Reply async so the queue can enqueue the second call first.
                    queueMicrotask(() => {
                        const p = (r as unknown as { pending: Map<string, { resolve: (v: unknown) => void }> }).pending.get(msg.id);
                        if (!p) return;
                        (r as unknown as { pending: Map<string, unknown> }).pending.delete(msg.id);
                        if (msg.type === 'embed') p.resolve({ vector: new Float32Array(4), latencyMs: 1 });
                        else p.resolve({ vectors: [new Float32Array(4)], latencyMs: 1 });
                    });
                },
            },
        };
        const batchP = r.embedBatch(['a', 'b']);
        const embedP = r.embed('query');
        await Promise.all([batchP, embedP]);
        // First post is whichever started the flight (batch was enqueued first).
        // Second post must be embed if it was waiting — but batch was already in
        // flight, so order is [embed-batch, embed]. Priority only reorders the
        // *queue*, not a flight already posted.
        expect(order).toEqual(['embed-batch', 'embed']);
    });

    it('when both are queued before the pump runs, embed posts before embed-batch', async () => {
        const r = new IframeRunner();
        const order: string[] = [];
        // Hold the pump: mark busy so both enqueue without starting.
        (r as unknown as { rpcBusy: boolean }).rpcBusy = true;
        (r as unknown as { iframe: { contentWindow: { postMessage: (msg: { id: string; type: string }) => void } } }).iframe = {
            contentWindow: {
                postMessage: (msg) => {
                    order.push(msg.type);
                    queueMicrotask(() => {
                        const pending = (r as unknown as { pending: Map<string, { resolve: (v: unknown) => void }> }).pending;
                        const p = pending.get(msg.id);
                        if (!p) return;
                        pending.delete(msg.id);
                        if (msg.type === 'embed') p.resolve({ vector: new Float32Array(4), latencyMs: 1 });
                        else p.resolve({ vectors: [new Float32Array(4)], latencyMs: 1 });
                    });
                },
            },
        };
        const batchP = r.embedBatch(['a']);
        const embedP = r.embed('q');
        (r as unknown as { rpcBusy: boolean }).rpcBusy = false;
        (r as unknown as { pumpRpc: () => void }).pumpRpc();
        await Promise.all([batchP, embedP]);
        expect(order[0]).toBe('embed');
        expect(order[1]).toBe('embed-batch');
    });

    it('drops an aborted query before it reaches the iframe', async () => {
        const r = new IframeRunner();
        const postedQueries: string[] = [];
        (r as unknown as { rpcBusy: boolean }).rpcBusy = true;
        (r as unknown as { iframe: { contentWindow: { postMessage: (msg: { id: string; type: string; payload: { text?: string } }) => void } } }).iframe = {
            contentWindow: {
                postMessage: (msg) => {
                    if (msg.type === 'embed') postedQueries.push(msg.payload.text ?? '');
                    queueMicrotask(() => {
                        const pending = (r as unknown as { pending: Map<string, { resolve: (v: unknown) => void }> }).pending;
                        const p = pending.get(msg.id);
                        if (!p) return;
                        pending.delete(msg.id);
                        p.resolve({ vector: new Float32Array(4), latencyMs: 1 });
                    });
                },
            },
        };

        const staleController = new AbortController();
        const stale = r.embed('stale query', staleController.signal);
        const latest = r.embed('latest query');
        staleController.abort();
        (r as unknown as { rpcBusy: boolean }).rpcBusy = false;
        (r as unknown as { pumpRpc: () => void }).pumpRpc();

        await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
        await latest;
        expect(postedQueries).toEqual(['latest query']);
    });

    it('finishes an active aborted RPC internally before starting the latest query', async () => {
        const r = new IframeRunner();
        const postedQueries: Array<{ id: string; text: string }> = [];
        (r as unknown as { iframe: { contentWindow: { postMessage: (msg: { id: string; type: string; payload: { text?: string } }) => void } } }).iframe = {
            contentWindow: {
                postMessage: (msg) => {
                    if (msg.type === 'embed') postedQueries.push({ id: msg.id, text: msg.payload.text ?? '' });
                },
            },
        };

        const staleController = new AbortController();
        const stale = r.embed('stale query', staleController.signal);
        const latest = r.embed('latest query');
        staleController.abort();
        expect(postedQueries.map(q => q.text)).toEqual(['stale query']);

        const pending = (r as unknown as { pending: Map<string, { resolve: (v: unknown) => void }> }).pending;
        pending.get(postedQueries[0].id)?.resolve({ vector: new Float32Array(4), latencyMs: 1 });
        await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
        expect(postedQueries.map(q => q.text)).toEqual(['stale query', 'latest query']);

        pending.get(postedQueries[1].id)?.resolve({ vector: new Float32Array(4), latencyMs: 1 });
        await latest;
    });

    it('keeps a rapid superseded-query burst bounded to the latest queued embed', async () => {
        const r = new IframeRunner();
        const postedQueries: string[] = [];
        (r as unknown as { rpcBusy: boolean }).rpcBusy = true;
        (r as unknown as { iframe: { contentWindow: { postMessage: (msg: { id: string; type: string; payload: { text?: string } }) => void } } }).iframe = {
            contentWindow: {
                postMessage: (msg) => {
                    if (msg.type === 'embed') postedQueries.push(msg.payload.text ?? '');
                    queueMicrotask(() => {
                        const pending = (r as unknown as { pending: Map<string, { resolve: (v: unknown) => void }> }).pending;
                        const p = pending.get(msg.id);
                        if (!p) return;
                        pending.delete(msg.id);
                        p.resolve({ vector: new Float32Array(4), latencyMs: 1 });
                    });
                },
            },
        };

        const superseded: Array<Promise<string>> = [];
        for (let i = 0; i < 50; i++) {
            const controller = new AbortController();
            superseded.push(r.embed(`stale ${i}`, controller.signal).then(
                () => 'resolved',
                error => error instanceof Error ? error.name : String(error),
            ));
            controller.abort();
        }
        const latest = r.embed('latest query');

        expect((r as unknown as { queryRpcQueue: unknown[] }).queryRpcQueue).toHaveLength(1);
        (r as unknown as { rpcBusy: boolean }).rpcBusy = false;
        (r as unknown as { pumpRpc: () => void }).pumpRpc();

        expect(await Promise.all(superseded)).toEqual(new Array(50).fill('AbortError'));
        await latest;
        expect(postedQueries).toEqual(['latest query']);
    });
});

describe('IframeRunner queued RPC rejection (R8)', () => {
    it('dispose rejects a queued embed with DISPOSED (does not hang)', async () => {
        const r = withDeadIframe();
        const inflight = r.embedBatch(['hello']);
        const queued = r.embed('query');
        expect((r as unknown as { queryRpcQueue: unknown[] }).queryRpcQueue).toHaveLength(1);

        const disposeP = r.dispose();
        await expect(queued).rejects.toMatchObject({ code: 'DISPOSED', message: 'iframe disposed' });
        await expect(inflight).rejects.toMatchObject({ code: 'DISPOSED' });
        await disposeP;
    });

    it('failInflight rejects a queued embed with the recoverable message, not DISPOSED', async () => {
        const r = withDeadIframe();
        const inflight = r.embedBatch(['hello']);
        const queued = r.embed('query');
        expect((r as unknown as { queryRpcQueue: unknown[] }).queryRpcQueue).toHaveLength(1);

        r.failInflight('webgpu device lost');
        const queuedErr = await queued.then(
            () => { throw new Error('queued embed should have rejected'); },
            (e: Error & { code?: string }) => e,
        );
        expect(queuedErr.message).toBe('webgpu device lost');
        expect(queuedErr.code).not.toBe('DISPOSED');
        await expect(inflight).rejects.toThrow('webgpu device lost');
    });
});

describe('IframeRunner per-RPC timeout (F5)', () => {
    it('rejects a never-answered embedBatch with a recoverable TIMEOUT error', async () => {
        vi.useFakeTimers();
        const r = withDeadIframe();
        const p = r.embedBatch(['hello']);
        // tagged TIMEOUT (not DISPOSED) so the embed catch recycles+retries.
        const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
        await vi.advanceTimersByTimeAsync(60_001);   // RPC_TIMEOUT_MS + 1
        await assertion;
    });

    it('a load RPC uses the longer ceiling (still pending past the embed timeout)', async () => {
        vi.useFakeTimers();
        const r = withDeadIframe();
        const p = r.load('some/repo', 'wasm', 'q4', true);
        let settled = false;
        p.then(() => { settled = true; }, () => { settled = true; });
        await vi.advanceTimersByTimeAsync(60_001);   // past the 60s embed ceiling
        expect(settled).toBe(false);                 // load gets LOAD_RPC_TIMEOUT_MS (180s), not 60s
        const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
        await vi.advanceTimersByTimeAsync(120_001);   // total > 180s
        await assertion;
    });

    it('an uninitialized runner rejects immediately, not via the timeout', async () => {
        const r = new IframeRunner();   // no iframe injected
        await expect(r.embedBatch(['x'])).rejects.toThrow(/not initialized/);
    });
});

describe('Chromium powerPreference requestAdapter warning (crbug.com/369219127)', () => {
    it('matches only warnings that name both powerPreference and requestAdapter', () => {
        expect(isChromiumPowerPreferenceAdapterWarning(
            "The 'powerPreference' option is currently ignored when calling requestAdapter()",
        )).toBe(true);
        expect(isChromiumPowerPreferenceAdapterWarning('requestAdapter returned null')).toBe(false);
        expect(isChromiumPowerPreferenceAdapterWarning('powerPreference is a no-op on Apple Silicon')).toBe(false);
        expect(isChromiumPowerPreferenceAdapterWarning('model load failed')).toBe(false);
    });

    it('strips powerPreference and leaves other adapter options', () => {
        expect(stripGpuPowerPreference(undefined)).toBeUndefined();
        expect(stripGpuPowerPreference({ powerPreference: 'high-performance' })).toEqual({});
        expect(stripGpuPowerPreference({ powerPreference: 'low-power', forceFallbackAdapter: true }))
            .toEqual({ forceFallbackAdapter: true });
        expect(stripGpuPowerPreference({ forceFallbackAdapter: false })).toEqual({ forceFallbackAdapter: false });
    });

    it('strips powerPreference on requestAdapter before pipeline bootstrap', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        const cdnIdx = script.indexOf('const CDN_URL');
        const stripIdx = script.indexOf("k !== 'powerPreference'");
        const protoIdx = script.indexOf('GPU.prototype.requestAdapter');
        const workerIdx = script.indexOf('self.Worker = SeekWorker');
        const pipelineIdx = script.indexOf('let pipeline = null');
        expect(stripIdx).toBeGreaterThan(cdnIdx);
        expect(protoIdx).toBeGreaterThan(stripIdx);
        expect(workerIdx).toBeGreaterThan(protoIdx);
        expect(pipelineIdx).toBeGreaterThan(workerIdx);
        expect(script).toContain('crbug.com/369219127');
    });
});

// Iframe child's RPC dispatch runs inside a srcdoc'd module script, which we
// can't execute in the node test env — so assert on the emitted source text
// that the child rejects postMessage events not sourced from window.parent
// before it ever reaches the RPC dispatcher (mirrors the parent-side
// `event.source !== this.iframe.contentWindow` guard in buildIframe()).
describe('iframe child message handler — source check', () => {
    it('gates RPC dispatch on event.source === window.parent', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        const handlerStart = script.indexOf("addEventListener('message', async (event)");
        expect(handlerStart).toBeGreaterThan(-1);
        const guardIdx = script.indexOf('event.source !== window.parent', handlerStart);
        const dispatchIdx = script.indexOf("data.type === 'load'", handlerStart);
        expect(guardIdx).toBeGreaterThan(handlerStart);
        expect(guardIdx).toBeLessThan(dispatchIdx);
    });
});

// tx.js pins non-WebKit engines to the asyncify ORT build for EVERY device,
// but that build has no CPU GatherBlockQuantized kernel — a device:'wasm'
// session can never load the shipped GBQ4 model on it (the r/ObsidianMD
// desktop failure; also all of Android). The child must rewrite the asyncify
// pin back to the plain build on BOTH wasm attempts (initial + SIMD retry).
describe('iframe child WASM path — plain-glue pin (CPU GBQ kernel)', () => {
    it('emits the asyncify→plain wasmPaths rewrite and applies it on the wasm path', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        // The override rewrites BOTH the .mjs glue and the .wasm binary.
        expect(script).toContain("'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.mjs'");
        expect(script).toContain("'ort-wasm-simd-threaded.asyncify.wasm', 'ort-wasm-simd-threaded.wasm'");
        // Applied on the wasm fallback: initial attempt + the 'no available
        // backend' SIMD retry each get a fresh module instance, so each must
        // re-apply the override. Match the call-site text (assignment form),
        // not the bare identifier — indexOf on the identifier alone would
        // count the function DECLARATION as the first hit and pass even if
        // the retry-path re-application were deleted.
        const first = script.indexOf('wasmGlue = overrideGlueForWasm(env)');
        const second = script.indexOf('wasmGlue = overrideGlueForWasm(env)', first + 1);
        expect(first).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(first);
    });

    it('no-ops when wasmPaths is not the asyncify pin (WebKit plain path)', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        const fnStart = script.indexOf('function overrideGlueForWasm');
        expect(fnStart).toBeGreaterThan(-1);
        const guardIdx = script.indexOf("includes('ort-wasm-simd-threaded.asyncify.mjs')", fnStart);
        const rewriteIdx = script.indexOf('wp.mjs = ', fnStart);
        expect(guardIdx).toBeGreaterThan(fnStart);
        expect(guardIdx).toBeLessThan(rewriteIdx);
    });
});

// When 'auto' falls through to WASM and WASM ALSO fails, the child must not
// throw only the terminal wasm error — that discards webgpuError before
// loadModel can return a LoadResult, so the diagnostic report shows the wasm
// session error but never WHY WebGPU fell back (the blind spot in the
// r/ObsidianMD report). Assert the emitted child preserves both causes, on
// both wasm attempts.
describe('iframe child WASM fallback — preserves the WebGPU failure cause', () => {
    it('re-throws with both webgpu and wasm error context when webgpu was attempted', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        // The combined throw fires only when a WebGPU attempt recorded an error.
        expect(script).toContain('webgpuAttempted && webgpuError');
        expect(script).toContain('model load failed on both paths');
        expect(script).toMatch(/webgpu: '\s*\+\s*webgpuError/);
        // Both the initial wasm attempt and the SIMD retry route their
        // failures through the combining helper.
        const first = script.indexOf('wasmFail(e)');
        const second = script.indexOf('wasmFail(e2)');
        expect(first).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(first);
    });
});

// T8 spike — the nested dedicated-worker probe. The node test env can't run a
// real srcdoc iframe or a real Worker, so (like the child-script tests above)
// we assert on the emitted source text: the worker body must be a valid
// script-shaped string carrying the probe contract, and the iframe child must
// relay a 'worker-probe' RPC to runWorkerProbe() and reply with a structured
// result (never a rejection).
describe('worker probe script (buildWorkerProbeScript)', () => {
    it('inlines the CDN URL and a unique probe id, no unreplaced placeholders', () => {
        const script = buildWorkerProbeScript('https://cdn.example.com/transformers');
        expect(script).toContain('"https://cdn.example.com/transformers"');
        expect(script).toMatch(/const id = "wp-[0-9a-z]+"/);
        expect(script).not.toContain('__PROBE_ID__');
        expect(script).not.toContain('__CDN_URL__');
    });

    it('contains no backticks (safe to embed in the iframe template literal)', () => {
        expect(buildWorkerProbeScript('https://cdn.example.com/x')).not.toContain('`');
        expect(buildWorkerProbeScript('https://cdn.example.com/x')).not.toContain('${');
    });

    it('dynamically imports the CDN URL and posts one structured result', () => {
        const script = buildWorkerProbeScript('https://cdn.example.com/x');
        expect(script).toContain('await import("https://cdn.example.com/x")');
        expect(script).toContain('self.postMessage({ __workerProbeResult: true');
        // Evidence-only process-shim report (the eventual embed-worker decides
        // whether to flip; the probe only reports what the realm exposes).
        expect(script).toContain('versionsNode');
        expect(script).toContain("String(proc.type || '')");
    });

    it('exercises a real WebGPU compute dispatch, not just requestAdapter', () => {
        const script = buildWorkerProbeScript('https://cdn.example.com/x');
        expect(script).toContain('navigator.gpu');
        expect(script).toContain('requestAdapter()');
        expect(script).toContain('requestDevice()');
        expect(script).toContain('GPUBufferUsage.STORAGE');
        expect(script).toContain('dispatchWorkgroups(1)');
        expect(script).toContain('onSubmittedWorkDone()');
    });
});

describe('iframe child worker-probe relay', () => {
    it("dispatches 'worker-probe' to runWorkerProbe() before the app-local-fetch arm", () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        const probeArm = script.indexOf("data.type === 'worker-probe'");
        const runCall = script.indexOf('await runWorkerProbe()', probeArm);
        const fetchArm = script.indexOf("data.type === 'app-local-fetch'");
        expect(probeArm).toBeGreaterThan(-1);
        expect(runCall).toBeGreaterThan(probeArm);
        expect(fetchArm).toBeGreaterThan(probeArm);
    });

    it('embeds the full worker source (spawn target present in the child)', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        // The child embeds the compiled worker body as a JSON string literal.
        expect(script).toContain('new Worker(url, { type: \'module\' })');
        expect(script).toContain('__workerProbeResult');
        expect(script).toContain('onSubmittedWorkDone()');
    });

    it('terminates the nested worker on a hard deadline (no wedged spawns)', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        expect(script).toContain('WORKER_PROBE_TIMEOUT_MS = 12000');
        const tIdx = script.indexOf('window.setTimeout(finish, WORKER_PROBE_TIMEOUT_MS)');
        const termIdx = script.indexOf('w.terminate()', 0);
        expect(tIdx).toBeGreaterThan(-1);
        expect(termIdx).toBeGreaterThan(-1);
    });

    it('parent RPC uses the dedicated worker-probe timeout budget', () => {
        expect(WORKER_PROBE_TIMEOUT_MS).toBeGreaterThan(12000);
        const r = new IframeRunner();
        const spy = vi.spyOn(r as unknown as { send: (...a: unknown[]) => unknown }, 'send');
        void r.workerProbe().catch(() => { /* dead-iframe rejection is fine here */ });
        expect(spy).toHaveBeenCalledWith('worker-probe', {}, WORKER_PROBE_TIMEOUT_MS);
    });
});

// T8 spike — the REAL embed worker. Same approach as the probe tests: the node
// env can't run Workers or the model, so we assert the emitted source text
// carries the load-bearing contract pieces.
describe('embed worker script (buildEmbedWorkerScript)', () => {
    const MODEL = 'tooape/granite-embedding-97m-multilingual-r2-GBQ4-ONNX';
    const REV = '54db88c5667bd79b4aea24ea6027a7ef45a7bbb5';

    it('pins model id, revision, q4 dtype, and dim from the spec', () => {
        const script = buildEmbedWorkerScript('https://cdn.example.com/tx', MODEL, REV, 384);
        expect(script).toContain(JSON.stringify(MODEL));
        expect(script).toContain(JSON.stringify(REV));
        expect(script).toContain("const DTYPE = 'q4';");
        expect(script).toContain('const EMBED_DIM = 384;');
        expect(script).not.toContain('__CDN_URL__');
        expect(script).not.toContain('__MODEL_ID__');
        expect(script).not.toContain('__REVISION__');
        expect(script).not.toContain('__DIM__');
    });

    it('carries the ORT/transformers node-branch shim', () => {
        const script = buildEmbedWorkerScript('https://cdn.example.com/tx', MODEL, REV, 384);
        // process.type flipped persistently (ORT glue's check at session-create).
        expect(script).toContain("proc.type = 'renderer'");
        // release.name flipped around the DYNAMIC transformers import (module
        // eval happens at import time, not worker startup) — flip + restore.
        expect(script).toContain('function flipReleaseNameForImport()');
        expect(script).toContain("release.name = 'obsidian-iframe-worker'");
        expect(script).toContain('flipReleaseNameForImport()');
        expect(script).toContain('restore();');
    });

    it('configures the web runtime: remote models, browser cache, single thread', () => {
        const script = buildEmbedWorkerScript('https://cdn.example.com/tx', MODEL, REV, 384);
        expect(script).toContain('env.allowLocalModels = false');
        expect(script).toContain('env.allowRemoteModels = true');
        expect(script).toContain('env.useBrowserCache = true');
        expect(script).toContain('o.numThreads = 1');
        expect(script).toContain('o.proxy = false');
    });

    it('produces CLS-pooled normalized vectors and transfers them back', () => {
        const script = buildEmbedWorkerScript('https://cdn.example.com/tx', MODEL, REV, 384);
        expect(script).toContain("pooling: 'cls'");
        expect(script).toMatch(/truncation: true, max_length: SEQ_CAP/);
        expect(script).toContain('function norm(v)');
        // Zero-copy reply + the __embedWorkerReply contract the child routes on.
        expect(script).toContain('[vector.buffer]');
        expect(script).toContain('__embedWorkerReply');
        expect(script).toContain("id: '__ready'");
    });

    it('contains no backticks (safe to embed in the iframe template literal)', () => {
        expect(buildEmbedWorkerScript('https://cdn.example.com/tx', MODEL, REV, 384)).not.toContain('`');
    });
});

describe('iframe child embed-worker relay', () => {
    it('inlines the worker source and dispatches the three embed-worker RPCs', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        // Source is injected as a JS string literal (no placeholder remains).
        expect(script).toContain('const __EMBED_WORKER_SOURCE__ = ');
        expect(script).not.toContain('undefined && __EMBED_WORKER_SOURCE__');
        // Lifecycle: long-lived worker + explicit kill (NOT per-RPC terminate).
        expect(script).toContain("new Worker(blobUrl, { type: 'module' })");
        expect(script).toContain("data.type === 'embed-worker-test'");
        expect(script).toContain("data.type === 'embed-worker-kill'");
        expect(script).toContain('function killEmbedWorker');
        // Cosine comparison against the iframe pipeline's own embedText.
        expect(script).toContain('await runWorkerEmbedTest(data.payload.text)');
        expect(script).toContain('out.cosine = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)');
    });

    it('routes __embedWorkerReply messages and rejects on worker death', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        const routeIdx = script.indexOf('d.__embedWorkerReply !== true');
        const readyIdx = script.indexOf("d.id === '__ready'", routeIdx);
        // killEmbedWorker is defined before the router in the emitted child —
        // presence is the contract here (its rejects fire on worker death).
        const killIdx = script.indexOf('embed worker killed: ');
        expect(routeIdx).toBeGreaterThan(-1);
        expect(readyIdx).toBeGreaterThan(routeIdx);
        expect(killIdx).toBeGreaterThan(-1);
        // Per-RPC timeout so a wedged worker rejects instead of hanging forever.
        expect(script).toContain(' timed out after ');
        expect(script).toContain('+ timeoutMs +');
    });

    it('embed-worker-test load RPC is parent-timeout compatible (never a raw hang)', () => {
        const script = buildChildScript('https://example.com/cdn', 384);
        // The load RPC uses a 180 s budget inside the child — the parent's
        // LOAD_RPC_TIMEOUT_MS (180 s) covers the whole test round trip.
        expect(script).toContain("embedWorkerRpc({ id: 'wtest-load', type: 'load' }, 180000)");
        expect(script).toContain("type: 'embed', text: String(text)");
    });
});
