import { describe, it, expect, vi } from 'vitest';
import type { App } from 'obsidian';
import { CacheManager } from './cache-manager';
import { IndexCoordinator } from './index-coordinator';
import type { IndexStore } from './index-store';
import type { LocalEmbedder } from './embedder';
import type { SeekLogger } from './logger';
import { DEFAULT_SETTINGS } from './types';

function cacheManager(): CacheManager {
    const settings = structuredClone(DEFAULT_SETTINGS);
    return new CacheManager({
        app: {} as App,
        store: {} as IndexStore,
        coord: new IndexCoordinator(null, settings),
        embedder: { loaded: true } as LocalEmbedder,
        settings,
        logger: {} as SeekLogger,
    });
}

describe('runWarmCaches light frames', () => {
    it('passes skipResidentInt8 into ensureFrame for a hydrate trigger', async () => {
        const cm = cacheManager();
        const ensureFrame = vi.spyOn(cm, 'ensureFrame').mockResolvedValue(null);

        await cm.warmCaches('hydrate');

        expect(ensureFrame).toHaveBeenCalledWith({ skipResidentInt8: true, skipWarmJoin: true });
    });

    it('passes skipResidentInt8 into ensureFrame for a model-load trigger', async () => {
        const cm = cacheManager();
        const ensureFrame = vi.spyOn(cm, 'ensureFrame').mockResolvedValue(null);

        await cm.warmCaches('model-load');

        expect(ensureFrame).toHaveBeenCalledWith({ skipResidentInt8: true, skipWarmJoin: true });
    });

    it('keeps a non-startup trigger on the full frame path', async () => {
        const cm = cacheManager();
        const ensureFrame = vi.spyOn(cm, 'ensureFrame').mockResolvedValue(null);

        await cm.warmCaches('delta');

        expect(ensureFrame).toHaveBeenCalledWith({ skipWarmJoin: true });
    });
});
