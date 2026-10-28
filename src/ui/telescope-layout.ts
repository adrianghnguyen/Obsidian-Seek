// Search modal width + telescope preview column share (desktop/tablet).

import type { SearchModalHeight, SearchModalWidth, TelescopePreviewLayout } from '../types/types';
import { applySearchModalSizePx } from './search-modal-size';

export const SEARCH_MODAL_WIDTH_MIN_PX = 400;

/** Former Extra-wide preset — snap target only, not a width ceiling. */
export const SEARCH_MODAL_WIDTH_EXTRA_WIDE_PX = 960;

/** Former width presets — snap targets on the modal width slider. */
export const SEARCH_MODAL_WIDTH_NOTCHES: readonly { px: number; label: string }[] = [
    { px: 640, label: 'Default' },
    { px: 800, label: 'Wide' },
    { px: SEARCH_MODAL_WIDTH_EXTRA_WIDE_PX, label: 'Extra wide' },
] as const;

/** Slider upper bound: current window. Applied CSS still caps at 94vw / 90vw. */
export function searchModalWidthSliderMaxPx(): number {
    const viewport = typeof window !== 'undefined' && window.innerWidth > 0
        ? Math.round(window.innerWidth)
        : SEARCH_MODAL_WIDTH_EXTRA_WIDE_PX;
    return Math.max(SEARCH_MODAL_WIDTH_MIN_PX, viewport);
}

export const TELESCOPE_PREVIEW_COLUMN_MIN_PCT = 25;
export const TELESCOPE_PREVIEW_COLUMN_MAX_PCT = 95;

/** Preview column share snap targets (former layout presets). */
export const TELESCOPE_PREVIEW_COLUMN_NOTCHES: readonly { pct: number; label: string }[] = [
    { pct: 35, label: 'List' },
    { pct: 45, label: 'Balanced' },
    { pct: 50, label: 'Even' },
    { pct: 60, label: 'Reading' },
] as const;

const WIDTH_SNAP_TOLERANCE_PX = 12;
const PREVIEW_SNAP_TOLERANCE_PCT = 3;

/** Combined layout presets for Ctrl/Cmd+Shift+P and the preview header cycle control. */
export interface TelescopeLayoutPreset {
    id: string;
    label: string;
    modalWidthPx: number;
    /** Percent width of the preview column (results get the remainder). */
    previewColumnPct: number;
}

export const TELESCOPE_LAYOUT_PRESETS: readonly TelescopeLayoutPreset[] = [
    { id: 'balanced', label: 'Balanced', modalWidthPx: 800, previewColumnPct: 45 },
    { id: 'even', label: 'Even', modalWidthPx: 960, previewColumnPct: 50 },
    { id: 'reading', label: 'Reading', modalWidthPx: 960, previewColumnPct: 60 },
    { id: 'list', label: 'List', modalWidthPx: 640, previewColumnPct: 35 },
] as const;

const LEGACY_MODAL_WIDTH_PX: Record<SearchModalWidth, number> = {
    default: 640,
    wide: 800,
    'extra-wide': 960,
};

export function clampSearchModalWidthPx(px: number): number {
    const n = Math.round(Number.isFinite(px) ? px : SEARCH_MODAL_WIDTH_MIN_PX);
    return Math.max(SEARCH_MODAL_WIDTH_MIN_PX, n);
}

export function snapSearchModalWidthPx(px: number): number {
    const clamped = clampSearchModalWidthPx(px);
    let best = clamped;
    let bestDist = WIDTH_SNAP_TOLERANCE_PX + 1;
    for (const notch of SEARCH_MODAL_WIDTH_NOTCHES) {
        const d = Math.abs(clamped - notch.px);
        if (d <= WIDTH_SNAP_TOLERANCE_PX && d < bestDist) {
            bestDist = d;
            best = notch.px;
        }
    }
    return best;
}

export function clampTelescopePreviewColumnPct(pct: number): number {
    const n = Math.round(pct);
    return Math.min(TELESCOPE_PREVIEW_COLUMN_MAX_PCT, Math.max(TELESCOPE_PREVIEW_COLUMN_MIN_PCT, n));
}

export function snapTelescopePreviewColumnPct(pct: number): number {
    const clamped = clampTelescopePreviewColumnPct(pct);
    let best = clamped;
    let bestDist = PREVIEW_SNAP_TOLERANCE_PCT + 1;
    for (const notch of TELESCOPE_PREVIEW_COLUMN_NOTCHES) {
        const d = Math.abs(clamped - notch.pct);
        if (d <= PREVIEW_SNAP_TOLERANCE_PCT && d < bestDist) {
            bestDist = d;
            best = notch.pct;
        }
    }
    return best;
}

/** Maps legacy enum width to px (migration + tests). */
export function searchModalWidthEnumToPx(width: SearchModalWidth): number {
    return LEGACY_MODAL_WIDTH_PX[width] ?? LEGACY_MODAL_WIDTH_PX.default;
}

/** Maps legacy layout id to preview column % (migration). */
export function telescopePreviewLayoutToColumnPct(id: TelescopePreviewLayout): number {
    const preset = TELESCOPE_LAYOUT_PRESETS.find((p) => p.id === id);
    return preset?.previewColumnPct ?? TELESCOPE_LAYOUT_PRESETS[0]!.previewColumnPct;
}

/** Maps legacy layout id to modal width px (migration). */
export function telescopePreviewLayoutToModalWidthPx(id: TelescopePreviewLayout): number {
    const preset = TELESCOPE_LAYOUT_PRESETS.find((p) => p.id === id);
    return preset?.modalWidthPx ?? TELESCOPE_LAYOUT_PRESETS[0]!.modalWidthPx;
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
        return { id: 'fallback', label: 'Preview', modalWidthPx: 640, previewColumnPct: 45 };
    }
    const i = ((index % n) + n) % n;
    return TELESCOPE_LAYOUT_PRESETS[i]!;
}

function presetMatchesSettings(
    preset: TelescopeLayoutPreset,
    widthPx: number,
    previewColumnPct: number,
): boolean {
    return Math.abs(preset.modalWidthPx - widthPx) <= WIDTH_SNAP_TOLERANCE_PX
        && Math.abs(preset.previewColumnPct - previewColumnPct) <= PREVIEW_SNAP_TOLERANCE_PCT;
}

/** Index into TELESCOPE_LAYOUT_PRESETS for cycle hotkey when sliders may sit between notches. */
export function telescopeLayoutCycleIndexForSettings(
    widthPx: number,
    previewColumnPct: number,
): number {
    for (let i = 0; i < TELESCOPE_LAYOUT_PRESETS.length; i++) {
        if (presetMatchesSettings(TELESCOPE_LAYOUT_PRESETS[i]!, widthPx, previewColumnPct)) return i;
    }
    return 0;
}

/** Label for the preview header cycle control (preset name or Custom). */
export function telescopeLayoutCycleLabel(widthPx: number, previewColumnPct: number): string {
    for (const p of TELESCOPE_LAYOUT_PRESETS) {
        if (presetMatchesSettings(p, widthPx, previewColumnPct)) return p.label;
    }
    return 'Custom';
}

export function telescopeLayoutPresetIdForSettings(widthPx: number, previewColumnPct: number): string {
    for (const p of TELESCOPE_LAYOUT_PRESETS) {
        if (presetMatchesSettings(p, widthPx, previewColumnPct)) return p.id;
    }
    return 'custom';
}

export function formatSearchModalWidthNotchHelp(): string {
    return SEARCH_MODAL_WIDTH_NOTCHES
        .map((n) => `${n.label} ${n.px}px`)
        .join(' · ');
}

export function formatTelescopePreviewColumnNotchHelp(): string {
    return TELESCOPE_PREVIEW_COLUMN_NOTCHES
        .map((n) => `${n.label} ${n.pct}%`)
        .join(' · ');
}

/** Applies modal width and split CSS vars while telescope preview is visible. */
export function applyTelescopeLayout(
    modalEl: HTMLElement,
    widthPx: number,
    previewColumnPct: number,
    height: SearchModalHeight,
    opts: { isPhone: boolean; isTablet: boolean },
): void {
    const previewPct = clampTelescopePreviewColumnPct(previewColumnPct);
    const resultsPct = 100 - previewPct;
    modalEl.style.setProperty('--seek-preview-results-pct', `${resultsPct}%`);
    modalEl.style.setProperty('--seek-preview-column-pct', `${previewPct}%`);
    modalEl.style.setProperty('--seek-mobile-results-pct', `${resultsPct}%`);
    modalEl.style.setProperty('--seek-mobile-preview-pct', `${previewPct}%`);
    modalEl.setAttribute(
        'data-seek-telescope-layout',
        telescopeLayoutPresetIdForSettings(widthPx, previewPct),
    );
    applySearchModalSizePx(modalEl, widthPx, height, opts);
}
