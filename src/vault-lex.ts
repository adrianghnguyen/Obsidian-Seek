// Vault-file lexical index for the progressive ladder during Starting.
//
// Name match and BM25 must not wait on the IDB resident frame (ensureFrame /
// listAllMeta / getBodiesMap) or join warmCaches / currentDelta / isWriting —
// those contend with boot hydrate and miss the 10s first-good SLO.
//
// Memory / process-lock budget:
//   • One MiniSearch doc per markdown file (not per chunk).
//   • Bodies: only the newest N files, capped in bytes. Never cachedRead the
//     whole vault. Title / alias / tag / heading fields come from metadataCache
//     (already in RAM) for every file.
//   • Yields between body reads and MiniSearch slices so boot I/O and the UI
//     thread keep running.
//   • No IndexStore calls. No write mutex. One in-flight fit, joined not duplicated.

import type { TFile } from 'obsidian';
import type { ChunkMeta } from './types';
import { MultiFieldBM25 } from './bm25';
import { noteBasename } from './name-match';

export const VAULT_LEX_BODY_MAX_FILES = 64;
export const VAULT_LEX_BODY_MAX_BYTES = 512 * 1024;
export const VAULT_LEX_YIELD_EVERY = 8;

export interface FileCacheLite {
    frontmatter?: Record<string, unknown>;
    headings?: Array<{ heading: string }>;
    tags?: Array<{ tag: string }>;
}

export interface VaultLexIndex {
    signature: string;
    chunks: ChunkMeta[];
    bm25: MultiFieldBM25;
    bodies: Map<string, string>;
    fileCount: number;
    bodiesIndexed: number;
}

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n?/;

export function vaultFileSignature(files: Array<{ path: string; stat: { mtime: number } }>): string {
    let max = 0;
    for (const f of files) if (f.stat.mtime > max) max = f.stat.mtime;
    return `${files.length}:${max}`;
}

export function fileCacheAliases(cache: FileCacheLite | null | undefined): string[] {
    const fm = cache?.frontmatter;
    if (!fm) return [];
    const raw = fm.aliases ?? fm.alias;
    if (Array.isArray(raw)) return raw.map(v => String(v)).filter(Boolean);
    if (typeof raw === 'string' && raw.trim()) return [raw];
    return [];
}

export function fileCacheTags(cache: FileCacheLite | null | undefined): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (raw: string) => {
        const t = raw.replace(/^#/, '').trim();
        if (!t || seen.has(t)) return;
        seen.add(t);
        out.push(t);
    };
    if (cache?.tags) for (const t of cache.tags) add(t.tag);
    const fm = cache?.frontmatter?.tags;
    if (Array.isArray(fm)) for (const t of fm) add(String(t));
    else if (typeof fm === 'string') add(fm);
    return out;
}

export function fileCacheHeadings(cache: FileCacheLite | null | undefined): string[] {
    return (cache?.headings ?? []).map(h => h.heading).filter(Boolean);
}

export function vaultChunkId(path: string): string {
    return `vault:${path}`;
}

export function vaultFileToMeta(file: TFile, cache: FileCacheLite | null | undefined): ChunkMeta {
    const title = noteBasename(file.path);
    const modified = file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : null;
    return {
        chunk_id: vaultChunkId(file.path),
        title,
        note_path: file.path,
        heading_path: fileCacheHeadings(cache),
        metadata: {
            tags: fileCacheTags(cache),
            aliases: fileCacheAliases(cache),
            created: null,
            modified,
            properties: {},
        },
        start_line: 1,
        end_line: 1,
        lexicalOnly: true,
    };
}

export function stripFrontmatter(text: string): string {
    return text.replace(FRONTMATTER_RE, '');
}

export function aliasesFromMarkdown(text: string): string[] {
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(text);
    if (!m) return [];
    const block = m[1];
    const dashed = /^(?:aliases|alias)\s*:\s*\n((?:[ \t]*-[ \t]*.+\n?)*)/im.exec(`${block}\n`);
    if (dashed) {
        const list: string[] = [];
        for (const line of dashed[1].split('\n')) {
            const item = /^\s*-\s+(.+)/.exec(line);
            if (item) list.push(item[1].trim().replace(/^["']|["']$/g, ''));
        }
        if (list.length) return list;
    }
    const inline = /^(?:aliases|alias)\s*:\s*\[([^\]]*)\]/im.exec(block);
    if (inline) {
        return inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    return [];
}

export function pickRecentForBodies<T extends { stat: { mtime: number; size?: number } }>(
    files: T[],
    maxFiles = VAULT_LEX_BODY_MAX_FILES,
    maxBytes = VAULT_LEX_BODY_MAX_BYTES,
): T[] {
    const ranked = files.slice().sort((a, b) => b.stat.mtime - a.stat.mtime);
    const out: T[] = [];
    let bytes = 0;
    for (const f of ranked) {
        if (out.length >= maxFiles) break;
        const size = f.stat.size ?? 0;
        if (out.length > 0 && bytes + size > maxBytes) break;
        out.push(f);
        bytes += size;
    }
    return out;
}

export async function buildVaultLexIndex(
    files: TFile[],
    cacheOf: (file: TFile) => FileCacheLite | null | undefined,
    read: (file: TFile) => Promise<string>,
    opts: {
        searchableProperties: boolean;
        headingsField: boolean;
        yieldFn: () => Promise<void>;
        signal?: AbortSignal;
        maxBodyFiles?: number;
        maxBodyBytes?: number;
    },
): Promise<VaultLexIndex> {
    const throwIfAborted = (): void => {
        if (opts.signal?.aborted) {
            throw Object.assign(new Error('Query superseded'), { name: 'AbortError', code: 'ABORTED' });
        }
    };
    const chunks: ChunkMeta[] = [];
    for (let i = 0; i < files.length; i++) {
        chunks.push(vaultFileToMeta(files[i], cacheOf(files[i])));
        if ((i + 1) % 500 === 0) {
            throwIfAborted();
            await opts.yieldFn();
        }
    }
    const bodies = new Map<string, string>();
    const recent = pickRecentForBodies(files, opts.maxBodyFiles, opts.maxBodyBytes);
    for (let i = 0; i < recent.length; i++) {
        throwIfAborted();
        try {
            const raw = await read(recent[i]);
            const id = vaultChunkId(recent[i].path);
            bodies.set(id, stripFrontmatter(raw));
            const fromBody = aliasesFromMarkdown(raw);
            if (fromBody.length > 0) {
                const chunk = chunks.find(c => c.chunk_id === id);
                if (chunk && chunk.metadata.aliases.length === 0) chunk.metadata.aliases = fromBody;
            }
        } catch {
            /* unreadable / iCloud placeholder — title fields still index */
        }
        if ((i + 1) % VAULT_LEX_YIELD_EVERY === 0) await opts.yieldFn();
    }
    throwIfAborted();
    const bm25 = await new MultiFieldBM25().fitAsync(
        chunks,
        bodies,
        { searchableProperties: opts.searchableProperties, headingsField: opts.headingsField },
        opts.yieldFn,
    );
    return {
        signature: vaultFileSignature(files),
        chunks,
        bm25,
        bodies,
        fileCount: files.length,
        bodiesIndexed: bodies.size,
    };
}
