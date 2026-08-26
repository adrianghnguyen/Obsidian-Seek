# AGENTS.md

## Cursor Cloud specific instructions

Seek is an **Obsidian plugin** (TypeScript, bundled with esbuild). There is no standalone server or web app — the plugin runs inside the Obsidian desktop/mobile app. Dependencies are managed with npm (`package-lock.json`); the startup update script already runs `npm ci`.

Standard commands live in `package.json` `scripts` — use those:
- `npm run typecheck` — `tsc --noEmit`. This is the static-analysis gate; there is **no separate lint step** (no ESLint config in the repo). CI (`.github/workflows/ci.yml`) runs typecheck → test → build.
- `npm test` — Vitest suite (~1000 tests, runs in a few seconds, no network needed).
- `npm run build` — production esbuild → `main.js` (minified, ~280 KB).
- `npm run dev` — esbuild in **watch mode** (does not exit; rebuilds `main.js` on change with inline sourcemaps, ~3 MB). Run it as a background/tmux process.

Non-obvious notes:
- `main.js`, `main.js.map`, and `*.log` are gitignored build artifacts — do not commit them.
- The `obsidian` npm package is **types-only** (`main: ""`). At build time esbuild externalizes it; under Vitest it is aliased to `src/test-stubs/obsidian.ts` (see `vitest.config.mts`). Only import runtime *values* from `obsidian` if that stub provides them.
- Tests run on `fake-indexeddb` (a W3C-faithful IndexedDB) and a deterministic fake embedder — the real ~100 MB embedding model is never downloaded in tests/CI.
- To exercise the real search pipeline (chunk → embed → store → BM25 fuse → rank) without Obsidian, use the Tier-2 harness in `src/test-harness/scenario.ts`: `Scenario` boots the real `SearchOrchestrator` + `IndexStore` over a fake vault/embedder, and `orch.search(query, k)` returns ranked results.
- To run the built plugin in a real vault, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/seek/`. First real index downloads the embedding model from `huggingface.co` and the transformers.js runtime from `cdn.jsdelivr.net` (once per device). Deploy/reload/verify details: `.cursor/rules/deploy-and-verify.mdc` (vault path `C:\Obsidian\.obsidian\plugins\seek\`).
- **Logging report (local debug):** Settings → Seek → Diagnostics → **Generate logging report**, or `obsidian eval vault=Obsidian code="app.plugins.plugins.seek.openLoggingReport().then(()=>'ok')"`. That is `SeekPlugin.openLoggingReport()` → `SeekLogger.writeReport()` (`src/main.ts`, `src/logger.ts`). It writes vault-root `seek-report.md` (short summary, opened in a leaf) and `seek-report.json` (parse target: `sidecar-hydrate`, `index-complete` with `chunkDurationMs` / `embedDurationMs`, searches, errors; no note bodies). Honors `redactReport`. Prefer this over `dev:console` for index/startup forensics — the CDP buffer often misses hydrate. The old command-palette `seek-generate-log` entry is gone. Obsidian CLI (`eval`, `seek:search`, `dev:console`, `dev:dom`) must stay **serial** — one session; parallel subagents queue behind each other and contaminate timings.

Configurable settings must always be available in the plugin options menu (Settings → Seek / `settings-tab.ts`). Do not add a user-tunable flag (synced `data.json` or per-device localStorage) without a corresponding control there. Hidden silent defaults are only for ratified non-user knobs already documented in `DEFAULT_SETTINGS`.

## Upstream sync (this is a fork)

This working copy is the **fork**, not the parent. Day-to-day push/PR work targets `origin` (`adrianghnguyen/Obsidian-Seek`). `upstream` is only for syncing parent releases.

Remotes:
- `origin` — fork (`adrianghnguyen/Obsidian-Seek`)
- `upstream` — parent (`ryan-manor/Obsidian-Seek`); keep this remote permanently

`gh` may resolve the default repo to **upstream** (read-only). For PRs and `gh pr` / `gh api` against our work, always pass `--repo adrianghnguyen/Obsidian-Seek` (or ensure the cwd remote/`gh` default is the fork). Do not open routine feature PRs against `ryan-manor/Obsidian-Seek` unless the user explicitly asks to contribute upstream.

Prefer **merge on a temp branch**, not rebase, so each sync builds a shared merge-base and does not force-push `main`.

Every sync cycle:
1. Clean working tree on `main`; `git fetch upstream` (and `origin`)
2. `git checkout -b sync/upstream-<upstream-version>` from `main`
3. `git merge upstream/main`
4. Resolve conflicts (heuristics below); **stop and ask the user** on ambiguous UX overlaps
5. `npm ci` if lockfile changed → `npm run typecheck` → `npm test` → `npm run build`
6. `git checkout main` → `git merge --ff-only sync/upstream-<version>` → `git push origin main`
7. Deploy to the Obsidian vault (copy artifacts + reload/restart + verify)
8. Delete the temp branch when done

Conflict heuristics:
- Prefer **upstream** for index/store/embedder/BM25/pacer/logger/redact/sidecar/stall paths
- Prefer **fork** for search-modal UX, insert-link (Alt+Enter / alias modes), OpenTarget modifiers (`seek:open`), modal size/snippet/alias settings, Windows CRLF atom fix
- Manually combine `CHANGELOG.md`; version tracks the upstream release unless a fork-only patch is required
- Do not silently pick sides when both change behavior — list conflicts and ask
