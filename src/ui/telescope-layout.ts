// Session layout presets for the search modal when the telescope preview column is on.

import type { SearchModalHeight, SearchModalWidth } from '../types/types';
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
