// The VISIBLE half of the version-identity gate (identity.ts is the invisible half:
// pure "is this index stale?" predicates). This is the pure copy + policy for the
// version-stale warning shown when the local index was built under an older Seek
// version than the running build — used by BOTH the toast (main.ts) and the
// search-modal banner (search-modal.ts), so the copy lives here once and can't drift.
//
// A 'version' mismatch surfaces as ONE of two banners, split by whether a peer's current
// index is actually on its way (the `peerSyncPending` signal) — the two questions a user
// actually asks ("can I search now?" / "do I need to do anything?"):
//   • peer syncing → SYNCING. Another device already holds a current index that hasn't
//                    finished syncing down; this device heals from it embed-free on the
//                    next poll. Calm, no action — an info banner with no button.
//   • no peer      → STALE, action needed. No peer index is coming (e.g. a single-device
//                    or mobile-only vault), so only an explicit reindex recovers it. A
//                    warning banner whose button opens Settings.
// NOTE the split is the peer signal, NOT indexHealth: the local drift-recovery ladder also
// sets indexHealth='recovering', and that case must stay silent (no false "syncing" claim).
//
// A 'peer-ahead' reason is the MIRROR of 'version': here the local index matches the local
// build, but another device's sidecar is at a NEWER chunkerVersion this build can't read.
// The honest fix is "update Seek on this device", not "reindex" — so it's its own warning
// banner (no reindex button; updating the plugin is what heals it). Always 'degraded'.
//
// The other states stay silent:
//   • 'drift'  — drift-recovery exhausted; a different failure with its own settings
//                affordance. "Index change detected … reindex" would mislead.
//   • null     — e.g. the 'drained' heal (unstamped-but-current index, edits deferred):
//                not a real format change, so no banner.
//
// Platform-independent on purpose: the message + tone vary by index STATE, not by device,
// so the modal renders the same thing everywhere (the reindex itself lives behind the
// Settings affordance, which owns any platform-specific guardrails).

export type DegradedReason = 'version' | 'drift' | 'peer-ahead' | null;
export type IndexHealth = 'healthy' | 'recovering' | 'degraded';

export interface IndexBannerSpec {
    message: string;
    // 'info' = reassuring (syncing, no action); 'warn' = action needed (stale). Drives the
    // banner's color and whether the modal shows the "Open settings" button (info hides it).
    tone: 'info' | 'warn';
    showAction: boolean;
}

// One source of truth for the copy (toast + banner). Kept exported so the test asserts
// against the same string the UI shows.
export const INDEX_STALE_MSG = 'Index change detected. Search results may be inaccurate. Please reindex.';
export const INDEX_SYNCING_MSG = 'A newer index is syncing from another device. Results may be inaccurate.';
export const INDEX_PEER_AHEAD_MSG = 'Another device has a newer index. Update Seek on this device to use it.';
// Shown (rate-limited) when index commits fail with QuotaExceededError — device
// storage is full. The un-committed files stay dirty by the drain's own criterion,
// so once space frees up the normal catch-up path heals them without a manual
// reindex; the copy promises exactly that and nothing more.
export const INDEX_QUOTA_MSG = 'Seek: device storage is full — some notes could not be indexed. Free up space and Seek will catch up automatically.';

// `peerSyncPending` = a peer device's CURRENT-version sidecar is present but hasn't
// finished syncing down (set only at the version-stale branch, from peerSidecarPresent()).
// It is the discriminator for the calm "syncing" banner — NOT health==='recovering'.
// Why a dedicated signal and not the health value: the LOCAL drift-recovery ladder also
// sets indexHealth='recovering' (over a possibly version-stale index), so keying "a peer
// is syncing" off 'recovering' falsely shows "syncing from another device" on a
// single-device vault mid drift-recovery. The peer fact must be carried explicitly.
export function indexBannerSpec(health: IndexHealth, reason: DegradedReason, peerSyncPending = false): IndexBannerSpec | null {
    // Local build is behind a peer's index version: the fix is to update the plugin (not
    // reindex), so warn with no action button. Independent of health (always 'degraded').
    if (reason === 'peer-ahead') return { message: INDEX_PEER_AHEAD_MSG, tone: 'warn', showAction: false };
    if (reason !== 'version') return null;
    // A peer's current index is on its way (heals embed-free on the next poll): say so,
    // calmly, and offer no button — there is nothing for the user to do. Gated on the
    // explicit peer signal so local drift recovery (recovering, no peer) stays silent.
    if (peerSyncPending) return { message: INDEX_SYNCING_MSG, tone: 'info', showAction: false };
    // Genuinely stale with no incoming heal: warn and hand them the reindex affordance.
    if (health === 'degraded') return { message: INDEX_STALE_MSG, tone: 'warn', showAction: true };
    // recovering + version with no peer = the local drift-recovery ladder running over a
    // version-stale index: silent (the degraded stale banner re-asserts on the next poll).
    return null;
}

export const INDEX_STARTING_TITLE = 'Starting up';
export const INDEX_STARTING_MSG = 'Seek is loading the search index. This is not an empty vault — search will be available in a moment.';
export const INDEX_RESTORING_TITLE = 'Restoring';
export const INDEX_RESTORING_MSG = 'Seek is restoring the search index from another device…';
export const INDEX_BUILDING_TITLE = 'Indexing';
export const INDEX_BUILDING_MSG = 'Seek is still indexing your notes…';
export const INDEX_NO_INDEX_TITLE = 'No index yet';
export const INDEX_NO_INDEX_MSG = 'This vault has not been indexed. Nothing is loading in the background — build an index in Seek settings to search.';
export const INDEX_NO_INDEX_LABEL = 'None';
export const INDEX_STARTING_LABEL = 'Starting';
export const INDEX_RESTORING_LABEL = 'Restoring';
export const INDEX_MODEL_LOADING_LABEL = 'Loading';
export const INDEX_ERROR_LABEL = 'Error';
export const INDEX_INDEXING_LABEL = 'Indexing';
export const INDEX_UP_TO_DATE_LABEL = 'Ready';

export type IndexLoadPhase = 'hydrating' | 'indexing' | 'idle';
export type IndexLoadKind = 'resting' | 'starting' | 'restoring' | 'indexing' | 'onboarding';
export type IndexFooterKind = 'restoring' | 'starting' | 'error' | 'indexing' | 'model-loading' | 'no-index' | 'up-to-date';
export type IndexFooterTone = 'info' | 'accent' | 'bad' | 'warn' | 'mid' | 'good';
/** Shared by status bar, settings card, modal, and CLI — one precedence tree. */
export type IndexUiStatus = 'none' | 'starting' | 'restoring' | 'ok' | 'indexing' | 'error';

export interface IndexLoadFlags {
    hydrating: boolean;
    catchUpPending: boolean;
    catchUpRunning: boolean;
    flushing: boolean;
    writing: boolean;
    /** Full or incremental reindex task (settings reindex, bulk flush). */
    indexing?: boolean;
}

export interface IndexLoadInput {
    chunks: number | null;
    phase: IndexLoadPhase;
    catchUpPending?: boolean;
    waitingForSidecar?: boolean;
}

export interface IndexLoadSpec {
    kind: IndexLoadKind;
    title?: string;
    message?: string;
    showAction: boolean;
}

// Snapshot the search-modal footer reads on each poll. Health/reason/peer are
// the same signals the version-stale banner uses; phase/waitingForSidecar are
// the hydrate/index wait path. `indexLoadSpec.kind` stays 'resting' once any
// chunks exist, so the footer also looks at phase (a populated index can still
// be hydrating or indexing).
export interface IndexLoadState {
    phase: IndexLoadPhase;
    catchUpPending?: boolean;
    waitingForSidecar?: boolean;
    health?: IndexHealth;
    reason?: DegradedReason;
    peerSyncPending?: boolean;
    /** Coordinator pass currently driving the status-bar badge, or null. */
    job?: { done: number; total: number; paused?: boolean } | null;
    /** Canonical UI status — every surface must show this, not a local remapping. */
    uiHealth?: IndexUiStatus;
}

export interface IndexFooterInput {
    kind: IndexLoadKind;
    modelReady: boolean;
    phase?: IndexLoadPhase;
    health?: IndexHealth;
    reason?: DegradedReason;
    peerSyncPending?: boolean;
    waitingForSidecar?: boolean;
    job?: { done: number; total: number; paused?: boolean } | null;
    uiHealth?: IndexUiStatus;
}

export interface IndexFooterStatus {
    kind: IndexFooterKind;
    label: string;
    icon: string;
    tone: IndexFooterTone;
    /** When set, footer paints the status-bar numbered badge instead of a lucide icon. */
    badgeCount?: number | null;
}

// Hydrate holds the write mutex, so `writing` must not win over an explicit hydrating
// flag — otherwise the modal would say "indexing" during an embed-free restore.
// warmCaches is a frame/BM25 rebuild, not note indexing — it must not flip this to
// 'indexing'.
export function resolveIndexLoadPhase(flags: IndexLoadFlags): IndexLoadPhase {
    if (flags.hydrating) return 'hydrating';
    // catchUpPending is queued work, not embeds. Painting it as indexing makes every
    // reload+Search look like "building index" while the modal pauses the drain.
    if (flags.indexing || flags.catchUpRunning || flags.flushing || flags.writing) {
        return 'indexing';
    }
    return 'idle';
}

export interface IndexUiStatusInput {
    /** Plugin construct → onload sidecar/reconcile IIFE (and optional startup cache warm). */
    booting: boolean;
    /** Actual sidecar hydrate in flight (startup, periodic, identity, drift). */
    hydrating: boolean;
    /** Greedy hydrate: tier 0 done — search gate released, background tiers continue. */
    goodEnough?: boolean;
    waitingForSidecar: boolean;
    peerSyncPending: boolean;
    health: IndexHealth;
    reason: DegradedReason;
    /** Real note-embed activity: catch-up, flush, full reindex — not cache warm. */
    indexing: boolean;
    /** Queued catch-up. Not indexing until embeds run. Empty+pending → starting, not none. */
    catchUpPending?: boolean;
    job?: { done: number; total: number } | null;
    searchableChunks: number | null;
    inventoryFiles: number | null;
}

/**
 * Canonical UI status. Precedence:
 * active restore > startup > integrity error > real indexing > empty > ready.
 * Cache warming is invisible here (search stays usable on a populated index).
 */
export function resolveIndexUiStatus(input: IndexUiStatusInput): IndexUiStatus {
    if (input.waitingForSidecar || input.peerSyncPending) {
        return 'restoring';
    }
    if (input.goodEnough && input.hydrating && !input.booting) {
        return 'indexing';
    }
    if (input.hydrating && !input.booting) return 'restoring';
    if (input.booting || input.hydrating) return 'starting';
    if (input.health === 'degraded' || input.reason === 'peer-ahead') return 'error';
    if (input.indexing || (input.job != null && input.job.total > 0)) return 'indexing';
    const chunks = input.searchableChunks;
    const files = input.inventoryFiles ?? 0;
    if (chunks === 0 && files === 0) {
        // Queued first build — not "no index", not "still indexing your notes".
        if (input.catchUpPending) return 'starting';
        return 'none';
    }
    return 'ok';
}

/** Warm no-op hydrate (accepted producer, nothing new) must clear Restoring. */
export function resolveSidecarWait(
    result: { hydrated: number; skippedPartialNotes: number },
    inventoryChunks: number | null,
): boolean {
    if (result.hydrated > 0) return false;
    return result.skippedPartialNotes > 0 && (inventoryChunks ?? 0) === 0;
}

/** CLI / headless search gate — null when the index checklist is satisfied. */
export type CliSearchGateHealth = 'ok' | 'starting' | 'restoring' | 'indexing' | 'error' | 'none';

export interface CliSearchGateInput {
    warmPhase: 'starting' | 'restoring' | null;
    uiHealth: CliSearchGateHealth;
    chunks: number | null;
}

export const CLI_SEARCH_GATE_STARTING = 'Seek not ready — search index still loading';
export const CLI_SEARCH_GATE_RESTORING = 'Seek not ready — restoring search index from another device';
export const CLI_SEARCH_GATE_INDEXING = 'Seek not ready — index still building';
export const CLI_SEARCH_GATE_NO_INDEX = 'Seek not ready — no indexed notes yet';

export function resolveCliSearchGate(input: CliSearchGateInput): string | null {
    // Starting/restoring block even on a populated store — search during boot
    // races sidecar hydrate / applyDelta and can empty the in-memory frame.
    if (input.warmPhase === 'starting' || input.uiHealth === 'starting') return CLI_SEARCH_GATE_STARTING;
    if (input.warmPhase === 'restoring' || input.uiHealth === 'restoring') return CLI_SEARCH_GATE_RESTORING;
    const populated = input.chunks != null && input.chunks > 0;
    if (populated) return null;
    if (input.uiHealth === 'indexing') return CLI_SEARCH_GATE_INDEXING;
    if (input.chunks == null) return CLI_SEARCH_GATE_STARTING;
    return CLI_SEARCH_GATE_NO_INDEX;
}

/** Drop a 0/0 snapshot that would clobber a known-positive inventory (transient IDB reads). */
export function retainIndexInventory(
    prev: { files: number | null; chunks: number | null },
    next: { files: number; chunks: number },
    force = false,
): { files: number; chunks: number } {
    if (!force && next.files === 0 && next.chunks === 0 && ((prev.chunks ?? 0) > 0 || (prev.files ?? 0) > 0)) {
        return { files: prev.files ?? 0, chunks: prev.chunks ?? 0 };
    }
    return next;
}

export function indexLoadSpec(input: IndexLoadInput): IndexLoadSpec {
    // A populated index keeps the resting body (recents) even mid-restore/rebuild.
    // The footer still names the live phase.
    if (input.chunks != null && input.chunks > 0) return { kind: 'resting', showAction: false };
    // Empty or not-yet-probed: name the real wait phase. Never claim "no index"
    // while Seek is still starting, restoring, or indexing.
    if (input.waitingForSidecar) {
        return { kind: 'restoring', title: INDEX_RESTORING_TITLE, message: INDEX_RESTORING_MSG, showAction: false };
    }
    if (input.phase === 'hydrating') {
        return { kind: 'starting', title: INDEX_STARTING_TITLE, message: INDEX_STARTING_MSG, showAction: false };
    }
    // Unknown probe: never claim "still indexing" just because catch-up is queued.
    if (input.chunks == null) {
        if (input.catchUpPending || input.phase === 'indexing') {
            return { kind: 'starting', title: INDEX_STARTING_TITLE, message: INDEX_STARTING_MSG, showAction: false };
        }
        return { kind: 'resting', showAction: false };
    }
    if (input.phase === 'indexing') {
        return { kind: 'indexing', title: INDEX_BUILDING_TITLE, message: INDEX_BUILDING_MSG, showAction: false };
    }
    if (input.catchUpPending) {
        return { kind: 'starting', title: INDEX_STARTING_TITLE, message: INDEX_STARTING_MSG, showAction: false };
    }
    return { kind: 'onboarding', title: INDEX_NO_INDEX_TITLE, message: INDEX_NO_INDEX_MSG, showAction: true };
}

export function isIndexWaitKind(kind: IndexLoadKind): boolean {
    return kind === 'starting' || kind === 'restoring' || kind === 'indexing';
}

// Search-modal footer: always-visible icon + one-word label. UI path is
// Starting / Restoring / Indexing (plus Loading, None, Error, Ready).
// Peer-sync and sidecar wait both read as Restoring.
export function indexFooterStatus(input: IndexFooterInput): IndexFooterStatus {
    if (input.uiHealth === 'restoring' || input.kind === 'restoring' || input.waitingForSidecar || input.peerSyncPending) {
        return { kind: 'restoring', label: INDEX_RESTORING_LABEL, icon: 'refresh-cw', tone: 'info' };
    }
    if (input.uiHealth === 'starting' || input.kind === 'starting' || input.phase === 'hydrating') {
        return { kind: 'starting', label: INDEX_STARTING_LABEL, icon: 'refresh-cw', tone: 'info' };
    }
    if (input.uiHealth === 'error' || input.health === 'degraded' || input.reason === 'peer-ahead') {
        return { kind: 'error', label: INDEX_ERROR_LABEL, icon: 'alert-triangle', tone: 'bad' };
    }
    if (input.health === 'recovering') {
        return { kind: 'starting', label: INDEX_STARTING_LABEL, icon: 'refresh-cw', tone: 'info' };
    }
    if (input.uiHealth === 'indexing' || input.kind === 'indexing' || input.phase === 'indexing'
        || (input.job != null && input.job.total > 0)) {
        const remaining = input.job && input.job.total > 0
            ? Math.max(0, input.job.total - input.job.done)
            : null;
        return {
            kind: 'indexing',
            label: INDEX_INDEXING_LABEL,
            icon: '',
            tone: 'accent',
            badgeCount: remaining,
        };
    }
    if (!input.modelReady) {
        return { kind: 'model-loading', label: INDEX_MODEL_LOADING_LABEL, icon: 'refresh-cw', tone: 'warn' };
    }
    if (input.kind === 'onboarding') {
        return { kind: 'no-index', label: INDEX_NO_INDEX_LABEL, icon: 'circle-off', tone: 'mid' };
    }
    return { kind: 'up-to-date', label: INDEX_UP_TO_DATE_LABEL, icon: 'check', tone: 'good' };
}
