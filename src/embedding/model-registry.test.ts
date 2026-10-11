// Unit tests for the production model-delivery registry: active-spec selection
// (debug override vs shipped default) and the parent-side Cache-API eviction that
// reclaims a previous model's ~100 MB on a switch. Pure — no DOM/iframe; the Cache
// API is a structural fake injected as CacheStorage.

import { describe, it, expect } from 'vitest';
import type { SeekSettings } from '../types/types';
import {
    ACTIVE_MODEL_SPEC,
    EMBEDDINGGEMMA_2,
    ML97_GBQ4,
    activeModelSpec,
    formatDocumentText,
    formatQueryText,
    resolveOverrideSpec,
    shouldEvictCacheUrl,
    evictStaleModelCaches,
    isCacheUrlForRepo,
    deleteModelCaches,
    probeModelDownloaded,
} from './model-registry';

const ACTIVE_REPO = ML97_GBQ4.repo;
// Only modelRepoOverride / modelRevisionOverride are read; the rest is irrelevant.
const settings = (o: Partial<SeekSettings> = {}): SeekSettings => o as unknown as SeekSettings;

const hfUrl = (repo: string, file = 'onnx/model_q4.onnx') =>
    `https://huggingface.co/${repo}/resolve/main/${file}`;

describe('activeModelSpec / resolveOverrideSpec', () => {
    it('no override → shipped default spec', () => {
        expect(activeModelSpec(settings())).toBe(ACTIVE_MODEL_SPEC);
        expect(activeModelSpec(settings()).key).toBe(ML97_GBQ4.key);
    });

    it('empty / whitespace override → still the default', () => {
        expect(resolveOverrideSpec(settings({ modelRepoOverride: '' }))).toBeNull();
        expect(resolveOverrideSpec(settings({ modelRepoOverride: '   ' }))).toBeNull();
        expect(activeModelSpec(settings({ modelRepoOverride: '  ' }))).toBe(ACTIVE_MODEL_SPEC);
    });

    it('override repo wins and becomes identity (key === repo), trimmed', () => {
        const s = activeModelSpec(settings({ modelRepoOverride: '  acme/my-embed  ' }));
        expect(s.repo).toBe('acme/my-embed');
        expect(s.key).toBe('acme/my-embed');   // identity = override repo → drifts vs stored index
        expect(s.dim).toBe(ML97_GBQ4.dim);      // inherits the standard layout/dim/dtype
        expect(s.dtype).toBe(ML97_GBQ4.dtype);
    });

    it('revision override threads through (else null)', () => {
        expect(resolveOverrideSpec(settings({ modelRepoOverride: 'a/b' }))!.revision).toBeNull();
        expect(resolveOverrideSpec(settings({ modelRepoOverride: 'a/b', modelRevisionOverride: 'deadbeef' }))!.revision)
            .toBe('deadbeef');
    });

    it('empty or unknown model key stays on Granite', () => {
        expect(activeModelSpec(settings({ embeddingModelKey: '', embeddingOutputDim: 0 }))).toBe(ACTIVE_MODEL_SPEC);
        expect(activeModelSpec(settings({ embeddingModelKey: 'nope' }))).toBe(ACTIVE_MODEL_SPEC);
    });

    it('EmbeddingGemma 2 is selectable and truncates only on a listed width', () => {
        const native = activeModelSpec(settings({ embeddingModelKey: EMBEDDINGGEMMA_2.key, embeddingOutputDim: 0 }));
        expect(native.repo).toBe(EMBEDDINGGEMMA_2.repo);
        expect(native.dim).toBe(768);
        expect(native.pooling).toBe('mean');
        expect(native.textOnly).toBe(true);
        expect(activeModelSpec(settings({ embeddingModelKey: EMBEDDINGGEMMA_2.key, embeddingOutputDim: 256 })).dim).toBe(256);
        expect(activeModelSpec(settings({ embeddingModelKey: EMBEDDINGGEMMA_2.key, embeddingOutputDim: 384 })).dim).toBe(768);
        expect(activeModelSpec(settings({ embeddingModelKey: EMBEDDINGGEMMA_2.key, embeddingOutputDim: 999 })).dim).toBe(768);
    });

    it('a debug override still wins and keeps the Granite layout', () => {
        const s = activeModelSpec(settings({
            modelRepoOverride: 'acme/x',
            embeddingModelKey: EMBEDDINGGEMMA_2.key,
            embeddingOutputDim: 256,
        }));
        expect(s.repo).toBe('acme/x');
        expect(s.dim).toBe(384);
        expect(s.pooling).toBe('cls');
        expect(s.queryPrefix).toBe('');
        expect(s.textOnly).toBe(false);
    });

    it('task prefixes apply once', () => {
        const q = EMBEDDINGGEMMA_2.queryPrefix + 'hello';
        expect(formatQueryText('hello', EMBEDDINGGEMMA_2)).toBe(q);
        expect(formatQueryText(q, EMBEDDINGGEMMA_2)).toBe(q);
        expect(formatDocumentText('note', EMBEDDINGGEMMA_2)).toBe(EMBEDDINGGEMMA_2.documentPrefix + 'note');
        expect(formatQueryText('hello', ML97_GBQ4)).toBe('hello');
        expect(formatDocumentText('note', ML97_GBQ4)).toBe('note');
    });
});

describe('shouldEvictCacheUrl', () => {
    it('keeps the active repo, evicts other HF repos', () => {
        expect(shouldEvictCacheUrl(hfUrl(ACTIVE_REPO), ACTIVE_REPO)).toBe(false);
        expect(shouldEvictCacheUrl(hfUrl(ACTIVE_REPO, 'config.json'), ACTIVE_REPO)).toBe(false);
        expect(shouldEvictCacheUrl(hfUrl('tooape/old-model'), ACTIVE_REPO)).toBe(true);
    });

    it('ignores non-HF / non-resolve URLs (jsdelivr runtime, etc.)', () => {
        expect(shouldEvictCacheUrl('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0', ACTIVE_REPO)).toBe(false);
        expect(shouldEvictCacheUrl('https://example.com/whatever', ACTIVE_REPO)).toBe(false);
    });

    it('matches the repo as a path segment (prefix-repo safety)', () => {
        // keepRepo is a prefix of another repo: the longer repo must still be evicted,
        // and the exact repo must still be kept.
        expect(shouldEvictCacheUrl(hfUrl('tooape/granite-2'), 'tooape/granite')).toBe(true);
        expect(shouldEvictCacheUrl(hfUrl('tooape/granite'), 'tooape/granite')).toBe(false);
    });
});

describe('isCacheUrlForRepo', () => {
    it('matches HF resolve URLs for the repo, ignores others', () => {
        expect(isCacheUrlForRepo(hfUrl(ACTIVE_REPO), ACTIVE_REPO)).toBe(true);
        expect(isCacheUrlForRepo(hfUrl(ACTIVE_REPO, 'config.json'), ACTIVE_REPO)).toBe(true);
        expect(isCacheUrlForRepo(hfUrl('tooape/other'), ACTIVE_REPO)).toBe(false);
        expect(isCacheUrlForRepo('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0', ACTIVE_REPO)).toBe(false);
    });

    it('is the exact inverse of shouldEvictCacheUrl for HF model URLs', () => {
        for (const url of [hfUrl(ACTIVE_REPO), hfUrl('tooape/granite-2'), hfUrl('tooape/granite')]) {
            expect(isCacheUrlForRepo(url, 'tooape/granite')).toBe(!shouldEvictCacheUrl(url, 'tooape/granite'));
        }
    });
});

// Structural CacheStorage fake — one named cache holding {url} request stand-ins.
function fakeCaches(urls: string[], present = true) {
    let reqs = urls.map(url => ({ url }));
    const cache = {
        keys: async () => reqs.slice(),
        delete: async (req: { url: string }) => {
            const before = reqs.length;
            reqs = reqs.filter(r => r.url !== req.url);
            return reqs.length < before;
        },
    };
    return {
        remaining: () => reqs.map(r => r.url),
        cs: {
            has: async () => present,
            open: async () => cache,
        } as unknown as CacheStorage,
    };
}

describe('evictStaleModelCaches', () => {
    it('deletes only stale-repo entries, keeps the active model + runtime', async () => {
        const f = fakeCaches([
            hfUrl(ACTIVE_REPO),
            hfUrl(ACTIVE_REPO, 'config.json'),
            hfUrl('tooape/old-model'),
            hfUrl('tooape/older-still', 'tokenizer.json'),
            'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0',
        ]);
        const res = await evictStaleModelCaches(f.cs, ACTIVE_REPO);
        expect(res.seen).toBe(5);
        expect(res.deleted).toBe(2);                 // two stale repos
        expect(f.remaining()).toContain(hfUrl(ACTIVE_REPO));
        expect(f.remaining()).toContain('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0');
        expect(f.remaining()).not.toContain(hfUrl('tooape/old-model'));
    });

    it('no-ops cleanly when the transformers cache is absent', async () => {
        const f = fakeCaches([], /* present */ false);
        expect(await evictStaleModelCaches(f.cs, ACTIVE_REPO)).toEqual({ seen: 0, deleted: 0 });
    });

    it('first-ever load (only active repo cached) deletes nothing', async () => {
        const f = fakeCaches([hfUrl(ACTIVE_REPO), hfUrl(ACTIVE_REPO, 'config.json')]);
        const res = await evictStaleModelCaches(f.cs, ACTIVE_REPO);
        expect(res).toEqual({ seen: 2, deleted: 0 });
    });
});

describe('deleteModelCaches', () => {
    it('deletes only the active repo, keeps other repos + runtime', async () => {
        const f = fakeCaches([
            hfUrl(ACTIVE_REPO),
            hfUrl(ACTIVE_REPO, 'config.json'),
            hfUrl('tooape/other-model'),
            'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0',
        ]);
        const res = await deleteModelCaches(f.cs, ACTIVE_REPO);
        expect(res.seen).toBe(4);
        expect(res.deleted).toBe(2);                            // both active-repo entries
        expect(f.remaining()).not.toContain(hfUrl(ACTIVE_REPO));
        expect(f.remaining()).toContain(hfUrl('tooape/other-model'));
        expect(f.remaining()).toContain('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0');
    });

    it('no-ops cleanly when the transformers cache is absent', async () => {
        const f = fakeCaches([], /* present */ false);
        expect(await deleteModelCaches(f.cs, ACTIVE_REPO)).toEqual({ seen: 0, deleted: 0 });
    });
});

describe('probeModelDownloaded', () => {
    it('detects the ONNX weight file by repo + path fragment', async () => {
        const f = fakeCaches([
            hfUrl(ACTIVE_REPO, 'config.json'),
            hfUrl(ACTIVE_REPO),
        ]);
        expect(await probeModelDownloaded(f.cs, ML97_GBQ4)).toEqual({ downloaded: true, persisted: null });
    });

    it('accepts URL-encoded weight paths in cache keys', async () => {
        const f = fakeCaches([
            `https://huggingface.co/${ACTIVE_REPO}/resolve/main/onnx%2Fmodel_q4.onnx`,
        ]);
        expect((await probeModelDownloaded(f.cs, ML97_GBQ4)).downloaded).toBe(true);
    });

    it('returns false when only small config files are cached', async () => {
        const f = fakeCaches([
            hfUrl(ACTIVE_REPO, 'config.json'),
            hfUrl(ACTIVE_REPO, 'tokenizer.json'),
        ]);
        expect((await probeModelDownloaded(f.cs, ML97_GBQ4)).downloaded).toBe(false);
    });

    it('no-ops cleanly when the transformers cache is absent', async () => {
        const f = fakeCaches([], false);
        expect(await probeModelDownloaded(f.cs, ML97_GBQ4)).toEqual({ downloaded: false, persisted: null });
    });

    it('treats onnx_data as the EmbeddingGemma weight canary', async () => {
        const repo = EMBEDDINGGEMMA_2.repo;
        const graphOnly = fakeCaches([hfUrl(repo, 'onnx/model_q4.onnx')]);
        expect((await probeModelDownloaded(graphOnly.cs, EMBEDDINGGEMMA_2)).downloaded).toBe(false);
        const weights = fakeCaches([hfUrl(repo, 'onnx/model_q4.onnx_data')]);
        expect((await probeModelDownloaded(weights.cs, EMBEDDINGGEMMA_2)).downloaded).toBe(true);
    });
});
