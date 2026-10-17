// Where the shared (sidecar) index folder lives, and the idempotent move into it.
// Pure over a narrow adapter so the toggle-on migrate and the on-load migrate are
// unit-testable without booting the plugin.

export interface SidecarMoveAdapter {
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
}

export interface SidecarMoveOptions {
    // Skip the move unless `to` has no files yet (on-load path: never second-guess a
    // destination this device or a peer already populated).
    onlyIfDestEmpty?: boolean;
    onError?: (e: unknown) => void;
}

/**
 * Move every file directly under `from` into `to`. Idempotent and non-fatal:
 * empty/missing source is a no-op, an existing destination file is never clobbered
 * (a prior partial migration leaves the rest to finish on the next call), and a
 * failed rename leaves the source for a later pass. Returns the number moved.
 */
export async function moveSidecarFiles(
    adapter: SidecarMoveAdapter,
    from: string,
    to: string,
    opts: SidecarMoveOptions = {},
): Promise<number> {
    if (from === to) return 0;
    const ls = await adapter.list(from).catch(() => null);
    if (!ls || ls.files.length === 0) return 0;
    if (opts.onlyIfDestEmpty) {
        const dest = await adapter.list(to).catch(() => null);
        if (dest && dest.files.length > 0) return 0;
    }
    if (!(await adapter.exists(to).catch(() => false))) await adapter.mkdir(to).catch(() => {});
    let moved = 0;
    for (const path of ls.files) {
        const dest = `${to}/${path.slice(path.lastIndexOf('/') + 1)}`;
        if (await adapter.exists(dest).catch(() => false)) continue;
        try {
            await adapter.rename(path, dest);
            moved++;
        } catch (e) {
            opts.onError?.(e);
        }
    }
    return moved;
}
