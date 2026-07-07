// Link insertion from the search modal and seek:insert-link CLI. Builds vault-
// respecting links via fileManager.generateMarkdownLink and inserts at the active
// editor cursor (or over a saved selection when an alias came from editor text).

import { MarkdownView } from 'obsidian';
import type { App, EditorPosition, TFile } from 'obsidian';
import type { InsertLinkAliasSource, SeekSettings } from './types';

export type { InsertLinkAliasSource };

export interface InsertLinkAliasInput {
    editorSelection?: string | null;
    searchQueryText?: string | null;
    explicitAlias?: string | null;
}

export interface InsertLinkAliasPolicy {
    priority: readonly InsertLinkAliasSource[];
}

export interface BuildNoteLinkOpts {
    subpath?: string;
    alias?: string;
}

export interface InsertLinkInEditorOpts {
    from?: EditorPosition;
    to?: EditorPosition;
}

const V1_ALIAS_POLICY: InsertLinkAliasPolicy = { priority: ['editorSelection'] };

export function insertLinkAliasPolicyFromSettings(
    settings: Pick<SeekSettings, 'insertLinkAliasSource'>,
): InsertLinkAliasPolicy {
    if (settings.insertLinkAliasSource === 'searchQuery') {
        return { priority: ['editorSelection', 'searchQuery'] };
    }
    return V1_ALIAS_POLICY;
}

export function resolveInsertLinkAlias(
    input: InsertLinkAliasInput,
    policy: InsertLinkAliasPolicy,
): string | undefined {
    if (input.explicitAlias?.trim()) return input.explicitAlias.trim();

    for (const source of policy.priority) {
        if (source === 'editorSelection') {
            const sel = input.editorSelection?.trim();
            if (sel) return sel;
        } else if (source === 'searchQuery') {
            const q = input.searchQueryText?.trim();
            if (q) return q;
        }
    }
    return undefined;
}

export function headingSubpath(headingPath: string[] | undefined | null): string | undefined {
    if (!headingPath?.length) return undefined;
    const last = headingPath[headingPath.length - 1]?.trim();
    if (!last) return undefined;
    return `#${last}`;
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
