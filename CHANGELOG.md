# Changelog

All notable changes to Seek are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.0.10

Sync index toggle and Windows CRLF atom parsing.

### Changed
- **Sync index across devices** — Settings → Index advanced exposes the existing sidecar toggle. ON (default) still writes vault index files for Sync/iOS hydrate; OFF keeps search on this device’s IndexedDB only. Index location is disabled while OFF.

### Fixed
- Markdown fences and tables parse correctly when note content uses Windows CRLF line endings.

## 1.0.9

Insert-link hotkey split — plain wiki links vs search-text alias.

### Changed
- **Alt+Enter** inserts a plain wiki link (`[[Note]]`) at the editor cursor; editor selection is left untouched.
- **Alt+Shift+Enter** inserts a wiki link with the search field's free text as the alias (`[[Note|words]]`).
- Removed the "Insert link uses search text" setting — alias behavior is now hotkey-driven.
- `seek:insert-link` CLI inserts a plain link by default; pass `alias=` for a display label.

## 1.0.8

Search modal UX release — larger panel, richer result metadata, and configurable snippets.

### Added
- **Configurable modal size** — Settings → Display → width (default / wide / extra wide) and height (default / tall / extra tall).
- **Result aliases** — frontmatter aliases on each result row, with per-alias pills, matched-alias highlight, and a configurable display limit.
- **Snippet preview** — Settings → Display → compact / standard / expanded controls how many lines and characters of surrounding text each result shows.
- **Expand snippet hotkey** — Ctrl/Cmd+Shift+E toggles the expanded snippet preset for all visible results while search is open.

### Changed
- Footer keyboard-hint bar uses flex-wrap so shortcuts are not clipped on narrow modals.

### Fixed
- Modal width/height presets apply reliably on open when theme CSS variables are stale (inline fallback).

## 1.0.7

Search-modal workflow release — open results in more places and insert links without leaving the editor.

### Added
- **Insert link from search** — Alt+Enter in the search modal inserts a wiki link to the selected result at the active editor cursor. Desktop only.
- **`seek:insert-link` CLI** — search and insert a link to a ranked result headlessly (`query`, optional `rank`, `alias`, and `heading`).
- **`seek:open` CLI** — search and open a ranked result in the active tab, a new tab, a split pane, or a pop-out window (`paneType=tab|split|window`).
- **Split-pane open** — ⌘/Ctrl+Alt+Enter (or ⌘/Ctrl+Alt+click) opens the selected result in a split pane while keeping the search modal focused.
- **Deep-link pane target** — `obsidian://seek?mode=open` now accepts `paneType=tab|split|window`.

### Changed
- Insert-link alias resolution: editor selection wins when present; otherwise the search field's free text is used as `[[note|alias]]` by default (toggle in Display settings).
- Insert-link subpath: section heading (`#Section`) is optional and off by default; enable "Insert link includes section heading" in Display settings for `[[Note#Section|…]]` links.

## 1.0.6

Indexing reliability release, prompted by a community bug report — thank you.

### Fixed
- A note dominated by enormous runs of whitespace padding (the reported case: a machine-generated Markdown table with megabytes of space-padded cells) could crash Obsidian during indexing or fail with `Tensor shape is too large`, and the file was then retried on every indexing pass without ever completing. The real cost was tokenizing the padding — gigabytes of memory for text that never survives truncation. Seek now collapses long whitespace runs before any text is measured or embedded, so these files index normally. Stored note text, snippets, and keyword search are untouched, and no reindex is needed.

### Changed
- When a chunk fails to embed deterministically, Seek now keeps the rest of the file indexed and records the failing chunk instead of retrying the whole file forever. Recorded failures are retried once per release, so a shipped fix reaches them automatically.
- Many embedding failures in a single pass (for example a lost GPU device, or the app backgrounded mid-index) are treated as an environment problem rather than a content problem: nothing is recorded as failed and the files retry normally on the next pass.

### Internal
- Embedding-failure diagnostics now record batch size, compute backend, and input sizes (counts only — never note content), so future reports of this class self-diagnose.

## 1.0.5

CPU-compute reliability release, prompted by a community bug report — thank you.

### Fixed
- On desktop and Android, loading the embedding model on the CPU path failed with `Could not find an implementation for GatherBlockQuantized`, so building the index was impossible whenever WebGPU wasn't usable (for example with hardware acceleration turned off) and when "Force CPU" was selected. Seek now loads the ONNX runtime build that includes the CPU kernels the quantized model needs. iPhone and iPad were unaffected. As a side effect, the CPU runtime download is ~10 MB smaller.
- When both WebGPU and the CPU fallback failed, the error reported only the CPU failure and discarded the reason WebGPU fell back. Both causes are now reported.

### Changed
- The diagnostic report now names the GPU adapter and flags software (fallback) adapters — "GPU yes" alone couldn't distinguish a real GPU from software rendering.
- The report now includes the last model load: which compute backend and quantization actually served it, and the fallback reason if WebGPU didn't.
- The report's version stamp now reflects the installed plugin version (it previously always read "v0.0.1").

## 1.0.4

Search accuracy and cross-device sync reliability release.

### Changed
- Lexical (keyword) search now indexes link targets, URLs, and aliased link text that were previously stripped before reaching it. Notes are now findable by the links and sources they reference, not just the surrounding prose.
- Inline `#tags` in note body text and the legacy `alias:` frontmatter key now reach tag search and the title index, matching what `tags:`/`aliases:` already did.
- List-valued frontmatter properties are now searchable as text, not just filterable.

### Fixed
- Date filters (`before:`/`after:`) no longer silently accept an out-of-range day or month (e.g. Feb 30) and normalize it into an unintended date.
- A timezone mismatch that could shift a date filter's boundary by a day is fixed.
- Typing with an IME (e.g. Japanese, Chinese, Korean input) while a filter pill was focused could interrupt composition; fixed.
- Filter pills no longer suggest notes excluded from the index.
- Numeric property filter pills now flag a value that fails to parse instead of matching silently.
- Several low-probability sync races fixed, including a stale index surviving a database upgrade, a duplicate device identity after cloning or restoring a vault, and orphaned index data not being reclaimed on some devices.

### Internal
- Hardened startup, log rotation, and index-compaction paths against concurrent-write races.
- Hardened the internal release pipeline that produces this build.

## 1.0.3

Settings refinement. Search, indexing, and sync are unchanged.

### Changed
- Reorganized the Index settings section: the index status and the reindex button stay in view, while the set-once options (index Base files, honor excluded folders, index location) now sit under an "Advanced settings" disclosure, matching the Relevance section.
- Clarified the reindex note: building the index re-embeds every note and isn't recommended on a phone. Run it on a computer and your phone syncs the finished index automatically.

## 1.0.2

Code-quality release addressing the second round of Obsidian community plugin-review feedback. No user-visible change — search, indexing, and sync behave identically to 1.0.1.

### Internal
- Replaced the remaining lint-rule suppressions with code that satisfies Obsidian's plugin guidelines directly (member access for the per-device backend/diagnostic storage and the hidden compute frame, popout-safe globals); no `eslint-disable` comments remain in shipped code.
- Switched the dev-only YAML test dependency to `yaml`.
- Added a local reproduction of the review's lint configuration so findings are caught before submission.

## 1.0.1

Compatibility and code-quality release addressing the Obsidian community plugin review. Search behavior is unchanged — the lexical/semantic ranking is byte-identical to 1.0.0.

### Fixed
- Startup crash on iOS before 16.4: a regex feature unsupported by older WebKit prevented the plugin from loading at all on those devices.
- Popout-window support: timers and DOM access now resolve against the correct window, and the hidden background compute frame and app-visibility tracking are anchored so they survive a popout window opening or closing.
- iPad and Android tablets are now classified correctly for compute-backend selection.

### Changed
- The search command id changed from `seek-search` to `search` (Obsidian namespaces it as `seek:search`). If you bound a custom hotkey to it, rebind it once.

### Internal
- Addressed the Obsidian community plugin-review findings: Platform API for device detection, popout-safe timers/DOM, vault-scoped storage where appropriate, typed worker/iframe messages, and removed dead code. No user-visible search changes.

## 1.0.0

Initial public release. Seek is a hybrid (lexical + semantic) search plugin for Obsidian, built on a quantized, sync-friendly index that stays current across devices without re-embedding on each one.

### Search & relevance
- Typed-value query filters: numeric comparison (e.g. `[price>50]`) and date ranges (`before:` / `after:`).
- Field-weight tuning from a fresh relevance evaluation — stronger body-content weighting and a higher dense-fusion weight for better-ranked results.
- Hardened the lexical coordination soft-AND so multi-term queries favor documents that match more of the query.
- Dense-channel hygiene: cleaner body and heading text, with cross-surface de-duplication before embedding.
- Converged tokenization across the surfaces that build, match, and enumerate terms, so identical text tokenizes identically everywhere.

### Query filter menu
- The `[` filter menu is keyed by property type and value shape: numeric keys show real note counts; date keys are kept out of the value menu and surfaced through `before:` / `after:` instead.
- Recency now defaults to the modified date, and the `before:` / `after:` hints name the configured date field.

### Sync & indexing
- Consent-gated reindex: a version-stale index warns and waits rather than silently rebuilding.
- A calm "syncing from another device" state when a newer index is arriving from a peer, distinct from the action-needed stale state.
- Mobile catch-up indexing is batched (O(N²) → ~O(N)) and stays stable under a large backlog.
- Peer-ahead state survives an app relaunch, and mobile no longer grinds during catch-up.

### Interface
- Search-modal keyboard, pointer, and link-handling polish; theme-proofed filter pills; the query field focuses on a dead-space click.
- The per-result score line is off by default.
