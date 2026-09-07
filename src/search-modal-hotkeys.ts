// Search-modal actions as Obsidian commands: defaults live here, users remap them
// in Settings → Hotkeys, and the query field matches the *effective* binding
// (customKeys over defaultKeys) so remaps work while the contenteditable is focused.

import { Platform } from 'obsidian';
import type { App, Hotkey, Modifier } from 'obsidian';

export type SearchModalAction =
    | 'navigate-up'
    | 'navigate-down'
    | 'open'
    | 'open-tab'
    | 'open-split'
    | 'insert-link'
    | 'insert-link-alias'
    | 'expand-snippet'
    | 'fill-autosuggest'
    | 'close';

export interface SearchModalCommandSpec {
    /** Local id passed to addCommand (Obsidian namespaces with the plugin id). */
    id: string;
    name: string;
    action: SearchModalAction;
    /** In-modal fallback + footer hints; also used when the user remaps in Hotkeys. */
    hotkeys: Hotkey[];
    /** Desktop-only actions (insert-link chords); still listed but checkCallback gates them. */
    desktopOnly?: boolean;
}

/**
 * Bare keys the editor owns globally. Registering them as addCommand defaults
 * hijacks the keymap even when checkCallback returns false — omit from addCommand
 * and rely on in-modal fallbacks (query field) instead.
 */
export const EDITOR_CONFLICTING_BARE_KEYS = new Set([
    'ArrowUp',
    'ArrowDown',
    'Enter',
    'Tab',
    'Escape',
]);

/** Hotkeys safe to pass to addCommand — chorded bindings only for editor-native keys. */
export function searchModalCommandRegisterHotkeys(fallback: Hotkey[]): Hotkey[] | undefined {
    const safe = fallback.filter(
        h => h.modifiers.length > 0 || !EDITOR_CONFLICTING_BARE_KEYS.has(h.key),
    );
    return safe.length > 0 ? safe : undefined;
}

/** Suffixes only — full command id is `${pluginId}:${id}`. */
export const SEARCH_MODAL_COMMANDS: readonly SearchModalCommandSpec[] = [
    {
        id: 'search-navigate-up',
        name: 'Search: Navigate up',
        action: 'navigate-up',
        hotkeys: [{ modifiers: [], key: 'ArrowUp' }],
    },
    {
        id: 'search-navigate-down',
        name: 'Search: Navigate down',
        action: 'navigate-down',
        hotkeys: [{ modifiers: [], key: 'ArrowDown' }],
    },
    {
        id: 'search-open',
        name: 'Search: Open',
        action: 'open',
        hotkeys: [{ modifiers: [], key: 'Enter' }],
    },
    {
        id: 'search-open-tab',
        name: 'Search: Open in new tab',
        action: 'open-tab',
        hotkeys: [{ modifiers: ['Mod'], key: 'Enter' }],
    },
    {
        id: 'search-open-split',
        name: 'Search: Open in split',
        action: 'open-split',
        hotkeys: [{ modifiers: ['Mod', 'Alt'], key: 'Enter' }],
    },
    {
        id: 'search-insert-link',
        name: 'Search: Insert link',
        action: 'insert-link',
        hotkeys: [{ modifiers: ['Alt'], key: 'Enter' }],
        desktopOnly: true,
    },
    {
        id: 'search-insert-link-alias',
        name: 'Search: Insert link with alias',
        action: 'insert-link-alias',
        hotkeys: [{ modifiers: ['Alt', 'Shift'], key: 'Enter' }],
        desktopOnly: true,
    },
    {
        id: 'search-expand-snippet',
        name: 'Search: Expand snippet',
        action: 'expand-snippet',
        hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'E' }],
    },
    {
        id: 'search-fill-autosuggest',
        name: 'Search: Fill autosuggest',
        action: 'fill-autosuggest',
        hotkeys: [{ modifiers: [], key: 'Tab' }],
    },
    {
        id: 'search-close',
        name: 'Search: Close',
        action: 'close',
        hotkeys: [{ modifiers: [], key: 'Escape' }],
    },
];

export function searchModalCommandId(pluginId: string, localId: string): string {
    return `${pluginId}:${localId}`;
}

interface HotkeyManagerLike {
    customKeys?: Record<string, Hotkey[] | undefined>;
    defaultKeys?: Record<string, Hotkey[] | undefined>;
    getHotkeys?(commandId: string): Hotkey[] | undefined;
    getDefaultHotkeys?(commandId: string): Hotkey[] | undefined;
    printHotkeyForCommand?(commandId: string): string;
}

function hotkeyManager(app: App): HotkeyManagerLike | null {
    return (app as unknown as { hotkeyManager?: HotkeyManagerLike }).hotkeyManager ?? null;
}

/** Effective hotkeys: customKeys wins even when empty (user cleared the default). */
export function effectiveHotkeys(
    app: App,
    fullCommandId: string,
    fallback: Hotkey[],
): Hotkey[] {
    const hm = hotkeyManager(app);
    if (!hm) return fallback;
    if (hm.customKeys && Object.prototype.hasOwnProperty.call(hm.customKeys, fullCommandId)) {
        return hm.customKeys[fullCommandId] ?? [];
    }
    const custom = hm.getHotkeys?.(fullCommandId);
    if (custom !== undefined) return custom;
    if (hm.defaultKeys?.[fullCommandId]) return hm.defaultKeys[fullCommandId] ?? fallback;
    return hm.getDefaultHotkeys?.(fullCommandId) ?? fallback;
}

function normalizeKey(key: string): string {
    if (key.length === 1) return key.toLowerCase();
    // Obsidian stores letter keys as lowercase; KeyboardEvent.key for letters is
    // case-sensitive when Shift is held ("E" vs "e").
    if (/^[a-zA-Z]$/.test(key)) return key.toLowerCase();
    return key;
}

function eventKey(evt: KeyboardEvent): string {
    return normalizeKey(evt.key);
}

function hotkeyKey(hotkey: Hotkey): string {
    return normalizeKey(hotkey.key);
}

function modifierSet(modifiers: Modifier[]): Set<string> {
    const s = new Set<string>();
    for (const m of modifiers) s.add(m);
    return s;
}

/** True when the event's modifiers match the hotkey's Mod/Ctrl/Meta/Alt/Shift set. */
export function eventMatchesHotkey(evt: KeyboardEvent, hotkey: Hotkey): boolean {
    if (eventKey(evt) !== hotkeyKey(hotkey)) return false;

    const mods = modifierSet(hotkey.modifiers);
    const wantMod = mods.has('Mod');
    const wantCtrl = mods.has('Ctrl');
    const wantMeta = mods.has('Meta');
    const wantAlt = mods.has('Alt');
    const wantShift = mods.has('Shift');

    // Mod = Meta on macOS, Ctrl elsewhere. Explicit Ctrl/Meta are additional.
    if (wantMod) {
        if (!(Platform.isMacOS ? evt.metaKey : evt.ctrlKey)) return false;
        if (Platform.isMacOS) {
            if (wantCtrl !== evt.ctrlKey) return false;
            // Meta already satisfied by Mod on macOS.
        } else {
            if (wantMeta !== evt.metaKey) return false;
            // Ctrl already satisfied by Mod on Windows/Linux.
        }
    } else {
        if (wantCtrl !== evt.ctrlKey) return false;
        if (wantMeta !== evt.metaKey) return false;
    }

    if (wantAlt !== evt.altKey) return false;
    if (wantShift !== evt.shiftKey) return false;
    return true;
}

export function eventMatchesAnyHotkey(evt: KeyboardEvent, hotkeys: Hotkey[]): boolean {
    return hotkeys.some(h => eventMatchesHotkey(evt, h));
}

function modifierCount(hotkey: Hotkey): number {
    return hotkey.modifiers.length;
}

/**
 * Resolve which search-modal action a key event should run, preferring the
 * most-specific (most modifiers) binding when several share a key (Enter family).
 */
export function matchSearchModalAction(
    app: App,
    pluginId: string,
    evt: KeyboardEvent,
): SearchModalAction | null {
    let best: { action: SearchModalAction; mods: number } | null = null;

    for (const spec of SEARCH_MODAL_COMMANDS) {
        if (spec.desktopOnly && Platform.isMobile) continue;
        const fullId = searchModalCommandId(pluginId, spec.id);
        const keys = effectiveHotkeys(app, fullId, spec.hotkeys);
        for (const hk of keys) {
            if (!eventMatchesHotkey(evt, hk)) continue;
            const mods = modifierCount(hk);
            if (!best || mods > best.mods) best = { action: spec.action, mods };
        }
    }

    return best?.action ?? null;
}

/** Footer / hint label from Obsidian when available; else a compact fallback. */
export function formatCommandHotkey(
    app: App,
    pluginId: string,
    localId: string,
    fallback: Hotkey[],
): string {
    const fullId = searchModalCommandId(pluginId, localId);
    const hm = hotkeyManager(app);
    const printed = hm?.printHotkeyForCommand?.(fullId)?.trim();
    if (printed) return printed;
    const keys = effectiveHotkeys(app, fullId, fallback);
    if (keys.length === 0) return '';
    return keys.map(formatHotkeyFallback).join(' / ');
}

function formatHotkeyFallback(hotkey: Hotkey): string {
    const parts: string[] = [];
    const mods = modifierSet(hotkey.modifiers);
    if (mods.has('Mod')) parts.push(Platform.isMacOS ? '⌘' : 'Ctrl');
    if (mods.has('Ctrl') && !mods.has('Mod')) parts.push('Ctrl');
    if (mods.has('Meta') && !mods.has('Mod')) parts.push(Platform.isMacOS ? '⌘' : 'Meta');
    if (mods.has('Alt')) parts.push(Platform.isMacOS ? '⌥' : 'Alt');
    if (mods.has('Shift')) parts.push(Platform.isMacOS ? '⇧' : 'Shift');
    parts.push(displayKey(hotkey.key));
    return parts.join(Platform.isMacOS ? '' : '+');
}

function displayKey(key: string): string {
    switch (key) {
        case 'Enter': return '↵';
        case 'Escape': return 'esc';
        case 'ArrowUp': return '↑';
        case 'ArrowDown': return '↓';
        case 'Tab': return 'tab';
        default: return key.length === 1 ? key.toUpperCase() : key;
    }
}

/** Footer hint rows: glyph caps + label, driven by effective hotkeys. */
export interface FooterHotkeyHint {
    keys: string[];
    label: string;
}

function capsForAction(app: App, pluginId: string, action: SearchModalAction): string[] {
    const spec = SEARCH_MODAL_COMMANDS.find(c => c.action === action);
    if (!spec) return [];
    const fullId = searchModalCommandId(pluginId, spec.id);
    const printed = hotkeyManager(app)?.printHotkeyForCommand?.(fullId)?.trim();
    if (printed) {
        return printed.split(/\s*\+\s*/).map(s => s.trim()).filter(Boolean);
    }
    const keys = effectiveHotkeys(app, fullId, spec.hotkeys);
    if (keys.length === 0) return [];
    return hotkeyToCaps(keys[0]);
}

export function searchModalFooterHints(app: App, pluginId: string): FooterHotkeyHint[] {
    const hints: FooterHotkeyHint[] = [
        { keys: [...capsForAction(app, pluginId, 'navigate-up'), ...capsForAction(app, pluginId, 'navigate-down')], label: 'navigate' },
        { keys: capsForAction(app, pluginId, 'open'), label: 'open' },
        { keys: capsForAction(app, pluginId, 'open-tab'), label: 'new tab' },
        { keys: capsForAction(app, pluginId, 'open-split'), label: 'split' },
        { keys: capsForAction(app, pluginId, 'fill-autosuggest'), label: 'fill autosuggest' },
        { keys: capsForAction(app, pluginId, 'expand-snippet'), label: 'expand snippet' },
    ];
    if (!Platform.isMobile) {
        hints.push(
            { keys: capsForAction(app, pluginId, 'insert-link'), label: 'insert link' },
            { keys: capsForAction(app, pluginId, 'insert-link-alias'), label: 'link with alias' },
        );
    }
    return hints.filter(h => h.keys.length > 0);
}

export function searchModalCloseHintKeys(app: App, pluginId: string): string[] {
    const keys = capsForAction(app, pluginId, 'close');
    return keys.length > 0 ? keys : ['esc'];
}

function hotkeyToCaps(hotkey: Hotkey): string[] {
    const caps: string[] = [];
    const mods = modifierSet(hotkey.modifiers);
    if (mods.has('Mod')) caps.push(Platform.isMacOS ? '⌘' : 'Ctrl');
    if (mods.has('Ctrl') && !mods.has('Mod')) caps.push('Ctrl');
    if (mods.has('Meta') && !mods.has('Mod')) caps.push(Platform.isMacOS ? '⌘' : 'Meta');
    if (mods.has('Alt')) caps.push(Platform.isMacOS ? '⌥' : 'Alt');
    if (mods.has('Shift')) caps.push(Platform.isMacOS ? '⇧' : 'Shift');
    caps.push(displayKey(hotkey.key));
    return caps;
}
