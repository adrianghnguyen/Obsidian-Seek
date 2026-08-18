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

export const INDEX_HYDRATING_MSG = 'Restoring the search index from another device…';
export const INDEX_BUILDING_MSG = 'Seek is still indexing your notes…';
export const INDEX_NO_INDEX_LABEL = 'No index';
export const INDEX_NOT_READY_LABEL = 'Index not ready';
export const INDEX_SYNCING_LABEL = 'Syncing…';
export const INDEX_ERROR_LABEL = 'Index error';
export const INDEX_INDEXING_LABEL = 'Indexing…';
export const INDEX_UP_TO_DATE_LABEL = 'Up to date';

export type IndexLoadPhase = 'hydrating' | 'indexing' | 'idle';
export type IndexLoadKind = 'resting' | 'hydrating' | 'indexing' | 'onboarding';
export type IndexFooterKind = 'syncing' | 'error' | 'indexing' | 'not-ready' | 'no-index' | 'up-to-date';
export type IndexFooterTone = 'accent' | 'bad' | 'warn' | 'mid' | 'good';

export interface IndexLoadFlags {
    hydrating: boolean;
    catchUpPending: boolean;
    catchUpRunning: boolean;
    flushing: boolean;
    writing: boolean;
}

export interface IndexLoadInput {
    chunks: number | null;
    phase: IndexLoadPhase;
    catchUpPending?: boolean;
    waitingForSidecar?: boolean;
}

export interface IndexLoadSpec {
    kind: IndexLoadKind;
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
}

export interface IndexFooterInput {
    kind: IndexLoadKind;
    modelReady: boolean;
    phase?: IndexLoadPhase;
    health?: IndexHealth;
    reason?: DegradedReason;
    peerSyncPending?: boolean;
}

export interface IndexFooterStatus {
    kind: IndexFooterKind;
    label: string;
    icon: string;
    tone: IndexFooterTone;
}

// Hydrate holds the write mutex, so `writing` must not win over an explicit hydrating
// flag — otherwise the modal would say "indexing" during an embed-free restore.
export function resolveIndexLoadPhase(flags: IndexLoadFlags): IndexLoadPhase {
    if (flags.hydrating) return 'hydrating';
    if (flags.catchUpPending || flags.catchUpRunning || flags.flushing || flags.writing) return 'indexing';
    return 'idle';
}

export function indexLoadSpec(input: IndexLoadInput): IndexLoadSpec {
    if (input.chunks == null || input.chunks > 0) return { kind: 'resting', showAction: false };
    if (input.phase === 'hydrating' || input.waitingForSidecar) {
        return { kind: 'hydrating', message: INDEX_HYDRATING_MSG, showAction: false };
    }
    if (input.phase === 'indexing' || input.catchUpPending) {
        return { kind: 'indexing', message: INDEX_BUILDING_MSG, showAction: false };
    }
    return { kind: 'onboarding', showAction: true };
}

// Search-modal footer status: always-visible icon + short label. Priority is
// syncing > error > indexing > model-not-ready > no-index > up-to-date, so a
// populated index with a cold model never claims "Up to date".
export function indexFooterStatus(input: IndexFooterInput): IndexFooterStatus {
    const hydrating = input.kind === 'hydrating' || input.phase === 'hydrating';
    if (hydrating || input.peerSyncPending) {
        return { kind: 'syncing', label: INDEX_SYNCING_LABEL, icon: 'refresh-cw', tone: 'accent' };
    }
    if (input.health === 'degraded' || input.reason === 'peer-ahead') {
        return { kind: 'error', label: INDEX_ERROR_LABEL, icon: 'alert-triangle', tone: 'bad' };
    }
    if (input.kind === 'indexing' || input.phase === 'indexing' || input.health === 'recovering') {
        return { kind: 'indexing', label: INDEX_INDEXING_LABEL, icon: 'refresh-cw', tone: 'accent' };
    }
    if (!input.modelReady) {
        return { kind: 'not-ready', label: INDEX_NOT_READY_LABEL, icon: 'alert-triangle', tone: 'warn' };
    }
    if (input.kind === 'onboarding') {
        return { kind: 'no-index', label: INDEX_NO_INDEX_LABEL, icon: 'circle-off', tone: 'mid' };
    }
    return { kind: 'up-to-date', label: INDEX_UP_TO_DATE_LABEL, icon: 'check', tone: 'good' };
}
