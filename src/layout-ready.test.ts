import { describe, it, expect } from 'vitest';
import {
    whenLayoutReady,
    scheduleAfterLayoutReady,
    isObsidianCoreBootIdbNoise,
    isPluginDataJsonBomError,
    isIgnorableStartupConsoleError,
} from './layout-ready';

describe('whenLayoutReady', () => {
    it('resolves immediately when onLayoutReady is missing (tests / stubs)', async () => {
        await expect(whenLayoutReady({})).resolves.toBeUndefined();
    });

    it('does not resolve until onLayoutReady fires', async () => {
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        let done = false;
        const pending = whenLayoutReady(workspace).then(() => { done = true; });
        expect(done).toBe(false);
        expect(queued).toHaveLength(1);
        queued[0]();
        await pending;
        expect(done).toBe(true);
    });
});

describe('scheduleAfterLayoutReady', () => {
    it('defers work until the workspace callback', () => {
        const queued: Array<() => void> = [];
        const workspace = { onLayoutReady: (cb: () => void) => { queued.push(cb); } };
        const order: string[] = [];
        scheduleAfterLayoutReady(workspace, () => order.push('boot'));
        order.push('onload');
        expect(order).toEqual(['onload']);
        queued[0]();
        expect(order).toEqual(['onload', 'boot']);
    });

    it('runs immediately when onLayoutReady is missing', () => {
        const order: string[] = [];
        scheduleAfterLayoutReady({}, () => order.push('boot'));
        expect(order).toEqual(['boot']);
    });
});

describe('core boot IndexedDB noise', () => {
    it('recognizes Obsidian File Recovery / cache / sync / backing-store errors', () => {
        expect(isObsidianCoreBootIdbNoise('File Recovery failed to connect to IndexedDB')).toBe(true);
        expect(isObsidianCoreBootIdbNoise('Failed to load cache, unable to open IndexedDB')).toBe(true);
        expect(isObsidianCoreBootIdbNoise('Failed to load sync data')).toBe(true);
        expect(isObsidianCoreBootIdbNoise(
            'UnknownError: Internal error opening backing store for indexedDB.open',
        )).toBe(true);
    });

    it('does not treat Seek-owned failures as core boot noise', () => {
        expect(isObsidianCoreBootIdbNoise('[seek] index store open deferred')).toBe(false);
        expect(isObsidianCoreBootIdbNoise('QuotaExceededError')).toBe(false);
    });
});

describe('plugin data.json BOM parse errors', () => {
    it('recognizes Unexpected token with a BOM or data.json path', () => {
        expect(isPluginDataJsonBomError("Unexpected token '\uFEFF'")).toBe(true);
        expect(isPluginDataJsonBomError(
            "Failed to parse .obsidian/plugins/agent-client/data.json: Unexpected token",
        )).toBe(true);
    });

    it('is ignorable for startup console gates along with core IDB noise', () => {
        expect(isIgnorableStartupConsoleError('Failed to load cache, unable to open IndexedDB')).toBe(true);
        expect(isIgnorableStartupConsoleError("Unexpected token '\uFEFF'")).toBe(true);
        expect(isIgnorableStartupConsoleError('[seek] sidecar hydrate failed')).toBe(false);
    });
});
