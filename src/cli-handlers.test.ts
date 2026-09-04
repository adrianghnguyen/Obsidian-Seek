import { describe, it, expect, vi } from 'vitest';
import { registerSeekCliHandlers, type SeekCliHost } from './cli-handlers';
import { CLI_SEARCH_WARMING } from './index-notice';
import { TFile } from 'obsidian';

describe('registerSeekCliHandlers', () => {
    it('gracefully returns if registerCliHandler is not provided on host', () => {
        const host: SeekCliHost = {
            app: {} as any,
            settings: {} as any,
            orchestrator: {} as any,
            cliSearchGateMessage: async () => null,
            withQueryInFlight: async fn => fn(),
            ensureModelLoaded: async () => {},
            openIndexedFile: async () => {},
        };
        expect(() => registerSeekCliHandlers(host)).not.toThrow();
    });

    it('registers seek:search, seek:open, and seek:insert-link handlers', () => {
        const registered: Record<string, Function> = {};
        const host: SeekCliHost = {
            app: {} as any,
            settings: {} as any,
            orchestrator: {} as any,
            cliSearchGateMessage: async () => null,
            withQueryInFlight: async fn => fn(),
            ensureModelLoaded: async () => {},
            openIndexedFile: async () => {},
            registerCliHandler: (id, desc, params, handler) => {
                registered[id] = handler;
            },
        };

        registerSeekCliHandlers(host);

        expect(registered['seek:search']).toBeDefined();
        expect(registered['seek:open']).toBeDefined();
        expect(registered['seek:insert-link']).toBeDefined();
    });

    describe('seek:search handler', () => {
        it('returns error when query is empty', async () => {
            const registered: Record<string, Function> = {};
            const host: SeekCliHost = {
                app: {} as any,
                settings: {} as any,
                orchestrator: {} as any,
                cliSearchGateMessage: async () => null,
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: async () => {},
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            const resText = await registered['seek:search']({ query: '' });
            expect(resText).toBe('Seek error: query is required');

            const resJson = await registered['seek:search']({ query: '', format: 'json' });
            expect(JSON.parse(resJson)).toEqual({ error: 'query is required', results: [] });
        });

        it('returns error if orchestrator is not initialized', async () => {
            const registered: Record<string, Function> = {};
            const host: SeekCliHost = {
                app: {} as any,
                settings: {} as any,
                orchestrator: null,
                cliSearchGateMessage: async () => null,
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: async () => {},
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            const resText = await registered['seek:search']({ query: 'test' });
            expect(resText).toContain('Seek not initialized');
        });

        it('returns gate message when gate is active and not warming', async () => {
            const registered: Record<string, Function> = {};
            const host: SeekCliHost = {
                app: {} as any,
                settings: {} as any,
                orchestrator: {} as any,
                cliSearchGateMessage: async () => 'Seek is reindexing (42%)',
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: async () => {},
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            const res = await registered['seek:search']({ query: 'test' });
            expect(res).toBe('Seek is reindexing (42%)');

            const resJson = JSON.parse(await registered['seek:search']({ query: 'test', format: 'json' }));
            expect(resJson.error).toBe('Seek is reindexing (42%)');
            expect(resJson.ready).toBe(false);
        });

        it('formats human readable text when results are found', async () => {
            const registered: Record<string, Function> = {};
            const mockSearch = vi.fn().mockResolvedValue({
                results: [
                    { note_path: 'Notes/Alpha.md', title: 'Alpha', score: 0.954, snippet: 'Excerpt from Alpha note' },
                    { note_path: 'Notes/Beta.md', title: 'Beta', score: 0.821, snippet: 'Excerpt from Beta note' },
                ],
                entry: { nameEarlyPainted: false, namePartialMs: 0 },
            });

            const host: SeekCliHost = {
                app: {} as any,
                settings: {} as any,
                orchestrator: { search: mockSearch } as any,
                cliSearchGateMessage: async () => null,
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: async () => {},
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            const out = await registered['seek:search']({ query: 'test query', limit: '5' });
            expect(out).toContain('Seek · "test query" · 2 results');
            expect(out).toContain('0.954  Notes/Alpha.md');
            expect(out).toContain('Excerpt from Alpha note');
        });

        it('formats json output when format=json', async () => {
            const registered: Record<string, Function> = {};
            const mockSearch = vi.fn().mockResolvedValue({
                results: [
                    { note_path: 'Notes/Alpha.md', title: 'Alpha', score: 0.954, snippet: 'Excerpt' },
                ],
                entry: { nameEarlyPainted: true, namePartialMs: 12 },
            });

            const host: SeekCliHost = {
                app: {} as any,
                settings: {} as any,
                orchestrator: { search: mockSearch } as any,
                cliSearchGateMessage: async () => null,
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: async () => {},
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            const out = JSON.parse(await registered['seek:search']({ query: 'test', format: 'json' }));
            expect(out.query).toBe('test');
            expect(out.count).toBe(1);
            expect(out.nameEarlyPainted).toBe(true);
            expect(out.results[0].path).toBe('Notes/Alpha.md');
        });

        it('falls back to searchLexicalOnly when warming on text format, and returns warming json on json format', async () => {
            const registered: Record<string, Function> = {};
            const mockLexical = vi.fn().mockResolvedValue({
                results: [
                    { note_path: 'Notes/Lex.md', title: 'Lex', score: 0.75, snippet: 'Lex excerpt' },
                ],
            });
            const mockSearch = vi.fn();

            const host: SeekCliHost = {
                app: {} as any,
                settings: {} as any,
                orchestrator: { searchLexicalOnly: mockLexical, search: mockSearch } as any,
                cliSearchGateMessage: async () => CLI_SEARCH_WARMING,
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: async () => {},
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            // On json format: returns early with warming JSON
            const outJson = JSON.parse(await registered['seek:search']({ query: 'warming query', format: 'json' }));
            expect(outJson.warming).toBe(true);
            expect(outJson.ready).toBe(false);
            expect(mockLexical).not.toHaveBeenCalled();

            // On text format: runs lexical search fallback
            const outText = await registered['seek:search']({ query: 'warming query' });
            expect(mockLexical).toHaveBeenCalledWith('warming query', 10);
            expect(outText).toContain('Notes/Lex.md');
        });
    });

    describe('seek:open handler', () => {
        it('opens target file at requested rank', async () => {
            const registered: Record<string, Function> = {};
            const mockFile = new (TFile as any)();
            mockFile.path = 'Notes/Second.md';

            const openSpy = vi.fn();
            const host: SeekCliHost = {
                app: {
                    vault: {
                        getAbstractFileByPath: (p: string) => (p === 'Notes/Second.md' ? mockFile : null),
                    },
                } as any,
                settings: {} as any,
                orchestrator: {
                    search: vi.fn().mockResolvedValue({
                        results: [
                            { note_path: 'Notes/First.md' },
                            { note_path: 'Notes/Second.md', heading_path: ['Header'] },
                        ],
                    }),
                } as any,
                cliSearchGateMessage: async () => null,
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: openSpy,
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            const res = await registered['seek:open']({ query: 'find note', rank: '2', paneType: 'split' });
            expect(res).toBe('Notes/Second.md');
            expect(openSpy).toHaveBeenCalledWith(mockFile, { note_path: 'Notes/Second.md', heading_path: ['Header'] }, 'split');
        });
    });

    describe('seek:insert-link handler', () => {
        it('builds and inserts markdown link in editor', async () => {
            const registered: Record<string, Function> = {};
            const mockFile = new (TFile as any)();
            mockFile.path = 'Guides/Start.md';
            mockFile.basename = 'Start';
            mockFile.extension = 'md';

            let insertedContent = '';
            const host: SeekCliHost = {
                app: {
                    vault: {
                        getAbstractFileByPath: () => mockFile,
                    },
                    workspace: {
                        getActiveFile: () => null,
                        getActiveViewOfType: () => ({
                            editor: {
                                getCursor: () => ({ line: 0, ch: 0 }),
                                replaceRange: (text: string) => {
                                    insertedContent = text;
                                },
                                posToOffset: () => 0,
                                offsetToPos: () => ({ line: 0, ch: 0 }),
                                setCursor: () => {},
                            },
                        }),
                    },
                    metadataCache: {
                        fileToLinktext: () => 'Start',
                    },
                } as any,
                settings: { insertLinkIncludeHeading: false } as any,
                orchestrator: {
                    search: vi.fn().mockResolvedValue({
                        results: [
                            { note_path: 'Guides/Start.md', heading_path: ['Intro'] },
                        ],
                    }),
                } as any,
                cliSearchGateMessage: async () => null,
                withQueryInFlight: async fn => fn(),
                ensureModelLoaded: async () => {},
                openIndexedFile: async () => {},
                registerCliHandler: (id, desc, params, handler) => {
                    registered[id] = handler;
                },
            };
            registerSeekCliHandlers(host);

            const res = await registered['seek:insert-link']({ query: 'start guide', alias: 'My Guide' });
            expect(res).toBe('[[Start|My Guide]]');
            expect(insertedContent).toBe('[[Start|My Guide]]');
        });
    });
});
