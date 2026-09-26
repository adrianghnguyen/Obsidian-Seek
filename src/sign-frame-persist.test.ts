import { describe, it, expect } from 'vitest';
import type { MetaConfig } from './index-store';
import {
    asSignPacked,
    buildSignFrameStamp,
    signFrameCoversChunks,
    signFramePackedShapeOk,
    signFrameStampMatches,
} from './sign-frame-persist';

const meta: MetaConfig = {
    embeddingDim: 384,
    lastIndexedAt: '2026-09-25T00:00:00.000Z',
    schemaVersion: 2,
    modelId: 'granite-r2',
};

describe('sign frame persist stamp', () => {
    const live = buildSignFrameStamp(meta, 100);

    it('accepts the same model and dim', () => {
        expect(signFrameStampMatches(buildSignFrameStamp(meta, 100), live)).toBe(true);
    });

    it('does not gate chunk count (coverage of live ids does that)', () => {
        expect(signFrameStampMatches(buildSignFrameStamp(meta, 50), live)).toBe(true);
    });

    it('rejects a different model or dim', () => {
        expect(signFrameStampMatches(buildSignFrameStamp({ ...meta, modelId: 'other' }, 100), live)).toBe(false);
        expect(signFrameStampMatches(buildSignFrameStamp({ ...meta, embeddingDim: 512 }, 100), live)).toBe(false);
    });

    it('rejects a missing stamp', () => {
        expect(signFrameStampMatches(null, live)).toBe(false);
        expect(signFrameStampMatches({}, live)).toBe(false);
    });
});

describe('sign frame blob shape', () => {
    it('requires packed bytes to be ids × bytesPerVec', () => {
        expect(signFramePackedShapeOk(['a', 'b'], new Uint8Array(96), 48)).toBe(true);
        expect(signFramePackedShapeOk(['a'], new Uint8Array(47), 48)).toBe(false);
        expect(signFramePackedShapeOk([], new Uint8Array(0), 48)).toBe(false);
    });

    it('covers every live chunk id and allows orphan blob ids', () => {
        expect(signFrameCoversChunks(['a', 'b', 'orphan'], [{ chunk_id: 'a' }, { chunk_id: 'b' }])).toBe(true);
        expect(signFrameCoversChunks(['a'], [{ chunk_id: 'a' }, { chunk_id: 'b' }])).toBe(false);
        expect(signFrameCoversChunks(['a'], [])).toBe(false);
    });

    it('accepts a Uint8Array or ArrayBuffer as packed bytes', () => {
        expect(asSignPacked(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
        expect(asSignPacked(new Uint8Array([3]).buffer)).toEqual(new Uint8Array([3]));
        expect(asSignPacked({ 0: 1 })).toBeNull();
    });
});
