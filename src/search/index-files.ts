// Vault-file planning and delta computation for the index. Pure functions over
// an explicit context — the file set, exclusion predicate, and dirty/deleted
// diff were previously private SearchOrchestrator methods. Extracted from
// search.ts, which keeps thin delegators so call sites are unchanged.

import type { App, TFile } from 'obsidian';
import type { Chunk, SeekSettings } from '../types/types';
import { MarkdownChunker, cyrb53Hex } from '../index/chunker';
import { extractBaseDocs } from '../index/base-extractor';
import { classifyFileDelta, type FileRecord, type IndexStore } from '../index/index-store';
import { PLUGIN_VERSION } from '../embedding/embedder';
import { shouldIndexPath } from './path-filter';

export interface IndexFilesContext {
    app: App;
    store: IndexStore;
    settings: SeekSettings;
    chunker: MarkdownChunker;
    isQuarantined: (path: string) => boolean;
    quarantineUnreadable: (path: string) => void;
    // Seam for the live indexable-file set so computeDelta routes through the
    // orchestrator's overridable method (thin test harnesses stub it).
    indexableLiveFiles: () => TFile[];
}

    // The single index-membership predicate, shared by full reindex (the scan
    // filter) and every incremental path (computeDelta, reindexDelta). Live
    // events and full reindex MUST agree on what's in the index, or a
    // rename-into-Archive and a full reindex would disagree. Two unconditional
    // exclusions (Seek's own machine output) plus the user-toggleable "honor
    // ignored folders" — when on, Obsidian's "Excluded files" (e.g. Archive) are
    // out-of-index, so moving a note in is a soft-delete.
    export function shouldIndex(ctx: IndexFilesContext, path: string): boolean {
        return shouldIndexPath(ctx.app, ctx.settings, path);
    }

    // The candidate set for every collection site (reindexAll, computeDelta, and
    // the sidecar liveness oracles reChunkLive / collectLiveIds — all of which must
    // agree on the file set or base chunk_ids drift between writer and re-deriver).
    // getMarkdownFiles() is .md-only; we additionally index .base files (Obsidian
    // Bases — saved query/view definitions) via per-view synthetic documents. The
    // watcher in main.ts gates create/rename/delete on the same two extensions.
    export function indexableFiles(ctx: IndexFilesContext): TFile[] {
        const md = ctx.app.vault.getMarkdownFiles();
        if (!ctx.settings.indexBases) return md;
        const bases = ctx.app.vault.getFiles().filter(f => f.extension === 'base');
        return bases.length === 0 ? md : [...md, ...bases];
    }

    // Content → chunks for one file, branching by extension. A .base file isn't
    // markdown — it's a YAML view definition — so it goes through extractBaseDocs
    // (one synthetic doc per view) + chunkBase, which builds a base-level chunk
    // plus one per non-generic view (each title-boosted, dense + BM25, the view
    // name in the 3.0x headings field). Every chunk-PRODUCTION site routes through
    // here so the .md/.base split lives in one place — reChunkLive, collectLiveIds,
    // dedupViaSidecar and carryOverHydrate all call this, not chunkContent, so a
    // base chunk's id is identical wherever it is re-derived. `modifiedIso` matches
    // the chunker's `modified` param contract.
    export function chunksFor(ctx: IndexFilesContext, content: string, path: string, modifiedIso: string | null): Chunk[] {
        if (path.endsWith('.base')) {
            return ctx.chunker.chunkBase(extractBaseDocs(content, path), path, modifiedIso);
        }
        return ctx.chunker.chunkContent(content, path, undefined, modifiedIso);
    }

    // Diff the persisted index against the live vault — the authoritative,
    // idempotent catch-up computation used by the startup sweep and the post-serve
    // hook. `dirty` = indexable files whose mtime advanced past the stored record
    // (or were never indexed); `deleted` = previously-indexed paths now gone OR no
    // longer indexable (moved into an ignored folder, or honor-ignored toggled on)
    // — a single "not in the live indexable set" test covers both.
    // Boot/sync races can briefly yield an empty vault enumeration or a live set
    // far smaller than the persisted index. Applying the deleted sweep then marks
    // every stored path gone and catch-up's first burst wipes the corpus (G_eviction
    // probe 2026-08-28: removed≈16742, compaction-due fallback, 0 chunks).
    export function shouldDeferMassDelete(storedSize: number, liveCount: number, deletedCount: number): boolean {
        if (storedSize === 0 || deletedCount === 0) return false;
        if (liveCount === 0) return true;
        // Partial vault enumeration: deleted ≈ (stored − live) fakes a mass removal
        // (G_eviction 2026-08-28: live 4026 / stored 4473 → 447 spurious deletes).
        // Require a LARGE gap — when novel≈0, deleted ≡ stored−live always, so a
        // small real delete set (12 fixture leftovers on a 4.4k vault) must not
        // trip this arm.
        const enumGap = storedSize - liveCount;
        const minSuspiciousGap = Math.max(50, storedSize * 0.05);
        if (enumGap >= minSuspiciousGap && liveCount >= 50
            && deletedCount >= enumGap * 0.85
            && deletedCount <= enumGap * 1.15) {
            return true;
        }
        return storedSize >= 50
            && deletedCount >= storedSize * 0.9
            && liveCount < storedSize * 0.5;
    }

    export function indexableLiveFiles(ctx: IndexFilesContext): TFile[] {
        return indexableFiles(ctx).filter(f => shouldIndex(ctx, f.path));
    }

    /** Retry when the vault file list is still filling in (boot / sync). */
    export async function indexableLiveFilesWhenStored(ctx: IndexFilesContext, storedSize: number): Promise<TFile[]> {
        let live = ctx.indexableLiveFiles();
        if (storedSize === 0) return live;
        // Wait only while the snapshot still looks like truncated enumeration
        // (empty OR a large stored−live gap). A few leftover stored paths are
        // real deletes — do not burn 2s on every computeDelta for those.
        // live===0 MUST wait: that is the boot race (G_eviction / main vault
        // 2026-08-29: stored 4468, live 0). Bailing immediately skipped the
        // poll and reconcileOnLoad applied neither deletes nor dirty.
        for (let i = 0; i < 40; i++) {
            const enumDeleted = Math.max(0, storedSize - live.length);
            if (!shouldDeferMassDelete(storedSize, live.length, enumDeleted)) break;
            await new Promise(r => setTimeout(r, 50));
            live = ctx.indexableLiveFiles();
        }
        return live;
    }

    export async function computeDelta(ctx: IndexFilesContext): Promise<{ dirty: string[]; deleted: string[] }> {
        const records = await ctx.store.listFileRecords();
        const stored = new Map<string, FileRecord>();
        for (const r of records) stored.set(r.note_path, r);

        let live = await indexableLiveFilesWhenStored(ctx, stored.size);
        const livePaths = new Set(live.map(f => f.path));

        // mtime advanced ≠ edited. An iCloud / Drive sync re-stamps a synced
        // file's mtime without changing a byte — on iOS that fires every couple
        // seconds, and keyed on mtime alone it re-embeds identical content
        // forever (each embed blocks the mobile main thread → 1 fps, and the
        // churn drives the jetsam crash-loop). classifyFileDelta confirms the
        // bytes actually changed via the stored content hash before flagging
        // dirty; we only pay the read+hash ('check-bytes') for files whose mtime
        // moved, and the hash is a sync ~5 µs cyrb53, never the embedder, so it
        // can't itself jank the UI.
        const dirty: string[] = [];
        for (const f of live) {
            // A persistently-unreadable file (quarantineUnreadable) is excluded
            // from dirty entirely while its backoff is live — otherwise its
            // dropped record makes classifyFileDelta report 'dirty' forever (see
            // the quarantine field comment), wedging every computeDelta caller.
            if (ctx.isQuarantined(f.path)) continue;
            const prev = stored.get(f.path);
            let decision = classifyFileDelta(prev, f.stat.mtime, undefined, PLUGIN_VERSION);
            if (decision === 'check-bytes') {
                try {
                    decision = classifyFileDelta(prev, f.stat.mtime, cyrb53Hex(await ctx.app.vault.cachedRead(f)), PLUGIN_VERSION);
                } catch {
                    decision = 'dirty';   // unreadable → let the embed path decide
                    ctx.quarantineUnreadable(f.path); // give it this one attempt, then back off
                }
            }
            if (decision === 'dirty') dirty.push(f.path);
        }
        const deleted: string[] = [];
        for (const path of stored.keys()) {
            if (!livePaths.has(path)) deleted.push(path);
        }
        if (shouldDeferMassDelete(stored.size, live.length, deleted.length)) {
            console.warn('[seek] computeDelta: deferring suspicious mass-delete sweep', {
                stored: stored.size, live: live.length, deleted: deleted.length,
                markdown: ctx.app.vault.getMarkdownFiles().length,
            });
            return { dirty, deleted: [] };
        }
        return { dirty, deleted };
    }
