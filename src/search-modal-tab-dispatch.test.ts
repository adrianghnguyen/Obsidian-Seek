import { describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import {
    isBareTabKey,
    matchSearchModalAction,
    resolveSearchModalKeyAction,
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

describe('Tab fill-then-insert-alias dispatch (hotkey resolution)', () => {
    it('bare Tab matches insert-link-alias before fill-autosuggest in the matcher', () => {
        const app = { hotkeyManager: { customKeys: {}, defaultKeys: {} } } as unknown as App;
        expect(matchSearchModalAction(app, 'seek', evt({ key: 'Tab' }))).toBe('insert-link-alias');
    });

    it('isBareTabKey excludes modified Tab', () => {
        expect(isBareTabKey(evt({ key: 'Tab' }))).toBe(true);
        expect(isBareTabKey(evt({ key: 'Tab', shiftKey: true }))).toBe(false);
    });

    it('resolveSearchModalKeyAction gates insert-link-alias on Tab without editor', () => {
        const app = {
            workspace: { getActiveViewOfType: () => null },
            hotkeyManager: { customKeys: {}, defaultKeys: {} },
        } as unknown as App;
        expect(resolveSearchModalKeyAction(app, 'seek', evt({ key: 'Tab' }))).toBeNull();
    });

    it('simulates fill-first: when fill would succeed, caller skips insert (no editor call)', () => {
        let insertCalled = false;
        const fillAutosuggest = vi.fn(() => true);
        const canInsert = () => true;
        const onInsert = () => { insertCalled = true; };

        const tab = evt({ key: 'Tab' });
        const app = {
            workspace: { getActiveViewOfType: () => ({ editor: {} }) },
            hotkeyManager: { customKeys: {}, defaultKeys: {} },
        } as unknown as App;
        const action = resolveSearchModalKeyAction(app, 'seek', tab);
        expect(action).toBe('insert-link-alias');

        if (action === 'fill-autosuggest' || (action === 'insert-link-alias' && isBareTabKey(tab))) {
            if (fillAutosuggest()) return;
            if (canInsert()) onInsert();
        }
        expect(fillAutosuggest).toHaveBeenCalled();
        expect(insertCalled).toBe(false);
    });

    it('simulates fill miss then insert when editor + results allow', () => {
        let insertCalled = false;
        const fillAutosuggest = vi.fn(() => false);
        const canInsert = () => true;
        const onInsert = () => { insertCalled = true; };

        const tab = evt({ key: 'Tab' });
        const app = {
            workspace: { getActiveViewOfType: () => ({ editor: {} }) },
            hotkeyManager: { customKeys: {}, defaultKeys: {} },
        } as unknown as App;
        const action = resolveSearchModalKeyAction(app, 'seek', tab);
        if (action === 'fill-autosuggest' || (action === 'insert-link-alias' && isBareTabKey(tab))) {
            if (fillAutosuggest()) return;
            if (canInsert()) onInsert();
        }
        expect(insertCalled).toBe(true);
    });
});
