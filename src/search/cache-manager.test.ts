import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Scenario } from '../test-harness/scenario';

describe('CacheManager warmDeferred', () => {
    let active: Scenario | null = null;
    afterEach(async () => {
        await active?.teardown();
        active = null;
    });

    it('defers delta warm while catch-up owns IDB, then warms when cleared', async () => {
        const s = new Scenario();
        active = s;
        await s.boot();
        s.vault.write('a.md', 'Alpha note content for warm deferral test.', 1000);
        await s.coldStart();
        await s.orch.warmCaches('scenario-settle');

        const orch = s.orch as unknown as { cacheManager: { runWarmCaches: (t: string) => Promise<void> } };
        const runWarmSpy = vi.spyOn(orch.cacheManager, 'runWarmCaches');

        s.orch.setWarmDeferred(true);
        await s.orch.warmCaches('delta');
        expect(runWarmSpy).not.toHaveBeenCalled();

        s.orch.setWarmDeferred(false);
        await s.orch.warmCaches('post-catchup');
        expect(runWarmSpy).toHaveBeenCalledWith('post-catchup');
    });
});
