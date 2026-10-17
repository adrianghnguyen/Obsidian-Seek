import { describe, expect, it, vi } from 'vitest';
import { executeFullReindexCleanSlate } from './full-reindex-clean-slate';

describe('executeFullReindexCleanSlate', () => {
    it('disposes orchestrator, releases embedder, closes store, and forceReset', async () => {
        const releaseEmbedder = vi.fn();
        const disposeOrchestrator = vi.fn();
        const close = vi.fn();
        const forceReset = vi.fn(async () => ({ nuked: true }));
        const store = {
            close,
            forceReset,
            isOpen: () => true,
        };
        const logger = { append: vi.fn(async () => {}) };

        const result = await executeFullReindexCleanSlate({
            store: store as never,
            adapter: {} as never,
            sidecarIndexDir: 'index',
            deviceId: 'dev-1',
            sidecarEnabled: false,
            logger: logger as never,
            releaseEmbedder,
            disposeOrchestrator,
        });

        expect(disposeOrchestrator).toHaveBeenCalled();
        expect(releaseEmbedder).toHaveBeenCalled();
        expect(close).toHaveBeenCalled();
        expect(forceReset).toHaveBeenCalled();
        expect(result.idbNuked).toBe(true);
        expect(result.sidecarCleared).toBe(false);
    });
});
