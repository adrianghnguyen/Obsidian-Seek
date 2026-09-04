/**
 * @file cli-handlers.ts
 * @module CliHandlers
 *
 * ## Responsibilities
 * Headless CLI bridge exposing Seek search and navigation to the `obsidian-cli` IPC interface:
 * - `seek:search`: Runs semantic hybrid search, returning structured JSON or human-readable text.
 *   Supports recency overrides (`recencyWeight`, `recencyHalflife`) and candidate limits.
 * - `seek:open`: Searches the vault and opens the top (or Nth ranked) hit in the active or target
 *   pane (`tab`, `split`, `window`), navigating directly to the matched heading anchor if present.
 * - `seek:insert-link`: Searches the vault and inserts a markdown link (`[[note#heading|alias]]`)
 *   at the current cursor position in the active Markdown editor.
 *
 * ## Order Dependencies & Lifecycle
 * - **Dependency tier**: Host Integration / Interface Adapter.
 * - **Registration**: Mounted in `SeekPlugin.onload()` via `registerSeekCliHandlers(this)`.
 * - **Serial Execution Invariant**:
 *   - Obsidian's CLI IPC uses a single, serial message queue. CLI commands MUST NOT be executed
 *     concurrently or pipelined without waiting for earlier commands to finish.
 * - **Query / Indexing Coordination**:
 *   - Calls `host.cliSearchGateMessage()` to verify the search index is warm and ready before querying.
 *   - Queries are wrapped in `host.withQueryInFlight()`, which signals `PluginSchedulerManager`
 *     to defer background incremental flushes while a CLI query is actively executing.
 */

import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import type { SeekSettings, ScoredChunk, SearchEntry } from './types';
import type { SearchOrchestrator, RecencyOverride } from './search';
import { parsePaneType, type OpenTarget } from './open-target';
import {
    buildNoteLink,
    insertLinkInEditor,
    isInsertableMarkdownFile,
    resolveInsertLinkAlias,
    resolveInsertLinkSubpath,
} from './insert-link';
import { CLI_SEARCH_WARMING } from './index-notice';

export interface SeekCliHost {
    app: App;
    settings: SeekSettings;
    orchestrator: SearchOrchestrator | null;
    cliSearchGateMessage(): Promise<string | null>;
    withQueryInFlight<T>(work: () => Promise<T>): Promise<T>;
    ensureModelLoaded(): Promise<void>;
    openIndexedFile(file: TFile, hit: { heading_path?: string[] }, target: OpenTarget): Promise<void>;
    registerCliHandler?: (
        id: string,
        description: string,
        params: Record<string, { value?: string; description: string; required: boolean }>,
        handler: (args: Record<string, string | boolean | undefined>) => Promise<string>,
    ) => void;
}

/**
 * Registers headless CLI query handlers:
 * - `seek:search query="..." [limit=N] [format=text|json] [recencyWeight=ε] [recencyHalflife=days]`
 * - `seek:open query="..." [paneType=tab|split|window] [rank=N]`
 * - `seek:insert-link query="..." [rank=N] [alias=text] [heading=true|false]`
 */
export function registerSeekCliHandlers(host: SeekCliHost): void {
    const registerCliHandler = (host as unknown as {
        registerCliHandler?: (
            id: string,
            description: string,
            params: Record<string, { value?: string; description: string; required: boolean }>,
            handler: (args: Record<string, string | boolean | undefined>) => Promise<string>,
        ) => void;
    }).registerCliHandler;

    if (typeof registerCliHandler !== 'function') {
        return;
    }

    registerCliHandler.call(
        host,
        'seek:search',
        'Seek on-device semantic search (hybrid BM25 + dense embeddings + recency)',
        {
            query: { value: '<text>', description: 'Search query (supports inline filters: #tag, tag:, path:, [k:v], dates)', required: true },
            limit: { value: '<n>', description: 'Max results (default: 10)', required: false },
            format: { value: 'text|json', description: 'Output format (default: text — readable list; json for programmatic use)', required: false },
            recencyWeight: { value: '<ε>', description: 'Override recency weight ε for THIS query only (additive; default 0.02). Not persisted — for scrobbling recency configs.', required: false },
            recencyHalflife: { value: '<days>', description: 'Override recency half-life in days for THIS query only (default 180). Not persisted.', required: false },
        },
        async (args: Record<string, string | boolean | undefined>): Promise<string> => {
            const query = typeof args.query === 'string' ? args.query : '';
            const asJson = args.format === 'json';
            const fail = (msg: string): string =>
                asJson ? JSON.stringify({ error: msg, results: [] }) : `Seek error: ${msg}`;

            if (!query) return fail('query is required');
            const orchestrator = host.orchestrator;
            if (!orchestrator) return fail('Seek not initialized — plugin still loading');

            const gate = await host.cliSearchGateMessage();
            const warming = gate === CLI_SEARCH_WARMING;
            if (gate && !warming) return asJson ? JSON.stringify({ error: gate, results: [], ready: false }) : gate;
            if (asJson && warming) return JSON.stringify({ error: gate, results: [], ready: false, warming: true });

            const parsedLimit = typeof args.limit === 'string' ? parseInt(args.limit, 10) : NaN;
            const topK = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 10;

            const ovEps = typeof args.recencyWeight === 'string' ? parseFloat(args.recencyWeight) : NaN;
            const ovHl = typeof args.recencyHalflife === 'string' ? parseFloat(args.recencyHalflife) : NaN;
            const recencyOverride: RecencyOverride | undefined =
                (Number.isFinite(ovEps) && ovEps >= 0) || (Number.isFinite(ovHl) && ovHl > 0)
                    ? {
                          ...(Number.isFinite(ovEps) && ovEps >= 0 ? { epsilon: ovEps } : {}),
                          ...(Number.isFinite(ovHl) && ovHl > 0 ? { halfLifeDays: ovHl } : {}),
                      }
                    : undefined;

            try {
                const run = warming
                    ? async (): Promise<{ results: ScoredChunk[]; entry: SearchEntry | null }> => ({
                        results: (await orchestrator.searchLexicalOnly(query, topK)).results,
                        entry: null,
                    })
                    : async (): Promise<{ results: ScoredChunk[]; entry: SearchEntry | null }> => {
                        return host.withQueryInFlight(async () => {
                            await host.ensureModelLoaded();
                            return orchestrator.search(query, topK, recencyOverride);
                        });
                    };

                const { results, entry } = await run();
                const mapped = results.map(r => ({
                    path: r.note_path,
                    title: r.displayTitle ?? r.title,
                    score: r.score,
                    excerpt: r.snippet ?? '',
                }));
                if (asJson) {
                    const payload: Record<string, unknown> = { results: mapped, query, count: mapped.length };
                    if (warming) {
                        payload.warming = CLI_SEARCH_WARMING;
                        payload.ready = false;
                    } else if (entry) {
                        payload.nameEarlyPainted = entry.nameEarlyPainted;
                        payload.namePartialMs = entry.namePartialMs;
                    }
                    return JSON.stringify(payload);
                }

                if (results.length === 0) return `Seek · "${query}" · no results`;

                const INDENT = ' '.repeat(11);
                const lines: string[] = [
                    `Seek · "${query}" · ${results.length} result${results.length === 1 ? '' : 's'}`,
                    '',
                ];
                results.forEach((r, i) => {
                    lines.push(`${String(i + 1).padStart(2, ' ')}  ${r.score.toFixed(3)}  ${r.note_path}`);
                    const excerpt = (r.snippet ?? '').replace(/\s+/g, ' ').trim();
                    if (excerpt) lines.push(`${INDENT}${excerpt.length > 160 ? excerpt.slice(0, 159) + '…' : excerpt}`);
                    lines.push('');
                });
                return lines.join('\n').replace(/\n+$/, '');
            } catch (err) {
                return fail(err instanceof Error ? err.message : String(err));
            }
        },
    );

    registerCliHandler.call(
        host,
        'seek:open',
        'Seek search and open a result in the active tab, new tab, or split pane',
        {
            query: { value: '<text>', description: 'Search query (supports inline filters: #tag, tag:, path:, [k:v], dates)', required: true },
            paneType: { value: 'tab|split|window', description: 'Pane to open in (default: active tab)', required: false },
            rank: { value: '<n>', description: '1-based result rank to open (default: 1)', required: false },
        },
        async (args: Record<string, string | boolean | undefined>): Promise<string> => {
            const query = typeof args.query === 'string' ? args.query : '';
            if (!query) return 'Seek error: query is required';
            const orchestrator = host.orchestrator;
            if (!orchestrator) return 'Seek error: Seek not initialized — plugin still loading';

            const gate = await host.cliSearchGateMessage();
            if (gate) return gate;

            const parsedRank = typeof args.rank === 'string' ? parseInt(args.rank, 10) : NaN;
            const rank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;
            const target = parsePaneType(typeof args.paneType === 'string' ? args.paneType : undefined);

            try {
                const { results } = await host.withQueryInFlight(async () => {
                    await host.ensureModelLoaded();
                    return orchestrator.search(query, rank);
                });
                const hit = results[rank - 1];
                if (!hit) return `Seek error: no result at rank ${rank} for "${query}"`;
                const file = host.app.vault.getAbstractFileByPath(hit.note_path);
                if (!(file instanceof TFile)) return `Seek error: result not on disk (${hit.note_path})`;
                await host.openIndexedFile(file, hit, target);
                return hit.note_path;
            } catch (err) {
                return `Seek error: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    );

    registerCliHandler.call(
        host,
        'seek:insert-link',
        'Seek search and insert a link to a result at the active editor cursor',
        {
            query: { value: '<text>', description: 'Search query (supports inline filters: #tag, tag:, path:, [k:v], dates)', required: true },
            rank: { value: '<n>', description: '1-based result rank to link (default: 1)', required: false },
            alias: { value: '<text>', description: 'Optional link display text ([[note|alias]])', required: false },
            heading: { value: '<true|false>', description: 'Include #heading for section hits (default: setting)', required: false },
        },
        async (args: Record<string, string | boolean | undefined>): Promise<string> => {
            const query = typeof args.query === 'string' ? args.query : '';
            if (!query) return 'Seek error: query is required';
            const orchestrator = host.orchestrator;
            if (!orchestrator) return 'Seek error: Seek not initialized — plugin still loading';

            const gate = await host.cliSearchGateMessage();
            if (gate) return gate;

            const parsedRank = typeof args.rank === 'string' ? parseInt(args.rank, 10) : NaN;
            const rank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;
            const explicitAlias = typeof args.alias === 'string' && args.alias.trim()
                ? args.alias.trim()
                : undefined;
            const alias = resolveInsertLinkAlias(explicitAlias);
            const headingArg = args.heading;
            const subpathSettings = headingArg === true || headingArg === 'true'
                ? { insertLinkIncludeHeading: true as const }
                : headingArg === false || headingArg === 'false'
                    ? { insertLinkIncludeHeading: false as const }
                    : host.settings;

            try {
                const { results } = await host.withQueryInFlight(async () => {
                    await host.ensureModelLoaded();
                    return orchestrator.search(query, rank);
                });
                const hit = results[rank - 1];
                if (!hit) return `Seek error: no result at rank ${rank} for "${query}"`;
                const file = host.app.vault.getAbstractFileByPath(hit.note_path);
                if (!(file instanceof TFile) || !isInsertableMarkdownFile(file)) {
                    return `Seek error: result is not a markdown note (${hit.note_path})`;
                }
                const link = buildNoteLink(host.app, file, {
                    subpath: resolveInsertLinkSubpath(hit.heading_path, subpathSettings),
                    alias,
                });
                const inserted = insertLinkInEditor(host.app, link);
                if (!inserted.ok) return `Seek error: ${inserted.reason}`;
                return link;
            } catch (err) {
                return `Seek error: ${err instanceof Error ? err.message : String(err)}`;
            }
        },
    );
}
