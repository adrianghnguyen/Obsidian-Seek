# Seek — Architecture Overview

Seek is an Obsidian plugin that provides **on-device hybrid search** over vault notes. It combines dense semantic embeddings with lexical BM25 retrieval, fuses scores at query time, and runs entirely inside Obsidian — no external API or local server.

This document describes how the codebase is organized, how major subsystems interact, and the main design choices behind the implementation.

---

## Table of contents

1. [System context](#1-system-context)
2. [High-level architecture](#2-high-level-architecture)
3. [Domain map (by folder / module group)](#3-domain-map-by-folder--module-group)
4. [Plugin lifecycle](#4-plugin-lifecycle)
5. [Indexing pipeline](#5-indexing-pipeline)
6. [Search pipeline](#6-search-pipeline)
7. [Persistence & cross-device sync](#7-persistence--cross-device-sync)
8. [Embedding & compute](#8-embedding--compute)
9. [UI & user interactions](#9-ui--user-interactions)
10. [Settings & configuration](#10-settings--configuration)
11. [Diagnostics & logging](#11-diagnostics--logging)
12. [Build, test & release](#12-build-test--release)
13. [External integration points](#13-external-integration-points)
14. [Design themes](#14-design-themes)

---

## 1. System context

| Aspect | Detail |
|--------|--------|
| **Runtime** | Obsidian desktop + mobile (not desktop-only) |
| **Entry point** | `src/main.ts` — `SeekPlugin` extends Obsidian `Plugin` |
| **Shipped artifacts** | `main.js` (esbuild bundle), `manifest.json`, `styles.css` |
| **Primary dependency** | [MiniSearch](https://github.com/lucaong/minisearch) for BM25 |
| **Embedding model** | IBM Granite multilingual (`granite-embedding-97m`), 384-d, via transformers.js in a sandboxed iframe |
| **Storage** | Per-vault IndexedDB + optional vault-file sidecar for sync |

Seek's responsibility is end-to-end: chunk notes → embed → index → parse queries → retrieve → rank → present results → open notes or insert links.

---

## 2. High-level architecture

```mermaid
flowchart TB
    subgraph obsidian [Obsidian Host]
        CMD[Command palette / hotkeys]
        URI[obsidian://seek protocol]
        CLI[obsidian-cli handlers]
        WS[Workspace / Editor]
    end

    subgraph plugin [SeekPlugin - main.ts]
        SET[Settings - data.json]
        LOG[SeekLogger]
        FOR[Forensics]
        EMB[LocalEmbedder]
        STORE[IndexStore - IndexedDB]
        ORC[SearchOrchestrator]
        MOD[SeekSearchModal]
        TAB[SeekSettingTab]
    end

    subgraph vault [Vault files]
        NOTES[Markdown + .base files]
        SIDE[Sidecar index files]
        LOGS[Diagnostic logs]
    end

    CMD --> MOD
    URI --> plugin
    CLI --> ORC
    MOD --> ORC
    ORC --> EMB
    ORC --> STORE
    ORC --> NOTES
    ORC --> SIDE
    MOD --> WS
    plugin --> SET
    plugin --> LOG
    plugin --> FOR
    TAB --> SET
    LOG --> LOGS
```

**Central orchestrator:** `SearchOrchestrator` (`src/search.ts`) owns chunking, embedding coordination, BM25 cache, in-memory search frame, sidecar hydration, and the `search()` / `reindexAll()` / `reindexDelta()` APIs. Everything else plugs into it or into `SeekPlugin` wiring in `main.ts`.

---

## 3. Domain map (by folder / module group)

All production code lives in a **flat `src/` directory** (~55 modules). Tests are colocated as `*.test.ts`. There is no nested `src/search/` package — domains are expressed by file naming and imports.

### 3.1 Plugin shell & types

| Files | Responsibility |
|-------|----------------|
| `main.ts` | Plugin lifecycle, commands, protocol/CLI handlers, indexing schedulers, model load gate |
| `types.ts` | `SeekSettings`, `Chunk`, `ScoredChunk`, query filters, log schema, `DEFAULT_SETTINGS`, migrations |
| `settings-tab.ts` | Settings UI (Index, Relevance, Display, Model, Diagnostics, Reset) |
| `manifest.json` | Obsidian plugin metadata (`id: seek`) |

### 3.2 Search & ranking

| Files | Responsibility |
|-------|----------------|
| `search.ts` | **`SearchOrchestrator`** — indexing, search, sidecar reconcile, frame cache (~5.3k lines; decomposition guide: [SEARCH-DECOMPOSITION.md](./SEARCH-DECOMPOSITION.md)) |
| `frame-utils.ts` | Resident frame ops, candidate alignment, delta row helpers *(Phase 1 extraction — PR #25)* |
| `coherence.ts` | Frame/BM25 drift detection and recovery decisions *(Phase 1 — PR #25)* |
| `bm25-persist.ts` | Persisted BM25 index identity stamps *(Phase 1 — PR #25)* |
| `query-parser.ts` | Inline filter syntax (`#tag`, `path:`, `[key:value]`, dates, negation) |
| `fusion.ts` | Score normalization, hybrid fusion, recency ε-tiebreaker, title boost, browse order |
| `ranker.ts` | `rank()` — combines dense + BM25 + recency + title on candidate set |
| `bm25.ts` | Multi-field MiniSearch BM25F (title, aliases, tags, content, properties, headings) |
| `tokenize.ts`, `synonyms.ts`, `tag-grammar.ts` | Tokenization, synonym expansion, tag parsing |
| `select.ts`, `pool.ts` | Top-N selection, candidate pool sizing (√N scaling) |
| `suggest.ts` | Vault metadata dictionaries for filter autocomplete |
| `snippet.ts`, `highlight.ts`, `result-aliases.ts` | Result display helpers |

### 3.3 Indexing & storage

| Files | Responsibility |
|-------|----------------|
| `chunker.ts` | Heading-aware markdown chunking, frontmatter, aliases, link terms |
| `token-budget.ts`, `atoms.ts` | Re-split oversized sections at paragraph/fence/table boundaries (≤512 tokens) |
| `base-extractor.ts` | Obsidian Bases (`.base`) → synthetic chunks |
| `dense-clean.ts`, `prop-normalize.ts` | Dense-channel text hygiene, property normalization |
| `index-store.ts` | IndexedDB schema (chunks, embeddings, binary, BM25 JSON, file records) |
| `index-coordinator.ts` | Write mutex, cache generation, delta visibility, sidecar gate |
| `index-size.ts` | Storage accounting |
| `catchup.ts` | Deferred embed drain when search is idle |
| `pacer.ts` | Compositor-friendly batch pacing during indexing |
| `identity.ts` | Index version fingerprint (model, chunker, analyzer, dim) |

### 3.4 Dense / vector retrieval

| Files | Responsibility |
|-------|----------------|
| `embedder.ts` | Parent-side embed API, load coalescing, query LRU cache |
| `embedder-lifecycle.ts` | Model load/unload policy (mobile idle eviction) |
| `iframe-runner.ts` | Sandboxed transformers.js runtime (WebGPU / WASM) |
| `model-registry.ts` | Active model spec, cache eviction, download probe |
| `platform.ts` | Per-device backend choice (`auto` / `webgpu` / `wasm`), crash demotion |
| `quant.ts` | Int8 quantization + scale for stored vectors |
| `binary.ts`, `binary-scorer.ts`, `binary-worker.ts` | Sign-bit binary index for stage-1 candidate retrieval |
| `dense-stats.ts` | Corpus background stats for display confidence (not ranking) |

### 3.5 Sidecar (cross-device index sync)

| Files | Responsibility |
|-------|----------------|
| `sidecar.ts` | Vault-file index format (JSONL + binary shards, tombstones, CRC) |
| `sidecar-sync.ts` | Hydration from peer device sidecars without re-embedding |
| `sidecar-meta.ts` | Producer metadata, version acceptance gates |

### 3.6 UI

| Files | Responsibility |
|-------|----------------|
| `search-modal.ts` | **`SeekSearchModal`** — results list, debounced search, keyboard model, pagination |
| `query-field.ts` | **`PillQueryField`** — pill filters + contenteditable query, autocomplete |
| `open-target.ts` | Pane targets (`tab`, `split`, `window`), modifier resolution |
| `insert-link.ts` | Wikilink build + editor insertion (Alt+Enter, CLI) |
| `index-notice.ts` | Degraded/stale index banners in modal |
| `styles.css` | Modal, pills, results, footer, mobile viewport CSS |

### 3.7 Diagnostics

| Files | Responsibility |
|-------|----------------|
| `logger.ts` | Per-device NDJSON logs, report generation (`seek-report.md`) |
| `forensics.ts` | Synchronous localStorage crash breadcrumbs |

### 3.8 Test infrastructure

| Path | Responsibility |
|------|----------------|
| `src/*.test.ts` | ~59 colocated unit/integration tests |
| `src/test-harness/scenario.ts` | Tier-2 composed scenarios (real orchestrator + fake IndexedDB) |
| `src/test-stubs/` | Vitest stubs for `obsidian` API and `window` |
| `src/fixtures/` | Realistic markdown fixtures for chunker/token tests |
| `tests/relevance-cases.json` | Illustrative relevance cases (documentation only, not CI) |

---

## 4. Plugin lifecycle

### 4.1 `onload()` (bootstrap)

Rough order in `SeekPlugin.onload()`:

1. **Logger** — create `SeekLogger`, run log maintenance (migrate, rotate, prune)
2. **Settings** — `loadData()` (BOM-stripped) → `migrateSettings()` → merge with `DEFAULT_SETTINGS`
3. **Index name** — `IndexStore.configure()` binds the per-vault DB name **without** opening IndexedDB
4. **Forensics** — inspect prior session; log crash if unclosed
5. **Orchestrator** — construct `SearchOrchestrator` with store, embedder, settings ref
6. **Settings tab** — register `SeekSettingTab`
7. **Incremental indexing** — wire vault/workspace event listeners
8. **`onLayoutReady`** — then start startup clocks, `IndexStore.open()`, sidecar hydrate, identity, reconcile
9. **Intervals** — periodic reconcile; mobile idle embedder unload
10. **Observers** — global errors, long tasks, memory pressure
11. **Embedder init** — `embedder.init()` (non-blocking; model loads lazily)
12. **Integration** — command, `obsidian://seek` protocol, optional CLI handlers

Do **not** `await onLayoutReady()` inside `onload` (that can deadlock). Use the callback form. Until that gate, Seek must not time startup, probe IndexedDB, or treat core File Recovery / cache / sync IndexedDB errors as Seek failures.

Model weights are **not** loaded at startup. First search or reindex calls `ensureModelLoaded()`.

### 4.2 `onunload()` (teardown)

Synchronous clean end: mark forensics session closed → teardown embedder iframe → dispose orchestrator → close IndexedDB → disconnect observers and timers.

### 4.3 Indexing schedulers (`main.ts`)

| Mechanism | Role |
|-----------|------|
| Vault file events | Queue dirty files for incremental reindex |
| `flushDirty()` | Debounced delta embed after edits |
| `runCatchUp()` | Drain backlog when search modal is idle |
| `reconcileOnLoad()` / `periodicReconcile()` | Sidecar sync, peer detection, drift recovery |
| `indexingBlocked` | Pause embeds while active search is in flight |

---

## 5. Indexing pipeline

```mermaid
flowchart LR
    file[TFile content]
    chunk[MarkdownChunker / chunkBase]
    budget[enforceTokenBudget]
    embed[LocalEmbedder.embedBatch]
    quant[quantizeInt8 + packSignBits]
    idb[IndexStore.putBatch]
    bm25[BM25 fit / applyDelta]
    side[sidecar bulkAppend]

    file --> chunk --> budget --> embed --> quant --> idb
    idb --> bm25
    idb --> side
```

### Chunking (`chunker.ts`)

- Splits notes at heading boundaries; builds hierarchical titles (`Note > H1 > H2`)
- Extracts frontmatter tags, aliases, properties, dates
- Produces `link_terms` for BM25-only wikilink reclamation
- Applies `denseSuffix` from frontmatter values (dense channel only)
- Falls back to title-only chunks for empty notes (`lexicalOnly`)
- `CHUNKER_VERSION` gates sidecar compatibility

### Chunk identity

`chunkIdFor(notePath, title, content, denseSuffix)` — path-salted hash. IDs must be reproducible for sidecar hydration (re-chunk live file, intersect with sidecar records).

### Full vs incremental

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Full reindex** | Settings → Reindex | Nuke IDB, walk all indexable files, embed all chunks, fit BM25, write sidecar |
| **Incremental delta** | File save/create/delete | Delete stale chunks, embed only changed chunks, `applyDelta()` on BM25 frame |

Writes are serialized through `IndexCoordinator.runExclusive()`. In-flight deltas block `ensureFrame()` so searches never read a half-updated corpus.

### IndexedDB stores (`index-store.ts`)

| Store | Contents |
|-------|----------|
| `chunk_meta` | Metadata without body |
| `chunk_body` | Chunk text content |
| `embeddings` | Quantized int8 vectors + scale |
| `binary` | Sign-bit packed vectors for fast scan |
| `files` | Per-note mtime, content hash, chunk id list |
| `meta` | Singleton (model id, dim, chunker version, bg stats) |
| `bm25` | Persisted MiniSearch JSON + analyzer stamp |

---

## 6. Search pipeline

```mermaid
flowchart TD
    q[User query]
    parse[parseQuery - filters + cleaned text]
    frame[ensureFrame - resident corpus]
    embedQ[embed query]
    s1a[Binary top-N]
    s1b[BM25 top-M]
    s1c[Recency top-K]
    union[Candidate union]
    s2[Cosine on int8 candidates]
    rank[rank - hybrid + recency + title]
    dedup[dedupByPath]
    hydrate[hydrateBodies + snippets]

    q --> parse --> frame
    parse --> embedQ
    embedQ --> s1a & s1b & s1c --> union --> s2 --> rank --> dedup --> hydrate
```

### Stage summary

| Stage | What it does |
|-------|----------------|
| **Parse** | Extract inline filters; produce `cleanedQuery` for embedding/BM25 |
| **Frame** | Load metadata + binary index + optional resident int8 block into RAM |
| **S1a** | Binary asymmetric scan (desktop: off-thread worker) |
| **S1b** | Multi-field BM25 with fuzzy, prefix, synonym, coverage soft-AND |
| **S1c** | Recency pool for browse/filter-only paths |
| **Union** | Merge candidate indices; pool size scales as √N |
| **S2** | Dequantize int8 → cosine similarity on union only |
| **S3** | `rank()` fusion, note-level dedup, body fetch, snippet render |

**Filter-only queries** (pills/filters with no free text) skip embedding and sort via `browseOrder()`.

### Fusion (`fusion.ts` + `ranker.ts`)

- TM2C2-style normalization: cosine mapped to [0,1], BM25 divided by theoretical query bound
- `hybrid = α·dense + (1-α)·bm25` where `α` = `settings.denseWeight` (default 0.85)
- Recency is an additive ε-tiebreaker, not a multiplicative boost
- Title boost rewards query terms that are a subset of the note title

---

## 7. Persistence & cross-device sync

Seek uses **two persistence layers**:

### 7.1 IndexedDB (local, per device)

Fast query path. Can be evicted on iOS WebView → sidecar recovers without re-embedding.

### 7.2 Sidecar (vault files, synced)

Written to `.obsidian/plugins/seek/index/` (default) or vault-root `Seek Index/` (split-config Obsidian Sync workaround).

| Artifact | Purpose |
|----------|---------|
| `index.<deviceId>.jsonl` | Chunk id → shard offset map |
| `embeddings.<deviceId>.<seq>.bin` | Packed int8 vectors (4 MB shards) |
| `meta.<deviceId>.json` | Format version, model, chunker, dim |

**Hydration** (`sidecar-sync.ts`): re-chunk live vault files, intersect chunk ids with sidecar records, decode vectors into IndexedDB — no re-embed if identity matches.

**Identity gates** (`identity.ts`, `sidecar-meta.ts`): model repo, chunker version, embedding dim, analyzer stamp must match before accepting a sidecar producer.

---

## 8. Embedding & compute

```mermaid
flowchart LR
    plat[platform.ts - device policy]
    reg[model-registry.ts]
    emb[LocalEmbedder]
    ifr[iframe-runner.ts]
    tfjs[transformers.js via jsDelivr]

    plat --> emb
    reg --> emb
    emb --> ifr --> tfjs
```

### Why an iframe?

Obsidian's CSP blocks remote `import()` in the main plugin context. A sandboxed `srcdoc` iframe loads transformers.js with a permissive CSP.

### Backend selection (`platform.ts`)

| Device class | Default | Override |
|--------------|---------|----------|
| Desktop, iPad | `auto` (WebGPU → WASM fallback) | Settings → Force CPU / WebGPU |
| iPhone, Android | `wasm` | Stored in **localStorage** (not synced) |

Crash demotion can sticky-force WASM after mobile GPU jetsam.

### Model

- **Spec:** `granite-embedding-97m-multilingual-r2`, 384-d, q4 quantized
- **Registry:** `model-registry.ts` — `activeModelSpec(settings)`; debug repo override for eval
- **Warmup:** shader/grid warmup in iframe; fingerprint skips ~1s on reload

### Vector storage

- Full vectors stored as **int8 + per-vector scale** (`quant.ts`)
- **Sign bits** packed for binary stage-1 scan (`binary.ts`)
- Stage-2 rerank dequantizes only the ~200–800 candidate union

---

## 9. UI & user interactions

### Search modal (`search-modal.ts`)

`SeekSearchModal` is a custom `Modal` (not `SuggestModal`):

| Component | Role |
|-----------|------|
| `PillQueryField` | Query input with inline filter pills |
| Results list | Reconciled row pool, infinite scroll (10 visible / 50 fetched) |
| Index banner | Stale/syncing notices |
| Footer | Keyboard hints (toggleable) |

**Keyboard model:**

| Key | Action |
|-----|--------|
| Enter | Open in active pane; close modal |
| ⌘/Ctrl+Enter | Open in new tab (modal stays open) |
| ⌘/Ctrl+Alt+Enter | Open in split pane |
| Alt+Enter | Insert plain wikilink at editor cursor (desktop) |
| Alt+Shift+Enter | Insert wikilink with search free text as alias (desktop) |
| ↑/↓ | Navigate results |
| Esc | Close |

Debounce: 200 ms desktop / 400 ms mobile. Catch-up indexing pauses while search is active.

### Query field / pills (`query-field.ts`)

Pills serialize to the same inline syntax the backend parses:

- `tag:value`, `path:folder/*`, `after:YYYY-MM`, `[key:value]`

`SuggestEngine` provides autocomplete from vault tags, paths, and property keys. `getFreeText()` returns non-pill text used as the link alias on Alt+Shift+Enter.

### Open targets (`open-target.ts`)

Shared by modal, `obsidian://seek?mode=open`, and `seek:open` CLI. `resolveOpenTarget()` maps modifiers via `Keymap.isModEvent()`. Mobile normalizes `split` → `tab`.

### Insert link (`insert-link.ts`)

- **Alt+Enter** — plain `[[Note]]` at the active editor cursor (selection untouched)
- **Alt+Shift+Enter** — `[[Note|search free text]]` when free text is non-empty; otherwise plain link
- Builds links via `app.fileManager.generateMarkdownLink()`
- Subpath (`#heading`) optional via `insertLinkIncludeHeading` setting
- CLI: `seek:insert-link query=… rank=… alias=… heading=true|false` (plain link unless `alias=` is set)

---

## 10. Settings & configuration

### Persisted (`data.json`, synced across devices)

`SeekSettings` in `types.ts` — ~30 fields including:

| Group | Examples |
|-------|----------|
| **Ranking** | `denseWeight`, `navTitleBoost`, `recencyEpsilon`, `recencyHalfLifeDays`, `fuzzyEnabled` |
| **Indexing** | `honorIgnoredFolders`, `indexBases`, `searchableProperties`, `sidecarEnabled`, `sidecarIndexLocation` |
| **Display** | `showScores`, `showHotkeyHints`, `insertLinkIncludeHeading`, snippet preview, modal size, aliases |
| **Schema** | `settingsRev` (currently 8) — `migrateSettings()` runs on load |

`this.settings` is a live object shared with `SearchOrchestrator` — ranking changes apply on the next search without reindex.

### Per-device (not in `data.json`)

| Setting | Storage |
|---------|---------|
| Compute backend (`auto` / `wasm` / `webgpu`) | `localStorage` via `platform.ts` |
| WebGPU crash demotion flag | `localStorage` |
| Device id for logs | `localStorage` |

---

## 11. Diagnostics & logging

### SeekLogger (`logger.ts`)

Per-device NDJSON append log:

```
.obsidian/plugins/seek/logs/seek-log-<deviceId>.ndjson
.obsidian/plugins/seek/logs/seek-init-<deviceId>.json
```

Generates human-readable reports at vault root:

- `seek-report.md` — summary for users
- `seek-report.json` — structured dump for offline analysis

Logs search queries, ranking signals, indexing events, errors. **No telemetry leaves the device.**

### Forensics (`forensics.ts`)

Synchronous `localStorage` ring buffer during indexing. Unclosed session at boot → crash entry with verdict (memory kill, GPU termination, etc.).

### Build-time stamps

esbuild injects `__PLUGIN_VERSION__`, `__SEEK_ANALYZER_VERSION__` (BM25 invalidation), `__BINARY_WORKER_SRC__` (inline worker).

---

## 12. Build, test & release

### Build (`esbuild.config.mjs`)

Single `main.js` bundle (CommonJS, ES2022):

1. **Binary worker** — `binary-worker.ts` bundled to IIFE string, injected as `__BINARY_WORKER_SRC__`
2. **Main plugin** — `main.ts` entry, externals: `obsidian`, `electron`

```bash
npm run dev      # watch + inline sourcemaps
npm run build    # production minify
npm run typecheck
npm test         # vitest run (~59 test files)
```

### Test strategy

| Tier | Scope | Location |
|------|-------|----------|
| **Unit** | Pure functions, isolated modules | Colocated `*.test.ts` |
| **Composed** | Full orchestrator + fake IndexedDB | `test-harness/scenario.test.ts` |

CI (`.github/workflows/ci.yml`): Node 22 → typecheck → test → build on push/PR.

### Release

Tag push (no `v` prefix) → build → Sigstore attestation → draft GitHub release with `main.js`, `manifest.json`, `styles.css`.

### Local dev loop

1. `npm run dev` in repo
2. Copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/seek/`
3. `obsidian plugin:reload id=seek`

---

## 13. External integration points

| Integration | Entry | Purpose |
|-------------|-------|---------|
| **Command palette** | `seek:search` | Open search modal |
| **Protocol URL** | `obsidian://seek?query=…&mode=open&paneType=tab` | Deep links, automation |
| **CLI** (desktop + obsidian-cli) | `seek:search`, `seek:open`, `seek:insert-link` | Headless search, open, insert link |
| **Settings** | Settings → Seek | Reindex, relevance tuning, diagnostics |

CLI handlers register only when `registerCliHandler` exists on the plugin instance (Obsidian 1.12.7+ with CLI bridge).

---

## 14. Design themes

1. **Two-stage retrieval** — Cheap binary + BM25 + recency union, then expensive cosine only on hundreds of candidates, not the full corpus.

2. **Frame-lite hot path** — Metadata and packed vectors in RAM; bodies fetched lazily for BM25 refit, negation, and top-K display.

3. **Generation-keyed caches** — BM25, binary index, and resident frame stay coherent via `IndexCoordinator.generation`; invalidated on delta or full rebuild.

4. **Path-salted chunk IDs** — Correct incremental delete; sidecar hydration reproduces IDs by re-chunking live files.

5. **TM2C2 fusion** — Fixed-endpoint score normalization avoids per-query min-max that can manufacture false dense winners on out-of-vocabulary queries.

6. **Synced settings vs per-device compute** — Ranking preferences sync via `data.json`; GPU/CPU choice stays local because WebGPU availability differs per device.

7. **Sidecar as sync transport** — IndexedDB is the query engine; vault files are the durable, iCloud/Obsidian-Sync-friendly backup that lets mobile recover without re-embedding.

8. **Lazy model load** — Plugin boots fast; embedding model downloads and initializes on first search or reindex.

---

## Related docs

- [SEARCH-DECOMPOSITION.md](./SEARCH-DECOMPOSITION.md) — how to split `search.ts` safely (phase order, anti-patterns, test gates)
- [seek-architecture.canvas.tsx](./seek-architecture.canvas.tsx) — interactive Cursor canvas (system map, index/search/persistence drill-downs)
- [README.md](../README.md) — user-facing install and privacy summary
- [CHANGELOG.md](../CHANGELOG.md) — release history
- [User guide](https://publish.obsidian.md/rmm/Seek+Documentation/About+Seek) — external documentation
- [Evaluation notes](https://publish.obsidian.md/rmm/Seek+Documentation/Seek+Evaluation+%26+Development) — relevance tuning context
