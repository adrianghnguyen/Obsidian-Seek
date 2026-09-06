import { describe, expect, it } from 'vitest';
import type { App, Hotkey } from 'obsidian';
import { Platform } from 'obsidian';
import {
    eventMatchesHotkey,
    effectiveHotkeys,
    matchSearchModalAction,
    searchModalCommandId,
    SEARCH_MODAL_COMMANDS,
} from './search-modal-hotkeys';

function evt(partial: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
    return {
        key: partial.key,
        ctrlKey: partial.ctrlKey ?? false,
        metaKey: partial.metaKey ?? false,
        altKey: partial.altKey ?? false,
        shiftKey: partial.shiftKey ?? false,
    } as KeyboardEvent;
}

function appWithHotkeys(custom: Record<string, Hotkey[]>, defaults: Record<string, Hotkey[]> = {}): App {
    return {
        hotkeyManager: {
            customKeys: custom,
            defaultKeys: defaults,
        },
    } as unknown as App;
}

describe('search-modal-hotkeys', () => {
    it('lists a command for every remappable footer action', () => {
        const actions = new Set(SEARCH_MODAL_COMMANDS.map(c => c.action));
        for (const a of [
            'navigate-up', 'navigate-down', 'open', 'open-tab', 'open-split',
            'insert-link', 'insert-link-alias', 'expand-snippet', 'fill-autosuggest', 'close',
        ] as const) {
            expect(actions.has(a)).toBe(true);
        }
    });

    it('matches default Enter family by specificity', () => {
        const app = appWithHotkeys({});
        const pluginId = 'seek';
        expect(matchSearchModalAction(app, pluginId, evt({ key: 'Enter' }))).toBe('open');
        expect(matchSearchModalAction(app, pluginId, evt({ key: 'Enter', ctrlKey: true }))).toBe('open-tab');
        expect(matchSearchModalAction(app, pluginId, evt({ key: 'Enter', ctrlKey: true, altKey: true }))).toBe('open-split');
        expect(matchSearchModalAction(app, pluginId, evt({ key: 'Enter', altKey: true }))).toBe('insert-link');
        expect(matchSearchModalAction(app, pluginId, evt({ key: 'Enter', altKey: true, shiftKey: true }))).toBe('insert-link-alias');
    });

    it('honors customKeys override (including cleared bindings)', () => {
        const openId = searchModalCommandId('seek', 'search-open');
        const tabId = searchModalCommandId('seek', 'search-open-tab');
        const app = appWithHotkeys({
            [openId]: [{ modifiers: ['Mod'], key: 'o' }],
            [tabId]: [], // user cleared — must not fall back to Mod+Enter
        });
        expect(matchSearchModalAction(app, 'seek', evt({ key: 'o', ctrlKey: true }))).toBe('open');
        expect(matchSearchModalAction(app, 'seek', evt({ key: 'Enter' }))).toBe(null);
        expect(matchSearchModalAction(app, 'seek', evt({ key: 'Enter', ctrlKey: true }))).toBe(null);
    });

    it('effectiveHotkeys prefers customKeys over defaults', () => {
        const id = searchModalCommandId('seek', 'search-open');
        const fallback: Hotkey[] = [{ modifiers: [], key: 'Enter' }];
        const app = appWithHotkeys(
            { [id]: [{ modifiers: ['Mod'], key: 'o' }] },
            { [id]: fallback },
        );
        expect(effectiveHotkeys(app, id, fallback)).toEqual([{ modifiers: ['Mod'], key: 'o' }]);
    });

    it('eventMatchesHotkey treats Mod as Ctrl off macOS', () => {
        const wasMac = Platform.isMacOS;
        (Platform as { isMacOS: boolean }).isMacOS = false;
        try {
            expect(eventMatchesHotkey(
                evt({ key: 'Enter', ctrlKey: true }),
                { modifiers: ['Mod'], key: 'Enter' },
            )).toBe(true);
            expect(eventMatchesHotkey(
                evt({ key: 'Enter', metaKey: true }),
                { modifiers: ['Mod'], key: 'Enter' },
            )).toBe(false);
        } finally {
            (Platform as { isMacOS: boolean }).isMacOS = wasMac;
        }
    });
});
