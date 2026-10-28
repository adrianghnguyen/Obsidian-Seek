// Session layout presets for the search modal when the telescope preview column is on.

import type { SearchModalHeight, SearchModalWidth, TelescopePreviewLayout } from '../types/types';
import { applySearchModalSize } from './search-modal-size';

/** One modal width + results/preview share while telescope preview is visible. */
export interface TelescopeLayoutPreset {
    id: string;
    /** Short label for the preview header cycle control. */
    label: string;
    modalWidth: SearchModalWidth;
    /** Percent width of the result list (preview gets the remainder). */
    resultsPercent: number;
}

export const TELESCOPE_LAYOUT_PRESETS: readonly TelescopeLayoutPreset[] = [
    { id: 'balanced', label: 'Balanced', modalWidth: 'wide', resultsPercent: 55 },
    { id: 'even', label: 'Even', modalWidth: 'extra-wide', resultsPercent: 50 },
    { id: 'reading', label: 'Reading', modalWidth: 'extra-wide', resultsPercent: 40 },
    { id: 'list', label: 'List', modalWidth: 'default', resultsPercent: 65 },
] as const;

const MODAL_WIDTH_PX: Record<SearchModalWidth, number> = {
    default: 640,
    wide: 800,
    'extra-wide': 960,
};

/** Dropdown labels for Settings → Display (modal width + preview share). */
export function telescopePreviewLayoutSettingLabels(): Record<TelescopePreviewLayout, string> {
    const out = {} as Record<TelescopePreviewLayout, string>;
    for (const p of TELESCOPE_LAYOUT_PRESETS) {
        const id = p.id as TelescopePreviewLayout;
        const previewPct = 100 - p.resultsPercent;
        const w = MODAL_WIDTH_PX[p.modalWidth];
        out[id] = `${p.label} — ${w}px modal, ${previewPct}% preview`;
    }
    return out;
}

export function telescopeLayoutPresetById(id: TelescopePreviewLayout): TelescopeLayoutPreset {
    return TELESCOPE_LAYOUT_PRESETS.find((p) => p.id === id) ?? TELESCOPE_LAYOUT_PRESETS[0]!;
}

export function telescopeLayoutIndexForId(id: TelescopePreviewLayout): number {
    const idx = TELESCOPE_LAYOUT_PRESETS.findIndex((p) => p.id === id);
    return idx >= 0 ? idx : 0;
}

export function nextTelescopeLayoutIndex(current: number): number {
    if (TELESCOPE_LAYOUT_PRESETS.length === 0) return 0;
    return (current + 1) % TELESCOPE_LAYOUT_PRESETS.length;
}

export function telescopeLayoutPreset(index: number): TelescopeLayoutPreset {
    const n = TELESCOPE_LAYOUT_PRESETS.length;
    if (n === 0) {
        return { id: 'fallback', label: 'Preview', modalWidth: 'default', resultsPercent: 55 };
    }
    const i = ((index % n) + n) % n;
    return TELESCOPE_LAYOUT_PRESETS[i]!;
}

/** Applies modal width and split CSS vars for the active telescope layout preset. */
export function applyTelescopeLayout(
    modalEl: HTMLElement,
    preset: TelescopeLayoutPreset,
    height: SearchModalHeight,
    opts: { isPhone: boolean; isTablet: boolean },
): void {
    const previewPercent = 100 - preset.resultsPercent;
    modalEl.style.setProperty('--seek-preview-results-pct', `${preset.resultsPercent}%`);
    modalEl.style.setProperty('--seek-preview-column-pct', `${previewPercent}%`);
    modalEl.style.setProperty('--seek-mobile-results-pct', `${preset.resultsPercent}%`);
    modalEl.style.setProperty('--seek-mobile-preview-pct', `${previewPercent}%`);
    modalEl.setAttribute('data-seek-telescope-layout', preset.id);
    applySearchModalSize(modalEl, preset.modalWidth, height, opts);
}
