/**
 * Load-generation gate for async boot work across plugin:reload.
 * onload/onunload bump the generation; IIFEs capture a token at start and bail
 * when it no longer matches or unloading is set.
 */
export function isLoadGenerationCurrent(
    capturedGen: number,
    currentGen: number,
    unloading: boolean,
): boolean {
    return isSessionWorkCurrent(unloading, currentGen, capturedGen);
}

/** True when fire-and-forget async should continue (not unloading; gen matches if given). */
export function isSessionWorkCurrent(
    unloading: boolean,
    currentGen: number,
    capturedGen?: number,
): boolean {
    if (unloading) return false;
    if (capturedGen !== undefined && capturedGen !== currentGen) return false;
    return true;
}

/** Skip appendError from torn-down reload sessions (stale gen or unloading). */
export function shouldLogSessionError(
    unloading: boolean,
    currentGen: number,
    capturedGen?: number,
): boolean {
    return isSessionWorkCurrent(unloading, currentGen, capturedGen);
}
