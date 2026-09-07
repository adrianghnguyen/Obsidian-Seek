import { describe, it, expect } from 'vitest';
import type { App } from 'obsidian';
import type { SeekSettings } from './types';
import {
    shouldIndexPath,
    normalizeExcludedFolderPath,
    isUnderExcludedFolder,
    isSeekExcludedPath,
} from './search';

function fakeApp(opts: { ignored?: string[] } = {}): App {
    const ignored = new Set(opts.ignored ?? []);
    return {
        metadataCache: {
            isUserIgnored: (p: string) => ignored.has(p) || [...ignored].some(f => p.startsWith(f + '/')),
        },
        vault: {},
    } as unknown as App;
}

function settings(partial: Partial<SeekSettings> = {}): SeekSettings {
    return {
        honorIgnoredFolders: true,
        customExcludedFolders: [],
        ...partial,
    } as SeekSettings;
}

describe('normalizeExcludedFolderPath', () => {
    it('trims whitespace and leading/trailing slashes', () => {
        expect(normalizeExcludedFolderPath('  /Archive/old/  ')).toBe('Archive/old');
    });

    it('collapses duplicate slashes and normalizes backslashes', () => {
        expect(normalizeExcludedFolderPath('Archive\\\\old//notes')).toBe('Archive/old/notes');
    });

    it('returns empty for blank input', () => {
        expect(normalizeExcludedFolderPath('   ')).toBe('');
        expect(normalizeExcludedFolderPath('///')).toBe('');
    });
});

describe('isUnderExcludedFolder', () => {
    it('matches the folder itself and descendants', () => {
        expect(isUnderExcludedFolder('Archive', 'Archive')).toBe(true);
        expect(isUnderExcludedFolder('Archive', 'Archive/note.md')).toBe(true);
        expect(isUnderExcludedFolder('Archive', 'Archive/sub/note.md')).toBe(true);
    });

    it('does not match a sibling prefix (Archive vs Archive2)', () => {
        expect(isUnderExcludedFolder('Archive', 'Archive2/note.md')).toBe(false);
        expect(isUnderExcludedFolder('Archive', 'notes/Archive.md')).toBe(false);
    });

    it('matches nested folder prefixes', () => {
        expect(isUnderExcludedFolder('Archive/sub', 'Archive/sub/a.md')).toBe(true);
        expect(isUnderExcludedFolder('Archive/sub', 'Archive/other.md')).toBe(false);
    });
});

describe('shouldIndexPath — customExcludedFolders', () => {
    it('excludes paths under a custom folder', () => {
        const app = fakeApp();
        const s = settings({ customExcludedFolders: ['Private'] });
        expect(shouldIndexPath(app, s, 'Private/secret.md')).toBe(false);
        expect(shouldIndexPath(app, s, 'Notes/ok.md')).toBe(true);
    });

    it('is additive with Obsidian excludes when honorIgnoredFolders is on', () => {
        const app = fakeApp({ ignored: ['Archive'] });
        const s = settings({
            honorIgnoredFolders: true,
            customExcludedFolders: ['Private'],
        });
        expect(shouldIndexPath(app, s, 'Archive/old.md')).toBe(false);
        expect(shouldIndexPath(app, s, 'Private/x.md')).toBe(false);
        expect(shouldIndexPath(app, s, 'Notes/ok.md')).toBe(true);
    });

    it('still applies custom excludes when honorIgnoredFolders is off', () => {
        const app = fakeApp({ ignored: ['Archive'] });
        const s = settings({
            honorIgnoredFolders: false,
            customExcludedFolders: ['Private'],
        });
        expect(shouldIndexPath(app, s, 'Archive/old.md')).toBe(true);
        expect(shouldIndexPath(app, s, 'Private/x.md')).toBe(false);
    });

    it('still excludes Seek artifact paths regardless of settings', () => {
        const app = fakeApp();
        const s = settings({ honorIgnoredFolders: false, customExcludedFolders: [] });
        expect(shouldIndexPath(app, s, 'seek-report.md')).toBe(false);
        expect(shouldIndexPath(app, s, '.seek-artifacts/foo.md')).toBe(false);
    });
});

describe('isSeekExcludedPath', () => {
    it('returns false for empty or missing list', () => {
        expect(isSeekExcludedPath(settings({ customExcludedFolders: [] }), 'a.md')).toBe(false);
        expect(isSeekExcludedPath({} as SeekSettings, 'a.md')).toBe(false);
    });
});
