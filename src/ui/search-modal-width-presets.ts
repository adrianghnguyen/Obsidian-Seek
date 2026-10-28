// Three user-configurable total-modal-width presets. Independent of telescope
// preview column share (that is a % of the modal, not the modal's outer width).

import { clampSearchModalWidthPx } from './telescope-layout';

export const SEARCH_MODAL_WIDTH_PRESET_COUNT = 3 as const;

/** Slot names for Settings and the footer cycle button (values are user-set). */
export const SEARCH_MODAL_WIDTH_PRESET_LABELS = ['Compact', 'Default', 'Wide'] as const;

export type SearchModalWidthPresetIndex = 0 | 1 | 2;

export const DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX: [number, number, number] = [640, 800, 960];

const PRESET_MATCH_TOLERANCE_PX = 12;

export function normalizeSearchModalWidthPresetsPx(
    raw: unknown,
): [number, number, number] {
    const fallback = DEFAULT_SEARCH_MODAL_WIDTH_PRESETS_PX;
    const arr = Array.isArray(raw) ? raw : fallback;
    const out: [number, number, number] = [
        clampSearchModalWidthPx(typeof arr[0] === 'number' ? arr[0] : fallback[0]),
        clampSearchModalWidthPx(typeof arr[1] === 'number' ? arr[1] : fallback[1]),
        clampSearchModalWidthPx(typeof arr[2] === 'number' ? arr[2] : fallback[2]),
    ];
    return out;
}

export function searchModalWidthPresetIndexForPx(
    widthPx: number,
    presets: readonly [number, number, number],
): SearchModalWidthPresetIndex | null {
    const clamped = clampSearchModalWidthPx(widthPx);
    for (let i = 0; i < SEARCH_MODAL_WIDTH_PRESET_COUNT; i++) {
        if (Math.abs(clamped - presets[i]!) <= PRESET_MATCH_TOLERANCE_PX) {
            return i as SearchModalWidthPresetIndex;
        }
    }
    return null;
}

export function nextSearchModalWidthPresetIndex(
    current: SearchModalWidthPresetIndex | null,
): SearchModalWidthPresetIndex {
    if (current == null) return 0;
    return ((current + 1) % SEARCH_MODAL_WIDTH_PRESET_COUNT) as SearchModalWidthPresetIndex;
}

export function cycleSearchModalWidthPx(
    currentWidthPx: number,
    presetsRaw: unknown,
): { nextPx: number; nextIndex: SearchModalWidthPresetIndex } {
    const presets = normalizeSearchModalWidthPresetsPx(presetsRaw);
    const idx = searchModalWidthPresetIndexForPx(currentWidthPx, presets);
    const nextIndex = nextSearchModalWidthPresetIndex(idx);
    return { nextPx: presets[nextIndex], nextIndex };
}

export function searchModalWidthPresetCycleLabel(
    widthPx: number,
    presetsRaw: unknown,
): string {
    const presets = normalizeSearchModalWidthPresetsPx(presetsRaw);
    const idx = searchModalWidthPresetIndexForPx(widthPx, presets);
    const px = clampSearchModalWidthPx(widthPx);
    if (idx == null) return `Width · Custom (${px})`;
    return `Width · ${SEARCH_MODAL_WIDTH_PRESET_LABELS[idx]} (${px})`;
}
