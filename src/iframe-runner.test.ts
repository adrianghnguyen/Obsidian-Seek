import { describe, it, expect, vi, afterEach } from 'vitest';
import { IframeRunner, buildChildScript, isChromiumPowerPreferenceAdapterWarning, stripGpuPowerPreference, SOFT_DISPOSE_MS } from './iframe-runner';

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
