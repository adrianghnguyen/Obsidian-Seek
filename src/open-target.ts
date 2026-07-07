// Shared pane-target resolution for opening notes from the search modal,
// obsidian://seek protocol, and seek:open CLI. Centralizes Keymap.isModEvent
// (UI) and paneType= (CLI/URI) onto workspace.getLeaf().

import { Keymap, Platform } from 'obsidian';
import type { App, PaneType, TFile, WorkspaceLeaf } from 'obsidian';

// false = replace the active tab; PaneType = new tab / split / pop-out window.
export type OpenTarget = false | PaneType;

export function resolveOpenTarget(evt: MouseEvent | KeyboardEvent): OpenTarget {
    const t = Keymap.isModEvent(evt);
    if (!t) return false;
    // Modal UX: pop-out window is CLI/protocol-only; treat as new tab.
    if (t === 'window') return 'tab';
    // isModEvent may return bare `true` for mod-click; same as tab.
    if (t === true || t === 'tab') return 'tab';
    return 'split';
}

export function parsePaneType(raw: string | undefined): OpenTarget {
    if (raw === 'tab' || raw === 'split' || raw === 'window') return raw;
    return false;
}

// Mobile has no meaningful split layout — fall back to background tab.
export function normalizeTarget(target: OpenTarget): OpenTarget {
    if (Platform.isMobile && target === 'split') return 'tab';
    return target;
}

export function getLeafForTarget(app: App, target: OpenTarget): WorkspaceLeaf {
    const t = normalizeTarget(target);
    if (t === false) return app.workspace.getLeaf(false);
    if (t === 'split') return app.workspace.getLeaf('split');
    if (t === 'window') return app.workspace.getLeaf('window');
    return app.workspace.getLeaf('tab');
}

export interface OpenAtTargetOpts {
    eState?: Record<string, unknown>;
    // When true, tab/split/window open with active:false (modal fan-out).
    background?: boolean;
}

export async function openFileAtTarget(
    app: App,
    file: TFile,
    target: OpenTarget,
    opts?: OpenAtTargetOpts,
): Promise<WorkspaceLeaf> {
    const t = normalizeTarget(target);
    const leaf = getLeafForTarget(app, t);
    const active = t === false ? true : !opts?.background;
    await leaf.openFile(file, { active, eState: opts?.eState });
    return leaf;
}

export async function openBaseAtTarget(
    app: App,
    file: TFile,
    target: OpenTarget,
    state: Record<string, unknown>,
    opts?: Pick<OpenAtTargetOpts, 'background'>,
): Promise<WorkspaceLeaf> {
    const t = normalizeTarget(target);
    const leaf = getLeafForTarget(app, t);
    const active = t === false ? true : !opts?.background;
    await leaf.setViewState({ type: 'bases', active, state });
    return leaf;
}

// Background open keeps the search modal focused (tab or split fan-out).
export function isBackgroundOpen(target: OpenTarget): boolean {
    return target !== false;
}
