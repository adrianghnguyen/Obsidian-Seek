/**
 * Workspace-ready gate. Obsidian does not log a stable "workspace loaded"
 * console line. The official signal is `app.workspace.onLayoutReady()`.
 *
 * Do not `await` this inside `Plugin.onload()` — Obsidian waits for every
 * plugin's onload before firing layout ready, so that can deadlock. Schedule
 * IndexedDB probes, startup clocks, and boot checks with the callback form
 * (`onLayoutReady(() => …)` / `scheduleAfterLayoutReady`).
 */

export type LayoutReadyWorkspace = {
    onLayoutReady?: (cb: () => void) => void;
};

export function whenLayoutReady(workspace: LayoutReadyWorkspace): Promise<void> {
    if (typeof workspace.onLayoutReady !== 'function') return Promise.resolve();
    return new Promise(resolve => workspace.onLayoutReady!(() => resolve()));
}

/** Run `work` once the workspace layout is ready. Runs immediately if the API is missing (tests). */
export function scheduleAfterLayoutReady(workspace: LayoutReadyWorkspace, work: () => void): void {
    if (typeof workspace.onLayoutReady === 'function') {
        workspace.onLayoutReady(work);
        return;
    }
    work();
}

/**
 * A cancellable, bypassable delayed callback — the boot buffer between
 * onLayoutReady and Seek's first IndexedDB / hydrate work.
 */
export interface BootBufferHandle {
    /** Cancel the pending delay without running the work. Idempotent; safe after firing. */
    cancel(): void;
    /**
     * Run the work as soon as possible, skipping the remaining delay. If
     * layout is not ready yet, the work runs at layout-ready (no extra
     * delay) — never before it. Idempotent; no-op after cancel or firing.
     */
    bypass(): void;
}

/**
 * Delay `work` by `delayMs` after the workspace layout is ready, so other
 * plugins' startup work (File Recovery, Dataview, sync backfills, …) gets the
 * disk/IDB window first. Layout-ready time is what the delay measures from —
 * NOT onload — so plugin-load ordering never adds to the wait.
 *
 * Cancel on teardown (unload / boot-generation supersede) so a dead
 * generation's buffer never fires mid-recycle. Bypass when the user opens
 * search immediately: the user's own I/O interest beats the politeness buffer.
 * If layout-ready already fired (worktree reload with a live workspace), the
 * delay still applies — it is a deliberate cooldown, not a layout wait.
 */
export function scheduleAfterLayoutReadyBuffered(
    workspace: LayoutReadyWorkspace,
    work: () => void,
    delayMs: number,
): BootBufferHandle {
    let cancelled = false;
    let workDone = false;
    let bypassRequested = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = (): void => {
        if (cancelled || workDone) return;
        workDone = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        work();
    };
    scheduleAfterLayoutReady(workspace, () => {
        if (cancelled) return;
        // bypass() before layout ready: the user's interest still wins, but
        // only now that layout IS ready — never as a pre-layout fire.
        if (bypassRequested) { run(); return; }
        timer = setTimeout(run, delayMs);
    });
    return {
        cancel: () => {
            if (cancelled) return;
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            timer = null;
        },
        bypass: () => {
            if (cancelled || workDone) return;
            if (timer !== null) { run(); return; }
            bypassRequested = true;
        },
    };
}

/** Core Obsidian IndexedDB / cache / sync failures during vault open — not Seek bugs. */
export function isObsidianCoreBootIdbNoise(message: string): boolean {
    const text = stripLeadingBom(message);
    return CORE_BOOT_IDB_NOISE.some(needle => text.includes(needle));
}

/** Another plugin's `data.json` starting with a UTF-8 BOM — not a Seek parse failure. */
export function isPluginDataJsonBomError(message: string): boolean {
    if (!/Unexpected token/i.test(message)) return false;
    return message.includes('\uFEFF') || /data\.json/i.test(message);
}

export function isIgnorableStartupConsoleError(message: string): boolean {
    return isObsidianCoreBootIdbNoise(message) || isPluginDataJsonBomError(message);
}

const CORE_BOOT_IDB_NOISE = [
    'File Recovery failed to connect to IndexedDB',
    'Failed to load cache, unable to open IndexedDB',
    'Failed to load sync data',
    'Internal error opening backing store for indexedDB.open',
] as const;

function stripLeadingBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
