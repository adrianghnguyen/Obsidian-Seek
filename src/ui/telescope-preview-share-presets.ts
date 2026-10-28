// Four user-configurable preview-column-share presets (% of modal). Independent
// of total search modal width.

import { clampTelescopePreviewColumnPct } from './telescope-layout';

export const TELESCOPE_PREVIEW_SHARE_PRESET_COUNT = 4 as const;

/** Settings row + header cycle names (values are user-set). */
export const TELESCOPE_PREVIEW_SHARE_PRESET_LABELS = ['List', 'Balanced', 'Even', 'Reading'] as const;

export type TelescopePreviewSharePresetIndex = 0 | 1 | 2 | 3;

/** Wider spread than 35/45/50/60 so List vs Reading is obvious. */
export const DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT: [number, number, number, number] = [25, 40, 50, 80];

const PRESET_MATCH_TOLERANCE_PCT = 3;

export function normalizeTelescopePreviewSharePresetsPct(
    raw: unknown,
): [number, number, number, number] {
    const fallback = DEFAULT_TELESCOPE_PREVIEW_SHARE_PRESETS_PCT;
    const arr = Array.isArray(raw) ? raw : fallback;
    return [
        clampTelescopePreviewColumnPct(typeof arr[0] === 'number' ? arr[0] : fallback[0]),
        clampTelescopePreviewColumnPct(typeof arr[1] === 'number' ? arr[1] : fallback[1]),
        clampTelescopePreviewColumnPct(typeof arr[2] === 'number' ? arr[2] : fallback[2]),
        clampTelescopePreviewColumnPct(typeof arr[3] === 'number' ? arr[3] : fallback[3]),
    ];
}

export function telescopePreviewSharePresetIndexForPct(
    pct: number,
    presets: readonly [number, number, number, number],
): TelescopePreviewSharePresetIndex | null {
    const clamped = clampTelescopePreviewColumnPct(pct);
    for (let i = 0; i < TELESCOPE_PREVIEW_SHARE_PRESET_COUNT; i++) {
        if (Math.abs(clamped - presets[i]!) <= PRESET_MATCH_TOLERANCE_PCT) {
            return i as TelescopePreviewSharePresetIndex;
        }
    }
    return null;
}

export function nextTelescopePreviewSharePresetIndex(
    current: TelescopePreviewSharePresetIndex | null,
): TelescopePreviewSharePresetIndex {
    if (current == null) return 0;
    return ((current + 1) % TELESCOPE_PREVIEW_SHARE_PRESET_COUNT) as TelescopePreviewSharePresetIndex;
}

export function cycleTelescopePreviewSharePct(
    currentPct: number,
    presetsRaw: unknown,
): { nextPct: number; nextIndex: TelescopePreviewSharePresetIndex } {
    const presets = normalizeTelescopePreviewSharePresetsPct(presetsRaw);
    const idx = telescopePreviewSharePresetIndexForPct(currentPct, presets);
    const nextIndex = nextTelescopePreviewSharePresetIndex(idx);
    return { nextPct: presets[nextIndex], nextIndex };
}

export function telescopePreviewShareCycleLabel(
    pct: number,
    presetsRaw: unknown,
): string {
    const presets = normalizeTelescopePreviewSharePresetsPct(presetsRaw);
    const idx = telescopePreviewSharePresetIndexForPct(pct, presets);
    const share = clampTelescopePreviewColumnPct(pct);
    if (idx == null) return `Custom (${share}%)`;
    return TELESCOPE_PREVIEW_SHARE_PRESET_LABELS[idx]!;
}

export function telescopePreviewSharePresetId(
    pct: number,
    presetsRaw: unknown,
): string {
    const presets = normalizeTelescopePreviewSharePresetsPct(presetsRaw);
    const idx = telescopePreviewSharePresetIndexForPct(pct, presets);
    if (idx == null) return 'custom';
    return TELESCOPE_PREVIEW_SHARE_PRESET_LABELS[idx]!.toLowerCase();
}

/** Writes one List/Balanced/Even/Reading slot. Live share follows only if it was that slot. */
export function applyTelescopePreviewSharePresetSlot(
    slot: TelescopePreviewSharePresetIndex,
    nextPct: number,
    currentPct: number,
    presetsRaw: unknown,
): { presets: [number, number, number, number]; currentPct: number } {
    const presets = normalizeTelescopePreviewSharePresetsPct(presetsRaw);
    const clamped = clampTelescopePreviewColumnPct(nextPct);
    const idx = telescopePreviewSharePresetIndexForPct(currentPct, presets);
    const next: [number, number, number, number] = [presets[0], presets[1], presets[2], presets[3]];
    next[slot] = clamped;
    return {
        presets: next,
        currentPct: idx === slot ? clamped : clampTelescopePreviewColumnPct(currentPct),
    };
}
