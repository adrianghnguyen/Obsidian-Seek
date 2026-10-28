// Maps search-modal size settings to CSS custom properties on the modal element.
// Desktop and tablet only — phones keep the full-width keyboard-aware shell.

import type { SearchModalHeight, SearchModalWidth } from '../types/types';
import {
    clampSearchModalWidthPx,
    searchModalWidthEnumToPx,
} from './telescope-layout';

const HEIGHT_PRESETS: Record<SearchModalHeight, { maxHeight: string; marginTop: string }> = {
    default: { maxHeight: '74vh', marginTop: '11vh' },
    tall: { maxHeight: '82vh', marginTop: '6vh' },
    'extra-tall': { maxHeight: '88vh', marginTop: '4vh' },
};

/** Tablet shell floor — never narrower than the pre-setting tablet column. */
const TABLET_MIN_WIDTH_PX = 820;

export function resolveSearchModalWidthPx(
    widthPx: number,
    isTablet: boolean,
): number {
    const base = clampSearchModalWidthPx(widthPx);
    return isTablet ? Math.max(base, TABLET_MIN_WIDTH_PX) : base;
}

/** @deprecated Use resolveSearchModalWidthPx with px from settings. */
export function resolveSearchModalWidthPxFromEnum(
    width: SearchModalWidth,
    isTablet: boolean,
): number {
    return resolveSearchModalWidthPx(searchModalWidthEnumToPx(width), isTablet);
}

export function applySearchModalSizePx(
    modalEl: HTMLElement,
    widthPx: number,
    height: SearchModalHeight,
    opts: { isPhone: boolean; isTablet: boolean },
): void {
    if (opts.isPhone) return;

    const widthResolved = resolveSearchModalWidthPx(widthPx, opts.isTablet);
    const h = HEIGHT_PRESETS[height] ?? HEIGHT_PRESETS.default;
    const maxWidth = opts.isTablet ? '90vw' : '94vw';

    modalEl.style.setProperty('--seek-modal-width', `${widthResolved}px`);
    modalEl.style.setProperty('--seek-modal-max-height', h.maxHeight);
    modalEl.style.setProperty('--seek-modal-margin-top', h.marginTop);
    modalEl.style.width = `${widthResolved}px`;
    modalEl.style.maxWidth = maxWidth;
    modalEl.style.maxHeight = h.maxHeight;
    modalEl.style.marginTop = h.marginTop;

    const content = modalEl.querySelector('.modal-content') as HTMLElement | null;
    if (content) content.style.maxHeight = h.maxHeight;
}

/** @deprecated Use applySearchModalSizePx. */
export function applySearchModalSize(
    modalEl: HTMLElement,
    width: SearchModalWidth,
    height: SearchModalHeight,
    opts: { isPhone: boolean; isTablet: boolean },
): void {
    applySearchModalSizePx(modalEl, searchModalWidthEnumToPx(width), height, opts);
}
