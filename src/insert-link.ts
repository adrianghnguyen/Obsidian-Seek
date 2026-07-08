// Link insertion from the search modal and seek:insert-link CLI. Builds vault-
// respecting links via fileManager.generateMarkdownLink and inserts at the active
// editor cursor.

import { MarkdownView } from 'obsidian';
import type { App, EditorPosition, TFile } from 'obsidian';
import type { SeekSettings } from './types';

export type InsertLinkMode = 'plain' | 'searchAlias';

export interface BuildNoteLinkOpts {
    subpath?: string;
    alias?: string;
}

export interface InsertLinkInEditorOpts {
    from?: EditorPosition;
    to?: EditorPosition;
}

/** Alias for modal insert: plain wiki link, or search-field free text when Shift is held. */
export function resolveInsertLinkAliasForMode(
    mode: InsertLinkMode,
    searchQueryText?: string | null,
): string | undefined {
    if (mode === 'plain') return undefined;
    const q = searchQueryText?.trim();
    return q || undefined;
}

/** CLI alias: explicit `alias=` param only (default is a plain wiki link). */
export function resolveInsertLinkAlias(explicitAlias?: string | null): string | undefined {
    const a = explicitAlias?.trim();
    return a || undefined;
}

export function headingSubpath(headingPath: string[] | undefined | null): string | undefined {
    if (!headingPath?.length) return undefined;
    const last = headingPath[headingPath.length - 1]?.trim();
    if (!last) return undefined;
    return `#${last}`;
}

export function resolveInsertLinkSubpath(
    headingPath: string[] | undefined | null,
    settings: Partial<Pick<SeekSettings, 'insertLinkIncludeHeading'>>,
): string {
    if (settings.insertLinkIncludeHeading !== true) return '';
    return headingSubpath(headingPath) ?? '';
}

function noteBasename(file: TFile): string {
    const base = file.path.split('/').pop() ?? file.path;
    return base.replace(/\.md$/i, '');
}

export function buildNoteLink(app: App, file: TFile, opts?: BuildNoteLinkOpts): string {
    const active = app.workspace.getActiveFile();
    const subpath = opts?.subpath ?? '';
    const alias = opts?.alias;

    if (active) {
        return app.fileManager.generateMarkdownLink(
            file,
            active.path,
            subpath,
            alias ?? '',
        );
    }

    const base = noteBasename(file);
    const pathPart = subpath ? `${base}${subpath}` : base;
    if (alias) return `[[${pathPart}|${alias}]]`;
    return `[[${pathPart}]]`;
}

export function insertLinkInEditor(
    app: App,
    link: string,
    opts?: InsertLinkInEditorOpts,
): { ok: true } | { ok: false; reason: string } {
    const view = app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor) return { ok: false, reason: 'no active editor' };

    const editor = view.editor;
    if (opts?.from && opts?.to) {
        editor.replaceRange(link, opts.from, opts.to);
        const end = editor.offsetToPos(editor.posToOffset(opts.from) + link.length);
        editor.setCursor(end);
        return { ok: true };
    }

    const cursor = editor.getCursor();
    editor.replaceRange(link, cursor, cursor);
    const end = editor.offsetToPos(editor.posToOffset(cursor) + link.length);
    editor.setCursor(end);
    return { ok: true };
}

export function isInsertableMarkdownFile(file: TFile | null): file is TFile {
    return file != null && file.extension === 'md';
}
