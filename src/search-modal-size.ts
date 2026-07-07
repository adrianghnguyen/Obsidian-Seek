// Maps search-modal size settings to CSS custom properties on the modal element.
// Desktop and tablet only — phones keep the full-width keyboard-aware shell.

import type { SearchModalHeight, SearchModalWidth } from './types';

const WIDTH_PX: Record<SearchModalWidth, number> = {
    default: 640,
    wide: 800,
    'extra-wide': 960,
};

const HEIGHT_PRESETS: Record<SearchModalHeight, { maxHeight: string; marginTop: string }> = {
    default: { maxHeight: '74vh', marginTop: '11vh' },
    tall: { maxHeight: '82vh', marginTop: '6vh' },
    'extra-tall': { maxHeight: '88vh', marginTop: '4vh' },
};

/** Tablet shell floor — never narrower than the pre-setting tablet column. */
const TABLET_MIN_WIDTH_PX = 820;

export function resolveSearchModalWidthPx(
    width: SearchModalWidth,
    isTablet: boolean,
): number {
    const base = WIDTH_PX[width] ?? WIDTH_PX.default;
    return isTablet ? Math.max(base, TABLET_MIN_WIDTH_PX) : base;
}

export function applySearchModalSize(
    modalEl: HTMLElement,
    width: SearchModalWidth,
    height: SearchModalHeight,
    opts: { isPhone: boolean; isTablet: boolean },
): void {
    if (opts.isPhone) return;

    const widthPx = resolveSearchModalWidthPx(width, opts.isTablet);
    const h = HEIGHT_PRESETS[height] ?? HEIGHT_PRESETS.default;
    const maxWidth = opts.isTablet ? '90vw' : '94vw';

    // CSS vars for styles.css; inline dimensions too so size settings survive a
    // stale plugin stylesheet until Obsidian fully reloads CSS on plugin:reload.
    modalEl.style.setProperty('--seek-modal-width', `${widthPx}px`);
    modalEl.style.setProperty('--seek-modal-max-height', h.maxHeight);
    modalEl.style.setProperty('--seek-modal-margin-top', h.marginTop);
    modalEl.style.width = `${widthPx}px`;
    modalEl.style.maxWidth = maxWidth;
    modalEl.style.maxHeight = h.maxHeight;
    modalEl.style.marginTop = h.marginTop;

    const content = modalEl.querySelector('.modal-content') as HTMLElement | null;
    if (content) content.style.maxHeight = h.maxHeight;
}
