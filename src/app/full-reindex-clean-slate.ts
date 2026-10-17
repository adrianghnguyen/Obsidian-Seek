/**
 * In-plugin clean slate before a user-confirmed full reindex: release GPU/IDB,
 * drop this device's sidecar shards, and attempt deleteDatabase without quitting Obsidian.
 */

import { Notice } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { clearDevice } from '../sidecar/sidecar';
import type { IndexStore } from '../index/index-store';
import type { SeekLogger } from '../diagnostics/logger';

export interface FullReindexCleanSlateDeps {
    store: IndexStore;
    adapter: DataAdapter;
    sidecarIndexDir: string;
    deviceId: string;
    sidecarEnabled: boolean;
    logger: SeekLogger;
    releaseEmbedder: () => void;
    disposeOrchestrator: () => void;
}

export type FullReindexCleanSlateResult = {
    idbNuked: boolean;
    idbFallbackClear: boolean;
    sidecarCleared: boolean;
    error?: string;
};

export async function executeFullReindexCleanSlate(
    deps: FullReindexCleanSlateDeps,
): Promise<FullReindexCleanSlateResult> {
    deps.disposeOrchestrator();
    deps.releaseEmbedder();
    deps.store.close();
    // Let Chromium drop this window's IDB connection before deleteDatabase.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    let sidecarCleared = false;
    if (deps.sidecarEnabled && deps.sidecarIndexDir) {
        await clearDevice(deps.adapter, deps.sidecarIndexDir, deps.deviceId, { preserveSeqFloor: true });
        sidecarCleared = true;
    }

    const reset = await deps.store.forceReset();
    if (reset.error?.includes('another window')) {
        new Notice(
            'Seek: another Obsidian window is holding this vault\'s index open — cleared stores in this window only. Close other windows for a full database drop.',
            12_000,
        );
    }

    await deps.logger.append({
        type: 'reset',
        timestamp: new Date().toISOString(),
        droppedDatabase: deps.store.dbName,
        chunksDeleted: 0,
        vectorsDeleted: 0,
        durationMs: 0,
        pass: reset.nuked,
        checks: [
            reset.nuked ? '✅ deleteDatabase (in-plugin full reindex)' : 'ℹ️ clearAllStores fallback (in-plugin full reindex)',
            sidecarCleared ? '✅ sidecar device shards cleared' : 'ℹ️ sidecar clear skipped',
            reset.error ? `⚠️ ${reset.error}` : '✅ no IDB block',
        ],
    }).catch(() => {});

    return {
        idbNuked: reset.nuked,
        idbFallbackClear: !reset.nuked && deps.store.isOpen(),
        sidecarCleared,
        error: reset.error,
    };
}
