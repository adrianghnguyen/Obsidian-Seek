/**
 * Folder-path autocomplete for a settings text input. Uses Obsidian's
 * AbstractInputSuggest rather than a bespoke suggester.
 */
import { AbstractInputSuggest, App, TFolder } from 'obsidian';

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
    constructor(
        app: App,
        private readonly inputEl: HTMLInputElement,
    ) {
        super(app, inputEl);
    }

    protected getSuggestions(query: string): TFolder[] {
        const q = query.toLowerCase();
        return this.app.vault
            .getAllFolders(false)
            .filter(folder => folder.path.toLowerCase().includes(q));
    }

    renderSuggestion(folder: TFolder, el: HTMLElement): void {
        el.setText(folder.path);
    }

    selectSuggestion(folder: TFolder): void {
        this.setValue(folder.path);
        this.inputEl.dispatchEvent(new Event('input'));
        this.close();
    }
}
