import { describe, expect, it } from 'vitest';
import type { App, TFile } from 'obsidian';
import {
    buildNoteLink,
    headingSubpath,
    insertLinkAliasPolicyFromSettings,
    resolveInsertLinkAlias,
    type InsertLinkAliasPolicy,
} from './insert-link';

describe('headingSubpath', () => {
    it('returns undefined for empty paths', () => {
        expect(headingSubpath([])).toBeUndefined();
        expect(headingSubpath(null)).toBeUndefined();
        expect(headingSubpath(undefined)).toBeUndefined();
    });

    it('uses the last heading segment', () => {
        expect(headingSubpath(['Agenda', 'Intern pgm'])).toBe('#Intern pgm');
        expect(headingSubpath(['Only'])).toBe('#Only');
    });
});

describe('resolveInsertLinkAlias', () => {
    const v1Policy: InsertLinkAliasPolicy = { priority: ['editorSelection'] };
    const queryPolicy: InsertLinkAliasPolicy = { priority: ['editorSelection', 'searchQuery'] };

    it('prefers explicit alias', () => {
        expect(resolveInsertLinkAlias({
            explicitAlias: 'cli alias',
            editorSelection: 'sel',
            searchQueryText: 'q',
        }, v1Policy)).toBe('cli alias');
    });

    it('uses editor selection in v1 policy', () => {
        expect(resolveInsertLinkAlias({
            editorSelection: 'selected words',
            searchQueryText: 'test',
        }, v1Policy)).toBe('selected words');
    });

    it('ignores search query in v1 policy', () => {
        expect(resolveInsertLinkAlias({
            searchQueryText: 'test',
        }, v1Policy)).toBeUndefined();
    });

    it('falls back to search query when policy includes it', () => {
        expect(resolveInsertLinkAlias({
            searchQueryText: 'test',
        }, queryPolicy)).toBe('test');
    });

    it('selection wins over search query in combined policy', () => {
        expect(resolveInsertLinkAlias({
            editorSelection: 'sel',
            searchQueryText: 'test',
        }, queryPolicy)).toBe('sel');
    });
});

describe('insertLinkAliasPolicyFromSettings', () => {
    it('defaults to selection-only', () => {
        expect(insertLinkAliasPolicyFromSettings({})).toEqual({ priority: ['editorSelection'] });
        expect(insertLinkAliasPolicyFromSettings({ insertLinkAliasSource: 'default' }))
            .toEqual({ priority: ['editorSelection'] });
    });

    it('includes searchQuery when setting is searchQuery', () => {
        expect(insertLinkAliasPolicyFromSettings({ insertLinkAliasSource: 'searchQuery' }))
            .toEqual({ priority: ['editorSelection', 'searchQuery'] });
    });
});

describe('buildNoteLink', () => {
    const file = { path: 'folder/Note Title.md', extension: 'md' } as TFile;

    it('uses generateMarkdownLink when active file exists', () => {
        const app = {
            workspace: { getActiveFile: () => ({ path: 'Daily.md' }) },
            fileManager: {
                generateMarkdownLink: (
                    f: TFile,
                    source: string,
                    subpath: string,
                    alias: string,
                ) => `LINK:${f.path}:${source}:${subpath}:${alias}`,
            },
        } as unknown as App;

        expect(buildNoteLink(app, file, { subpath: '#Sec', alias: 'alias' }))
            .toBe('LINK:folder/Note Title.md:Daily.md:#Sec:alias');
    });

    it('falls back to wikilink syntax without active file', () => {
        const app = {
            workspace: { getActiveFile: () => null },
            fileManager: { generateMarkdownLink: () => 'unused' },
        } as unknown as App;

        expect(buildNoteLink(app, file)).toBe('[[Note Title]]');
        expect(buildNoteLink(app, file, { subpath: '#H', alias: 'test' }))
            .toBe('[[Note Title#H|test]]');
    });
});
