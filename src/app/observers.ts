// Global DOM/performance observers for the plugin host: window error +
// unhandledrejection capture, the longtask PerformanceObserver, and the
// visibilitychange/pagehide memory-pressure handlers. Extracted from main.ts
// (SeekPlugin) so the host class stays about lifecycle/wiring; the handlers
// receive an explicit host interface instead of closing over `this`.
//
// `disposeObservers` performs the exact teardown onunload needs — the host
// stores the returned handles and removes them against the SAME document they
// were bound to (see visibilityDoc).

import type { LongTaskEntry, MemoryPressureEntry } from '../types/types';
import type { SeekLogger } from '../diagnostics/logger';
import type { TaskContextTracker } from './task-context';
import type { Forensics } from '../diagnostics/forensics';
import { seekPerf } from '../diagnostics/perf-console';
import { isIgnorableStartupConsoleError } from './layout-ready';

// Entries shorter than this are not logged as long tasks. Kept module-local
// (only wired_gate reads it) so the threshold travels with the observer.
const LONG_TASK_THRESHOLD_MS = 250;

export interface ObserverHost {
    /** Live probe — true once onunload begins; async callbacks must not resurrect teardown. */
    isUnloading: () => boolean;
    logger: SeekLogger;
    taskCtx: TaskContextTracker;
    forensics: Forensics | null;
    /** Force a pending-edit flush now, bypassing the idle debounce. */
    flushOnBackground: () => void;
    runCatchUp: () => void;
    runDriftRecovery: () => void;
}

export interface ObserverHandles {
    longTaskObserver?: PerformanceObserver | null;
    onError?: ((e: ErrorEvent) => void) | null;
    onUnhandledRejection?: ((e: PromiseRejectionEvent) => void) | null;
    onVisibilityChange?: (() => void) | null;
    onPageHide?: (() => void) | null;
    visibilityDoc?: Document | null;
}

// Catch errors that escape the explicit try/catch sites. Without these,
// async errors in event handlers / iframe message processing vanish.
export function wireGlobalErrorHandlers(host: ObserverHost): ObserverHandles {
    const onError = (e: ErrorEvent) => {
        if (host.isUnloading()) return;
        // Only log if the error originates from our code. The renderer
        // process gets a lot of unrelated cross-plugin noise, and we
        // don't want to claim other plugins' errors as ours.
        const src = (e.filename ?? '') + ' ' + (e.message ?? '');
        if (isIgnorableStartupConsoleError(e.message ?? '')) return;
        if (!/seek|transformers|webgpu/i.test(src)) return;
        host.logger.appendError('window.onerror', e.error ?? new Error(e.message)).catch(() => {});
    };
    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
        if (host.isUnloading()) return;
        const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
        const stackStr = reason.stack ?? '';
        if (isIgnorableStartupConsoleError(reason.message) || isIgnorableStartupConsoleError(stackStr)) return;
        // Same filter as above. False negatives are fine; false positives
        // (logging other plugins' errors as Seek's) are worse.
        if (!/seek|transformers|webgpu/i.test(stackStr) && !/seek|transformers|webgpu/i.test(reason.message)) return;
        host.logger.appendError('unhandledrejection', reason).catch(() => {});
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return { onError, onUnhandledRejection };
}

// PerformanceObserver for longtask entries. On iOS WKWebView this API
// is supported as of iOS 16 — if absent, we silently skip (no harm).
// Each longtask >= LONG_TASK_THRESHOLD_MS becomes a log entry tagged
// with currentTaskContext so the report can group jank by what we
// were doing at the time.
export function wireLongTaskObserver(host: ObserverHost): PerformanceObserver | null {
    interface PolyfillObserver {
        new(cb: (list: { getEntries(): PerformanceEntry[] }) => void): PerformanceObserver;
    }
    const Ctor = (window as unknown as { PerformanceObserver?: PolyfillObserver }).PerformanceObserver;
    if (!Ctor) return null;
    let observer: PerformanceObserver | null = null;
    try {
        observer = new Ctor(list => {
            for (const entry of list.getEntries()) {
                if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
                // `attribution[0].name` is spec'd to the constant 'unknown' —
                // it was the only frame field we recorded, and it answered
                // nothing (issue #5: a whole report of hourly 14 s stalls, every
                // one reading 'unknown'). The useful pair is one level up:
                // `entry.name` says WHICH FRAME ('self' vs a descendant iframe),
                // and TaskAttributionTiming's container* fields name that frame.
                const attrSrc = entry as unknown as {
                    attribution?: Array<{
                        name?: string; containerType?: string;
                        containerId?: string; containerName?: string; containerSrc?: string;
                    }>;
                };
                const attr = attrSrc.attribution?.[0];
                const logEntry: LongTaskEntry = {
                    type: 'long-task',
                    timestamp: new Date().toISOString(),
                    durationMs: parseFloat(entry.duration.toFixed(2)),
                    startTimeMs: parseFloat(entry.startTime.toFixed(2)),
                    attribution: attr?.name ?? null,
                    culprit: entry.name || null,
                    containerType: attr?.containerType || null,
                    containerId: attr?.containerId || null,
                    containerName: attr?.containerName || null,
                    // Cap: an iframe src can be a multi-KB data: URL, and this
                    // row is written on every stall. The prefix is enough to
                    // identify the frame. Redacted like any other string when
                    // the report's privacy toggle is on — a vault-local
                    // app://local/… src carries the vault path.
                    containerSrc: attr?.containerSrc?.slice(0, 120) || null,
                    // Attribute by span overlap at TASK time, not delivery
                    // time — the observer fires only after the task ends,
                    // so a top-of-stack read here mislabels every task
                    // whose phase popped before delivery (issue #5).
                    context: host.taskCtx.attribute(entry.startTime, entry.duration),
                };
                seekPerf.recordLongTask(logEntry);
                host.logger.append(logEntry).catch(() => {});
            }
        });
        observer.observe({ entryTypes: ['longtask'] });
    } catch (e) {
        // entryType 'longtask' isn't supported everywhere — Safari pre-16.
        // Silently skip; the report will just have an empty long-task section.
        console.warn('[seek] longtask observer unavailable:', e);
        return null;
    }
    return observer;
}

// visibilitychange + pagehide. On iOS, the WebView can be jetsam-killed
// while backgrounded — recording state at the moment we lose foreground
// lets us correlate "session ended abruptly" with "heap was at 240 MB".
export function wireMemoryPressureHandlers(host: ObserverHost): ObserverHandles {
    const emit = async (event: MemoryPressureEntry['event']) => {
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        const heapMB = heap ? heap.usedJSHeapSize / 1e6 : null;
        let storageMB: number | null = null;
        let persisted = false;
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                storageMB = est.usage != null ? est.usage / 1e6 : null;
            } catch { /* swallow */ }
        }
        if (navigator.storage?.persisted) {
            try { persisted = await navigator.storage.persisted(); } catch { /* swallow */ }
        }
        const entry: MemoryPressureEntry = {
            type: 'memory-pressure',
            timestamp: new Date().toISOString(),
            event,
            heapMB,
            storageMB,
            persisted,
        };
        await host.logger.append(entry);
    };
    const visibilityDoc = activeDocument;
    const onVisibilityChange = () => {
        if (visibilityDoc.visibilityState === 'hidden') {
            // Forensics beat FIRST and synchronously — the async emit below
            // can be lost to a background kill; the breadcrumb can't.
            host.forensics?.beat('visibility-hidden');
            emit('visibility-hidden').catch(() => {});
            // Backgrounding is the last safe write window on iOS (the WebView
            // can be jetsam-killed). Capture the note being edited and flush
            // now, bypassing the 5-min idle debounce.
            host.flushOnBackground();
        }
        else if (visibilityDoc.visibilityState === 'visible') {
            host.forensics?.beat('visibility-visible');
            emit('visibility-visible').catch(() => {});
            host.runCatchUp();
            host.runDriftRecovery();
        }
    };
    const onPageHide = () => {
        host.forensics?.beat('pagehide');
        emit('pagehide').catch(() => {});
        host.flushOnBackground();
    };
    // Bind to the active document and remember it, so unload removes against the
    // SAME document (see visibilityDoc field).
    visibilityDoc.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    return { onVisibilityChange, onPageHide, visibilityDoc };
}

// Remove every listener/observer a prior wire* returned. The host passes the
// handles it stored; nullish entries are skipped.
export function disposeObservers(handles: ObserverHandles): void {
    if (handles.longTaskObserver) {
        try { handles.longTaskObserver.disconnect(); } catch { /* swallow */ }
    }
    if (handles.onError) window.removeEventListener('error', handles.onError);
    if (handles.onUnhandledRejection) window.removeEventListener('unhandledrejection', handles.onUnhandledRejection);
    if (handles.onVisibilityChange && handles.visibilityDoc) {
        handles.visibilityDoc.removeEventListener('visibilitychange', handles.onVisibilityChange);
    }
    if (handles.onPageHide) window.removeEventListener('pagehide', handles.onPageHide);
}
