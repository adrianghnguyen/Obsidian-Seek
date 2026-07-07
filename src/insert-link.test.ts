import { describe, expect, it } from 'vitest';
import type { App, TFile } from 'obsidian';
import {
    buildNoteLink,
    headingSubpath,
    insertLinkAliasPolicyFromSettings,
    resolveInsertLinkAlias,
    resolveInsertLinkSubpath,
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

describe('resolveInsertLinkSubpath', () => {
    const sectionPath = ['Agenda', 'Intern pgm'];

    it('returns empty subpath by default', () => {
        expect(resolveInsertLinkSubpath(sectionPath, {})).toBe('');
        expect(resolveInsertLinkSubpath(sectionPath, { insertLinkIncludeHeading: false })).toBe('');
    });

    it('includes heading when setting is on', () => {
        expect(resolveInsertLinkSubpath(sectionPath, { insertLinkIncludeHeading: true })).toBe('#Intern pgm');
    });

    it('returns empty subpath for empty heading paths', () => {
        expect(resolveInsertLinkSubpath([], { insertLinkIncludeHeading: true })).toBe('');
        expect(resolveInsertLinkSubpath(null, { insertLinkIncludeHeading: true })).toBe('');
    });
});

describe('resolveInsertLinkAlias', () => {
    const selectionOnlyPolicy: InsertLinkAliasPolicy = { priority: ['editorSelection'] };
    const defaultPolicy: InsertLinkAliasPolicy = { priority: ['editorSelection', 'searchQuery'] };

    it('prefers explicit alias', () => {
        expect(resolveInsertLinkAlias({
            explicitAlias: 'cli alias',
            editorSelection: 'sel',
            searchQueryText: 'q',
        }, selectionOnlyPolicy)).toBe('cli alias');
    });

    it('uses editor selection when present', () => {
        expect(resolveInsertLinkAlias({
            editorSelection: 'selected words',
            searchQueryText: 'test',
        }, defaultPolicy)).toBe('selected words');
    });

    it('ignores search query when policy is selection-only', () => {
        expect(resolveInsertLinkAlias({
            searchQueryText: 'test',
        }, selectionOnlyPolicy)).toBeUndefined();
    });

    it('falls back to search query in default policy', () => {
        expect(resolveInsertLinkAlias({
            searchQueryText: 'test',
        }, defaultPolicy)).toBe('test');
    });

    it('selection wins over search query in default policy', () => {
        expect(resolveInsertLinkAlias({
            editorSelection: 'sel',
            searchQueryText: 'test',
        }, defaultPolicy)).toBe('sel');
    });
});

describe('insertLinkAliasPolicyFromSettings', () => {
    it('defaults to selection + search query', () => {
        expect(insertLinkAliasPolicyFromSettings({})).toEqual({
            priority: ['editorSelection', 'searchQuery'],
        });
        expect(insertLinkAliasPolicyFromSettings({ insertLinkQueryAlias: true })).toEqual({
            priority: ['editorSelection', 'searchQuery'],
        });
    });

    it('is selection-only when toggle is off', () => {
        expect(insertLinkAliasPolicyFromSettings({ insertLinkQueryAlias: false })).toEqual({
            priority: ['editorSelection'],
        });
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
