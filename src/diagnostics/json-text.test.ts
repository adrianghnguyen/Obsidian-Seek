import { describe, it, expect } from 'vitest';
import { stripUtf8Bom, parseJsonStripBom } from './json-text';

describe('stripUtf8Bom', () => {
    it('removes a leading U+FEFF', () => {
        expect(stripUtf8Bom('\uFEFF{"a":1}')).toBe('{"a":1}');
    });

    it('leaves BOM-free text unchanged', () => {
        expect(stripUtf8Bom('{"a":1}')).toBe('{"a":1}');
    });
});

describe('parseJsonStripBom', () => {
    it('parses plugin data.json that starts with a UTF-8 BOM', () => {
        expect(parseJsonStripBom('\uFEFF{"sidecarEnabled":true}')).toEqual({ sidecarEnabled: true });
    });

    it('parses ordinary JSON', () => {
        expect(parseJsonStripBom('{"ok":true}')).toEqual({ ok: true });
    });
});
