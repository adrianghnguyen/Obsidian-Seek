# Seek

<img width="693" height="817" alt="Screenshot 2026-06-29 at 14 33 54" src="https://github.com/user-attachments/assets/127d554d-9faf-45c0-8215-02e151c1f5c4" />

Seek is a native hybrid search plugin for Obsidian vaults, built to find buried information in large and complex vaults. It combines dense semantic embeddings with lexical (keyword) search to find exactly what you're looking for, all running within Obsidian. No APIs or local servers needed.

Relevance has been tested and evaluated on hundreds of thousands of queries and notes, and offers easy customization to best suit your vault.

> **Fork notice:** This repo is a maintained fork of [ryan-manor/Obsidian-Seek](https://github.com/ryan-manor/Obsidian-Seek) by Ryan Manor, extended by [Adrian Nguyen](https://github.com/adrianghnguyen/Obsidian-Seek). Current version: **1.8.0**. The [upstream user guide](https://publish.obsidian.md/rmm/Seek+Documentation/About+Seek) still applies for core relevance and tuning; see [What's different in this fork](#whats-different-in-this-fork) and [CHANGELOG.md](./CHANGELOG.md) for fork-specific additions.

<img width="735" height="595" alt="Screenshot 2026-06-30 at 09 25 33" src="https://github.com/user-attachments/assets/ab5bf543-8d57-4f79-b912-bede11bac059" />

## What's different in this fork

Compared to upstream [ryan-manor/Obsidian-Seek](https://github.com/ryan-manor/Obsidian-Seek) (**1.1.3**), this fork (**1.8.0**) keeps the same hybrid ranking core and adds UX, diagnostics, and automation. Full history is in [CHANGELOG.md](./CHANGELOG.md).

**Search & modal**
- Progressive pipeline (Name match → Lexical BM25 → Hybrid semantic) with warm-up lexical results before the model finishes loading
- Optional footer stage indicator; remappable in-modal hotkeys (Settings → Hotkeys) that do not register globally
- Insert-link defaults are **Alt+Enter** (plain) and **Alt+Shift+Enter** (alias); upstream uses Shift+Enter
- Configurable modal size, snippet depth, and result aliases; Quick Switcher–like dismiss after tab/split open (optional keep-open)
- Mod+Enter / Mod+Alt+Enter (and clicks) open in a new tab or split via OpenTarget modifiers

**Indexing & Settings**
- Live startup timeline, boot history, and boot-over-boot trend
- Embedder coverage by folder tree; embedding-pass throughput (`ch/s`, `files/s`, `tok/s`)
- Seek-only **Additional excluded folders** (additive with Obsidian’s Excluded files), with automatic backfill / soft-delete
- BM25 field-weight sliders under Relevance → Advanced (score-time; no reindex)

**Automation & desktop**
- `seek:open` CLI and richer `obsidian://seek` open targets (`paneType=tab|split|window`)
- Lexical `seek:search` during warm-up (`ready: false` / `warming` in JSON)
- Experimental background query worker (desktop, Settings → Model & performance)
- Windows CRLF-safe markdown fence/table parsing for indexing

Core relevance tuning still follows the [upstream user guide](https://publish.obsidian.md/rmm/Seek+Documentation/About+Seek); fork-only surfaces are documented below and in Settings → Seek.

## Features

**Search**
- Hybrid lexical + semantic ranking, tuned for vaults from hundreds to tens of thousands of notes
- Progressive results (name match → lexical BM25 → hybrid semantic) with optional footer stage indicator
- Recent searches in the modal resting state; remappable in-modal hotkeys (Settings → Hotkeys)
- Configurable modal size, snippet depth, and result aliases
- Inline filters with autosuggestions (`#tag`, `path:`, `[key:value]`, dates, negation)
- BM25 field-weight sliders under Relevance → Advanced (no reindex)

**Indexing**
- Status-bar progress during full and catch-up passes
- Settings embedding pass shows live `ch/s`, `files/s`, and `tok/s`, plus per-folder embedder coverage
- Startup timeline, boot history, and boot-over-boot trend in Settings → Index
- Automatic backfill / soft-delete when Obsidian’s Excluded files or Seek’s additional excluded folders change
- Cross-device synced index for mobile (sidecar hydrate without re-embedding)

**Automation**
- Obsidian CLI: `seek:search`, `seek:open`, `seek:insert-link` (Obsidian 1.12.7+)
- Deep links via `obsidian://seek` (search or open top hit)
- Lexical results during warm-up (`ready: false` in JSON) before semantic ranking is ready

**Desktop extras**
- Insert a wiki link from search without leaving the editor (Alt+Enter / Alt+Shift+Enter)
- Experimental background query worker (Settings → Model & performance)

Support for 52 languages (plus code). The [upstream user guide](https://publish.obsidian.md/rmm/Seek+Documentation/About+Seek) and [evaluation notes](https://publish.obsidian.md/rmm/Seek+Documentation/Seek+Evaluation+%26+Development) cover relevance tuning in depth.

## Installation

1. Install the plugin in your vault.
2. Open Obsidian and let Seek build the index on first load (typically 1–3 minutes; longer for very large vaults).
3. Open search with the **Search** command and start typing.

## Search examples

Type a natural-language query, then narrow with filters. Press `[` for a property-type-aware filter menu. `before:` / `after:` use the recency date field from Settings → Relevance.

```text
standup notes #meetings/1x1
project alpha path:"Projects/Active"
[status:done][priority>2]
budget review before:2026-01-01 after:2025-06-01
meeting -archive
```

| Operator | Effect |
|----------|--------|
| `#tag` / `tag:x` | Tag filter (hierarchical) |
| `path:pattern` | Path glob (`path:"folder with spaces"`) |
| `[key:value]` / `[key>n]` | Frontmatter match or numeric compare |
| `before:DATE` / `after:DATE` | Date range on the configured recency field |
| `-term` | Exclude notes containing that term |

## Keyboard shortcuts

Defaults apply **only while the Seek search modal is focused** (they do not hijack the editor). Remap under Settings → Hotkeys; the modal footer shows your live bindings.

| Action | Default |
|--------|---------|
| Navigate results | ↑ / ↓ |
| Open | Enter |
| Open in new tab | Mod+Enter |
| Open in split | Mod+Alt+Enter |
| Insert plain link | Alt+Enter (desktop; active markdown editor) |
| Insert link with alias | Alt+Shift+Enter; **Tab** when no ghost/suggestion (desktop; active markdown editor) |
| Expand snippet | Mod+Shift+E |
| Fill autosuggest | Tab (wins over insert-with-alias when a completion is available) |
| Close | Esc |

Mod+click / Mod+Alt+click also open in a new tab or split. By default the modal closes after those opens (Quick Switcher–like); opt into fan-out under Display → **Keep search open when opening in new tab or split**.

## How It Works

Seek embeds your notes with a local embedding model and fuses those semantic scores with a lexical BM25 ranker. Indexing, embedding, and ranking all happen inside Obsidian. Your notes and queries never leave your machine.

### Progressive search: three tiers, promoted in place

A search streams results through three tiers, each promoting into the next without a flash or flicker:

1. **Name match** — the basename and alias prefix paint first, so a known-item keystroke shows its note immediately.
2. **Lexical BM25** — the persisted keyword index ranks matches within a few milliseconds, before the embedding model has finished computing vectors.
3. **Hybrid semantic** — the dense embedding and fusion pass reconciles the list in place with the final ranked results.

Because the lexical tier is served from the persisted index, search works even on a cold start, before the model finishes downloading or loading. Enable Display → **Show search stages** for a persistent Name match → Lexical BM25 → Hybrid semantic indicator in the modal footer (off by default).

### Local index cache

The index lives in an IndexedDB database scoped to your vault (`seek-index:<appId>`). Notes are chunked and stored across tiered object stores so the search hot path only reads what it needs:

- **Chunk metadata and bodies** — text and per-chunk metadata for snippets and ranking.
- **Quantized embeddings** — vectors stored as int8 (SQ8), a 4× shrink over fp32 with negligible relevance loss.
- **Sign-bit projections** — a compact binary tier used to pick candidate chunks before exact reranking.
- **Persisted BM25** — the lexical index is serialized and reloaded on startup instead of being rebuilt from scratch.

The resident frame (the corpus in ranked order plus its packed vectors) is cached in memory and reused across keystrokes, so a warm query makes no IndexedDB round-trips. For multi-device use, Seek also writes a synced sidecar — per-device vault files that Obsidian Sync or iCloud can carry between devices — so a phone can hydrate the index without re-embedding.

## CLI and automation

Seek registers Obsidian CLI commands for headless use (Obsidian 1.12.7+ with the CLI enabled):

```powershell
obsidian seek:search query="project notes" format=json vault=MyVault
obsidian seek:open query="project notes" rank=1 paneType=tab vault=MyVault
obsidian seek:insert-link query="project notes" rank=1 vault=MyVault
obsidian seek:insert-link query="project notes" rank=1 alias="label" heading=true vault=MyVault
```

- **`format=json`** — structured results. During warm-up you may get lexical hits with `ready: false` (and `warming: true`) until semantic search is available; `seek:open` / `seek:insert-link` wait for full readiness so a wrong top hit cannot misfire.
- **Per-query recency** (not persisted): `recencyWeight=` and `recencyHalflife=` on `seek:search`.
- **Insert-link**: plain `[[Note]]` by default; pass `alias=` for a display label and `heading=true` for `[[Note#Section]]`.

Deep links (encode `#` in query text — it is both a URL fragment and Seek’s `#tag` sigil):

```text
obsidian://seek?query=project%20notes
obsidian://seek?query=project%20notes&mode=open&paneType=split&vault=MyVault
```

## Settings overview

Under **Settings → Seek**:

| Section | What you’ll find |
|---------|------------------|
| **Relevance** | Fusion diagram, search-stages explainer, recency / title boosts, BM25 field weights (Advanced) |
| **Display** | Modal size, snippets, aliases, stage indicator, hotkey hints, keep-open on tab/split |
| **Index** | Status and reindex, embedding-pass throughput, folder coverage tree, boot history, excluded folders (Obsidian + Seek-only additional) |
| **Model & performance** | Compute backend; experimental background query worker (desktop, per-device) |
| **Diagnostics** | Logging report (paths/queries redacted by default), recent search timings |

## Network Use

Seek runs the embedding model locally, but it has to download the model and its runtime **once per device**, the first time you index a vault:

- **Model weights** are fetched from **Hugging Face** (`huggingface.co`) — the IBM Granite multilingual embedding model (~100 MB, quantized).
- **The transformers.js runtime** (the library that runs the model) is loaded from the **jsDelivr CDN** (`cdn.jsdelivr.net`).

These downloads happen only when the assets are not already cached. They are cached on-device afterward, so there are no repeat downloads, and Seek works fully offline once the model is in place. Only these model assets are ever fetched. No note content, query text, or usage data is transmitted.

## Privacy and Local Logging

Seek writes diagnostic logs (indexing progress, search activity, and errors) to local files inside your vault to help debug performance and relevance. These logs stay on your device and are never transmitted anywhere. Additionally, diagnostics for search and relevance can be generated which creates a report of your recent searches, with note titles, and metadata included. Results content is not included in these reports, and the reports are written to your local Seek folder.

Seek transmits no logging or data to me about your index, or your queries.

## License and Attribution

Seek is released under the MIT License (see [`LICENSE`](./LICENSE)).

It builds on:

- [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) — on-device model inference.
- [IBM Granite embedding models](https://huggingface.co/ibm-granite) (Apache-2.0) — the embedding model.
- [MiniSearch](https://github.com/lucaong/minisearch) (MIT) — lexical (BM25) search.

Original Seek by [Ryan Manor](https://github.com/ryan-manor/Obsidian-Seek).
