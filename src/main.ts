// Seek plugin entry. Three commands per v0 scope:
//   1. seek-search        — open the search modal
//   2. seek-reindex       — full reindex (nuke + rebuild)
//   3. seek-generate-log  — write seek-report.md from seek-log.ndjson
//
// Plus a headless CLI query handler (registerCliHandler), exposed only when the
// obsidian-cli bridge is present: `obsidian seek:search query="..."`. Unlike the
// palette command (which opens a modal and returns void), the CLI handler returns
// a string the bridge writes to stdout — readable text by default, JSON with
// `format=json`. See the registration in onload.
//
// Intentional non-features for v0:
//   - No settings tab (zero admin console, per task brief)
//   - No incremental reindex
//   - No sync sidecar protocol
//   - No model-cache management
//   - No MCP wrapper

import { Notice, Plugin, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { ConfirmModal } from './confirm-modal';
import { LocalEmbedder, LOCAL_MODEL, LEGACY_ENGLISH_MODEL_ID, EMBEDDING_DIM } from './embedder';
import type { WorkerProbeResult, WorkerEmbedTestResult } from './iframe-runner';
import { activeModelSpec, resolveOverrideSpec, evictStaleModelCaches, deleteModelCaches, probeModelDownloaded } from './model-registry';
import { pluginIdentity, identityMatches, identityFromMeta } from './identity';
import { isLoadGenerationCurrent, isSessionWorkCurrent } from './boot-session';
import {
    createStoreOpenRetryScheduler,
    isRetryIndexStoreCommandEnabled,
    storeOpenRetryDelaysMs,
    storeOpenBackoffDelaysMs,
    type StoreOpenRetryScheduler,
} from './index-store-lock';
import { sweepOrphanTmpFiles } from './sidecar';
import type { SeekSettings, IndexCompleteEntry, ModelDeliveryEntry, ScoredChunk, SearchEntry } from './types';
import { DEFAULT_SETTINGS, migrateSettings } from './types';
import { IndexStore, indexDbPrefix, isTransientIdbUnavailable } from './index-store';
import { SeekLogger, REPORT_ARTIFACTS_DIR } from './logger';
import { openDiagnosticReport } from './diagnostic-report';
import { Forensics } from './forensics';
import { RecentSearches } from './recents';
import { SearchOrchestrator, driftRecoveryDecision, shouldIndexPath, type RecencyOverride } from './search';
import {
    diffExcludedPaths,
    exclusionDiffIsEmpty,
    emptyFolderCoverage,
    type ExclusionDiff,
    type FolderCoverageSummary,
} from './folder-coverage';
import { SeekSearchModal, type IndexBanner } from './search-modal';
import { parsePaneType, openFileAtTarget, openBaseAtTarget, type OpenTarget } from './open-target';
import { registerSeekCliHandlers } from './cli-handlers';
import { DriftRecoveryCoordinator } from './drift-recovery-coordinator';
import {
    PluginSchedulerManager,
    type PluginSchedulerHost,
    isIndexableFile,
    IDLE_FLUSH_MS,
    STRUCT_FLUSH_MS,
    IDLE_UNLOAD_MS,
    UNLOAD_CHECK_MS,
    BULK_DELTA_THRESHOLD,
} from './plugin-schedulers';
import { indexBannerSpec, resolveIndexLoadPhase, resolveCliSearchGate, CLI_SEARCH_WARMING, resolveIndexUiStatus, resolveSidecarWait, retainIndexInventory, INDEX_STALE_MSG, INDEX_SYNCING_MSG, INDEX_PEER_AHEAD_MSG, type DegradedReason, type IndexLoadState } from './index-notice';
import { IndexStatusBar, extendIndexPassTotal, parseIndexedProgress } from './index-status-bar';
import type { IndexJobKind, IndexStatusHealth, IndexStatusJob } from './index-status-card';
import {
    RecentSearchRing,
    StartupBootHistory,
    StartupSessionTracker,
    type RecentSearchEntry,
    type StartupTimingView,
    type StoredStartupBoot,
} from './session-telemetry';
import { SeekSettingTab } from './settings-tab';
import { collectPlatformInfo, isMobilePlatform, resolveDevice, recordActiveBackend, maybeDemoteOnCrash, getStartupWarm } from './platform';
import { CompositorPacer, cheapYield } from './pacer';
import { shouldUnloadEmbedder, type UnloadGateState } from './embedder-lifecycle';
import {
    drainCatchUp,
} from './catchup';
import {
    isKnownEmptyIndexWithNotes,
    shouldAutoDrainStartupCatchUp,
    resolveIndexBuildMode,
    catchUpBurstLimits,
    type IndexBuildMode,
} from './startup-drain';
import { TaskContextTracker, type TaskContext } from './task-context';
import { seekPerf } from './perf-console';
import {
    whenLayoutReady,
    scheduleAfterLayoutReady,
    scheduleAfterLayoutReadyBuffered,
    isIgnorableStartupConsoleError,
    type BootBufferHandle,
} from './layout-ready';
import { parseJsonStripBom } from './json-text';
import type { LongTaskEntry, MemoryPressureEntry, StorageSnapshotEntry, EvictionSuspectedEntry, AppLocalFetchEntry } from './types';

// Long-task threshold. PerformanceObserver fires for any task ≥50 ms by spec,
// but at that floor we'd flood the log. 250 ms is the rough threshold above
// which the user perceives a stutter and is also the design-doc latency
// budget for search.
const LONG_TASK_THRESHOLD_MS = 250;

// Boot buffer: after onLayoutReady, wait this long before the first IndexedDB
// work (store open, hydrate, reconcile) so other plugins' startup I/O gets the
// window first. The search modal bypasses the remaining wait immediately, so
// the cost only lands on background indexing — never on the user opening
// search. Kept small: user-approved budget is "a few seconds, no more".
const POST_LAYOUT_BOOT_BUFFER_MS = 3500;


// Sidecar compaction: how many 'incomplete-rechunk' verdicts (each = a full
// vault re-chunk that found an unreadable/untokenizable file) to tolerate per
// session before latching compaction off until the next session. 3 gives a
// genuinely transient failure (file mid-sync) two more polls to clear while
// capping the pathological case at ~15 minutes of exposure.
const SIDECAR_COMPACT_MAX_INCOMPLETE_RETRIES = 3;
// Hard-error budget for the every-poll small-shard coalesce before it latches
// off for the session (transient iCloud/WKWebView IO deserves a few retries;
// a persistent disk-full must not re-run a rewrite every 5 minutes).
const SIDECAR_COALESCE_MAX_FAILURES = 3;


// DTOs returned to the settings tab by getIndexStats() / getModelStatus(). Defined
// here (not types.ts) because they describe this plugin's read API; settings-tab.ts
// imports them as types.
export interface IndexStats {
    files: number;
    chunks: number;
    // storageMB = navigator.storage.estimate().usage — the WHOLE origin (index + model
    // + every other plugin's storage); kept as a fallback. indexMB / modelMB split it via
    // the non-standard usageDetails ({ indexedDB, caches }) that Electron/Chromium exposes:
    // indexedDB ≈ the vector index, caches ≈ the transformers-cache model bytes. Both are
    // origin-shared (other plugins' IDB/Cache count too), but Seek dominates each, so the
    // split is a far more honest read than the conflated total. null when unavailable.
    storageMB: number | null;
    indexMB: number | null;
    modelMB: number | null;
    // "Last full index" is sourced from the most recent index-complete log entry whose
    // mode is 'full' — timestamp + duration come from the SAME run, so they always agree
    // (the prior code mixed meta's any-mode timestamp with the log's any-mode duration,
    // which let a 2-file catch-up's 2.0s masquerade as a full reindex). Null if no full
    // run survives in the (rotatable) log.
    lastFullAt: string | null;
    lastFullDurationMs: number | null;
    // Last index of ANY mode (incremental catch-ups included), from store meta. Shown as
    // a secondary "updated …" line when it post-dates the full reindex.
    lastUpdatedAt: string | null;
    // True once the index has a calibrated dense background (bgMean/bgStd present,
    // σ>0) — the precondition for a non-null match strength. Gates the "Display
    // scores" toggle: scores can't be shown on an uncalibrated corpus.
    calibrated: boolean;
}
export interface ModelStatus {
    downloaded: boolean;
    persisted: boolean | null;
    name: string;
    dim: number;
}

/** Settings tab hook for live startup / recent-search console refresh. */
export interface SettingsTelemetrySink {
    onSessionTelemetryChanged(): void;
    /** Fired when per-folder embedder coverage or an exclusion change is detected. */
    onFolderCoverageChanged?(): void;
}

export default class SeekPlugin extends Plugin {
    private embedder = new LocalEmbedder();
    private store = new IndexStore();
    private logger!: SeekLogger;
    /* internal */ orchestrator!: SearchOrchestrator;
    // Mutated in place on settings change so the orchestrator (which holds the
    // same reference) always reads current values. See types.ts SeekSettings.
    settings: SeekSettings = { ...DEFAULT_SETTINGS };

    // Promise that resolves once the model is loaded. Lazy-init: we don't
    // want to spend 250 MB of RAM on plugin startup if the user never opens
    // the search modal. The first search/reindex invocation triggers it.
    private modelLoadPromise: Promise<void> | null = null;

    // Async observer handles + global handlers we register on load and
    // explicitly tear down on unload. Without cleanup these leak into the
    // next plugin reload and we end up with duplicate logging on every hot
    // reload during development.
    private longTaskObserver: PerformanceObserver | null = null;
    // Task contexts as SPANS, not a scalar (audit R2 #9 kept the overlap
    // tolerance; issue #5 forced the span upgrade): contexts overlap — opening
    // the search modal during a running reindex used to stomp the scalar back
    // to 'idle' — and, worse, the longtask observer delivers entries only
    // AFTER a task ends, so a read-at-delivery stack labeled the final task of
    // every phase (and every un-wrapped path) 'idle'. The tracker records
    // push/pop as timestamped spans and attributes each longtask by interval
    // overlap; current() preserves the old top-of-stack read for the
    // behavioral consumers (isIndexing, the mobile unload gate).
    private readonly taskCtx = new TaskContextTracker();
    private get currentTaskContext(): TaskContext | 'idle' {
        return this.taskCtx.current();
    }
    private pushTaskContext(c: TaskContext): void {
        this.taskCtx.push(c);
    }
    private popTaskContext(c: TaskContext): void {
        this.taskCtx.pop(c);
    }
    private onError: ((e: ErrorEvent) => void) | null = null;
    private onUnhandledRejection: ((e: PromiseRejectionEvent) => void) | null = null;
    private onVisibilityChange: (() => void) | null = null;
    private onPageHide: (() => void) | null = null;
    // The document the visibilitychange listener is bound to, captured at add-time.
    // activeDocument tracks the focused window, which can change to a popout between
    // load and unload — so removing against a fresh activeDocument would target the
    // wrong document and leak the main-window listener. Bind + unbind via this ref.
    private visibilityDoc: Document | null = null;
    // Crash forensics (see forensics.ts). Created in onload once the vault
    // scope (appId) is known; null only during the first lines of onload.
    private forensics: Forensics | null = null;
    // Recent searches (see recents.ts) — per-device localStorage, same
    // manifest-id + vault scoping as forensics. Null only during early onload.
    private recents: RecentSearches | null = null;

    // Background schedulers and queue state (see plugin-schedulers.ts).
    private _schedulers?: PluginSchedulerManager;
    /* internal */ get schedulers(): PluginSchedulerManager {
        if (!this._schedulers) {
            this._schedulers = new PluginSchedulerManager(this as unknown as PluginSchedulerHost);
        }
        return this._schedulers;
    }

    private get dirtyQueue(): Set<string> { return this.schedulers.dirtyQueue; }
    private set dirtyQueue(val: Set<string>) {
        this.schedulers.dirtyQueue.clear();
        for (const item of val) this.schedulers.dirtyQueue.add(item);
    }
    private get deletedQueue(): Set<string> { return this.schedulers.deletedQueue; }
    private set deletedQueue(val: Set<string>) {
        this.schedulers.deletedQueue.clear();
        for (const item of val) this.schedulers.deletedQueue.add(item);
    }
    // False until onLayoutReady: vault.on('create') fires for every existing note
    // while the adapter is still enumerating. Those are not real creates — they
    // queued the whole vault as dirty (main vault 2026-08-29: 4528-note bulk flush)
    // and made computeDelta see live:0 vs thousands stored.
    private vaultIndexEventsReady = false;
    private get lastActiveFile(): TFile | null { return this.schedulers.lastActiveFile; }
    private set lastActiveFile(val: TFile | null) { this.schedulers.lastActiveFile = val; }
    private get idleTimer(): number | null { return this.schedulers.idleTimer; }
    private set idleTimer(val: number | null) { this.schedulers.idleTimer = val; }
    private get structTimer(): number | null { return this.schedulers.structTimer; }
    private set structTimer(val: number | null) { this.schedulers.structTimer = val; }
    private lastModelUseAt = 0;                  // epoch ms of the last ensureModelLoaded; drives the idle-unload timer (mobile)
    private get lastExcludedPaths(): string[] | null { return this.schedulers.lastExcludedPaths; }
    private set lastExcludedPaths(val: string[] | null) { this.schedulers.lastExcludedPaths = val; }
    private get exclusionChange(): ExclusionDiff | null { return this.schedulers.exclusionChange; }
    private set exclusionChange(val: ExclusionDiff | null) { this.schedulers.exclusionChange = val; }
    private get exclusionChangeDetectedAt(): number { return this.schedulers.exclusionChangeDetectedAt; }
    private set exclusionChangeDetectedAt(val: number) { this.schedulers.exclusionChangeDetectedAt = val; }
    private get exclusionWatcherArmed(): boolean { return this.schedulers.exclusionWatcherArmed; }
    private set exclusionWatcherArmed(val: boolean) { this.schedulers.exclusionWatcherArmed = val; }
    private get flushing(): boolean { return this.schedulers.flushing; }
    private set flushing(val: boolean) { this.schedulers.flushing = val; }
    private catchUpPending = false;              // cold-mobile deferred an embed
    private catchUpRunning = false;              // runCatchUp re-entrancy guard
    private coldBuildScheduled = false;          // scheduleColdBuild single-flight
    private persistCacheRestoredThisBoot = false; // restorePersistedCachesBeforeReconcile once
    /** Live catch-up pass shown on the status bar — survives burst pauses and self-chains. */
    private catchUpJob: { id: number; passTotal: number; committed: number } | null = null;
    // True from construct until the onload sidecar/reconcile IIFE finishes, so the
    // search modal cannot latch "isn't indexed yet" on an empty store mid-hydrate.
    private indexBootPending = true;
    /** False once applyPostBootIndexScheduling has classified idle vs catch-up vs full. */
    private indexBootDecisionPending = true;
    private indexGoodEnough = false;
    private sidecarHydrating = false;
    // performance.now() at boot IIFE start — used for startup-gate elapsedMs.
    private bootStartMs = 0;
    private waitingForSidecar = false;
    // Last known indexed file/chunk counts for sync status-bar health (null = not probed yet).
    private indexInventoryFiles: number | null = null;
    private indexInventoryChunks: number | null = null;
    private inventoryGen = 0;
    private nextIndexJobId = 1;
    private readonly indexProgress = new IndexStatusBar();
    // Drift auto-recovery (sibling of catch-up). The orchestrator detects persistent
    // frame/BM25 row-space drift and fires onPersistentDrift; we run a bounded,
    // embed-free recovery ladder (warm → sidecar hydrate → verify). Re-escalation is
    // suppressed per index generation (see driftRecoveryDecision); indexHealth surfaces
    // a terminal 'degraded' on the settings page when the ladder can't re-couple.
    private driftRecoveryCoordinator!: DriftRecoveryCoordinator;
    get driftRecoveryPending(): boolean { return this.driftRecoveryCoordinator?.pending ?? false; }
    set driftRecoveryPending(val: boolean) { if (this.driftRecoveryCoordinator) this.driftRecoveryCoordinator.pending = val; }
    get driftRecoveryRunning(): boolean { return this.driftRecoveryCoordinator?.running ?? false; }
    set driftRecoveryRunning(val: boolean) { if (this.driftRecoveryCoordinator) this.driftRecoveryCoordinator.running = val; }
    get lastDriftRecoveryGen(): number { return this.driftRecoveryCoordinator?.lastRecoveryGen ?? -1; }
    set lastDriftRecoveryGen(val: number) { if (this.driftRecoveryCoordinator) this.driftRecoveryCoordinator.lastRecoveryGen = val; }
    private indexHealth: 'healthy' | 'recovering' | 'degraded' = 'healthy';
    get indexHealthState(): 'healthy' | 'recovering' | 'degraded' { return this.indexHealth; }
    // WHY the index is in a non-healthy state, so the search-modal banner says the true
    // thing per cause (a 'drift' degradation must not claim "this update changed indexing").
    // Read alongside indexHealth, which splits the SAME 'version' reason into two banners:
    // 'recovering' = a peer's current index is syncing in (calm, no action); 'degraded' =
    // genuinely stale, reindex needed. Cleared on every return to 'healthy'. 'version' = a
    // CHUNKER_VERSION/model bump the user hasn't reindexed for; 'drift' = drift-recovery
    // exhausted; 'peer-ahead' = a PEER's index is newer than this build (update Seek), set
    // from orchestrator.peerAhead by applyPeerAheadBanner. See indexBannerSpec.
    private degradedReason: DegradedReason = null;
    // True while the local index is version-stale AND a peer device's current-version
    // sidecar is present (so it WILL hydrate us embed-free on a later poll). Set from
    // peerSidecarPresent() at the version-stale branch and cleared on every heal. This —
    // NOT indexHealth==='recovering' — drives the calm "syncing from another device"
    // banner, because the local drift-recovery ladder also sets 'recovering' and must not
    // claim a (non-existent) peer is syncing on a single-device vault. See indexBannerSpec.
    private peerSyncPending = false;
    // Fires the "update Seek" toast once per peer-ahead spell (cleared when the signal
    // clears, e.g. after the user updates and the newer sidecar becomes readable).
    private peerAheadNotified = false;
    // Fires the version-identity mismatch log + the mobile "reindex on desktop" notice
    // once per stale spell (the gate re-checks every 5 min); cleared when identity heals
    // so a future version ship reports again. See enforceIndexIdentity.
    private identityHealNotified = false;
    // True while a heal (peer rebuild / desktop reindex) is running, so the 5-min poll
    // firing mid-reindex doesn't stack a second one (reindexAllInner would queue it).
    private identityHealInFlight = false;
    // The referential-integrity orphan sweep runs once per session (Phase 3), on the
    // first healthy 5-min poll — not at boot (it taxes app-open) and not repeatedly.
    // `Done` latches only on a COMPLETED pass; `Running` guards re-entrancy so an
    // overlapping poll tick can't double-run it.
    private orphanSweepDone = false;
    private orphanSweepRunning = false;
    // Sidecar self-compaction runs once per session on the same poll (after the sweep):
    // it reclaims this device's own superseded/orphaned sidecar records — the one GC an
    // off-grid device gets, since version-bump reindex + hydrate-from-peer need sync.
    // `Done` latches on any DEFINITIVE outcome (an incomplete re-chunk leaves it open to
    // retry); `Running` guards re-entrancy.
    private sidecarCompactDone = false;
    // Bounded retries for the 'incomplete-rechunk' verdict (see periodicReconcile):
    // each retry costs a whole-vault re-chunk, so a persistent failure must not
    // grind every 5-minute poll for the session.
    private sidecarCompactIncompleteRetries = 0;
    private sidecarCompactRunning = false;
    // Small-shard coalesce (oracle-free, every poll tick — see periodicReconcile).
    // `Failed` latches OFF for the session after a few hard errors so a failing
    // rewrite (disk full, write error) doesn't re-run every 5 minutes — but a
    // single transient iCloud/WKWebView hiccup gets bounded retries first, since
    // a long mobile session that latched on one blip would quietly re-grow the
    // exact small-shard pile the pass exists to fold. `Running` guards
    // re-entrancy against a slow fold spanning a poll tick.
    private sidecarCoalesceFailed = false;
    private sidecarCoalesceFailures = 0;
    private sidecarCoalesceRunning = false;
    /** IndexedDB refused to open after short retries — surfaces Locked UI and deferred retry. */
    private indexStoreLocked = false;
    private storeOpenRetryScheduler: StoreOpenRetryScheduler | null = null;
    private bootResumeCtx: {
        migrateSidecarPath: boolean;
        sidecarIndexDir: string;
        legacySidecarDir: string | null;
    } | null = null;
    /** Boot hydrate/reconcile ran (or was skipped because store stayed locked). */
    private bootContinuationDone = false;
    /**
     * Boot buffer between onLayoutReady and the first IndexedDB work: other
     * plugins' startup I/O gets the window first. Null once fired/cancelled.
     */
    private bootBuffer: BootBufferHandle | null = null;
    /** True when the search modal bypassed the boot buffer before it fired. */
    private bootBufferBypassed = false;
    private readonly startupTelemetry = new StartupSessionTracker();
    private startupHistory!: StartupBootHistory;
    private startupBootRecorded = false;
    private readonly recentSearchRing = new RecentSearchRing();
    private settingsTelemetrySink: SettingsTelemetrySink | null = null;

    // True while a reindex / incremental embed is running. currentTaskContext is
    // private; this is the read-only surface the settings Index status card reads
    // (on open and while polling a live reindex) to show its "Indexing…" state.
    get isIndexing(): boolean { return this.currentTaskContext === 'indexing'; }
    /** Boot / sidecar-restore phase for explicit status copy. Null when idle. */
    get indexWarmPhase(): 'starting' | 'restoring' | null {
        if (this.indexGoodEnough) {
            if (this.waitingForSidecar) return 'restoring';
            return null;
        }
        if (this.waitingForSidecar || (this.sidecarHydrating && !this.indexBootPending)) return 'restoring';
        if (this.indexBootPending || this.sidecarHydrating) return 'starting';
        return null;
    }
    get isIndexWarmingUp(): boolean { return this.indexWarmPhase != null; }
    /** True once tier-0 or post-hydrate gate released search (CLI probes). */
    get isIndexGoodEnough(): boolean { return this.indexGoodEnough; }

    /** Same health the status-bar item uses — Settings and the search modal must match it. */
    get indexUiHealth(): IndexStatusHealth {
        return this.statusBarHealth();
    }

    /** Coordinator pass currently shown on the status-bar badge, or null. */
    getIndexJob(): IndexStatusJob | null {
        return this.indexProgress.job();
    }

    private statusBarHealth(): IndexStatusHealth {
        return resolveIndexUiStatus({
            storeLocked: this.indexStoreLocked,
            booting: this.indexBootPending,
            bootDecisionPending: this.indexBootDecisionPending,
            hydrating: this.sidecarHydrating,
            goodEnough: this.indexGoodEnough,
            waitingForSidecar: this.waitingForSidecar,
            peerSyncPending: this.peerSyncPending,
            health: this.indexHealth,
            reason: this.degradedReason,
            indexing: this.catchUpRunning || this.flushing || this.isIndexing,
            catchUpPending: this.catchUpPending,
            job: this.indexProgress.job(),
            searchableChunks: this.indexInventoryChunks,
            inventoryFiles: this.indexInventoryFiles,
        });
    }

    private refreshIndexStatusBar(): void {
        this.indexProgress.refreshIdle();
    }

    private publishInventory(files: number, chunks: number, force = false): void {
        const next = retainIndexInventory(
            { files: this.indexInventoryFiles, chunks: this.indexInventoryChunks },
            { files, chunks },
            force,
        );
        this.indexInventoryFiles = next.files;
        this.indexInventoryChunks = next.chunks;
    }

    private async touchIndexInventory(): Promise<void> {
        const gen = ++this.inventoryGen;
        try {
            const c = await this.store.count();
            if (gen !== this.inventoryGen) return;
            this.publishInventory(c.files, c.chunks);
        } catch { /* store not open yet */ }
        if (gen === this.inventoryGen) this.refreshIndexStatusBar();
    }

    private beginIndexJob(kind: IndexJobKind, total: number, label: string): number {
        const id = this.nextIndexJobId++;
        this.indexProgress.show(total, label, { id, kind });
        return id;
    }

    private catchUpJobLabel(total: number): string {
        return `Seek: indexing ${total.toLocaleString()} notes…`;
    }

    /** Start or extend the catch-up coordinator job without resetting committed progress. */
    private syncCatchUpJob(dirtyCount: number): void {
        if (dirtyCount <= 0) return;
        if (this.catchUpJob == null) {
            const id = this.beginIndexJob('catchup', dirtyCount, this.catchUpJobLabel(dirtyCount));
            this.catchUpJob = { id, passTotal: dirtyCount, committed: 0 };
            return;
        }
        const passTotal = extendIndexPassTotal(this.catchUpJob.committed, this.catchUpJob.passTotal, dirtyCount);
        if (passTotal !== this.catchUpJob.passTotal) {
            this.catchUpJob.passTotal = passTotal;
            this.indexProgress.update(
                this.catchUpJob.committed,
                passTotal,
                this.catchUpJobLabel(passTotal),
                this.catchUpJob.id,
            );
        }
    }

    private finishCatchUpJob(): void {
        if (this.catchUpJob == null) return;
        this.indexProgress.hide(this.catchUpJob.id);
        this.catchUpJob = null;
    }

    /** Readiness gate for seek:search / seek:open / seek:insert-link — null when search may run. */
    async cliSearchGateMessage(): Promise<string | null> {
        let chunks = this.orchestrator ? await this.orchestrator.indexedChunkCount() : null;
        if ((chunks ?? 0) === 0 && (this.indexInventoryChunks ?? 0) > 0) chunks = this.indexInventoryChunks;
        return resolveCliSearchGate({
            warmPhase: this.indexWarmPhase,
            uiHealth: this.indexUiHealth,
            chunks,
            fullJobActive: this.getIndexJob()?.kind === 'full',
        });
    }

    // Soft-warming probe for the seek:search lexical fallback: resolveCliSearchGate
    // returns the warm-up notice (not a refusal) exactly when the store is
    // populated but boot/restore hasn't released the gate. seek:search serves
    // lexical results in that window (marked ready:false); seek:open /
    // seek:insert-link keep the hard gate since a wrong top hit misfires.
    private async cliSearchWarmingNotice(): Promise<string | null> {
        const gate = await this.cliSearchGateMessage();
        return gate === CLI_SEARCH_WARMING ? gate : null;
    }

    private openSeekSettings(): void {
        const setting = (this.app as unknown as {
            setting?: { open(): void; openTabById(id: string): void };
        }).setting;
        setting?.open();
        setting?.openTabById('seek');
    }
    private searchActiveTimestamp: number | null = null;   // null = no live query session; else the ms timestamp of the last activity ping (modal open / keystroke) — pauses the catch-up drain so embedding never competes with the user's search
    private static readonly SEARCH_ACTIVE_MAX_AGE_MS = 60_000;
    // Count of query embeds/searches actually running right now (onQueryInFlight).
    // Distinct from the keystroke-timed searchActive — it falls only when the query
    // COMPLETES, so indexing waits for the query, not just for typing to pause.
    // A COUNT, not a boolean: the modal emits balanced 0↔1 edges for its own
    // queries, and each headless query (CLI handlers, deep-link open) contributes
    // one balanced true/false pair — so overlapping callers can't clear each
    // other's signal the way a shared boolean would.
    private queryInFlightCount = 0;
    // Self-healing read of searchActive. A modal torn down without onClose (teardown
    // exception, dev hot-reload) would otherwise latch the flag true forever and
    // permanently starve catch-up (runCatchUp/drainCatchUp early-return on it, so
    // deferred cold-mobile embeds never reconcile until restart). Treat it inactive
    // past a max age; an active session re-stamps the timestamp on every keystroke.
    private get searchActive(): boolean {
        if (this.searchActiveTimestamp === null) return false;
        if (Date.now() - this.searchActiveTimestamp > SeekPlugin.SEARCH_ACTIVE_MAX_AGE_MS) {
            this.searchActiveTimestamp = null;
            return false;
        }
        return true;
    }

    // The single gate every indexing path honours: hold embeds while the user's
    // query must win the shared (iOS) thread — an active typing session (keystroke-
    // timed) OR a query embed that is actually in flight (lifecycle-timed). The
    // second term is what makes indexing wait for the query to COMPLETE rather than
    // resuming 1.5 s after the last keystroke while a slow mobile embed still runs.
    private get indexingBlocked(): boolean {
        return this.searchActive || this.queryInFlightCount > 0;
    }

    async onload() {
        this.unloading = false;
        this.loadGeneration++;
        const bootGen = this.loadGeneration;
        this.logger = new SeekLogger(this.app, this.manifest.id);
        const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
        this.startupHistory = StartupBootHistory.forPlugin(this.app.vault.adapter, pluginDir);
        void this.startupHistory.load()
            .then(() => {
                if (this.isSessionWorkCurrent(bootGen)) this.notifySessionTelemetryChanged();
            })
            .catch(e => this.appendErrorIfCurrent('startup-history-load', e, bootGen));
        // Sweep any pre-existing root-level seek-log/init/captures files into the
        // hidden LOG_DIR next to the index, THEN tail-truncate this device's log if it
        // has outgrown MAX_LOG_BYTES (append-only logs have no natural ceiling), THEN
        // prune any abandoned other-device / legacy logs (pruneOrphanLogs). All three are
        // fire-and-forget: new writes already target LOG_DIR, the report reads both
        // locations during the migration window, and rotation/pruning only shrink the tail
        // or drop dead files — so this blocks nothing on the load path. The steps chain in
        // order so each operates on the files at their final LOG_DIR location.
        void this.logger.migrateRootFiles()
            .then(() => this.logger.rotateIfOversize())
            .then(() => this.logger.pruneOrphanLogs())
            .catch(e => this.appendErrorIfCurrent('logger-onload-maintenance', e, bootGen));
        // Load persisted settings (merge over defaults so new keys appear).
        // Mutate the existing object in place — the orchestrator holds this
        // same reference.
        const raw = ((await this.loadData()) ?? {}) as Partial<SeekSettings>;
        // Rev 4 = sidecar path pinned to the literal '.obsidian'. Capture the
        // pre-migration rev HERE — the actual sidecar FILE move runs further below
        // (it needs the old active-override + new literal paths), and migrateSettings
        // is about to overwrite raw.settingsRev, so the flag must be read first.
        const migrateSidecarPath = (raw.settingsRev ?? 1) < 4;
        // Key-level schema migrations (rev 2 denseWeight rescale, rev 5 defaults
        // ratification — see migrateSettings in types.ts, where they're unit-tested).
        // Mutates `raw` and stamps settingsRev; runs BEFORE the Object.assign so the
        // migrated values win over the persisted ones rather than being overridden.
        migrateSettings(raw);
        Object.assign(this.settings, DEFAULT_SETTINGS, raw);
        // Persist migrated settings off the blocking onload path — await saveData
        // here can deadlock Obsidian on "Loading plugins" while the vault adapter
        // is still busy with other plugins' onload work (see vault plugin-dev gotchas).
        void this.saveData(this.settings).catch(e =>
            console.warn('[seek] deferred settings persist failed:', e));
        // Scope the index DB per vault. IndexedDB is shared across every vault
        // window (one Electron origin), so an unscoped name means vault A's
        // reindex destroys vault B's index (see index-store.ts LEGACY_DB_NAME).
        // appId is Obsidian's stable per-vault id — the same key it uses for
        // its own vault-scoped localStorage; not in the public typings, hence
        // the cast. Vault name fallback keeps a (rename-fragile) scope if a
        // future Obsidian drops appId.
        const appId = (this.app as unknown as { appId?: string }).appId;
        const vaultScope = appId ?? this.app.vault.getName();
        // Scope the DB by PLUGIN id too (indexDbPrefix), not just the vault, so a
        // second Seek build in this vault (e.g. an id 'seek-prototype' dev build)
        // owns a separate database. id 'seek' → 'seek-index:<appId>', unchanged.
        // Bind the name now; do not open IndexedDB until onLayoutReady — opening
        // here races Obsidian's File Recovery / cache / sync stores.
        this.store.configure(vaultScope, indexDbPrefix(this.manifest.id));

        // Crash forensics: synchronous localStorage breadcrumbs (vault-scoped
        // like the IDB name — localStorage is origin-shared across vaults on
        // mobile). bootInspect classifies an unclean previous session and we
        // promote it into the log; this is the ONLY way a jetsam kill becomes
        // visible, since async NDJSON appends die with the process. Scoped by
        // plugin id as well, so a co-installed build's breadcrumbs can't be
        // misread as this build's crash.
        this.forensics = new Forensics(`${this.manifest.id}:${vaultScope}`, this.logger.deviceId, this.logger.sessionId);
        // Recent searches share the forensics scope: plugin id keeps a
        // co-installed build's history separate, vault scope keeps two vaults
        // on one iOS origin from bleeding queries into each other.
        this.recents = new RecentSearches(`${this.manifest.id}:${vaultScope}`);
        const crash = this.forensics.bootInspect();
        if (crash) {
            // Forensics: always persist the classified crash to the per-device
            // log. This is the diagnostic surface (read via the log report) — it
            // is silent by design, not a toast.
            void this.logger.append(crash).catch(() => {});
            // Tripwire WITH a side effect: maybeDemoteOnCrash performs the sticky,
            // per-device WebGPU→WASM demotion (a localStorage write) when a mobile
            // device was killed mid-reindex in the foreground while WebGPU was the
            // active backend, so the next reindex doesn't walk into the same OS
            // kill. It MUST run on every boot — only its actionable "you're now on
            // WASM" result is surfaced. The generic "previous session ended
            // uncleanly" notice was removed: on iOS onunload never fires on an OS
            // suspend-kill, so any routine 12h+-backgrounded reopen classifies as a
            // benign `evicted-while-hidden` exit — that fired the toast on
            // essentially every mobile open for normal app lifecycle.
            if (maybeDemoteOnCrash(crash.verdict)) {
                new Notice('Seek: last session was killed mid-reindex on WebGPU — this device is now on WASM. Re-enable WebGPU in settings to retry.', 8000);
            }
        }

        // WebGPU loss diagnostics: the iframe pushes device-created / device-
        // lost / uncaptured-error events from its requestDevice hook. device-
        // lost is the only JS-visible discriminator between a GPU-process
        // death (page survives, this fires) and a WebContent kill (silence) —
        // see [[Seek Mobile WebGPU Investigation]]. Forensics beat FIRST and
        // synchronously: if the page is about to die too, the localStorage
        // write must win the race; the NDJSON append is the best-effort twin.
        this.embedder.onIframeEvent = (event) => {
            const kind = typeof event.kind === 'string' ? event.kind : 'webgpu-event';
            const detail: Record<string, number | string | boolean | null> = {};
            for (const [k, v] of Object.entries(event)) {
                if (k !== 'kind') detail[k] = v;
            }
            this.forensics?.beat(kind, detail);
            void this.logger.append({
                type: 'webgpu-event',
                timestamp: new Date().toISOString(),
                kind,
                ...detail,
            });
            // WebGPU device death (GPU process died, page survived). The in-flight
            // embedBatch would otherwise hang on the dead device until the per-RPC
            // timeout; reject it now (recoverable, NOT 'DISPOSED') so the embed
            // catch's recycle+retry rebuilds a fresh device promptly. Skipped while
            // unloading — the iframe is being torn down; don't poke it.
            if (kind === 'webgpu-device-lost' && !this.unloading) {
                this.embedder.failInflight('webgpu device lost');
            }
        };

        // Sidecar index dir. CRITICAL: resolved from a LITERAL config-folder
        // name, not this.manifest.dir — manifest.dir resolves against the
        // device's active Override Config Folder (vault.configDir), which is
        // per-device and never synced, so a split-config setup made producer
        // and consumer read different paths → silent zero results. See the
        // Sidecar Integration Plan §config-folder CRITICAL.
        const sidecarIndexDir = this.resolveSidecarIndexDir();
        // The pre-rev-4 path (active-override-relative). Used only to migrate an
        // existing index off it into the literal path on upgrade.
        const legacySidecarDir = this.manifest.dir ? `${this.manifest.dir}/index` : null;
        this.orchestrator = new SearchOrchestrator(this.app, this.store, this.embedder, this.logger, this.settings, this.forensics, sidecarIndexDir, this.taskCtx);
        this.driftRecoveryCoordinator = new DriftRecoveryCoordinator({
            getOrchestrator: () => this.orchestrator,
            getIndexHealth: () => this.indexHealth,
            setIndexHealth: (h) => { this.indexHealth = h; },
            setDegradedReason: (r) => { this.degradedReason = r; },
            isIndexingBlocked: () => this.indexingBlocked,
            isSessionWorkCurrent: (gen) => this.isSessionWorkCurrent(gen),
            getLoadGeneration: () => this.loadGeneration,
            appendErrorIfCurrent: (ctx, e, gen) => this.appendErrorIfCurrent(ctx, e, gen),
            withSidecarHydrate: (fn) => this.withSidecarHydrate(fn),
        });
        // The orchestrator is pull-based; this is its one injected outbound edge — it
        // fires when persistent frame/BM25 drift survives the cooldown, and we drive the
        // embed-free recovery ladder from the plugin (which owns scheduling + gating).
        this.orchestrator.setPersistentDriftHandler(() => this.onPersistentDrift());
        this.orchestrator.setGoodEnoughHandler(() => this.markIndexGoodEnough());
        this.addSettingTab(new SeekSettingTab(this.app, this));
        this.indexProgress.mount(this.addStatusBarItem(), {
            getStats: () => this.getIndexStats(),
            getHealth: () => this.statusBarHealth(),
            onOpenSettings: () => this.openSeekSettings(),
        });

        // Incremental indexing: live vault-event triggers + the startup catch-up
        // sweep. Wired here, after the orchestrator exists.
        this.wireIncrementalIndexing();
        // Sidecar restore THEN the mtime-diff sweep, sequenced (not raced): on a
        // cold/evicted device hydrate must finish populating the store before
        // reconcileOnLoad computes its delta, or computeDelta would read the empty
        // store, mark the whole vault dirty, and re-embed everything the sidecar
        // already holds. IndexedDB open, startup clocks, and hydrate wait for
        // onLayoutReady (callback, not awaited in onload) so they do not race
        // Obsidian's File Recovery / cache / sync stores.
        this.sidecarHydrating = false;
        this.bootResumeCtx = {
            migrateSidecarPath,
            sidecarIndexDir,
            legacySidecarDir,
        };
        // Callback form, not `await onLayoutReady()` inside onload — awaiting
        // here can deadlock because Obsidian waits for every plugin's onload
        // before firing layout ready.
        //
        // Buffered: hold POST_LAYOUT_BOOT_BUFFER_MS after layout ready before
        // the first IndexedDB work so other plugins' startup I/O (File
        // Recovery, cache, sync, heavy plugins) gets the window first. The
        // search modal bypasses the remaining wait (openSearchModal), so an
        // impatient user never eats the buffer. Cancelled on unload.
        const layoutGen = bootGen;
        this.bootBufferBypassed = false;
        this.bootBuffer = scheduleAfterLayoutReadyBuffered(
            this.app.workspace,
            () => {
                this.bootBuffer = null;
                if (!this.isBootCurrent(layoutGen)) return;
                this.vaultIndexEventsReady = true;
                seekPerf.recordStartupSpan({
                    type: 'startup-span',
                    timestamp: new Date().toISOString(),
                    span: 'boot-buffer',
                    phase: 'end',
                    durationMs: POST_LAYOUT_BOOT_BUFFER_MS,
                    bypassed: this.bootBufferBypassed,
                });
                void this.startPostLayoutBoot(layoutGen);
            },
            POST_LAYOUT_BOOT_BUFFER_MS,
        );

        // Periodic sidecar reconcile, exclusion-list watch, and mobile idle model unload.
        this.schedulers.wireBackgroundIntervals((id) => this.registerInterval(id));

        // Wire global observers + handlers BEFORE we do anything else, so
        // any error in the init path itself gets logged.
        this.wireGlobalErrorHandlers();
        this.wireLongTaskObserver();
        this.wireMemoryPressureHandlers();

        // Init the iframe runtime OFF the blocking onload path. The search command
        // (registered below) no longer waits on it: an early search coalesces onto
        // this same memoized init inside embedder.load() (embedder.ts init()/load()),
        // so there is no init race. The init log entry, the diagnostics that want a
        // live iframe (platform GPU probe, app-local probe), and the failure Notice
        // all ride this continuation instead of blocking app-open. The diagnostics
        // are DEFERRED, not removed — still dogfooding.
        const initGen = this.loadGeneration;
        void this.embedder.init()
            .then(async (initEntry) => {
                if (!this.isBootCurrent(initGen)) return;
                await this.logger.writeInit(initEntry);
                if (!this.isBootCurrent(initGen)) return;
                await this.logger.append(initEntry);

                if (!this.isBootCurrent(initGen)) return;
                const platformInfo = await collectPlatformInfo();
                await this.logger.append(platformInfo);

                if (!this.isBootCurrent(initGen)) return;
                // Boot-time storage snapshot. Week-over-week drops in storageUsedMB
                // are the canary for Cache API / IDB eviction even when no cold-start
                // outlier fires. Cheap — one navigator.storage.estimate().
                await this.emitStorageSnapshot('boot');

                // `app://local/...` capability probe. Runs once per session after
                // iframe init (before any model load) so the result is available
                // regardless of whether the user ever searches.
                if (initEntry.iframeReady && this.isBootCurrent(initGen)) {
                    this.runAppLocalProbe().catch(e =>
                        this.appendErrorIfCurrent('app-local-probe', e, initGen));
                }

                // No success toast — readiness is signalled by the modal glyph
                // brightening. Only a genuine failure interrupts: a dead iframe means
                // no search will work, which is worth one toast.
                if (!this.isBootCurrent(initGen)) return;
                if (!initEntry.iframeReady || initEntry.error) {
                    new Notice(
                        `Seek: search engine failed to start${initEntry.error ? ` — ${initEntry.error.slice(0, 80)}` : ''}. See Settings → Seek → Generate logging report.`,
                        8000,
                    );
                }
            })
            .catch(e => this.appendErrorIfCurrent('embedder-init-onload', e, initGen));

        // Auto-request persistent storage so iOS / Safari won't evict our
        // ~250 MB model cache + index under memory pressure. Best-effort.
        if (navigator.storage?.persist) {
            navigator.storage.persist().catch(e => {
                console.warn('[seek] navigator.storage.persist() failed:', e);
            });
        }

        // ---- Commands ----

        this.addCommand({
            // Obsidian auto-namespaces command ids with the plugin id, so the
            // public id is already `<plugin-id>:search` — don't repeat the prefix.
            id: 'search',
            name: 'Search',
            callback: () => this.openSearchModal(),
        });

        this.addCommand({
            id: 'retry-index-store',
            name: 'Retry opening the search index',
            checkCallback: (checking) => {
                if (checking) return isRetryIndexStoreCommandEnabled(this.indexStoreLocked);
            },
            callback: () => { void this.retryIndexStoreOpen(); },
        });

        this.addCommand({
            id: 'force-reset-index',
            name: 'Force reset search index',
            checkCallback: (checking) => {
                if (checking) return this.indexStoreLocked;
                if (!this.indexStoreLocked) return false;
                const bootGen = this.loadGeneration;
                void this.forceResetAndReindex(bootGen);
                return true;
            },
        });

        // ---- obsidian://seek deep-link --------------------------------
        // `obsidian://seek?query=<urlencoded>[&mode=open][&paneType=tab|split|window][&vault=<name>]`.
        // registerObsidianProtocolHandler is a core Plugin API (present on
        // EVERY platform, incl. mobile — unlike the CLI bridge below), so this
        // is the mobile-safe deep-link surface. Two modes:
        //   search (default) — open the modal pre-filled + running the query
        //                      (human-in-the-loop; the modal owns cold-start).
        //   open            — headless: load the model, run the query, open the
        //                      top hit's note ("jump to my note about X").
        // `mode` (not `action`) is the discriminator because ObsidianProtocolData
        // RESERVES `action` for the protocol host ('seek') — a `&action=` param
        // would collide with it. The scheme is deliberately READ-ONLY: any web
        // page can fire an obsidian:// URL, so no write/reindex/config action is
        // ever exposed here — those stay command/CLI-only where intent is explicit.
        this.registerObsidianProtocolHandler('seek', (params) => {
            // Obsidian percent-DECODES params, so `%23`→`#` etc. arrive clean.
            // The producer must encode `#` (URL fragment delimiter AND Seek's
            // own `#tag` sigil) — the modal's "copy link" action does this.
            const query = typeof params.query === 'string' ? params.query : '';
            const target = parsePaneType(typeof params.paneType === 'string' ? params.paneType : undefined);
            if (params.mode === 'open') void this.openTopResult(query, target);
            else this.openSearchModal(query);
        });

        // Reindex and diagnostics are intentionally NOT palette commands: a full
        // reindex nukes and re-embeds the whole vault (too destructive for a fuzzy
        // palette match), so it lives in Settings → Seek → Index behind a confirm;
        // the logging report is a Settings button (openLoggingReport). Sidecar
        // reconcile/rebuild are automatic. Search is the only command Seek adds.

        // ---- Headless CLI query handlers --------------------------------
        registerSeekCliHandlers(this);
    }

    // Set true the instant onunload starts so async callbacks (the WebGPU
    // device-lost handler) can't resurrect a teardown-in-progress iframe.
    private unloading = false;
    // Bumped on every onload/onunload so async boot work from a prior load aborts
    // cleanly after plugin:reload (onunload can close the store mid-IIFE).
    private loadGeneration = 0;

    private isBootCurrent(gen: number): boolean {
        return isLoadGenerationCurrent(gen, this.loadGeneration, this.unloading);
    }

    private isSessionWorkCurrent(capturedGen?: number): boolean {
        return isSessionWorkCurrent(this.unloading, this.loadGeneration, capturedGen);
    }

    private appendErrorIfCurrent(context: string, e: unknown, capturedGen?: number): void {
        if (!this.isSessionWorkCurrent(capturedGen)) return;
        if (isTransientIdbUnavailable(e)) return;
        void this.logger.appendError(context, e).catch(() => {});
    }

    private async ensureStoreReady(): Promise<void> {
        await this.whenLayoutReady();
        await this.store.ensureOpen();
    }

    /**
     * After workspace layout is ready: start debug clocks, open the index DB,
     * then hydrate / reconcile. Must not run from onload itself.
     */
    private async startPostLayoutBoot(bootGen: number): Promise<void> {
        if (!this.isBootCurrent(bootGen)) return;
        this.bootStartMs = performance.now();
        this.startupTelemetry.beginBoot(this.bootStartMs);
        {
            const span = {
                type: 'startup-span' as const,
                timestamp: new Date().toISOString(),
                span: 'boot-ifi',
                phase: 'start' as const,
            };
            seekPerf.recordStartupSpan(span);
            void this.logger.append(span).catch(() => {});
        }
        try {
            if (!this.isBootCurrent(bootGen)) return;
            await this.ensureStoreReady().catch(e => {
                if (!isTransientIdbUnavailable(e)) {
                    this.appendErrorIfCurrent('store-open-boot', e, bootGen);
                } else {
                    console.warn('[seek] index store still locked after retry:', e);
                }
            });
            if (!this.isBootCurrent(bootGen)) return;
            if (!this.store.isOpen()) {
                this.beginIndexStoreLocked(bootGen);
                return;
            }
            void this.touchIndexInventory();
            try {
                await this.store.backfillBinaryIfMissing();
            } catch (e) {
                if (!isTransientIdbUnavailable(e)) {
                    this.appendErrorIfCurrent('binary-backfill', e, bootGen);
                }
            }
            if (!this.isBootCurrent(bootGen)) return;
            await this.resumeBootAfterStoreOpen(bootGen);
        } finally {
            if (!this.isBootCurrent(bootGen)) return;
            this.sidecarHydrating = false;
            const bootDurationMs = Math.round(performance.now() - this.bootStartMs);
            {
                const span = {
                    type: 'startup-span' as const,
                    timestamp: new Date().toISOString(),
                    span: 'boot-ifi',
                    phase: 'end' as const,
                    durationMs: bootDurationMs,
                };
                seekPerf.recordStartupSpan(span);
                void this.logger.append(span).catch(() => {});
            }
            if (this.indexStoreLocked) {
                void this.touchIndexInventory();
                return;
            }
            if (!this.indexGoodEnough) {
                this.indexBootPending = false;
                await this.logStartupGateReleased();
                this.finalizeStartupTelemetryIfNeeded();
                await this.touchIndexInventory();
            } else {
                void this.touchIndexInventory();
            }
            // Empty store + live notes: desktop must drain without opening Search.
            // Covers identity-nuke-then-empty-hydrate and boot races that skip
            // reconcileOnLoad's pending flag.
            this.applyPostBootIndexScheduling();
        }
    }

    private disposeStoreOpenRetryScheduler(): void {
        this.storeOpenRetryScheduler?.dispose();
        this.storeOpenRetryScheduler = null;
    }

    private clearIndexStoreLocked(): void {
        if (!this.indexStoreLocked) return;
        this.indexStoreLocked = false;
        this.disposeStoreOpenRetryScheduler();
        this.refreshIndexStatusBar();
    }

    private beginIndexStoreLocked(bootGen: number): void {
        this.indexStoreLocked = true;
        this.refreshIndexStatusBar();
        this.disposeStoreOpenRetryScheduler();
        // Wrap ensureStoreReady in a timeout so the retry chain doesn't hang
        // on a stale LevelDB lock (indexedDB.open() can hang indefinitely on
        // Windows/Electron after a crash). The timeout rejection lets the
        // scheduler continue to the next backoff tick. deleteDatabase (forceReset)
        // does NOT need the open lock.
        const ensureOpenWithTimeout = async (): Promise<void> => {
            const timeoutMs = 8000;
            await Promise.race([
                this.ensureStoreReady(),
                new Promise<void>((_, reject) =>
                    window.setTimeout(() => reject(new Error(`store open timed out after ${timeoutMs}ms`)), timeoutMs)),
            ]);
        };
        this.storeOpenRetryScheduler = createStoreOpenRetryScheduler({
            delaysMs: storeOpenRetryDelaysMs(),
            backoffDelaysMs: storeOpenBackoffDelaysMs(),
            ensureOpen: ensureOpenWithTimeout,
            isCurrent: () => this.isSessionWorkCurrent(bootGen),
            onLocked: () => {
                this.indexStoreLocked = true;
                this.refreshIndexStatusBar();
            },
            onRetry: (attempt, delayMs, elapsedMs) => {
                const msg = `[seek] store lock retry #${attempt} in ${delayMs}ms (${elapsedMs}ms elapsed)`;
                console.warn(msg);
                void this.logger.append({
                    type: 'store-lock-retry',
                    timestamp: new Date().toISOString(),
                    attempt,
                    delayMs,
                    totalElapsedMs: elapsedMs,
                }).catch(() => {});
            },
            onExhausted: () => {
                console.warn('[seek] store lock retry exhausted — attempting self-heal (nuke + rebuild)');
                void this.logger.append({
                    type: 'store-lock-exhausted',
                    timestamp: new Date().toISOString(),
                }).catch(() => {});
                void this.forceResetAndReindex(bootGen);
            },
            onSuccess: () => {
                if (!this.isSessionWorkCurrent(bootGen)) return;
                this.clearIndexStoreLocked();
                void this.resumeBootAfterStoreOpen(bootGen);
            },
            schedule: (fn, ms) => window.setTimeout(fn, ms),
            cancel: (id) => window.clearTimeout(id),
        });
        this.storeOpenRetryScheduler.start();
    }

    /** Self-heal: nuke the IndexedDB database and schedule a full reindex. */
    private async forceResetAndReindex(bootGen: number): Promise<void> {
        if (!this.isBootCurrent(bootGen)) return;
        try {
            new Notice('Seek: search index is stuck locked — resetting database...', 8000);
            await this.logger.append({
                type: 'store-force-reset',
                timestamp: new Date().toISOString(),
            }).catch(() => {});
            const result = await this.store.forceReset();
            if (!this.isBootCurrent(bootGen)) return;
            if (result.error) {
                new Notice(`Seek: ${result.error}`, 8000);
                return;
            }
            if (!this.store.isOpen()) {
                new Notice('Seek: cannot reset search index — another window may hold the lock. Close other vault windows and retry.', 8000);
                return;
            }
            this.clearIndexStoreLocked();
            new Notice(`Seek: index ${result.nuked ? 'reset' : 'cleared'} — rebuilding from scratch...`, 6000);
            void this.scheduleColdBuild();
        } catch (e) {
            this.appendErrorIfCurrent('force-reset', e, bootGen);
            new Notice('Seek: failed to reset search index. Try quitting Obsidian completely.', 8000);
        }
    }

    private async retryIndexStoreOpen(): Promise<void> {
        if (this.storeOpenRetryScheduler) {
            // Use retryNow to bypass pending backoff timers.
            this.storeOpenRetryScheduler.retryNow();
            new Notice('Seek: retrying search index...', 3000);
            return;
        }
        const bootGen = this.loadGeneration;
        try {
            await this.ensureStoreReady();
        } catch (e) {
            if (!isTransientIdbUnavailable(e)) {
                this.appendErrorIfCurrent('retry-index-store', e, bootGen);
            }
        }
        if (!this.store.isOpen()) {
            new Notice('Seek: search index is still locked. Try force-reset or quit Obsidian completely.', 6000);
            return;
        }
        this.clearIndexStoreLocked();
        new Notice('Seek: search index opened.', 4000);
        await this.resumeBootAfterStoreOpen(bootGen);
    }

    /** Sidecar hydrate + reconcile after the index store opens (boot or retry). */
    private async resumeBootAfterStoreOpen(bootGen: number): Promise<void> {
        if (this.bootContinuationDone) return;
        if (!this.isBootCurrent(bootGen)) return;
        if (!this.store.isOpen()) return;
        const ctx = this.bootResumeCtx;
        if (!ctx) return;
        this.bootContinuationDone = true;

        let identityHandled = false;
        try {
            if (this.settings.sidecarEnabled && ctx.migrateSidecarPath
                && this.settings.sidecarIndexLocation === 'config'
                && ctx.legacySidecarDir && ctx.legacySidecarDir !== ctx.sidecarIndexDir) {
                await this.migrateSidecarFiles(ctx.legacySidecarDir, ctx.sidecarIndexDir);
            }
            if (this.settings.sidecarEnabled && ctx.sidecarIndexDir) {
                await sweepOrphanTmpFiles(this.app.vault.adapter, ctx.sidecarIndexDir, this.logger.deviceId);
            }
            identityHandled = await this.enforceIndexIdentity();
            if (!identityHandled) {
                if (!this.isBootCurrent(bootGen)) return;
                const hydrated = await this.withSidecarHydrate(() => this.orchestrator.reconcileSidecarIfChanged());
                this.applySidecarWait(hydrated);
                this.applyPeerAheadBanner();
            }
        } catch (e) {
            if (this.isBootCurrent(bootGen) && !isTransientIdbUnavailable(e)) {
                await this.logger.appendError('sidecar-hydrate-onload', e).catch(() => {});
            }
        }
        await this.maybeSteerSidecarLocation().catch(() => {});
        if (!identityHandled) {
            if (!this.indexGoodEnough) this.markIndexGoodEnough();
            if (this.isBootCurrent(bootGen)) {
                void this.reconcileOnLoad(bootGen).catch(e =>
                    this.appendErrorIfCurrent('reconcileOnLoad', e, bootGen));
            }
        }
        if (!this.isBootCurrent(bootGen)) return;
        if (!this.indexGoodEnough) {
            this.indexBootPending = false;
            await this.logStartupGateReleased();
            this.finalizeStartupTelemetryIfNeeded();
            await this.touchIndexInventory();
        } else {
            void this.touchIndexInventory();
        }
        this.applyPostBootIndexScheduling();
    }

    onunload() {
        this.loadGeneration++;
        this.unloading = true;
        this.bootBuffer?.cancel();
        this.bootBuffer = null;
        this.disposeStoreOpenRetryScheduler();
        this.indexStoreLocked = false;
        this.bootContinuationDone = false;
        this.bootResumeCtx = null;
        this.vaultIndexEventsReady = false;
        this.catchUpRunning = false;
        this.flushing = false;
        this.driftRecoveryRunning = false;
        this.orphanSweepRunning = false;
        this.sidecarCompactRunning = false;
        this.sidecarCoalesceRunning = false;
        this.coldBuildScheduled = false;
        // First thing, synchronously: a session whose record isn't closed at
        // next boot reads as a crash. Reload/disable/quit all pass through here.
        this.forensics?.markCleanEnd();
        this.indexProgress.hide();
        this.embedder.teardown();
        this.orchestrator?.dispose();
        this.store.close();
        if (this.longTaskObserver) {
            try { this.longTaskObserver.disconnect(); } catch { /* swallow */ }
            this.longTaskObserver = null;
        }
        if (this.onError) window.removeEventListener('error', this.onError);
        if (this.onUnhandledRejection) window.removeEventListener('unhandledrejection', this.onUnhandledRejection);
        if (this.onVisibilityChange && this.visibilityDoc) this.visibilityDoc.removeEventListener('visibilitychange', this.onVisibilityChange);
        if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide);
        this.schedulers.dispose();
        // vault/workspace events and the window 'blur' DOM event are registered
        // via registerEvent/registerDomEvent, so Obsidian tears them down for us.
    }

    // ── Sidecar index location ──────────────────────────────────────────────
    // The DEFAULT config-folder name. We pin to this literal default `.obsidian`
    // rather than vault.configDir (the per-device active override) so every device
    // resolves the SAME synced sidecar path. This is also the baseline
    // maybeSteerSidecarLocation compares vault.configDir AGAINST to detect a
    // renamed config folder.
    private static readonly DEFAULT_CONFIG_DIR = `.obsidian`;
    // Per-INSTANCE so a co-installed build (different manifest.id) gets its own
    // sidecar location and can't write into the public build's plugin folder. The
    // hidden default is `.obsidian/plugins/<id>/index` (id 'seek' → the historical
    // path, no migration); the visible opt-in folder is `<name> Index` (name
    // 'Seek' → 'Seek Index', unchanged). Still a LITERAL `.obsidian` (not
    // vault.configDir) so every device resolves the same synced path — the
    // config-folder CRITICAL fix.
    private get sidecarConfigDir(): string { return `.obsidian/plugins/${this.manifest.id}/index`; }
    private get sidecarVisibleDir(): string { return `${this.manifest.name} Index`; }

    // Hidden literal path by default; the vault-root visible folder only when a
    // split-config Obsidian Sync user opts in (see maybeSteerSidecarLocation).
    private resolveSidecarIndexDir(): string {
        return this.settings.sidecarIndexLocation === 'visible'
            ? this.sidecarVisibleDir
            : this.sidecarConfigDir;
    }

    // One-time rev-3→4 move of an index written under the old active-override
    // path into the literal path. Uses rename (a move) per file; idempotent and
    // non-fatal — a failed move leaves the source for the next reindex to
    // repopulate, never aborts hydrate.
    private async migrateSidecarFiles(from: string, to: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const ls = await adapter.list(from).catch(() => null);
        if (!ls || ls.files.length === 0) return; // nothing written under the old path
        if (!(await adapter.exists(to).catch(() => false))) await adapter.mkdir(to).catch(() => {});
        for (const path of ls.files) {
            const dest = `${to}/${path.slice(path.lastIndexOf('/') + 1)}`;
            // Never clobber the new location (a prior partial migration, or this
            // device already wrote there) — the literal path is authoritative.
            if (await adapter.exists(dest).catch(() => false)) continue;
            try {
                await adapter.rename(path, dest);
            } catch (e) {
                await this.logger.appendError('sidecar-migrate-file', e).catch(() => {});
            }
        }
    }

    // Steer the lone unreachable case to the visible folder: Obsidian Sync + a
    // RENAMED config folder. The hidden literal '.obsidian/' is never delivered
    // to a device booting a renamed config over Sync, so embeddings can't cross.
    // iCloud/Syncthing/Dropbox carry the literal path regardless, so they never
    // trip this. One-time per device (the condition is per-device) via
    // localStorage — a uniform-config device never sees it.
    private async maybeSteerSidecarLocation(): Promise<void> {
        if (!this.settings.sidecarEnabled) return;
        if (this.settings.sidecarIndexLocation !== 'config') return; // already opted in / steered
        const configDir = this.app.vault.configDir;
        if (configDir === SeekPlugin.DEFAULT_CONFIG_DIR) return;     // uniform config — literal path syncs fine
        // Obsidian Sync writes sync.json into the active config folder; its
        // presence is the in-use signal. iCloud/Syncthing have no such file.
        const onObsidianSync = await this.app.vault.adapter.exists(`${configDir}/sync.json`).catch(() => false);
        if (!onObsidianSync) return;
        const flagKey = `${this.manifest.id}-sidecar-steer-shown`;
        if (window.localStorage.getItem(flagKey)) return;
        window.localStorage.setItem(flagKey, '1');
        new Notice(
            `Seek: Obsidian Sync won't deliver the hidden index to a renamed config folder ("${configDir}"). ` +
            "Set Seek's index location to “Visible folder” (Settings → Seek → Sync) to sync embeddings across your devices.",
            12000,
        );
    }

    // Public pre-warm entry for the settings "Download now" button: fetches +
    // caches the ~100 MB model bytes (and loads it) so a user can pre-warm over
    // Wi-Fi before going offline, instead of search stalling on the first fetch.
    // Idempotent — delegates to the memoized loader below; a no-op if already loaded.
    async prewarmModel(): Promise<void> { await this.ensureModelLoaded(); }

    // Proactively release the embedder when it's provably safe — the only way to
    // shrink the iframe's WASM heap (WebAssembly.Memory never contracts within a
    // page, so a long mobile session ratchets toward the OOM that kills the next
    // model load). The next search/embed reloads transparently: ensureModelLoaded
    // sees `loaded` false and `modelLoadPromise` null and rebuilds (loadImpl calls
    // init() first). Nulling modelLoadPromise is load-bearing — without it,
    // ensureModelLoaded would hand back a resolved promise for a model that's gone
    // (it checks modelLoadPromise before loaded). Mirrors the manual
    // seek-unload-model command, gated by the pure shouldUnloadEmbedder predicate.
    private maybeUnloadEmbedder(reason: 'idle' | 'background'): void {
        const gate: UnloadGateState = {
            loaded: this.embedder.loaded,
            busy: this.currentTaskContext !== 'idle',
            queryActive: this.indexingBlocked,
            running: this.flushing || this.catchUpRunning || this.driftRecoveryRunning,
            pending: this.catchUpPending || this.driftRecoveryPending
                || this.dirtyQueue.size > 0 || this.deletedQueue.size > 0
                || this.idleTimer != null || this.structTimer != null,
        };
        if (!shouldUnloadEmbedder(reason, gate)) return;
        this.embedder.teardown();
        this.modelLoadPromise = null;
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        void this.logger.append({
            type: 'model-lifecycle',
            timestamp: new Date().toISOString(),
            event: 'unload',
            reason,
            heapMB: heap ? heap.usedJSHeapSize / 1e6 : null,
        }).catch(() => {});
        // Synchronous breadcrumb too — the background unload races a possible
        // jetsam kill, and the async log line above can be lost to it.
        this.forensics?.beat(reason === 'idle' ? 'model-unload-idle' : 'model-unload-bg');
    }

    ensureModelLoaded(): Promise<void> {
        // Every search/embed path funnels through here, so this is the single
        // chokepoint that marks the model "in use" — the idle-unload timer counts
        // from it. Stamped even on the already-loaded fast path so a burst of
        // searches keeps the model resident.
        this.lastModelUseAt = Date.now();
        if (this.embedder.loaded) return Promise.resolve();
        if (this.modelLoadPromise) return this.modelLoadPromise;

        // Device selection. Desktop: WebGPU first with WASM fallback (design
        // doc: WebGPU ~4× faster on iPhone single-query historically, and
        // competitive on desktop). iOS: skip WebGPU entirely — see the iOS
        // skip rationale at the load() call below.
        this.modelLoadPromise = (async () => {
            // Span the load: wasm compile + session init + shader warmup are
            // main-thread-heavy and used to log as 'idle' long tasks.
            this.pushTaskContext('model-load');
            try {
                // Overlap BM25/frame warm with the cold model load in case a search
                // beats the onload 'startup' warm (or mobile, which bails until the
                // embedder is resident). Self-guarded: `warming` dedups startup/delta.
                void this.orchestrator.warmCaches('model-load');
                // q4: equal quality (bake-off NDCG@10 Δ=0.0005) and, on the
                // pinned v4 runtime, also the fastest + lightest config (20.6
                // ch/s, ~103 MB heap vs q8 13.2 ch/s, ~380 MB). q4's viability
                // depends on the v4 ORT-Web floor — see iframe-runner.ts
                // TRANSFORMERS_VERSION / dtype-ladder comments for the full
                // history (the q4-vs-q8 gap on old ORT-Web was real, not a
                // fusion confound). 'auto' = WebGPU (q4-only ladder) with WASM
                // q4 fallback. q4f16 excluded — Gemma's LayerNorm shader fails
                // to compile on Dawn with half-precision activations (ORT #26732).
                // Phase-5: when LOCAL_MODEL.enabled, load the trimmed
                // model from the vault via an app://local resource URL
                // instead of the HF CDN. getResourcePath appends a
                // `?<ts>` cache-buster (seen in the app-local probe) —
                // strip it so transformers.js path-joins
                // `<base>/onnx/model_*.onnx` cleanly.
                const ra = this.app.vault.adapter as unknown as { getResourcePath?: (p: string) => string };
                const localBase = LOCAL_MODEL.enabled && ra.getResourcePath
                    ? ra.getResourcePath(LOCAL_MODEL.vaultRelPath).split('?')[0].replace(/\/+$/, '')
                    : undefined;
                if (LOCAL_MODEL.enabled && !localBase) {
                    await this.logger.appendError('local-model', new Error('getResourcePath unavailable; using remote MODEL_ID'));
                }
                // Active model from the registry (debug override wins, else the
                // shipped default). spec.repo is the CDN-streamed load base on the
                // remote path; spec.key is the index drift-identity. EMBEDDING_DIM
                // now DERIVES from ACTIVE_MODEL_SPEC.dim (the single source), so a
                // shipped-model swap can't trip this. It only fires for a debug
                // model OVERRIDE whose real width differs from the build dim —
                // loud-log it (mis-indexing into the wrong-dim store is worse).
                const spec = activeModelSpec(this.settings);
                if (spec.dim !== EMBEDDING_DIM) {
                    await this.logger.appendError('model-registry', new Error(
                        `override model ${spec.key} dim ${spec.dim} != build dim ${EMBEDDING_DIM}; a model override needs a matching-dim build (registry dim is the single source — bump DB_VERSION when changing the shipped model)`));
                }
                // Device selection is per-DEVICE (platform.ts resolveDevice),
                // not a synced setting — see the NOTE in types.ts for why a
                // data.json toggle would leak across iCloud-synced devices.
                // 'auto' = WebGPU-then-WASM ladder; 'wasm' = skip WebGPU. The
                // allowlist: desktop + iPad get 'auto', iPhone + all Android get
                // 'wasm' (jetsam / immature WebView WebGPU), a per-device manual
                // override wins, and a sticky tripwire demotes any mobile device
                // that was OS-killed mid-WebGPU-reindex.
                //
                // On the 'auto' path the iframe's WebGPU attempt rewrites
                // wasmPaths to a webgpuInit-capable glue (jspi/asyncify — see
                // overrideWebkitGlueForWebgpu in iframe-runner.ts), the fix that
                // let the iPad run granite on WKWebView WebGPU (2026-06-10).
                // tx.js 4.2.0 otherwise pins anything Safari-detected (WKWebView
                // included) to the plain wasm glue compiled WITHOUT webgpuInit,
                // so without that override the webgpu EP init throws by
                // construction. On failure the load falls back to WASM on a
                // fresh module instance (tx.js's webInitChain has no rejection
                // handler — one failed load poisons the instance) and logs
                // webgpuError. ⚠️ ORT #26827 hang risk still applies on iPhone,
                // which is why iPhone stays off the 'auto' path by default.
                const requestedDevice = resolveDevice();
                // Model selection: the LOCAL_MODEL dev override wins (it's a
                // base URL, not a hub id); otherwise MODEL_ID. Both ride dtype
                // 'q4' — tx.js resolves it to onnx/model_q4.onnx (the ml97
                // repo's model_q4.onnx IS the GBQ-int4 export).
                // Bracket the load with beats: a death inside (the iPhone
                // wasm-OOM class, or a WebGPU device-init kill) gets attributed
                // to 'model-load' instead of reading as idle.
                this.forensics?.beat('model-load-start', { device: requestedDevice, model: spec.repo });
                const entry = await this.embedder.load(requestedDevice, LOCAL_MODEL.enabled ? LOCAL_MODEL.dtype : spec.dtype, localBase ?? spec.repo, LOCAL_MODEL.enabled ? null : spec.revision);
                this.forensics?.beat('model-load-done', { device: entry.actualDevice, dtype: entry.dtype, coldStartMs: Math.round(entry.coldStartMs) });
                // Stamp the backend this load actually resolved to (WebGPU can
                // fall back to WASM). Read at next boot by maybeDemoteOnCrash to
                // decide whether an indexing-crash implicates WebGPU.
                recordActiveBackend(entry.actualDevice);
                seekPerf.recordLoad(entry);
                await this.logger.append(entry);
                await this.warnOnModelIndexDrift();
                // Production model delivery (remote/Cache-API path only — the
                // LOCAL_MODEL dev path loads from the vault, nothing CDN-cached):
                // (1) request Cache-API persistence (best-effort; Safari grants on
                // engagement heuristics) and (2) evict a PREVIOUS model's cached
                // bytes after a switch. Eviction is parent-side because our iframe
                // is non-sandboxed (shares the cache partition); benign if the cache
                // is absent. `cacheSeen===0` in the log is the canary that the
                // parent can't see the iframe cache (→ move eviction to an RPC).
                if (!LOCAL_MODEL.enabled) {
                    let persisted: boolean | null = null;
                    try { persisted = await navigator.storage.persist(); }
                    catch { /* private mode / unsupported */ }
                    let evicted = { seen: 0, deleted: 0 };
                    try {
                        if (typeof caches !== 'undefined') evicted = await evictStaleModelCaches(caches, spec.repo);
                    } catch (e) {
                        await this.logger.appendError('model-evict', e);
                    }
                    await this.logger.append({
                        type: 'model-delivery',
                        timestamp: new Date().toISOString(),
                        key: spec.key,
                        repo: spec.repo,
                        revision: spec.revision,
                        persisted,
                        cacheSeen: evicted.seen,
                        cacheEvicted: evicted.deleted,
                    });
                }
                // Eviction canary. The same 5 s threshold the LoadEntry's
                // checks array uses, but emitted as its own structured event
                // so the report (and future alerting) can count suspected
                // evictions without parsing free-text checklists.
                if (entry.coldStartMs >= 5000) {
                    await this.emitEvictionSuspected(entry);
                }
                // Success is signalled ambiently by the search modal's glyph
                // brightening from faint → full (PillQueryField.setModelReady),
                // not a toast — the bare device/dtype/timing line was noise on
                // every cold open. Warnings still get a toast: a degraded load
                // is worth interrupting for, and the glyph can't convey "why".
                if (!entry.pass) {
                    console.warn(`[seek] model loaded with warnings on ${entry.actualDevice} — see the logging report (Settings → Seek).`);
                }
            } catch (e) {
                this.modelLoadPromise = null; // allow retry
                await this.logger.appendError('ensureModelLoaded', e);
                throw e;
            } finally {
                this.popTaskContext('model-load');
            }
        })();
        return this.modelLoadPromise;
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    // Model ↔ index drift check, run after every successful model load. The
    // index meta carries the modelId that built it (stamped by reindexAll);
    // if the loaded model differs, dense scores would be cross-model garbage —
    // tell the user to full-reindex. Pre-2026-06-10 indexes have no stamp
    // (all english-r2 by construction), so an unstamped index always reads as
    // drift against ml97 and routes to a reindex. Once per session — the
    // condition can't self-heal without a reindex, so repeating the notice is
    // pure noise.
    private modelDriftWarned = false;
    // ── Boot version-identity cascade ─────────────────────────────────────────────
    // The active replacement for warn-only drift: when the local index's stored
    // identity (chunker/model/revision/dim) differs from this build's, the index is
    // provably stale, so heal it WITHOUT user commands. Order: hydrate from a matching
    // peer (embed-free, both platforms) → else desktop auto full-reindex / mobile wait
    // (mobile never bulk-embeds = no jetsam; the 5-min poll retries until a desktop
    // publishes a current sidecar). Returns true when it took over the index (the
    // caller then skips the normal catch-up). Runs off pluginIdentity() (compiled
    // constants), so it needs no model load and can gate a cold mobile boot.
    private async enforceIndexIdentity(): Promise<boolean> {
        // The cascade self-heals via cross-device sidecar hydration (+ desktop reindex
        // fallback), so it only applies with the sidecar on. Sidecar-off keeps the
        // legacy warn-only check (warnOnModelIndexDrift, fired at model-load time).
        if (!this.settings.sidecarEnabled) return false;
        // A debug model override (testing arbitrary repos) keys the loaded model off
        // the override while the sidecar/identity machinery keys off the shipped
        // MODEL_ID — running the cascade would loop. Defer to the warn-only check.
        if (resolveOverrideSpec(this.settings)) return false;
        // A heal is already running — don't stack a second when the 5-min poll fires
        // mid-reindex. Report "handled" so the caller still skips the normal catch-up.
        if (this.identityHealInFlight) return true;
        // A reindex / cold-build / delta is mutating the index right now: its meta is
        // mid-stamp and its identity not yet written, so an identity check would race
        // it and could "heal" a build that is about to stamp itself current. Report
        // NOT handled — by the next poll the writer has finished and stamped (Fix A/C).
        // (Primary guard is periodicReconcile.isIndexBusy; this also covers the onload
        // call, where nothing is writing yet, as cheap belt-and-suspenders.)
        if (this.orchestrator.isWriting()) return false;

        const meta = await this.store.getMeta().catch(() => null);
        if (!meta) return false; // store unreadable mid-teardown — the 5-min poll rechecks
        // An empty index isn't "stale" — the normal first-build / cold-hydrate path
        // owns it. Count, NOT lastIndexedAt: a hydrate-only device holds chunks with a
        // null lastIndexedAt.
        if ((await this.store.count()).chunks === 0) return false;

        if (identityMatches(identityFromMeta(meta), pluginIdentity())) {
            this.identityHealNotified = false; // healthy — re-arm reporting for a future ship
            // A peer sidecar (or a completed reindex) healed a version-stale index out
            // from under us: clear the banner/health. Scoped to 'version' so a concurrent
            // DRIFT degradation (separate axis) isn't stomped healthy here.
            if (this.degradedReason === 'version') { this.indexHealth = 'healthy'; this.degradedReason = null; this.peerSyncPending = false; }
            return false;
        }

        // ── MISMATCH: local index built under a different chunker/model/revision/dim.
        const cur = pluginIdentity();
        const firstReport = !this.identityHealNotified;
        this.identityHealNotified = true;
        if (firstReport) {
            await this.logger.appendError('index-identity-mismatch', new Error(
                `stored chunker=${meta.chunkerVersion} model=${meta.modelId} rev=${meta.revision} dim=${meta.embeddingDim}` +
                ` → build chunker=${cur.chunkerVersion} model=${cur.modelId} rev=${cur.revision} dim=${cur.dim}`)).catch(() => {});
        }

        this.identityHealInFlight = true;
        try {
            // 1. Both platforms: hydrate from a matching-identity peer first (embed-free).
            //    rebuildFromSidecar nukes+stamps+hydrates ONLY if a compatible producer
            //    exists; otherwise it returns acceptedProducers:0 without touching the index.
            const rebuilt = await this.withSidecarHydrate(() => this.orchestrator.rebuildFromSidecar());
            if (rebuilt && rebuilt.acceptedProducers > 0) {
                this.identityHealNotified = false; // healed (silent — background sync)
                // A current-version peer existed: the fleet self-heals embed-free even
                // with desktop auto-reindex gone. Clear any version banner this device
                // was showing while it waited.
                if (this.degradedReason === 'version') { this.indexHealth = 'healthy'; this.degradedReason = null; this.peerSyncPending = false; }
                return true;
            }

            // 1b. No matching peer. Before the destructive fallback, try the embed-free
            //     in-place heal: an index that is merely UNSTAMPED but provably current
            //     (same model+dim, files unchanged — the cold-build identity bug, PR #43)
            //     is stamped in seconds instead of a ~7-min nuke+re-embed, and an
            //     interrupted attempt resumes (re-runs the seconds-long proof) instead of
            //     restarting from zero. Both platforms reach it; mobile stays embed-free.
            //     Only a GENUINELY old index ('stale') falls through to the rebuild/wait.
            const healed = await this.withSidecarHydrate(() => this.orchestrator.reconcileIdentityInPlace());
            if (healed === 'stamped') {
                this.identityHealNotified = false;
                this.indexHealth = 'healthy';
                this.degradedReason = null;
                this.peerSyncPending = false;
                return true;
            }
            if (healed === 'drained') {
                // Healed enough to stop the destructive loop, but a few edits are deferred
                // (mobile / model not yet loaded): the index isn't fully current, so leave
                // it degraded — the catch-up drain + a later poll finish and stamp it.
                this.indexHealth = 'degraded';
                // NOT a 'version' degradation: a drained index is an unstamped-but-
                // current-model index mid-catch-up (the cold-build path), not an
                // old-format one, so it must NOT raise the version-stale banner.
                // degradedReason is left untouched on purpose: a genuine concurrent 'drift'
                // reason (orthogonal axis) should persist. 'version' is effectively
                // unreachable here (a genuinely old index returns 'stale', not 'drained');
                // were a stale 'version' to somehow survive from a prior poll, the next
                // poll re-stamps and clears it, so the worst case is bounded, not stuck.
                return true;
            }

            // 2. No matching peer and a genuinely old index. CONSENT-GATED (2026-06-23):
            //    NEITHER platform auto-reindexes here anymore. We only mark the index
            //    version-stale, fire a one-time warning toast, and let the search-modal
            //    banner carry the action. Rationale:
            //      • Desktop auto-nuke silently degraded the user's search mid-rebuild
            //        (recency-first partial results with no explanation) — a surprise
            //        the user never opted into. The banner makes the state honest and
            //        hands them the trigger (decision: reverse the old auto-reindex).
            //      • Mobile already waited; now it gets the SAME banner, not just a toast.
            //    The embed-free heals above (peer sidecar / in-place stamp) still run
            //    automatically every poll, so a fleet where ANY device reindexes still
            //    converges for free — only the expensive re-embed needs consent.
            //    A still-valid older index stays fully queryable in the meantime; its
            //    stale chunks are invisible-not-wrong (content-addressed ids).
            //    KNOWN trade: a vault used ONLY from mobile (no desktop ever clicks
            //    Reindex, and a phone never bulk-embeds — the jetsam rule) stays degraded
            //    indefinitely. Intentional: an honest banner beats a surprise auto-nuke,
            //    and the embed-free heal still converges it the moment any desktop reindexes.
            //
            //    Split the message by whether a heal is actually coming. A peer device's
            //    sidecar is present (this vault is multi-device) but not yet at the current
            //    identity → its current index is mid-sync and WILL hydrate us embed-free on
            //    a later poll. That's a calm 'recovering' "syncing" state (answers the
            //    user's real questions: yes you can search, no you needn't do anything —
            //    and tapping Reindex on a phone is exactly the bulk re-embed we want them
            //    NOT to trigger). Only a genuinely-stuck index (no peer in sight) is
            //    'degraded' with the action-needed banner + sticky toast.
            const peerComing = await this.orchestrator.peerSidecarPresent();
            this.indexHealth = peerComing ? 'recovering' : 'degraded';
            this.degradedReason = 'version';
            // Drive the calm "syncing" banner off this explicit peer fact, not indexHealth:
            // local drift recovery also sets 'recovering' and must stay silent (see indexBannerSpec).
            this.peerSyncPending = peerComing;
            if (firstReport) {
                // Syncing: a brief, non-sticky heads-up (it self-heals, so don't nag).
                // Stale: sticky (duration 0) — rare enough that the intrusion is worth not
                // letting it auto-vanish unseen. Same copy as the modal banner, once per spell.
                if (peerComing) new Notice(INDEX_SYNCING_MSG, 8000);
                else new Notice(INDEX_STALE_MSG, 0);
            }
            return true;
        } finally {
            this.identityHealInFlight = false;
        }
    }

    // True while the index is being built or mutated — a reindex/delta under the write
    // mutex (orchestrator.isWriting, which covers the cold first-build's reindexDelta),
    // a catch-up drain, a live flush, or a drift-recovery pass. The reconcile poll
    // consults this so a long build is never reconciled / healed out from under itself
    // on a large vault (Fix C: reindex_time > poll_interval). identityHealInFlight is
    // handled separately inside enforceIndexIdentity (it reports "handled", not "busy").
    private isIndexBusy(): boolean {
        return this.catchUpRunning || this.flushing || this.driftRecoveryRunning
            || (this.orchestrator?.isWriting() ?? false);
    }

    // Periodic sidecar poll (remote sidecar arrivals fire no vault events). Re-runs the
    // identity gate FIRST so a device that was WAITING for a peer heals the moment a
    // desktop publishes a matching sidecar; otherwise the normal dir-signature-gated
    // catch-up. Wired to the 5-min interval.
    private async periodicReconcile(): Promise<void> {
        if (this.unloading) return;
        const workGen = this.loadGeneration;
        // Span the whole poll: the sidecar reconcile, orphan sweep, and sidecar
        // compaction (a whole-vault re-chunk + tokenizer pass) all run here, and
        // none of their jank was attributed before (issue #5's 'idle' long-tasks).
        // Also load-bearing for the mobile unload gate: `busy` now covers the
        // compaction window, so the idle-unload can't tear the tokenizer down
        // mid-collectLiveIds (which read as a transient incomplete-rechunk).
        this.pushTaskContext('reconcile');
        try {
            if (!this.isSessionWorkCurrent(workGen)) return;
            // Never poll while a build/delta is in flight: assessing identity or
            // hydrating a sidecar would race a writer whose meta is mid-stamp. The
            // next tick (build done, identity stamped) handles it. This is the fix for
            // the large-vault loop where a 415s reindex outlived the 300s poll.
            if (this.isIndexBusy()) return;
            // Skip the first poll after cold boot: the 5-min timer can fire while
            // catch-up is still loading the model, and sidecar/orphan work racing a
            // deferred delta has wiped populated indexes (G_eviction 2026-08-28).
            if (performance.now() - this.bootStartMs < 6 * 60 * 1000) return;
            if (await this.enforceIndexIdentity()) return;
            const hydrated = await this.withSidecarHydrate(() => this.orchestrator.reconcileSidecarIfChanged());
            this.applySidecarWait(hydrated);
            // The reconcile above scanned the sidecar dir, so peerAhead is fresh: raise (or
            // clear) the "update Seek" banner. Runs only on the local-healthy path, since
            // enforceIndexIdentity returns early when the local index is itself version-stale.
            this.applyPeerAheadBanner();
            // Once per session, after identity is confirmed healthy: GC orphan chunks
            // from same-version churn (a missed delete event, a file record overwritten
            // by hydrate). Embed-free set-arithmetic; if backgrounded mid-sweep it
            // aborts and the NEXT poll tick resumes it (latch only on completion).
            if (!this.orphanSweepDone && !this.orphanSweepRunning) {
                this.orphanSweepRunning = true;
                try {
                    const { completed } = await this.orchestrator.sweepOrphanChunks({ shouldContinue: () => !activeDocument.hidden });
                    if (completed) this.orphanSweepDone = true;
                } finally {
                    this.orphanSweepRunning = false;
                }
            }
            // Once per session: compact this device's own sidecar if it has bloated with
            // dead records (superseded re-appends + un-tombstoned orphans). Model-free
            // byte-copy, so mobile-safe; reclaims the disk a full reindex would otherwise
            // be the only thing to free — and the only GC reaching an off-grid device.
            if (!this.sidecarCompactDone && !this.sidecarCompactRunning) {
                this.sidecarCompactRunning = true;
                try {
                    const r = await this.orchestrator.compactOwnSidecar();
                    if (r?.compacted) {
                        // A shed = this device's OWN shard was unreadable/corrupt for a
                        // still-live record → that note needs a model re-embed to be
                        // searchable again. Expected zero; surface any non-zero as a
                        // corruption breadcrumb (invisible on mobile without it).
                        if (r.shed > 0) await this.logger.appendError('sidecar-compaction-shed', new Error(`shed ${r.shed} corrupt/unreadable record(s)`)).catch(() => {});
                    } else if (r && r.reason === 'incomplete-rechunk') {
                        // Transient in principle (a file mid-sync failed to read, a
                        // tokenizer hiccup) — but each retry re-runs the WHOLE-VAULT
                        // re-chunk + tokenizer pass, and a persistently unreadable
                        // file (an un-downloaded iCloud original) turned that into a
                        // full-vault CPU burn every 5-minute poll for the entire
                        // session (issue #5's "unresponsive every couple of
                        // minutes"). Bound it: a few retries this session, then
                        // latch and say so — the next session starts fresh, and a
                        // full reindex still compacts unconditionally.
                        this.sidecarCompactIncompleteRetries++;
                        if (this.sidecarCompactIncompleteRetries >= SIDECAR_COMPACT_MAX_INCOMPLETE_RETRIES) {
                            this.sidecarCompactDone = true;
                            await this.logger.appendError('sidecar-compaction-retry-cap', new Error(
                                `live-id re-chunk incomplete ${this.sidecarCompactIncompleteRetries}× — a file is persistently unreadable or the tokenizer keeps failing (see collectLiveIds-* errors); deferring compaction to the next session`)).catch(() => {});
                        }
                    }
                    // Latch on any definitive verdict; an incomplete re-chunk retries
                    // (bounded above). null = sidecar off → don't latch (it may be
                    // enabled later this session).
                    if (r && r.reason !== 'incomplete-rechunk') this.sidecarCompactDone = true;
                } catch (e) {
                    // A hard failure (disk full, write error) would otherwise re-run the
                    // whole-vault re-chunk every poll forever — log it and latch off for
                    // the session rather than spin silently.
                    await this.logger.appendError('sidecar-compaction', e).catch(() => {});
                    this.sidecarCompactDone = true;
                } finally {
                    this.sidecarCompactRunning = false;
                }
            }
            // EVERY poll tick (unlike the once-per-session compaction): fold the
            // small per-flush shards the append-only writer (1A) accumulates into
            // dense ones once enough pile up. Oracle-free byte-copy — no re-chunk,
            // no model — and below its count gate it costs one directory listing,
            // so a heavy editing session gets folded down the same day instead of
            // waiting weeks for compaction's byte floor.
            if (!this.sidecarCoalesceFailed && !this.sidecarCoalesceRunning) {
                this.sidecarCoalesceRunning = true;
                try {
                    const c = await this.orchestrator.coalesceOwnSidecar();
                    // Same corruption breadcrumb as compaction: a shed record is a
                    // live id whose own-shard bytes were unreadable (expected zero).
                    if (c && c.shed > 0) await this.logger.appendError('sidecar-coalesce-shed', new Error(`shed ${c.shed} corrupt/unreadable record(s)`)).catch(() => {});
                    // Torn jsonl lines the fold's rewrite just removed for good —
                    // log the evidence before it is only visible here.
                    if (c && c.skippedLines > 0) await this.logger.appendError('sidecar-coalesce-skipped-lines', new Error(`rewrite dropped ${c.skippedLines} unparseable jsonl line(s)`)).catch(() => {});
                } catch (e) {
                    await this.logger.appendError('sidecar-coalesce', e).catch(() => {});
                    if (++this.sidecarCoalesceFailures >= SIDECAR_COALESCE_MAX_FAILURES) {
                        this.sidecarCoalesceFailed = true;
                        await this.logger.appendError('sidecar-coalesce-retry-cap', new Error(`coalesce failed ${this.sidecarCoalesceFailures}× — latching off for the session`)).catch(() => {});
                    }
                } finally {
                    this.sidecarCoalesceRunning = false;
                }
            }
        } catch (e) {
            this.appendErrorIfCurrent('periodic-reconcile', e, workGen);
        } finally {
            if (this.isSessionWorkCurrent(workGen)) this.popTaskContext('reconcile');
        }
    }

    // Generate the diagnostic report (full seek-report.json + a short seek-report.md
    // summary) and open the .md. The user-facing debug affordance, surfaced as a
    // Settings button now that the command-palette entry is gone. Errors tee to
    // console + NDJSON as usual.
    async openLoggingReport(): Promise<void> {
        await openDiagnosticReport({
            app: this.app,
            logger: this.logger,
            redactReport: this.settings.redactReport,
        });
    }

    // T8 spike — dedicated-worker capability probe (CLI eval target). Spawns a
    // module Worker inside the Seek iframe and reports spawn / CDN-import /
    // process-shim / WebGPU-compute results. Never mutates index or pipeline
    // state, so it is safe to run before or after a model load.
    async runWorkerProbe(): Promise<WorkerProbeResult> {
        return this.embedder.workerProbe();
    }

    // T8 spike — functional embed-worker test (CLI eval target). Loads the real
    // model in a long-lived nested worker, embeds the given text there, and
    // compares the vector against the iframe pipeline's own output via cosine.
    // Independent of the iframe pipeline's load state; never mutates index data.
    async runWorkerEmbedTest(text = 'The quick brown fox jumps over the lazy dog'): Promise<WorkerEmbedTestResult> {
        return this.embedder.workerEmbedTest(text);
    }

    // T8 spike — terminate the nested embed worker (frees wasm heap + GPU
    // state). Next runWorkerEmbedTest() respawns it fresh.
    async killEmbedWorker(reason = 'manual'): Promise<{ killed: boolean }> {
        return this.embedder.killEmbedWorker(reason);
    }

    private async warnOnModelIndexDrift(): Promise<void> {
        if (this.modelDriftWarned) return;
        try {
            const meta = await this.store.getMeta();
            if (meta.lastIndexedAt === null) return;   // empty index — first reindex will stamp it
            const indexModel = meta.modelId ?? LEGACY_ENGLISH_MODEL_ID;
            if (indexModel !== this.embedder.modelId) {
                this.modelDriftWarned = true;
                new Notice(
                    'Seek: the index was built with a different embedding model. ' +
                    'Open Settings → Seek → Index and choose Reindex — until then, incremental ' +
                    'indexing is paused and semantic ranking is unreliable.',
                    15000,
                );
                await this.logger.appendError('model-index-drift', new Error(
                    `index=${indexModel} loaded=${this.embedder.modelId}`));
            }
        } catch { /* meta unavailable (store closed mid-teardown) — next load rechecks */ }
    }

    // ---- Incremental indexing ----
    //
    // Keeps the index fresh without re-embedding the vault, on cheap triggers
    // that never fire mid-edit:
    //   - Leaving a note (active-leaf-change) enqueues it IF its mtime advanced
    //     (the mtime guard skips read-only visits); a 5-min idle timer then
    //     flushes. Edits are NOT watched per-keystroke — leaving the note is the
    //     debounce.
    //   - Backgrounding (visibilitychange:hidden / pagehide / window blur) flushes
    //     immediately — the last safe write window on iOS.
    //   - Deletes/renames/creates are discrete structural events with no blur
    //     equivalent, so we watch them directly; a rename is drop-old + index-new,
    //     which makes a move into an ignored folder a soft-delete.
    //   - A BULK flush (> BULK_DELTA_THRESHOLD dirty files = a paste / vault sync /
    //     git checkout, not an edit) is a mini-reindex: progress shows on a Notice,
    //     a live query preempts the embed (shouldContinue), a cold DESKTOP model is
    //     deferred not force-loaded (like reconcileOnLoad), and the deferred/
    //     preempted remainder is reconciled by the drain. Small deltas stay a plain
    //     force-embed.
    // The catch-up drain (runCatchUp/drainCatchUp) reconciles deferred embeds —
    // cold-mobile, cold-desktop-bulk, or query-preempted — via a computeDelta diff.
    // It runs once a search SESSION ENDS (onSearchActivity, query settled / modal
    // closed, NOT per keystroke, so the foreground embed never competes with the
    // live query on the shared iOS process) AND is kicked immediately after a bulk
    // flush (a no-op when nothing's left). Startup reconciliation (reconcileOnLoad)
    // backstops anything missed while Seek wasn't running.
    private wireIncrementalIndexing(): void {
        this.schedulers.wireIncrementalIndexing(
            (ref) => this.registerEvent(ref),
            (el, type, handler) => this.registerDomEvent(el, type, handler),
        );
    }

    // Delegated to this.schedulers (see plugin-schedulers.ts)
    private async enqueueIfDirty(file: TFile | null): Promise<void> {
        return this.schedulers.enqueueIfDirty(file);
    }

    private scheduleFlush(): void {
        this.schedulers.scheduleFlush();
    }

    private flushStructuralSoon(): void {
        this.schedulers.flushStructuralSoon();
    }

    private flushOnBackground(): void {
        this.schedulers.flushOnBackground();
    }

    private async flushDirty(): Promise<void> {
        return this.schedulers.flushDirty();
    }

    // Startup mtime-diff sweep. Authoritative diff of the persisted index vs. the
    // live vault — catches external sync, edits made while disabled, and deletes
    // missed by a crash. Deletes/moves apply immediately (model-free). Edits are
    // DEFERRED at this step (embed: false); desktop then auto-drains via
    // scheduleStartupCatchUp without opening Search. Mobile stays lazy.
  /** @returns true when reconcile applied a non-empty delta (restore + reindex). */
    private async reconcileOnLoad(sessionGen?: number): Promise<boolean> {
        const workGen = sessionGen ?? this.loadGeneration;
        if (!this.isSessionWorkCurrent(workGen) || !this.orchestrator) return false;
        await this.store.ensureOpen().catch(() => {});
        if (!this.isSessionWorkCurrent(workGen) || !this.store.isOpen()) return false;
        this.pushTaskContext('reconcile');
        try {
            await this.whenLayoutReady();
            if (!this.isSessionWorkCurrent(workGen)) return false;
            const { dirty, deleted } = await this.orchestrator.computeDelta();
            if (dirty.length === 0 && deleted.length === 0) return false;
            if (!this.isSessionWorkCurrent(workGen)) return false;
            let storedFiles = 0;
            try {
                storedFiles = (await this.store.count()).files;
            } catch { /* treat as empty store */ }
            const buildMode = resolveIndexBuildMode({
                inventoryChunks: this.indexInventoryChunks,
                noteCount: this.indexableNoteCount(),
                dirtyCount: dirty.length,
                storedFiles,
            });
            if (buildMode === 'cold') {
                this.scheduleIndexBuild('cold');
            } else if (buildMode === 'catchup') {
                this.scheduleIndexBuild('catchup');
            }
            // T4 persist-cache: restore before reconcile only when structural deletes
            // need applyDelta (embed:false still patches the frame for deleted paths).
            // Dirty-only deferrals skip restore here — catch-up pays it once on embed.
            if (deleted.length > 0) {
                try {
                    await this.orchestrator.restorePersistedCachesBeforeReconcile();
                } catch (e) {
                    this.appendErrorIfCurrent('persist-cache-restore', e, workGen);
                }
                if (!this.isSessionWorkCurrent(workGen)) return false;
                await this.orchestrator.reindexDelta(dirty, deleted, { embed: false });
            }
            // Dirty-only: do NOT run embed:false reindexDelta here. That pass held the
            // write lock across thousands of files and blocked pre-catchup warmCaches /
            // seek:search behind IDB (G_catchup_ux). Catch-up embeds the dirty set.
            return true;
        } catch (e) {
            this.appendErrorIfCurrent('reconcileOnLoad', e, workGen);
            return true;
        } finally {
            if (this.isSessionWorkCurrent(workGen)) {
                this.popTaskContext('reconcile');
                void this.touchIndexInventory();
            }
        }
    }

    // The modal reports its session lifecycle here: opening + each keystroke =
    // active (pauses the drain so a foreground embed never competes with the live
    // query on the shared iOS WebContent process); query-settled + modal-closed =
    // inactive, which is the trigger to drain. Gated/no-op when nothing's pending.
    private onSearchActivity(active: boolean): void {
        this.searchActiveTimestamp = active ? Date.now() : null;
        // Session settled = a safe window. Drive both deferred drains: catch-up (embeds)
        // and drift recovery (embed-free). Each is a cheap no-op unless it has pending work.
        if (!active) { this.runCatchUp(); this.runDriftRecovery(); }
    }

    // Hard query-lifecycle signal: true the moment a query embed starts, false
    // when its results settle. The modal emits balanced edges (ref-counted
    // modal-side across the cold path); headless queries emit balanced pairs via
    // withQueryInFlight. Held in indexingBlocked so a preempted/deferred reindex
    // resumes only AFTER the query completes — the note's "make indexing wait for
    // the query". The last-caller-out edge is a drain trigger, exactly like
    // onSearchActivity(false). Max(0,·) self-heals an unbalanced false (e.g. a
    // torn-down modal's reset firing when nothing was counted).
    private onQueryInFlight(inFlight: boolean): void {
        this.queryInFlightCount = Math.max(0, this.queryInFlightCount + (inFlight ? 1 : -1));
        // All queries complete = a safe window — same dual drive as onSearchActivity(false).
        if (this.queryInFlightCount === 0) { this.runCatchUp(); this.runDriftRecovery(); }
    }

    // Run a headless query (CLI handler, deep-link open) under the same
    // query-in-flight gate the modal honors. Raising the flag makes a running
    // catch-up drain or bulk flush yield at its next batch boundary
    // (indexingBlocked → shouldContinue/isSearchActive), so the query's embed
    // isn't queued behind minutes of indexing — previously a CLI search on a
    // cold install waited out the entire initial drain. The finally edge
    // restarts whatever was preempted.
    async withQueryInFlight<T>(fn: () => Promise<T>): Promise<T> {
        this.onQueryInFlight(true);
        try {
            // indexingBlocked → catch-up shouldContinue aborts at the next file
            // boundary. Do NOT wait for catchUpRunning here: that waited out whole
            // bursts (20s+) before the query embed was even queued. IframeRunner
            // single-flights RPCs with query priority so embed jumps ahead of
            // queued embed-batch/token-counts (G_catchup_ux).
            return await fn();
        } finally {
            this.onQueryInFlight(false);
        }
    }

    // Open the Seek search modal, optionally seeded with a query (the `seek-search`
    // command passes none; the obsidian://seek deep-link passes the URL's query).
    // Decouples modal-open from model-load: the model can take 3–10 s cold-start
    // (7.6 s on iOS first-run, per the [[Seek Model Performance]] revision trail)
    // and the input field has no reason to wait — the orchestrator only needs the
    // model at query-execution time. We start the load eagerly (overlapping the
    // user's typing latency) and hand the in-flight promise to the modal, which
    // awaits it inside `runSearch`, not `onOpen`. The .catch is the unhandled-
    // rejection guard for when nothing in the modal ever awaits it (e.g. the user
    // closes the modal before typing); errors are already logged in ensureModelLoaded.
    // The version-stale banner spec for the search modal, or null when the index
    // identity matches this build (the common case). Platform-independent: the banner is
    // a signpost whose button opens Settings (the modal owns that), so the only policy
    // here is "is the index version-stale?". Re-evaluated by the modal on each open, so a
    // reindex done from Settings clears it the next time the modal opens.
    private indexNotice(): IndexBanner | null {
        return indexBannerSpec(this.indexHealth, this.degradedReason, this.peerSyncPending);
    }

    private indexLoadState(): IndexLoadState {
        return {
            phase: resolveIndexLoadPhase({
                hydrating: (this.indexBootPending || this.sidecarHydrating) && !this.indexGoodEnough,
                catchUpPending: this.catchUpPending,
                catchUpRunning: this.catchUpRunning,
                flushing: this.flushing,
                writing: this.orchestrator?.isWriting() ?? false,
                indexing: this.isIndexing,
            }),
            catchUpPending: this.catchUpPending,
            waitingForSidecar: this.waitingForSidecar,
            health: this.indexHealth,
            reason: this.degradedReason,
            peerSyncPending: this.peerSyncPending,
            job: this.indexProgress.job(),
            uiHealth: this.statusBarHealth(),
            inventoryChunks: this.indexInventoryChunks,
        };
    }

    private applySidecarWait(result: { hydrated: number; skippedPartialNotes: number; acceptedProducers: number } | null): void {
        if (!result) return;
        this.waitingForSidecar = resolveSidecarWait(result, this.indexInventoryChunks);
        if (result.hydrated > 0) void this.touchIndexInventory();
        else this.refreshIndexStatusBar();
    }

    private markIndexGoodEnough(): void {
        if (this.indexGoodEnough) return;
        this.indexGoodEnough = true;
        this.indexBootPending = false;
        void this.logStartupGateReleased();
        void this.touchIndexInventory();
        this.refreshIndexStatusBar();
        this.syncWarmDeferred();
        void this.runStartupWarm();
    }

    private async runStartupWarm(trigger: 'startup-good-enough' | 'post-catchup' = 'startup-good-enough'): Promise<void> {
        if (this.startupTelemetry.view().bootComplete) return;
        if (!getStartupWarm() || !this.orchestrator) {
            this.startupTelemetry.markWarmSkipped();
            this.recordStartupBoot();
            this.notifySessionTelemetryChanged();
            return;
        }
        // Catch-up owns IDB — warm after the drain finishes (post-catchup).
        if (this.catchUpPending || this.catchUpRunning) return;
        this.startupTelemetry.beginWarm();
        try {
            await this.orchestrator.warmCaches(trigger);
        } finally {
            this.startupTelemetry.endWarm();
            this.recordStartupBoot();
            this.notifySessionTelemetryChanged();
        }
    }

    private finalizeStartupTelemetryIfNeeded(): void {
        if (this.startupTelemetry.view().bootComplete) return;
        if (this.startupTelemetry.view().searchableMs == null) return;
        // Warm still owed after catch-up — leave the timeline open.
        if (getStartupWarm() && (this.catchUpPending || this.catchUpRunning)) return;
        if (getStartupWarm() && this.orchestrator && !this.catchUpPending && !this.catchUpRunning) {
            void this.runStartupWarm('startup-good-enough');
            return;
        }
        this.startupTelemetry.markWarmSkipped();
        this.recordStartupBoot();
        this.notifySessionTelemetryChanged();
    }

    registerSettingsTelemetrySink(sink: SettingsTelemetrySink | null): void {
        this.settingsTelemetrySink = sink;
    }

    /** Snapshot a completed boot into device-local history (once per boot). */
    private recordStartupBoot(): void {
        if (this.startupBootRecorded) return;
        const view = this.startupTelemetry.view();
        if (!view.bootComplete || view.readyFromStartMs == null) return;
        this.startupBootRecorded = true;
        this.startupHistory.record(view);
    }

    getStartupTimingView(): StartupTimingView {
        return this.startupTelemetry.view();
    }

    /** Previous boot from device-local history, for the Settings trend row. */
    getPreviousStartupBoot(): { readyFromStartMs: number | null; warmSkipped: boolean } | null {
        const prev = this.startupHistory.previous();
        return prev ? { readyFromStartMs: prev.readyFromStartMs, warmSkipped: prev.warmSkipped } : null;
    }

    /** Last five completed boots from the on-disk history file. */
    getStartupBootHistory(): readonly StoredStartupBoot[] {
        return this.startupHistory.all();
    }

    getStartupLiveElapsedMs(): number | null {
        return this.startupTelemetry.liveElapsedMs();
    }

    getRecentSearchEntries(): readonly RecentSearchEntry[] {
        return this.recentSearchRing.snapshot();
    }

    recordModalSearchLatency(query: string, ms: number): void {
        this.recentSearchRing.push(query, ms);
        this.notifySessionTelemetryChanged();
    }

    private notifySessionTelemetryChanged(): void {
        this.settingsTelemetrySink?.onSessionTelemetryChanged();
    }

    /** Tell the orchestrator to defer background warm while catch-up holds IDB. */
    private syncWarmDeferred(): void {
        this.orchestrator?.setWarmDeferred(this.catchUpPending || this.catchUpRunning);
    }

    private async withSidecarHydrate<T>(fn: () => Promise<T>): Promise<T> {
        const hydrateGen = this.loadGeneration;
        this.sidecarHydrating = true;
        this.pushTaskContext('hydrating');
        this.refreshIndexStatusBar();
        const spanStart = performance.now();
        {
            const span = {
                type: 'startup-span' as const,
                timestamp: new Date().toISOString(),
                span: 'sidecar-hydrate',
                phase: 'start' as const,
            };
            seekPerf.recordStartupSpan(span);
            void this.logger.append(span).catch(() => {});
        }
        try {
            return await fn();
        } finally {
            if (!this.isSessionWorkCurrent(hydrateGen)) {
                /* stale hydrate — leave UI state to the current session */
            } else {
            const durationMs = Math.round(performance.now() - spanStart);
            {
                const span = {
                    type: 'startup-span' as const,
                    timestamp: new Date().toISOString(),
                    span: 'sidecar-hydrate',
                    phase: 'end' as const,
                    durationMs,
                };
                seekPerf.recordStartupSpan(span);
                void this.logger.append(span).catch(() => {});
            }
            this.popTaskContext('hydrating');
            this.sidecarHydrating = false;
            this.refreshIndexStatusBar();
            }
        }
    }

    private async logStartupGateReleased(): Promise<void> {
        this.startupTelemetry.markSearchable();
        this.notifySessionTelemetryChanged();
        const entry = {
            type: 'startup-gate' as const,
            timestamp: new Date().toISOString(),
            event: 'released' as const,
            warmPhase: this.indexWarmPhase,
            uiHealth: this.indexUiHealth,
            elapsedMs: Math.round(performance.now() - this.bootStartMs),
        };
        seekPerf.recordStartupGate(entry);
        await this.logger.append(entry).catch(() => {});
    }

    /** Replay in-memory `[seek:perf]` beats into the console for CLI `dev:console` after CDP reattach. */
    dumpPerfConsole(): number {
        return seekPerf.dump();
    }

    /** Clear the Seek perf ring (does not clear the CDP console buffer — use `dev:console clear`). */
    clearPerfConsole(): void {
        seekPerf.clear();
    }

    private whenLayoutReady(): Promise<void> {
        return whenLayoutReady(this.app.workspace);
    }

    /**
     * Settings load that survives a UTF-8 BOM on data.json (`Unexpected token '﻿'`).
     * Layout-ready does not fix this — the BOM has to be stripped.
     */
    async loadData(): Promise<any> {
        const dir = this.manifest.dir;
        if (dir) {
            try {
                const path = `${dir}/data.json`;
                const adapter = this.app.vault.adapter;
                if (await adapter.exists(path)) {
                    const text = await adapter.read(path);
                    if (!text) return null;
                    return parseJsonStripBom(text);
                }
                return null;
            } catch {
                // Fall through to Obsidian's loader.
            }
        }
        try {
            return await super.loadData();
        } catch {
            return null;
        }
    }

    private indexableNoteCount(): number {
        const md = this.app.vault.getMarkdownFiles();
        const extra = this.settings.indexBases ? this.app.vault.getFiles().filter(f => f.extension === 'base') : [];
        const all = extra.length === 0 ? md : [...md, ...extra];
        return all.filter(f => shouldIndexPath(this.app, this.settings, f.path)).length;
    }

    // Translate the orchestrator's peer-ahead signal (a sidecar refused for being at a
    // NEWER chunkerVersion than this build) into the banner state. This is the MIRROR of
    // enforceIndexIdentity: there the LOCAL index is stale vs the local build; here the
    // local index matches the build, but a peer holds an index this build can't read, so
    // the honest fix is "update Seek", not "reindex". Called after every reconcile/hydrate.
    //
    // A real local problem ('version'/'drift') always wins — it's worse and more specific,
    // and it's what an actual reindex/update would clear first. We only own the otherwise-
    // healthy case, so we never stomp those reasons, and we only clear back to healthy a
    // banner WE set (degradedReason === 'peer-ahead').
    private applyPeerAheadBanner(): void {
        const ahead = this.orchestrator?.peerAhead ?? false;
        if (ahead) {
            if (this.degradedReason === 'version' || this.degradedReason === 'drift') return;
            this.indexHealth = 'degraded';
            this.degradedReason = 'peer-ahead';
            if (!this.peerAheadNotified) {
                this.peerAheadNotified = true;
                new Notice(INDEX_PEER_AHEAD_MSG, 8000); // brief, non-sticky — informational, not urgent
            }
        } else {
            this.peerAheadNotified = false;
            if (this.degradedReason === 'peer-ahead') { this.indexHealth = 'healthy'; this.degradedReason = null; }
        }
        this.refreshIndexStatusBar();
    }

    private openSearchModal(initialQuery = ''): void {
        this.pushTaskContext('search');
        // The user's search intent beats the boot politeness buffer: run the
        // deferred post-layout boot now instead of leaving them waiting for it.
        if (this.bootBuffer) {
            this.bootBufferBypassed = true;
            const handle = this.bootBuffer;
            this.bootBuffer = null;
            handle.bypass();
        }
        try {
            const wasLoaded = this.embedder.loaded;
            const loadPromise = this.ensureModelLoaded();
            loadPromise.catch(() => { /* logged in ensureModelLoaded */ });
            new SeekSearchModal(
                this.app,
                this.orchestrator,
                this.logger,
                { ready: wasLoaded, promise: loadPromise },
                this.settings,
                (active) => this.onSearchActivity(active),
                (inFlight) => this.onQueryInFlight(inFlight),
                () => this.indexNotice(),
                () => this.indexLoadState(),
                initialQuery,
                this.recents,
                (query, ms) => this.recordModalSearchLatency(query, ms),
            ).open();
        } catch (e) {
            // Synchronous failure path (rare — only if the Modal ctor or
            // ensureModelLoaded throws before returning a promise).
            this.logger.appendError('seek-search:open', e).catch(() => {});
            new Notice('Seek: search failed to open — see the developer console.');
        } finally {
            // Modal lifecycle isn't observable from here; pop after open().
            this.popTaskContext('search');
        }
    }

    // Headless deep-link target (obsidian://seek?query=…&mode=open[&paneType=…]):
    // load the model, run the query, and open the top hit's note directly — no modal.
    // Mirrors the seek:search CLI handler's model-gating (cold start blocks, so a
    // Notice stands in for the modal's progress UI). An empty query falls back to
    // the normal modal so a malformed link still does something useful.
    private async openTopResult(query: string, target: OpenTarget = false): Promise<void> {
        if (!query.trim()) { this.openSearchModal(); return; }
        // Captured for the withQueryInFlight closure (null-check narrowing).
        const orchestrator = this.orchestrator;
        if (!orchestrator) { new Notice('Seek: still loading — try again in a moment'); return; }
        const notice = new Notice(`Seek: searching “${query}”…`, 0);
        this.pushTaskContext('search');
        try {
            // Under the query-in-flight gate, same as the seek:search CLI handler:
            // a running drain/flush yields at its next batch boundary.
            const { results } = await this.withQueryInFlight(async () => {
                // No modal to overlap the cold-start, so block on the model load
                // (3–10 s first call) before querying — same as the CLI handler.
                await this.ensureModelLoaded();
                // topK=1 — we only open the single best hit.
                return orchestrator.search(query, 1);
            });
            notice.hide();
            const top = results[0];
            if (!top) { new Notice(`Seek: no results for “${query}”`); return; }
            const file = this.app.vault.getAbstractFileByPath(top.note_path);
            if (!(file instanceof TFile)) { new Notice(`Seek: top result not on disk (${top.note_path})`); return; }
            await this.openIndexedFile(file, top, target);
        } catch (e) {
            notice.hide();
            this.logger.appendError('seek:protocol-open', e).catch(() => {});
            new Notice('Seek: could not open the result — see the developer console.');
        } finally {
            this.popTaskContext('search');
        }
    }

    // Open an indexed hit (markdown or .base) at the requested pane target.
    // Headless paths (protocol, seek:open CLI) always focus the opened pane.
    async openIndexedFile(file: TFile, hit: { heading_path?: string[] }, target: OpenTarget): Promise<void> {
        if (file.extension === 'base') {
            const viewName = hit.heading_path?.[hit.heading_path.length - 1];
            const state: Record<string, unknown> = viewName
                ? { file: file.path, viewName }
                : { file: file.path };
            await openBaseAtTarget(this.app, file, target, state);
            return;
        }
        await openFileAtTarget(this.app, file, target);
    }

    // Drain cold-mobile deferred embeds once a search session ends and the model is
    // warm. Runs the work in safety-bounded, self-chaining bursts (drainCatchUp) so
    // the foreground iOS embed can't saturate the shared process into a jetsam kill,
    // and desktop stays responsive while a large backlog drains. Fire-and-forget;
    // cheap no-op
    // unless something was deferred (catchUpPending) and we're in a safe window.
    private runCatchUp(): void {
        if (!this.catchUpPending || this.catchUpRunning || !this.orchestrator) return;
        if (!this.embedder.loaded) {
            this.scheduleStartupCatchUp();
            return;
        }
        // Desktop drains in background (headless CLI, minimized window). Mobile
        // stays lazy while hidden — main-thread embed jank (G_catchup_ux probe).
        if ((isMobilePlatform() && activeDocument.hidden) || this.indexingBlocked) return;
        // Peer-ahead grind-stop: while a newer-version peer index exists, draining the
        // deferred backlog would re-embed (on the iOS main thread) chunks this build will
        // discard the moment it updates. Leave catchUpPending set so the drain resumes
        // automatically once the user updates Seek and peerAhead clears. (This is the exact
        // loop behind the 2026-06-28 mobile bog-down: v7 phone grinding against a v8 sidecar.)
        if (isMobilePlatform() && this.orchestrator.peerAhead) return;
        this.catchUpRunning = true;
        this.syncWarmDeferred();
        const orchestrator = this.orchestrator;
        const mobile = isMobilePlatform();
        const pacer = new CompositorPacer();
        const workGen = this.loadGeneration;
        void (async () => {
            if (!this.isSessionWorkCurrent(workGen)) return;
            this.pushTaskContext('catchup');
            try {
                if (!this.persistCacheRestoredThisBoot && (this.indexInventoryChunks ?? 0) > 0) {
                    this.persistCacheRestoredThisBoot = true;
                    try {
                        await orchestrator.restorePersistedCachesBeforeReconcile();
                    } catch (e) {
                        await this.logger.appendError('persist-cache-restore', e).catch(() => {});
                    }
                }
                const burst = catchUpBurstLimits({
                    mobile,
                    burstMaxFiles: this.settings.catchUpBurstMaxFiles,
                });
                // Desktop catch-up is allowed to drain while the window is hidden;
                // only mobile pauses for backgrounding (the WebContent/jetsam path).
                // Keep this predicate aligned with runCatchUp's entry guard above.
                const shouldPauseForHidden = () => mobile && activeDocument.hidden;
                // Drain first — never block on warm/restore (G_catchup_ux). Search
                // serves stale frame / persisted BM25 during bursts; warm runs after
                // idle or on the search hot path.
                const { pending } = await drainCatchUp({
                    computeDelta: async () => {
                        const d = await orchestrator.computeDelta();
                        if (d.dirty.length > 0) this.syncCatchUpJob(d.dirty.length);
                        return d;
                    },
                    reindexDelta: async (d, del, opts) => {
                        const r = await orchestrator.reindexDelta(d, del, {
                            ...opts,
                            onProgress: (msg) => {
                                const job = this.catchUpJob;
                                if (!job) return;
                                const p = parseIndexedProgress(msg);
                                this.indexProgress.update(
                                    job.committed + (p?.files ?? 0),
                                    job.passTotal,
                                    msg,
                                    job.id,
                                );
                            },
                        });
                        if (this.catchUpJob) {
                            this.catchUpJob.committed += r.committedPaths.length;
                            const { committed, passTotal, id } = this.catchUpJob;
                            const label = this.indexingBlocked
                                ? `Seek: indexing paused · ${committed} / ${passTotal}`
                                : `Seek: indexing ${committed} / ${passTotal} notes…`;
                            this.indexProgress.update(committed, passTotal, label, id);
                        }
                        return r;
                    },
                    isHidden: shouldPauseForHidden,
                    isSearchActive: () => this.indexingBlocked,
                    pace: () => pacer.pace(),
                    maxFiles: burst.maxFiles,
                    budgetMs: burst.budgetMs,
                });
                this.catchUpPending = pending;
            } catch (e) {
                this.appendErrorIfCurrent('runCatchUp', e, workGen);
                if (this.isSessionWorkCurrent(workGen)) this.catchUpPending = true;  // unknown state — let a later trigger retry
            } finally {
                if (!this.isSessionWorkCurrent(workGen)) {
                    this.catchUpRunning = false;
                    return;
                }
                this.popTaskContext('catchup');
                this.catchUpRunning = false;
                this.syncWarmDeferred();
                if (!this.catchUpPending) this.finishCatchUpJob();
                else this.indexProgress.refreshIdle();
                void this.touchIndexInventory();
                if (!this.catchUpPending) {
                    // The drain reached an empty delta — any exclusion change it was
                    // backfilling is now reflected in the index. Clear the banner.
                    this.clearExclusionChange();
                    void this.runStartupWarm('post-catchup');
                }
                // drainCatchUp self-chains every progressing burst. A pending return
                // means it hit a stop/no-progress condition and must wait for an
                // external trigger (visibility, search completion, file activity, or
                // the periodic reconcile) rather than immediately retrying forever.
            }
        })();
    }

    // After boot reconciliation, desktop loads the model and drains pending
    // embeds without opening Search. Mobile stays lazy (jetsam / heap).
    private applyPostBootIndexScheduling(): void {
        if (this.unloading) return;
        const empty = isKnownEmptyIndexWithNotes(this.indexInventoryChunks, this.indexableNoteCount());
        if (empty && !isMobilePlatform()) {
            this.scheduleIndexBuild('cold');
        } else if (shouldAutoDrainStartupCatchUp({
            mobile: isMobilePlatform(),
            catchUpPending: this.catchUpPending,
        }) && this.catchUpPending) {
            this.scheduleIndexBuild('catchup');
        }
        if (this.indexBootDecisionPending) {
            this.indexBootDecisionPending = false;
            this.refreshIndexStatusBar();
        }
    }

    private scheduleIndexBuild(mode: IndexBuildMode): void {
        if (mode === 'idle') return;
        if (isMobilePlatform()) {
            if (mode === 'catchup') this.catchUpPending = true;
            return;
        }
        if (mode === 'cold') {
            if (this.coldBuildScheduled || this.orchestrator?.isWriting()) return;
            this.coldBuildScheduled = true;
            void this.scheduleColdBuild();
            return;
        }
        this.catchUpPending = true;
        this.syncWarmDeferred();
        this.scheduleStartupCatchUp();
    }

    private async scheduleColdBuild(): Promise<void> {
        const workGen = this.loadGeneration;
        if (isMobilePlatform() || !this.orchestrator) {
            this.coldBuildScheduled = false;
            return;
        }
        try {
            await cheapYield();
            if (!this.isSessionWorkCurrent(workGen)) return;
            await this.ensureModelLoaded();
            if (!this.isSessionWorkCurrent(workGen)) return;
            this.catchUpPending = false;
            const ok = await this.runFullReindex({ skipConfirm: true });
            if (!this.isSessionWorkCurrent(workGen)) return;
            if (!ok && !this.orchestrator.isWriting()) {
                await this.touchIndexInventory();
                // A failed wipe must not kick a whole-vault catch-up while the
                // existing index is still on disk (that froze the main vault).
                if (isKnownEmptyIndexWithNotes(this.indexInventoryChunks, this.indexableNoteCount())) {
                    this.catchUpPending = true;
                    this.scheduleStartupCatchUp();
                }
            }
        } catch (e) {
            this.appendErrorIfCurrent('cold-build', e, workGen);
            if (this.isSessionWorkCurrent(workGen)) {
                this.catchUpPending = true;
                this.scheduleStartupCatchUp();
            }
        } finally {
            if (this.isSessionWorkCurrent(workGen)) this.coldBuildScheduled = false;
        }
    }

    private scheduleStartupCatchUp(): void {
        if (!shouldAutoDrainStartupCatchUp({
            mobile: isMobilePlatform(),
            catchUpPending: this.catchUpPending,
        })) return;
        const workGen = this.loadGeneration;
        const pacer = new CompositorPacer();
        void pacer.pace().then(async () => {
            if (!this.isSessionWorkCurrent(workGen) || !this.catchUpPending) return;
            try {
                await this.ensureModelLoaded();
                if (!this.isSessionWorkCurrent(workGen)) return;
                this.runCatchUp();
            } catch {
                // Leave catchUpPending set — visibility / next search retries.
            }
        });
    }

    // ── Exclusion-list change detection ────────────────────────────────────────────
    // Obsidian's "Excluded files" (Settings → Files & Links) exposes no plugin event,
    // so we poll its EFFECTIVE excluded live-path set (indexable-by-extension files
    // that shouldIndex currently rejects). The first post-boot poll seeds the baseline;
    // each later poll set-diffs against it. A path that left the excluded set came back
    // (backfill it — its chunks were soft-deleted or never built); a path that entered
    // it was hidden (soft-delete its chunks). Only real path-set changes fire — a
    // Delegated to this.schedulers (see plugin-schedulers.ts)
    private pollExclusionChanges(): void {
        this.schedulers.pollExclusionChanges();
    }

    private driveExclusionBackfill(diff: ExclusionDiff): void {
        this.schedulers.driveExclusionBackfill(diff);
    }

    /** The last exclusion-list change, or null. `backfilling` = a pass is in flight. */
    getExclusionChange(): { diff: ExclusionDiff; detectedAt: number; backfilling: boolean } | null {
        return this.schedulers.getExclusionChange();
    }

    /** Called when the backfill for a detected change finishes (catch-up drained). */
    /* internal */ clearExclusionChange(): void {
        this.schedulers.clearExclusionChange();
    }

    private notifyFolderCoverageChanged(): void {
        this.settingsTelemetrySink?.onFolderCoverageChanged?.();
    }

    /** True once the search orchestrator exists — coverage reads need it. */
    get isCoverageSourceReady(): boolean {
        return this.orchestrator != null;
    }

    /** Per-folder embedder coverage for the settings surface (passthrough). */
    async getFolderCoverage(): Promise<FolderCoverageSummary> {
        if (!this.orchestrator) return emptyFolderCoverage();
        try {
            return await this.orchestrator.getFolderCoverage();
        } catch {
            return emptyFolderCoverage();
        }
    }

    // Force an exclusion re-check now (used when the user flips "Honor excluded
    // folders" in Settings, rather than waiting for the 5s poll).
    forcePollExclusions(): void {
        this.schedulers.forcePollExclusions();
    }
    private onPersistentDrift(): void {
        this.driftRecoveryCoordinator.onPersistentDrift();
    }

    private runDriftRecovery(): void {
        this.driftRecoveryCoordinator.runDriftRecovery();
    }

    private commitDriftHealth(health: 'healthy' | 'degraded', gen: number): void {
        this.driftRecoveryCoordinator.commitDriftHealth(health, gen);
    }

    // Full reindex: nuke the index and re-embed every markdown file. Shared by the
    // command palette and the settings "Full reindex" button (the degraded-health
    // recovery affordance). USER-INITIATED, so unlike the automatic drift-recovery
    // ladder it is allowed to embed — the embed-free guarantee covers only the auto path.
    // opts.skipConfirm: the caller already confirmed (the settings Index section has its
    // own inline two-button confirm, so it suppresses the blocking confirm dialog).
    // opts.onProgress: a second progress sink (besides the Notice) — the settings status
    // card subscribes to drive its live "N / TOTAL notes" bar. Arg-less callers (command
    // palette main.ts:496, degraded-health button) keep the confirm + Notice unchanged.
    // Returns whether a reindex actually RAN — false when refused (a build is already
    // running) or declined at the confirm, or if it threw. The identity heal uses this
    // to avoid falsely clearing its "needs heal" latch when its reindex didn't happen.
    async runFullReindex(opts?: { skipConfirm?: boolean; onProgress?: (msg: string) => void }): Promise<boolean> {
        // Refuse to STACK a reindex on a running one. The write mutex would otherwise
        // queue a second reindex behind the first (it nukes + re-embeds the whole
        // vault again the moment the first releases) — pure waste, and on a large
        // vault the second's nuke is exactly the deleteDatabase that fired versionchange
        // at an in-flight pass. The identity heal also routes through here, so this
        // doubles as a guard against a heal stacking on a manual reindex (Fix B). The
        // catch-up cold build runs under the same mutex (isWriting covers it too).
        if (this.orchestrator.isWriting()) {
            new Notice('Seek: a reindex is already running.', 4000);
            return false;
        }
        if (!opts?.skipConfirm) {
            const message = 'This will delete the existing Seek index and re-embed every markdown file in this vault.\nProceed?';
            if (!(await new ConfirmModal(this.app, message).openAndConfirm())) return false;
            // Re-check: the confirm dialog awaits user input, so a reindex (e.g. the
            // identity heal, or another caller of this same method) could have started
            // in that window. Without this, both would proceed past the mutex.
            if (this.orchestrator.isWriting()) {
                new Notice('Seek: a reindex is already running.', 4000);
                return false;
            }
        }

        const jobId = this.beginIndexJob('full', this.indexableNoteCount(), 'Seek: indexing…');
        this.pushTaskContext('indexing');
        try {
            await this.ensureModelLoaded();
            this.orchestrator.invalidateBm25Cache();
            const result = await this.orchestrator.reindexAll((msg) => {
                opts?.onProgress?.(msg);
                this.indexProgress.updateFromProgress(msg, jobId);
            });
            const summary = [
                result.pass ? '✅' : '❌',
                `${result.filesIndexed} files`,
                `${result.chunksIndexed} chunks`,
                `${(result.totalDurationMs / 1000).toFixed(1)} s`,
                `${result.chunksPerSec.toFixed(1)} ch/s`,
            ].join(' · ');
            new Notice(`Seek reindex: ${summary}`, 10000);

            // Post-reindex storage snapshot — answers "how much disk does the index
            // actually consume?" without waiting for the next platform probe (reload).
            await this.emitStorageSnapshot('post-reindex');
            // A full reindex re-couples the index from scratch (it is the terminal
            // recovery): clear any lingering degraded health so the settings affordance,
            // the version banner, and the suppression baseline all reset.
            this.indexHealth = 'healthy';
            this.degradedReason = null;
            this.peerSyncPending = false;
            // Re-arm version reporting: this build just stamped its identity, so a FUTURE
            // ship should toast/banner again. (Without this, identityHealNotified could
            // stay latched until the next poll's identityMatches clears it.)
            this.identityHealNotified = false;
            return true;
        } catch (e) {
            await this.store.open().catch(() => {});
            await this.logger.appendError('seek-full-reindex', e);
            // One end-toast whether it passed or failed (the recap). Detail → console + log.
            new Notice('Seek reindex: ❌ failed — see the logging report (Settings → Seek).', 10000);
            return false;
        } finally {
            this.popTaskContext('indexing');
            this.indexProgress.hide(jobId);
            void this.touchIndexInventory();
        }
    }

    // Index health snapshot for the settings Index status card. Read-only; gathers the
    // private store + logger so the settings tab needs no plugin internals. Counts come
    // from the index store, on-disk bytes from the Storage API (iOS-safe), the last-index
    // timestamp from index meta (persisted), and its duration from the newest index-complete
    // log entry (logged only). Each source is independently guarded so a single failure
    // degrades one field rather than blanking the whole card.
    async getIndexStats(): Promise<IndexStats> {
        let files = 0, chunks = 0;
        try {
            const c = await this.store.count();
            files = c.files;
            chunks = c.chunks;
            this.inventoryGen++;
            this.publishInventory(files, chunks);
            files = this.indexInventoryFiles ?? files;
            chunks = this.indexInventoryChunks ?? chunks;
            this.refreshIndexStatusBar();
        } catch {
            if (this.indexInventoryFiles != null) files = this.indexInventoryFiles;
            if (this.indexInventoryChunks != null) chunks = this.indexInventoryChunks;
        }
        let storageMB: number | null = null, indexMB: number | null = null, modelMB: number | null = null;
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                storageMB = est.usage != null ? est.usage / 1e6 : null;
                // usageDetails is non-standard but present in Electron/Chromium: per-bucket
                // bytes ({ indexedDB, caches, ... }). Split the origin total into the index
                // (IndexedDB) vs the model cache (Cache API) so the card stops implying the
                // whole origin is the index.
                const details = (est as { usageDetails?: Record<string, number> }).usageDetails;
                if (details) {
                    if (typeof details.indexedDB === 'number') indexMB = details.indexedDB / 1e6;
                    if (typeof details.caches === 'number') modelMB = details.caches / 1e6;
                }
            } catch { /* unsupported */ }
        }
        // Last FULL reindex: newest index-complete entry with mode==='full'. Taking the
        // stamp AND the duration from that one entry keeps them coherent — a later
        // incremental catch-up (mode==='incremental') is skipped, so its tiny duration
        // never gets shown as if it were a full rebuild.
        let lastFullAt: string | null = null;
        let lastFullDurationMs: number | null = null;
        try {
            const entries = await this.logger.readAll();
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].type !== 'index-complete') continue;
                const ic = entries[i] as IndexCompleteEntry;
                if (ic.mode !== 'full') continue;
                lastFullAt = ic.timestamp;
                lastFullDurationMs = ic.totalDurationMs;
                break;
            }
        } catch { /* log unreadable */ }
        // Last index of ANY mode (meta is rewritten on every reindex + delta) → "updated".
        // The same meta carries the dense background stats: a calibrated corpus has
        // bgMean/bgStd with σ>0 (mirrors SearchOrchestrator.getDenseBgStats).
        let lastUpdatedAt: string | null = null;
        let calibrated = false;
        try {
            const meta = await this.store.getMeta();
            lastUpdatedAt = meta.lastIndexedAt;
            calibrated = meta.bgMean != null && meta.bgStd != null && meta.bgStd > 0;
        } catch { /* meta unreadable */ }
        return { files, chunks, storageMB, indexMB, modelMB, lastFullAt, lastFullDurationMs, lastUpdatedAt, calibrated };
    }

    // Embedding-model DOWNLOAD status for the settings Model section — distinct from
    // "loaded into memory" (which the search modal signals ambiently, so settings does
    // not repeat it). Tries the parent-side Cache-API probe first; because parent
    // visibility into the iframe's cache is unproven on iPhone (the cacheSeen canary),
    // it falls back to a definitely-loaded embedder, then to the last model-delivery log
    // entry that recorded cacheSeen>0 — either implies the bytes are on disk. Never throws.
    async getModelStatus(): Promise<ModelStatus> {
        const spec = activeModelSpec(this.settings);
        const name = spec.repo.includes('/') ? spec.repo.split('/')[1] : spec.repo;
        let downloaded = false, persisted: boolean | null = null;
        if (typeof caches !== 'undefined') {
            const st = await probeModelDownloaded(caches, spec);
            downloaded = st.downloaded; persisted = st.persisted;
        }
        if (!downloaded) {
            if (this.embedder.loaded) {
                downloaded = true;
            } else {
                try {
                    const entries = await this.logger.readAll();
                    for (let i = entries.length - 1; i >= 0; i--) {
                        if (entries[i].type === 'model-delivery') {
                            if ((entries[i] as ModelDeliveryEntry).cacheSeen > 0) downloaded = true;
                            break;
                        }
                    }
                } catch { /* log unreadable */ }
            }
        }
        return { downloaded, persisted, name, dim: spec.dim };
    }

    // User-invoked "Delete model" (settings). Removes the active model's ~100 MB of
    // Cache-API bytes (the inverse of the switch-time evictStaleModelCaches), drops the
    // in-memory copy, and records a model-delivery entry with cacheSeen:0 so the three
    // sources getModelStatus() reads — Cache probe, loaded embedder, last delivery log —
    // all agree the model is gone. The next search re-downloads it. Best-effort +
    // parent-side: on iPhone, where the parent may not see the iframe's cache (the
    // cacheSeen canary), the bytes can survive until reload, same caveat as eviction.
    async deleteModel(): Promise<{ deleted: number }> {
        const spec = activeModelSpec(this.settings);
        let deleted = 0;
        try {
            if (typeof caches !== 'undefined') {
                deleted = (await deleteModelCaches(caches, spec.repo)).deleted;
            }
        } catch (e) {
            await this.logger.appendError('model-delete', e);
            throw e instanceof Error ? e : new Error(String(e));
        } finally {
            // Drop the runtime copy on ANY delete attempt — even a partial one. The iframe
            // holds the model in memory and getModelStatus() counts a loaded embedder as
            // "downloaded"; keeping it resident over a (possibly half-) deleted on-disk cache
            // would misreport state. teardown() also forces the next search to rebuild the
            // iframe and re-fetch cleanly — the intended consequence of a delete.
            this.embedder.teardown();
        }
        // Keep the log fallback honest: after a delete our cache holds 0 entries, so record
        // that — else the previous load's cacheSeen>0 would still read back as "downloaded".
        await this.logger.append({
            type: 'model-delivery',
            timestamp: new Date().toISOString(),
            key: spec.key,
            repo: spec.repo,
            revision: spec.revision,
            persisted: null,
            cacheSeen: 0,
            cacheEvicted: deleted,
        });
        return { deleted };
    }

    // ---- Global observers ----

    // Catch errors that escape the explicit try/catch sites. Without these,
    // async errors in event handlers / iframe message processing vanish.
    private wireGlobalErrorHandlers(): void {
        this.onError = (e: ErrorEvent) => {
            if (this.unloading) return;
            // Only log if the error originates from our code. The renderer
            // process gets a lot of unrelated cross-plugin noise, and we
            // don't want to claim other plugins' errors as ours.
            const src = (e.filename ?? '') + ' ' + (e.message ?? '');
            if (isIgnorableStartupConsoleError(e.message ?? '')) return;
            if (!/seek|transformers|webgpu/i.test(src)) return;
            this.logger.appendError('window.onerror', e.error ?? new Error(e.message)).catch(() => {});
        };
        this.onUnhandledRejection = (e: PromiseRejectionEvent) => {
            if (this.unloading) return;
            const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
            const stackStr = reason.stack ?? '';
            if (isIgnorableStartupConsoleError(reason.message) || isIgnorableStartupConsoleError(stackStr)) return;
            // Same filter as above. False negatives are fine; false positives
            // (logging other plugins' errors as Seek's) are worse.
            if (!/seek|transformers|webgpu/i.test(stackStr) && !/seek|transformers|webgpu/i.test(reason.message)) return;
            this.logger.appendError('unhandledrejection', reason).catch(() => {});
        };
        window.addEventListener('error', this.onError);
        window.addEventListener('unhandledrejection', this.onUnhandledRejection);
    }

    // PerformanceObserver for longtask entries. On iOS WKWebView this API
    // is supported as of iOS 16 — if absent, we silently skip (no harm).
    // Each longtask >= LONG_TASK_THRESHOLD_MS becomes a log entry tagged
    // with currentTaskContext so the report can group jank by what we
    // were doing at the time.
    private wireLongTaskObserver(): void {
        interface PolyfillObserver {
            new(cb: (list: { getEntries(): PerformanceEntry[] }) => void): PerformanceObserver;
        }
        const Ctor = (window as unknown as { PerformanceObserver?: PolyfillObserver }).PerformanceObserver;
        if (!Ctor) return;
        try {
            this.longTaskObserver = new Ctor(list => {
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
                        context: this.taskCtx.attribute(entry.startTime, entry.duration),
                    };
                    seekPerf.recordLongTask(logEntry);
                    this.logger.append(logEntry).catch(() => {});
                }
            });
            this.longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch (e) {
            // entryType 'longtask' isn't supported everywhere — Safari pre-16.
            // Silently skip; the report will just have an empty long-task section.
            console.warn('[seek] longtask observer unavailable:', e);
        }
    }

    // visibilitychange + pagehide. On iOS, the WebView can be jetsam-killed
    // while backgrounded — recording state at the moment we lose foreground
    // lets us correlate "session ended abruptly" with "heap was at 240 MB".
    private wireMemoryPressureHandlers(): void {
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
            await this.logger.append(entry);
        };
        this.onVisibilityChange = () => {
            if (this.visibilityDoc?.visibilityState === 'hidden') {
                // Forensics beat FIRST and synchronously — the async emit below
                // can be lost to a background kill; the breadcrumb can't.
                this.forensics?.beat('visibility-hidden');
                emit('visibility-hidden').catch(() => {});
                // Backgrounding is the last safe write window on iOS (the WebView
                // can be jetsam-killed). Capture the note being edited and flush
                // now, bypassing the 5-min idle debounce.
                this.flushOnBackground();
            }
            else if (this.visibilityDoc?.visibilityState === 'visible') {
                this.forensics?.beat('visibility-visible');
                emit('visibility-visible').catch(() => {});
                this.runCatchUp();
                this.runDriftRecovery();
            }
        };
        this.onPageHide = () => {
            this.forensics?.beat('pagehide');
            emit('pagehide').catch(() => {});
            this.flushOnBackground();
        };
        // Bind to the active document and remember it, so unload removes against the
        // SAME document (see visibilityDoc field).
        this.visibilityDoc = activeDocument;
        this.visibilityDoc.addEventListener('visibilitychange', this.onVisibilityChange);
        window.addEventListener('pagehide', this.onPageHide);
    }

    // Emits an eviction-suspected event when cold-start exceeded the
    // 5 s mobile budget. Captures the storage state at the same instant
    // so a low storageUsedMB confirms the cache was actually emptied
    // (vs. a thermal-throttle false positive). Best-effort; never throws.
    private async emitEvictionSuspected(load: import('./types').LoadEntry): Promise<void> {
        let storageUsedMB: number | null = null;
        let storageQuotaMB: number | null = null;
        let persisted: boolean | null = null;
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                storageUsedMB = est.usage != null ? est.usage / 1e6 : null;
                storageQuotaMB = est.quota != null ? est.quota / 1e6 : null;
            } catch { /* swallow */ }
        }
        if (navigator.storage?.persisted) {
            try { persisted = await navigator.storage.persisted(); } catch { /* swallow */ }
        }
        const entry: EvictionSuspectedEntry = {
            type: 'eviction-suspected',
            timestamp: new Date().toISOString(),
            coldStartMs: load.coldStartMs,
            actualDevice: load.actualDevice,
            dtype: load.dtype,
            storageUsedMB,
            storageQuotaMB,
            persisted,
        };
        await this.logger.append(entry);
    }

    // One-shot `app://local/...` capability probe. Writes a tiny file to the
    // vault, asks the iframe to fetch it via adapter.getResourcePath(), and
    // logs the result. Gates the Phase 3 model-shard streaming pattern: a
    // green probe means we can stream shards through the iframe via a
    // resource URL; a red probe means Phase 3 has to transfer bytes via
    // postMessage. See seek-dataadapter-rearchitecture-plan §Phase 1.
    private async runAppLocalProbe(): Promise<void> {
        if (this.unloading) return;
        const adapter = this.app.vault.adapter;
        // Site the probe inside the plugin's OWN folder (always present, hidden
        // under the config dir) — NOT a visible vault folder. The earlier
        // 'Documents/seek/' literal did adapter.mkdir() and left a stray, visible
        // Documents/ folder in the vault root on every load; manifest.dir is where
        // the running plugin already lives, so there's no mkdir and nothing
        // user-visible. getResourcePath resolves it identically — the capability
        // under test (iframe fetch of an app://local / capacitor:// resource URL)
        // is unchanged.
        const dir = this.manifest.dir;
        if (!dir) return; // no plugin dir → can't site the probe; skip the diagnostic
        const PROBE_PATH = `${dir}/.seek-applocal-probe`;
        const PROBE_BODY = 'seek-probe-v1';

        let url = '';
        try {
            await adapter.write(PROBE_PATH, PROBE_BODY);
            // Obsidian's adapter exposes getResourcePath on both desktop
            // (returns `app://local/...`) and Capacitor mobile (returns
            // `capacitor://localhost/...`). Either is the platform-correct
            // URL the iframe would need to use in Phase 3.
            const ra = adapter as unknown as { getResourcePath?: (p: string) => string };
            url = ra.getResourcePath ? ra.getResourcePath(PROBE_PATH) : '';
        } catch (e) {
            const entry: AppLocalFetchEntry = {
                type: 'app-local-fetch',
                timestamp: new Date().toISOString(),
                result: 'unknown',
                url,
                httpStatus: null,
                bodyMatched: null,
                error: `probe setup failed: ${e}`,
            };
            await this.logger.append(entry);
            return;
        }

        if (!url) {
            const entry: AppLocalFetchEntry = {
                type: 'app-local-fetch',
                timestamp: new Date().toISOString(),
                result: 'unknown',
                url: '',
                httpStatus: null,
                bodyMatched: null,
                error: 'adapter.getResourcePath unavailable',
            };
            await this.logger.append(entry);
            return;
        }

        const fr = await this.embedder.appLocalFetch(url);
        const bodyMatched = fr.body == null ? null : fr.body === PROBE_BODY;
        const entry: AppLocalFetchEntry = {
            type: 'app-local-fetch',
            timestamp: new Date().toISOString(),
            result: fr.ok && bodyMatched === true ? 'ok' : 'blocked',
            url,
            httpStatus: fr.status,
            bodyMatched,
            error: fr.error,
        };
        await this.logger.append(entry);
    }

    // Lightweight storage snapshot. Used after reindex; could be invoked
    // periodically in v1. Keeps the cost low compared to the full platform probe.
    private async emitStorageSnapshot(context: string): Promise<void> {
        let storageUsedMB: number | null = null;
        let storageQuotaMB: number | null = null;
        if (navigator.storage?.estimate) {
            try {
                const est = await navigator.storage.estimate();
                storageUsedMB = est.usage != null ? est.usage / 1e6 : null;
                storageQuotaMB = est.quota != null ? est.quota / 1e6 : null;
            } catch { /* swallow */ }
        }
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        const heapMB = heap ? heap.usedJSHeapSize / 1e6 : null;
        const entry: StorageSnapshotEntry = {
            type: 'storage-snapshot',
            timestamp: new Date().toISOString(),
            context,
            storageUsedMB,
            storageQuotaMB,
            heapMB,
        };
        await this.logger.append(entry);
    }
}

