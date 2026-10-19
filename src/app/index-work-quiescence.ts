/**
 * Wait for in-flight catch-up before tearing down the embedder / IDB hold.
 * Recovery and force-reset must not release the GPU while a drain burst still runs.
 */

export async function awaitCatchUpQuiescence(
    isRunning: () => boolean,
    opts?: { timeoutMs?: number; pollMs?: number },
): Promise<boolean> {
    if (!isRunning()) return true;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const pollMs = opts?.pollMs ?? 25;
    const deadline = Date.now() + timeoutMs;
    while (isRunning()) {
        if (Date.now() >= deadline) return false;
        await new Promise<void>(resolve => setTimeout(resolve, pollMs));
    }
    return true;
}
