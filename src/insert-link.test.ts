import { describe, expect, it } from 'vitest';
import type { App, TFile } from 'obsidian';
import {
    buildNoteLink,
    headingSubpath,
    resolveInsertLinkAlias,
    resolveInsertLinkAliasForMode,
    resolveInsertLinkSubpath,
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

describe('resolveInsertLinkAliasForMode', () => {
    it('returns undefined for plain mode regardless of search text', () => {
        expect(resolveInsertLinkAliasForMode('plain', 'hello')).toBeUndefined();
        expect(resolveInsertLinkAliasForMode('plain', null)).toBeUndefined();
    });

    it('uses search free text in searchAlias mode', () => {
        expect(resolveInsertLinkAliasForMode('searchAlias', 'hello world')).toBe('hello world');
    });

    it('returns undefined when searchAlias mode has empty free text', () => {
        expect(resolveInsertLinkAliasForMode('searchAlias', '   ')).toBeUndefined();
        expect(resolveInsertLinkAliasForMode('searchAlias', null)).toBeUndefined();
    });
});

describe('resolveInsertLinkAlias', () => {
    it('returns trimmed explicit alias for CLI', () => {
        expect(resolveInsertLinkAlias('  cli alias  ')).toBe('cli alias');
    });

    it('returns undefined when no explicit alias', () => {
        expect(resolveInsertLinkAlias(undefined)).toBeUndefined();
        expect(resolveInsertLinkAlias('')).toBeUndefined();
        expect(resolveInsertLinkAlias('   ')).toBeUndefined();
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
