/** Strip a leading UTF-8 BOM (U+FEFF). Windows editors and some sync copies prefix it. */
export function stripUtf8Bom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** JSON.parse that survives a leading BOM (`Unexpected token '﻿'`). */
export function parseJsonStripBom(text: string): unknown {
    return JSON.parse(stripUtf8Bom(text));
}
