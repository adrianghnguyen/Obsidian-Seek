# Changelog

All notable changes to Seek are documented here. This project adheres to [Semantic Versioning](https://semver.org/).

## 1.1.6

Startup deadlock guard on settings persist. No reindex is needed, since the index format is unchanged.

### Fixed
- **Vault startup no longer hangs on "Loading plugins" when settings migrate.** Seek persisted migrated settings with `await saveData` inside `onload`, which can deadlock while Obsidian is still loading other plugins. Settings persist and crash forensics logging now run off the blocking onload path.

## 1.1.5

Unified first-index and full-reindex progress, faster full passes, and honest reload status. No reindex is needed, since the index format is unchanged.

### Changed
- **First index and full reindex share one progress UI.** Settings shows the same **Indexing…** row with live percent for an automatic cold build and a manual reindex — driven by the coordinator job, not a separate button state.
- **Full index passes run at maximum throughput.** Between embed dispatches, Seek yields only briefly instead of waiting for idle compositor time. Catch-up and incremental indexing still pace for UI responsiveness and still pause for live search.
- **Search is blocked during a full rebuild.** Opening Seek or running CLI search while a first index or full reindex is running shows a wait state instead of results from a half-written index. Catch-up indexing stays searchable.
- **Status bar progress updates every committed file** with exact percent on the label and bar. A rough time remaining appears after a short warmup on the Settings line and status-bar tooltip.

### Fixed
- **Ready no longer disagrees with the search modal on first open.** While the index was warming or the modal’s chunk probe was still catching up, the status bar could say Ready while the footer or results area still showed indexing. Ready now means search can run and the modal is not in a build wait state (incremental catch-up in the status bar is unchanged).
- **Startup clocks and index checks wait until the workspace is ready.** Seek used to open its search index and start timing as soon as the plugin loaded, while File Recovery, cache, and sync were still connecting. Those checks now wait until the workspace layout is up, so early IndexedDB errors are not treated as Seek failures.
- **Settings still load when data.json starts with a UTF-8 BOM.** A Windows-saved settings file could fail to parse (`Unexpected token '﻿'`). Seek now strips the BOM before reading settings.
- **Plugin reload no longer leaves startup hitting a closed index or a torn-down iframe.** After `plugin:reload`, in-flight boot work from the prior load is abandoned, the index store is reopened before sidecar hydrate and reconcile, and diagnostics skip when the new load has already replaced the session. Catch-up, periodic reconcile, layout-ready scheduling, and flush timers also bail on the current load generation so a torn-down session does not log spurious errors.
- **Restored init files no longer trigger a false clone-collision alarm.** When the per-device init file is older than this install’s remembered generation (backup restore or sync conflict), Seek resyncs the counter instead of logging a device-clone error and scheduling device-id regeneration.
- **Reload no longer flashes Ready before Seek knows the index state.** The status bar stays **Starting** with a soft orange glow until inventory is probed and the first post-boot scheduling decision completes.
- **Delete & reindex no longer freezes Obsidian when another window holds the index.** A full rebuild empties the existing database instead of deleting it. A failed rebuild no longer leaves the store closed or starts a whole-vault catch-up on top of a still-valid index.
- **Seek no longer reports a plugin failure when the index database is briefly locked.** After reload or with another vault window open, IndexedDB can refuse the first open. Seek retries, keeps loading, and does not log index-not-opened errors for that lock. The index opens when the lock clears.
- **Leftover unscoped-index delete no longer runs on load.** Seek used to fire-and-forget a delete of the old bare `seek-index` database on every open, which could wedge LevelDB when two vault windows were open on the same origin.

### Added
- **Settings shows startup latency and recent search timing.** Under Index, **last startup** lists Searchable, Cache warm, and Fully ready with phase duration and wall-clock from Obsidian open. Under Diagnostics, a copyable console lists the last five modal searches as `[query] time`.
- **Index locked status when the database cannot open.** The status bar, search modal, and Settings index card show **Locked** instead of Ready or Starting. Seek retries opening in the background (2s, 5s, 10s, 15s), and the command palette adds **Retry opening the search index** when locked.

## 1.1.4

Search-modal honesty while the index is still coming up. No reindex is needed, since the index format is unchanged.

### Changed
- **Known-item search paints sooner.** Typing a note name or alias — including a partial last word, like `alex che` for “Alex Chen” — shows those matches before the semantic pass finishes. Keyword scoring starts without waiting on the query embedding. Full ranking still runs and can reorder the list.
- **Search no longer says the vault isn’t indexed while Seek is still restoring or building the index.** Opening search during sidecar hydrate, a pending first-time embed, or a full rebuild shows a waiting state instead of “Your vault isn’t indexed yet” or “No notes match.” Index status is an icon and short label in the footer next to esc; the query-row chip is gone.
- **Indexing progress lives in the status bar**, not a sticky toast. The item shows quantized percent for the current full or incremental pass (5% steps). Hover reuses the Settings index card (files, chunks, last index) plus this-pass counts. Single-note saves do not. Completion notices are unchanged.
- **Empty indexes now build through the fast full-reindex path on desktop.** A vault with no saved index (fresh install, sandbox reset, or cleared IndexedDB) previously indexed every note through throttled catch-up bursts — hours on a large vault. Seek now routes that case to a full reindex without the per-burst cap.
- **Catch-up batch size is adjustable in Settings → Index (advanced).** Desktop catch-up defaults to **30 notes per burst** (up from 8). Lower it if search feels sluggish while indexing; raise it up to 40 for faster backlog drain. Mobile keeps its fixed smaller cap.
- **Rapid typing no longer builds a queue of obsolete searches.** Superseded modal queries now leave the embedding queue before they run, while an already-running inference finishes safely before the latest query starts. This keeps follow-up searches responsive without changing indexing or ranking.

### Fixed
- **Catch-up indexing progress no longer resets or vanishes between bursts.** The status bar hid the job after every burst and restarted the counter when new edits arrived mid-drain, so remaining counts jumped backward and the badge often disappeared while indexing was still running. Progress now stays on one pass until the drain finishes or pauses for search.
- **Reload with a partial index restores saved search caches before catch-up embeds.** BM25 and frame caches from disk were skipped on dirty-only startup reconciles, so search stayed cold until catch-up finished re-embedding. Catch-up now reloads persisted caches once per boot when the index already has chunks.
- **Startup no longer treats a still-loading vault as a mass delete.** On a large vault, Seek could run its catch-up pass before Obsidian had listed any notes, see thousands of indexed files and zero live files, and log `deferring suspicious mass-delete sweep`. The index was kept, but every existing note then arrived as a `create` and queued a full re-embed. Catch-up now waits until the vault layout is ready, retries while the file list looks truncated, and ignores create/delete/rename until that point so boot enumeration is not mistaken for new notes.
- **Recent notes start appearing without another keystroke while Seek restores the index.** Startup previously declared its recent restore good enough after one note and an empty modal query stayed empty as more chunks arrived. Seek now restores every coverable note modified in the last three days before releasing the startup gate, automatically retries an active empty query as coverage grows, and leaves older recovery work in the background.

## 1.1.3

Performance release for editing notes in a large vault, prompted by a community bug report and the diagnostics shared with it. Thank you! No reindex is needed, since the index format is unchanged.

### Changed
- **Saving a note now only re-indexes the parts of it that changed.** Every save re-embedded the whole note and rewrote all of its entries in the keyword index, so editing one paragraph of a long note did the work of indexing that note from scratch, repeatedly, for any note you keep open and edit through the day. Seek now compares the new version against what it already has and touches only what actually differs, usually a chunk or two out of dozens. The note also stays searchable throughout, since nothing is removed until its replacement is ready.
- **Searching while a note is being indexed no longer waits.** Removing entries from the keyword index left bookkeeping behind that was reclaimed by a pass over every term in the index, and that pass ran while the index was locked, so a search issued at that moment queued behind it. Removals are now exact and leave nothing to reclaim, and the pass is gone. On a heavily edited note in a large vault, the locked portion of a save went from roughly 2 to 7 seconds down to under a tenth of a second.
- **A pause after saving is gone.** Seek periodically writes a snapshot of the keyword index to disk, and that write happened in a single uninterruptible step that grew with vault size, up to two thirds of a second. It now waits for an idle moment, and only runs immediately when the window is hidden, where there is no interface to hold up.
- **Indexing in a hidden window no longer crawls.** Indexing paces itself between batches by waiting for the screen to be ready for more work, but a hidden window never reports that, so the wait fell back to a timeout on every batch. A run that takes a minute in the foreground could stretch to many times that with Obsidian in the background, keeping the CPU busy the whole time. Hidden windows now pace without waiting on the screen.
- The logging report now records whether each index update was applied incrementally, the reason when one wasn't, and how long the index was held, so a slow vault can be diagnosed from the report alone.

## 1.1.2

Diagnostics release, improving the logging report users are asked to share when filing an issue. No reindex is needed, since the index format is unchanged.

### Changed
- **The logging report now redacts note paths, titles, and search queries by default.** The report is the one file users are asked to paste into a public issue, and it carried note paths and query text, so sharing it meant hand-scrubbing it first. Every identifier is now replaced with a token derived from a salt that is generated fresh for each report and never stored, so repeated references to the same note stay correlated (patterns like one file re-embedding every hour remain visible) while the actual names are not disclosed and cannot be recovered or matched across reports. File extensions are kept, and queries are reduced to a length and word count. A new setting turns redaction off for relevance triage, where the query and the notes it matched are the evidence.
- **Stalls in the report now name the frame responsible and flag periodic patterns.** Long tasks previously recorded a frame attribution field that the browser spec defines as the constant string "unknown", so every stall looked anonymous. The report now records which frame ran the task, and the summary detects stalls recurring on a near-exact fixed period, which separates an external timer's work from Seek's own.

## 1.1.1

Indexing and sync reliability release. No reindex is needed, since the index format is unchanged.

### Changed
- **Editing a note no longer rewrites a large sync file.** Cross-device sync previously merged every change into an active shard file, so a small edit near a full 4 MB shard read and rewrote the whole file, and services like iCloud re-uploaded all of it. Each change now lands in a small fresh file, and a background pass folds accumulated small files back into dense ones, so file counts stay low at rest.
- **Searching during a full rebuild pauses indexing instead of competing with it.** A full reindex now yields between files while a query is in flight and resumes where it left off, so searches stay responsive during an initial build without cancelling any indexing work.
- **Searches no longer wait for sync files to finish writing.** At the end of an indexing pass, the sync data was written while the index was still locked, so a search issued at that moment queued behind file IO. The write now happens after the index is released.
- **Running out of storage shows one clear notice.** If the device's storage quota fills mid-index, affected files are skipped with a single "storage full" notice instead of failing quietly on every file, and they are picked up automatically once space frees.
- **A file's index entry now commits in one transaction.** A file's chunks and its bookkeeping record used to be written separately, so an interruption at the wrong moment could leave a file half-indexed. That window is closed.
- Diagnostics now record why an incremental update fell back to a full pass, to guide future tuning.

## 1.1.0

The first feature release since launch! A big thanks to everyone on the reddit thread with feedback and suggestions! No reindex is needed, since the index format is unchanged.

### Added
- **Recent searches.** The last three searches now appear in the modal's resting state, under the query field. Only searches where you opened a result, or closed the modal while results were showing are shown, and this history is not synced across devices.
- **Insert a link to a result without leaving the modal.** Shift+Enter, or Shift+click, inserts a wikilink to the highlighted result at your cursor. The link mirrors what opening the result would do: when your query strongly matches the note's title it inserts `[[Note]]`, and otherwise it links the section the match was found in, `[[Note#Section]]`. Ported from [@adrianghnguyen](https://github.com/adrianghnguyen)'s fork, thank you!
- **A setting for where Cmd/Ctrl opens a result** (Display → "Open results with Cmd/Ctrl in"): a new tab (the previous behavior, still the default), a split, or a window (desktop only). A plain click or Enter still opens in the current tab.

### Changed
- **Improvements to Snippets**
    - Seek previously anchored the snippet on the earliest raw text match of any query word including stopwords, and without respecting word boundaries. So "bread not rising" would anchor on the "not" inside "cannot". A result matched on meaning rather than wording often fell back to showing the start of the section with nothing marked. Snippets are now chosen by scoring candidate sentences and returning the best-matching window, similar to Lucene's highlighter.
- **A strong title match now opens the note at the top**
    - Queries where all search terms are in the title of a note are treated more like a note look up, rather than a passage search. Queries carrying terms beyond the title still jump to the best matched section within that note.
- **Indexing is quieter.** A large sync could leave a live-updating progress notice on screen for the entire embedding run, which could be many minutes. Indexing now shows one notice when it starts and a summary when it finishes. Live progress still streams to the inline display in settings.
- **Embedding runs off the main thread wherever WebGPU isn't in use**
    - Using a webworker on iPhone and Android, desktop with "Force CPU", and desktop when WebGPU falls back. Which keeps the interface responsive while the index builds. Results are unchanged: same model, same vectors, same throughput, only a different thread. Any failure falls back to the previous behavior.
- **The footer hint bar drops hints it can't fit** instead of overflowing the modal on narrow windows.
- **Recency "High" more strongly favors recent notes.** High now uses a 90-day half-life, so an episodic vault queried by series name ("standup", "1x1", "session") surfaces the recent entries.
- **The relevance readout no longer reports a recency score while the recency bonus is Off.** With "Show scores" enabled, the recency figure was computed and displayed even when it was being multiplied by zero and contributing nothing to the ranking.
- **A search from the CLI or an `obsidian://seek` link no longer waits for indexing to finish.** These paths didn't signal that a query was in flight, so a search could queue behind an entire indexing pass. On a cold install, a first search could wait out the full initial build. They now interrupt indexing the way a search from the modal always has.
- **A file Seek could never finish re-reading no longer makes the app unresponsive every few minutes.** Index compaction re-ran its whole-vault pass on every poll when a file was persistently unreadable — an iCloud file whose contents were never downloaded, for example. The pass now yields as it works and stops retrying after a few attempts.
- On mobile, releasing the model while idle could interrupt index compaction mid-pass, manufacturing the incomplete-pass retries above.

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
