/**
 * @file plugin-schedulers.ts
 * @module PluginSchedulers
 *
 * ## Responsibilities
 * Background lifecycle scheduling, vault event watchers, debounce queues, and memory watchdog:
 * - **Incremental Indexing Debounce (`queueDirty`, `flushDirty`)**: Batches modified notes with
 *   a 5-minute idle window (`IDLE_FLUSH_MS`) so active typing is never interrupted, while
 *   structural changes (deletions/moves) flush on a short 1.5s delay (`STRUCT_FLUSH_MS`).
 * - **Periodic Catch-Up (`runCatchUp`)**: Runs catch-up indexing passes at startup and every 5
 *   minutes to reconcile offline vault modifications.
 * - **Exclusion Folder Watcher (`reconcileFolderExclusions`)**: Diffs active vault folders against
 *   settings exclusions, purging newly excluded folders or queueing newly included notes.
 * - **Mobile Memory Watchdog (`maybeUnloadEmbedder`)**: Unloads the ~240 MB embedder iframe after
 *   3 minutes of quiescence (`IDLE_UNLOAD_MS`) on mobile platforms to prevent OS memory kills.
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: Host Integration & Lifecycle Scheduler Layer.
 * - **Lifecycle Sequence**:
 *   1. Instantiated in `SeekPlugin.onload()` after `SearchOrchestrator` and `IndexStore` are live.
 *   2. Registers vault listeners (`vault.on('modify')`, `vault.on('delete')`, `vault.on('rename')`).
 *   3. Initial catch-up indexing MUST be scheduled only AFTER startup sidecar hydration completes.
 *   4. Periodic background intervals run every 5 minutes for catch-up and 1 minute for mobile watchdog.
 *   5. Disposed cleanly on plugin unload (`dispose()`), clearing all timers and event references.
 * - **Concurrency Invariants**:
 *   - Background flushes yield immediately when `isQueryInFlight` is true (user typing in search modal
 *     or CLI query executing) to protect UI responsiveness.
 *   - Mobile unload predicate never disposes the embedder if an edit flush timer is armed or query is pending.
 */

import type { App, EventRef } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import type { SeekSettings } from './types';
import type { SearchOrchestrator } from './search';
import type { LocalEmbedder } from './embedder';
import type { IndexStore } from './index-store';
import type { IndexStatusBar } from './index-status-bar';
import type { SeekLogger } from './logger';
import { isMobilePlatform } from './platform';
import { CompositorPacer } from './pacer';
import {
    diffExcludedPaths,
    exclusionDiffIsEmpty,
    type ExclusionDiff,
} from './folder-coverage';
import type { TaskContext } from './task-context';

export interface SettingsTelemetrySink {
    onFolderCoverageChanged?(): void;
    onSessionTelemetryChanged?(): void;
}

// Extensions Seek indexes: markdown notes always, plus .base files (Obsidian
// Bases — YAML view definitions, indexed via a synthetic doc; see
// base-extractor.ts) when `indexBases` is on. The orchestrator's collection set
// (indexableFiles) must agree with this, so both gate on the same setting.
export function isIndexableFile(f: TFile, indexBases: boolean): boolean {
    if (f.extension === 'md') return true;
    return indexBases && f.extension === 'base';
}

// Incremental-indexing debounces. Edits wait out a 5-min idle window after the
// user leaves a note (so flipping back to keep writing never triggers a flush
// mid-thought); deletes/moves apply on a short window (they're model-free and a
// dead search result is jarring). See wireIncrementalIndexing.
export const IDLE_FLUSH_MS = 5 * 60 * 1000;
export const STRUCT_FLUSH_MS = 1500;

// Mobile-only embedder unload (see maybeUnloadEmbedder). After this long with no
// model use in a quiescent state, tear down the iframe to release its ~240 MB
// model + ratcheted WASM heap; the next search pays one cold reload. The race
// with a pending edit flush is settled by the unload PREDICATE (an armed flush
// timer counts as `pending`), not by the relative size of these constants.
// Checked on a coarse interval — a minute of slack on a 3-minute idle is fine.
export const IDLE_UNLOAD_MS = 3 * 60 * 1000;
export const UNLOAD_CHECK_MS = 60 * 1000;

// A delta larger than this isn't an edit — it's a bulk import (paste, vault sync,
// git checkout). flushDirty treats it as a mini-reindex: progress is surfaced, a
// live query preempts the embed, and a cold desktop model is deferred rather than
// force-loaded for a background paste. At or below it, the single-note force path
// is unchanged (a 1-2 file embed is too short to be worth the extra machinery).
export const BULK_DELTA_THRESHOLD = 50;

export interface PluginSchedulerHost {
    app: App;
    settings: SeekSettings;
    orchestrator: SearchOrchestrator | null;
    embedder: LocalEmbedder;
    store: IndexStore;
    indexProgress: IndexStatusBar;
    logger: SeekLogger;
    unloading: boolean;
    loadGeneration: number;
    vaultIndexEventsReady: boolean;
    indexingBlocked: boolean;
    catchUpPending: boolean;
    catchUpRunning: boolean;
    indexBootPending: boolean;
    sidecarHydrating: boolean;
    lastModelUseAt: number;
    settingsTelemetrySink: SettingsTelemetrySink | null;
    isSessionWorkCurrent(workGen: number): boolean;
    pushTaskContext(ctx: TaskContext): void;
    popTaskContext(ctx: TaskContext): void;
    ensureModelLoaded(): Promise<void>;
    beginIndexJob(kind: 'full' | 'catchup' | 'cold', total: number, label: string): number;
    refreshIndexStatusBar(): void;
    touchIndexInventory(): Promise<void>;
    maybeUnloadEmbedder(reason: 'idle' | 'background'): void;
    appendErrorIfCurrent(context: string, error: unknown, gen?: number): void;
    runCatchUp(): void;
    scheduleStartupCatchUp(): void;
    syncWarmDeferred(): void;
    syncCatchUpJob(count: number): void;
    periodicReconcile(): Promise<void>;
}

export class PluginSchedulerManager {
    private host: PluginSchedulerHost;
    readonly dirtyQueue = new Set<string>();
    readonly deletedQueue = new Set<string>();
    idleTimer: number | null = null;
    structTimer: number | null = null;
    flushing = false;
    lastActiveFile: TFile | null = null;

    lastExcludedPaths: string[] | null = null;
    exclusionWatcherArmed = false;
    exclusionChange: ExclusionDiff | null = null;
    exclusionChangeDetectedAt = 0;

    constructor(host: PluginSchedulerHost) {
        this.host = host;
    }

    /**
     * Wires active leaf changes, vault creates/deletes/renames, and window blur
     * handlers for incremental indexing debouncing.
     */
    wireIncrementalIndexing(
        registerEvent: (ref: EventRef) => void,
        registerDomEvent: (el: Window, type: 'blur', handler: () => void) => void,
    ): void {
        this.lastActiveFile = this.host.app.workspace.getActiveFile();

        // Edits: index the note you LEAVE, not the one you arrive at.
        registerEvent(this.host.app.workspace.on('active-leaf-change', () => {
            const left = this.lastActiveFile;
            this.lastActiveFile = this.host.app.workspace.getActiveFile();
            if (left) void this.enqueueIfDirty(left);
        }));

        // Structural events — discrete, rare, no blur equivalent. Gated on
        // vaultIndexEventsReady so the initial adapter enumeration is not treated
        // as thousands of creates (reconcileOnLoad diffs the settled vault).
        registerEvent(this.host.app.vault.on('create', (f) => {
            if (!this.host.vaultIndexEventsReady) return;
            if (f instanceof TFile && isIndexableFile(f, this.host.settings.indexBases)) {
                this.dirtyQueue.add(f.path);
                this.scheduleFlush();
            }
        }));
        registerEvent(this.host.app.vault.on('delete', (f) => {
            if (!this.host.vaultIndexEventsReady) return;
            if (!(f instanceof TFile) || !isIndexableFile(f, this.host.settings.indexBases)) return;
            this.deletedQueue.add(f.path);
            this.dirtyQueue.delete(f.path);
            this.flushStructuralSoon();
        }));
        registerEvent(this.host.app.vault.on('rename', (f, oldPath) => {
            if (!this.host.vaultIndexEventsReady) return;
            // Drop the old path (covers plain rename, move, and move-into-ignored
            // = soft-delete) and index the new one. shouldIndex/reindexDelta decide
            // the archive/un-archive outcome by destination.
            this.deletedQueue.add(oldPath);
            this.dirtyQueue.delete(oldPath);
            if (f instanceof TFile && isIndexableFile(f, this.host.settings.indexBases)) {
                this.dirtyQueue.add(f.path);
            }
            this.flushStructuralSoon();
        }));

        // Window blur (desktop alt-tab) — same intent as visibilitychange:hidden.
        registerDomEvent(window, 'blur', () => this.flushOnBackground());
    }

    /**
     * Wires background periodic intervals (periodic reconcile, exclusion polling, idle model unload).
     */
    wireBackgroundIntervals(registerInterval: (id: number) => void): void {
        // Periodic sidecar reconcile: remote arrivals don't fire vault events for
        // .obsidian/ dotfiles, so poll for another device's freshly-synced index
        // every 5 min.
        registerInterval(window.setInterval(() => void this.host.periodicReconcile(), 5 * 60 * 1000));

        // Exclusion-list watch: Obsidian's "Excluded files" has no plugin event, so
        // poll its effective excluded live-path set every 5s.
        registerInterval(window.setInterval(() => this.pollExclusionChanges(), 5000));

        // Mobile: reset the WASM heap during genuine idle.
        if (isMobilePlatform()) {
            registerInterval(window.setInterval(() => {
                if (Date.now() - this.host.lastModelUseAt >= IDLE_UNLOAD_MS) {
                    this.host.maybeUnloadEmbedder('idle');
                }
            }, UNLOAD_CHECK_MS));
        }
    }

    // Enqueue a note for re-index only if it actually changed since we last
    // indexed it (the mtime guard) — so navigating through notes to READ them
    // never triggers an embed. One quick IDB read per note-leave.
    async enqueueIfDirty(file: TFile | null): Promise<void> {
        if (this.host.unloading) return;
        if (!file || !isIndexableFile(file, this.host.settings.indexBases)) return;
        if (!this.host.orchestrator) return;
        try {
            const stored = await this.host.store.getFileRecord(file.path);
            if (!stored || file.stat.mtime > stored.mtimeMs) {
                this.dirtyQueue.add(file.path);
                this.scheduleFlush();
            }
        } catch (e) {
            this.host.appendErrorIfCurrent('enqueueIfDirty', e);
        }
    }

    // 5-min idle debounce for edits: resets on every enqueue, so flipping back to
    // keep writing pushes the flush out rather than firing mid-thought.
    scheduleFlush(): void {
        if (this.idleTimer != null) window.clearTimeout(this.idleTimer);
        this.idleTimer = window.setTimeout(() => {
            this.idleTimer = null;
            void this.flushDirty();
        }, IDLE_FLUSH_MS);
    }

    // Short debounce for structural changes — model-free, so flush them soon
    // rather than waiting out the 5-min edit window (a dead result is jarring).
    flushStructuralSoon(): void {
        if (this.structTimer != null) window.clearTimeout(this.structTimer);
        this.structTimer = window.setTimeout(() => {
            this.structTimer = null;
            void this.flushDirty();
        }, STRUCT_FLUSH_MS);
    }

    // Backgrounding flush: capture the note currently being edited (it may never
    // have fired active-leaf-change) and drain immediately, before the OS can
    // reclaim the WebView.
    flushOnBackground(): void {
        const active = this.host.app.workspace.getActiveFile();
        const flushed = active
            ? this.enqueueIfDirty(active).then(() => this.flushDirty())
            : this.flushDirty();
        // Mobile: once the last-safe-window flush settles, free the model before
        // iOS can jetsam-kill the backgrounded WebView. Chained AFTER the flush so
        // the unload predicate sees its settled state (not a half-armed queue);
        // any embeds the mobile flush deferred are re-found by computeDelta and
        // reloaded on the next foreground, so this never drops work.
        if (isMobilePlatform()) {
            void flushed.then(() => {
                if (!this.host.unloading) this.host.maybeUnloadEmbedder('background');
            }).catch(() => {});
        }
    }

    // Drain the dirty/deleted queues through one reindexDelta. Deletes/moves
    // always apply (model-free structural phase); the embed half runs now on
    // desktop or a warm model, and defers on a cold mobile model (the edit's old
    // version stays searchable and the post-serve catch-up re-embeds it).
    async flushDirty(): Promise<void> {
        if (this.host.unloading) return;
        const workGen = this.host.loadGeneration;
        if (this.flushing || !this.host.orchestrator) {
            // A timer fired while a flush was already running (the in-progress flush
            // snapshotted BEFORE these items, so they need their own cycle). Re-arm
            // one so queued edits don't wait for the next unrelated enqueue or a
            // restart. Guard on no pending timer to avoid stacking; a stale re-arm
            // is harmless — flushDirty no-ops on an empty queue.
            if (this.flushing && (this.dirtyQueue.size > 0 || this.deletedQueue.size > 0)
                && this.idleTimer == null && this.structTimer == null) {
                this.scheduleFlush();
            }
            return;
        }
        if (this.dirtyQueue.size === 0 && this.deletedQueue.size === 0) return;
        this.flushing = true;
        let bulkProgress = false;
        let bulkJobId: number | null = null;
        // Span the whole drain: the incremental path was the biggest un-wrapped
        // jank source (issue #5 — all its long tasks logged as 'idle').
        this.host.pushTaskContext('indexing');
        const orchestrator = this.host.orchestrator;
        try {
            const dirty = [...this.dirtyQueue];
            const deleted = [...this.deletedQueue];
            // Snapshot each dirty file's mtime so the cleanup below can tell "this
            // exact version was flushed" from "re-edited during the await". A re-edit
            // bumps the mtime and enqueueIfDirty re-adds the path; a blind delete
            // would then clobber that second edit (lost until reconcileOnLoad).
            // -1 = the file vanished (deleted/moved) — handled via deletedQueue.
            const dirtyMtimes = new Map<string, number>();
            for (const p of dirty) {
                const f = this.host.app.vault.getAbstractFileByPath(p);
                dirtyMtimes.set(p, f instanceof TFile ? f.stat.mtime : -1);
            }
            const bulk = dirty.length > BULK_DELTA_THRESHOLD;
            // Cold-model embed deferral. Mobile: a cold model always defers (the
            // jetsam rule). Desktop: additionally defer a BULK cold flush — a
            // background paste/sync shouldn't force a ~250 MB model load; treat it
            // like reconcileOnLoad and let the first search drive the embed. A small
            // cold delta still loads, because the user is actively in that note.
            const coldMobile = isMobilePlatform() && !this.host.embedder.loaded;
            const coldDesktopBulk = !isMobilePlatform() && !this.host.embedder.loaded && bulk;
            // Peer-ahead grind-stop (mobile): a newer-version peer index exists that this
            // build can't read, so any local embed now is throwaway work (discarded the
            // moment the user updates Seek and hydrates the peer's index). Defer instead —
            // the file keeps its old chunks (queryable, stale-not-wrong) and the banner
            // tells the user to update. Mobile-only: desktop embedding isn't jetsam-bound
            // and a desktop is the fleet's heal path.
            const peerAheadDefer = isMobilePlatform() && (this.host.orchestrator?.peerAhead ?? false);
            const deferEmbed = coldMobile || coldDesktopBulk || peerAheadDefer;
            if (!deferEmbed) await this.host.ensureModelLoaded();

            if (bulk) {
                // Mini-reindex path. Status-bar percent; skipped when the
                // embed is deferred (nothing to count). A live query aborts the burst
                // (shouldContinue); hide the bar so it can reopen on the drain.
                if (!deferEmbed) {
                    bulkJobId = this.host.beginIndexJob('catchup', dirty.length, `Seek: indexing ${dirty.length} changed notes—`);
                    bulkProgress = true;
                }
                const result = await orchestrator.reindexDelta(dirty, deleted, {
                    embed: !deferEmbed,
                    shouldContinue: () => !this.host.indexingBlocked,
                    onProgress: deferEmbed ? undefined : (msg) => {
                        if (bulkJobId != null) this.host.indexProgress.updateFromProgress(msg, bulkJobId);
                    },
                });
                // Summary counts what actually committed — an embed preempted by a
                // query reports the partial total honestly; the drain finishes the
                // rest silently. No toast on throw (flushDirty's catch logs it).
                if (!deferEmbed && result.embedded) {
                    new Notice(`Seek: indexed ${result.embedded.committedFilePaths.length} files — ${result.embedded.chunksIndexed} chunks`, 5000);
                }
                // Reconcile whatever the embed left undone (deferred cold, or
                // preempted by a query). runCatchUp is self-guarding (no-op while
                // searching / hidden / model cold) and computeDelta-idempotent — a
                // fully-completed pass just costs one empty diff.
                this.host.catchUpPending = true;
                this.host.runCatchUp();
            } else {
                // Single-note fast path. Still preempt on a live OR in-flight query
                // so a just-edited note can't force a main-thread embed mid-search —
                // the foreground query must win the shared iOS thread (the note's
                // "indexing must wait for the query"). A preempted (or cold-deferred)
                // note keeps its old chunks, doesn't advance its file record, and so
                // stays dirty + pending for runCatchUp, which fires the moment the
                // query completes (onQueryInFlight(false)) — computeDelta re-finds it.
                await orchestrator.reindexDelta(dirty, deleted, {
                    embed: !deferEmbed,
                    shouldContinue: () => !this.host.indexingBlocked,
                });
                if ((deferEmbed || this.host.indexingBlocked) && dirty.length > 0) {
                    this.host.catchUpPending = true;
                }
                this.host.runCatchUp();
            }

            // Clear exactly what we snapshotted — but only dirty paths NOT re-edited
            // mid-flush (mtime unchanged since the snapshot). A re-enqueued path
            // stays for the next flush instead of being clobbered; new paths queued
            // during the await were never in `dirty`. Deletes are unconditional.
            for (const p of deleted) this.deletedQueue.delete(p);
            for (const p of dirty) {
                const f = this.host.app.vault.getAbstractFileByPath(p);
                const current = f instanceof TFile ? f.stat.mtime : -1;
                if (current === dirtyMtimes.get(p)) this.dirtyQueue.delete(p);
            }
        } catch (e) {
            this.host.appendErrorIfCurrent('flushDirty', e, workGen);
        } finally {
            if (this.host.isSessionWorkCurrent(workGen)) this.host.popTaskContext('indexing');
            this.flushing = false;
            if (bulkJobId != null) this.host.indexProgress.hide(bulkJobId);
            else if (!bulkProgress) this.host.refreshIndexStatusBar();
            if (this.host.isSessionWorkCurrent(workGen)) void this.host.touchIndexInventory();
        }
    }

    // Exclusion-list watch: Obsidian's "Excluded files" has no plugin event, so
    // poll its effective excluded live-path set every 5s. Cheap (in-memory filter
    // over the TFile list, no IDB, no reads) and self-gating — it no-ops while a
    // write/boot pass is running, and only fires on a real path-set change.
    pollExclusionChanges(): void {
        if (!this.host.vaultIndexEventsReady || !this.host.orchestrator || this.host.unloading) return;
        // Don't snapshot while a write is in flight OR while boot reconciliation is
        // still running — a mid-reconcile/mid-reindex enumeration could read a
        // partially-updated live set and manufacture a spurious diff.
        if (this.flushing || this.host.catchUpRunning || this.host.indexBootPending || this.host.sidecarHydrating) {
            return;
        }
        let next: string[];
        try {
            next = this.host.orchestrator.getExcludedLivePaths();
        } catch { return; }
        const prev = this.lastExcludedPaths;
        this.lastExcludedPaths = next;
        if (prev === null) { this.exclusionWatcherArmed = true; return; }  // seed baseline
        const diff = diffExcludedPaths(prev, next);
        if (exclusionDiffIsEmpty(diff)) return;
        this.exclusionChange = diff;
        this.exclusionChangeDetectedAt = Date.now();
        this.notifyFolderCoverageChanged();
        this.driveExclusionBackfill(diff);
    }

    // Drive an index pass for the detected exclusion change. Newly-included files have
    // no FileRecord, so computeDelta already flags them dirty and drainCatchUp backfills
    // them; newly-excluded files are in computeDelta's deleted set, so the same pass
    // soft-deletes them. This just arms + surfaces the pass.
    driveExclusionBackfill(diff: ExclusionDiff): void {
        if (!this.host.orchestrator || this.host.unloading) return;
        this.host.catchUpPending = true;
        this.host.syncWarmDeferred();
        const count = Math.max(diff.newlyIncludedPaths.length, diff.newlyExcludedPaths.length, 1);
        // Surface the pass on the status bar immediately so it reads "indexing—".
        this.host.syncCatchUpJob(count);
        if (isMobilePlatform()) {
            this.host.scheduleStartupCatchUp();
            return;
        }
        const workGen = this.host.loadGeneration;
        const pacer = new CompositorPacer();
        void pacer.pace().then(async () => {
            if (!this.host.isSessionWorkCurrent(workGen) || !this.host.catchUpPending) return;
            try {
                await this.host.ensureModelLoaded();
                if (!this.host.isSessionWorkCurrent(workGen)) return;
                this.host.runCatchUp();
            } catch {
                // Leave catchUpPending set — a later trigger (search end / foreground)
                // retries the drain.
            }
        });
    }

    /** The last exclusion-list change, or null. `backfilling` = a pass is in flight. */
    getExclusionChange(): { diff: ExclusionDiff; detectedAt: number; backfilling: boolean } | null {
        if (!this.exclusionChange || exclusionDiffIsEmpty(this.exclusionChange)) return null;
        return {
            diff: this.exclusionChange,
            detectedAt: this.exclusionChangeDetectedAt,
            backfilling: this.host.catchUpPending || this.host.catchUpRunning,
        };
    }

    /** Called when the backfill for a detected change finishes (catch-up drained). */
    clearExclusionChange(): void {
        if (this.exclusionChange === null) return;
        this.exclusionChange = null;
        this.exclusionChangeDetectedAt = 0;
        this.notifyFolderCoverageChanged();
    }

    private notifyFolderCoverageChanged(): void {
        this.host.settingsTelemetrySink?.onFolderCoverageChanged?.();
    }

    // Force an exclusion re-check now (used when the user flips "Honor excluded
    // folders" in Settings, rather than waiting for the 5s poll).
    forcePollExclusions(): void {
        this.pollExclusionChanges();
    }

    runCatchUp(): void {
        this.host.runCatchUp();
    }

    hasDeferredWork(): boolean {
        return (
            this.dirtyQueue.size > 0 ||
            this.deletedQueue.size > 0 ||
            this.idleTimer != null ||
            this.structTimer != null
        );
    }

    dispose(): void {
        if (this.idleTimer != null) {
            window.clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.structTimer != null) {
            window.clearTimeout(this.structTimer);
            this.structTimer = null;
        }
        this.dirtyQueue.clear();
        this.deletedQueue.clear();
    }
}
