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
