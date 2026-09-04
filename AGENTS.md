# AGENTS.md

## Cursor Cloud specific instructions

### UI transparency gate
Any feature, behavioral change, or settings addition that affects what the user sees or experiences must be reviewed against the plugin's own UI surfaces — Settings (especially the Relevance pipeline diagram and the Search stages explainer), the search modal footer, status bar, and keyboard hints. If the change introduces a new state, label, ranking stage, or visual cue that the plugin advertises, the corresponding UI surface in the plugin must be updated to explain or reflect it. This ensures Seek users always have a path to understand what the plugin is doing.

### Commands

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
- **System Architecture & Call Orders:** Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the end-to-end system design, module domain map, lifecycle call order sequences (§4.4), and decomposition learnings (§15). Interactive visual map: [docs/seek-architecture.canvas.tsx](docs/seek-architecture.canvas.tsx).
- To exercise the real search pipeline (chunk → embed → store → BM25 fuse → rank) without Obsidian, use the Tier-2 harness in `src/test-harness/scenario.ts`: `Scenario` boots the real `SearchOrchestrator` + `IndexStore` over a fake vault/embedder, and `orch.search(query, k)` returns ranked results. Full-pipeline contract tests live in `src/search-integration.test.ts`. **Decomposing `search.ts`:** read [docs/archive/SEARCH-DECOMPOSITION.md](docs/archive/SEARCH-DECOMPOSITION.md) — extract pure helpers first; never merge parallel CacheManager/SearchQuery copies without deleting orchestrator originals in the same PR.
- To run the built plugin in a real vault, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/seek/`. First real index downloads the embedding model from `huggingface.co` and the transformers.js runtime from `cdn.jsdelivr.net` (once per device). **Default deploy target:** sandbox `C:\plugin-sandbox-Obsidian\.obsidian\plugins\seek\` — see `.cursor/rules/deploy-and-verify.mdc`. Production vault `Obsidian` is promotion-only.
- **Visual verification:** UI, CSS, status-bar, modal, or settings changes need **screenshots**, not only `eval` or unit tests. Follow [`.cursor/skills/seek-visual-verify/SKILL.md`](.cursor/skills/seek-visual-verify/SKILL.md) — it lists which surface to capture (`Main`, `StatusBar`, `Settings`, `SearchModal`). Open Settings only when verifying Settings UI. Driver: `capture-surfaces.ps1` under that skill.
- **Obsidian CLI — serial only (never block threads):** See global skill `~/.cursor/skills/obsidian-multi-vault-cli/SKILL.md` (per-vault reload vs global restart, staging vs production). The CLI is a **single IPC queue** into one Obsidian process. **One `obsidian` command at a time** — wait for it to finish (or fail) before the next. Do **not** run parallel `eval`, `plugin:reload`, `dev:screenshot`, or `restart` in the same turn, across subagents, or in background shells. Chaining many CLI calls in one long script also wedges the queue if an early step hangs. Open/focus a vault with `Start-Process "obsidian://open?vault=<name>"` first; then run CLI **serially** with `vault=<name>`. If commands hang with no `=>` output for ~15s, **stop** — do not pile on more CLI. Kill the stuck shell, **quit Obsidian manually** (tray → Quit), reopen, then retry one `eval code="'alive'"` probe. When the IPC queue is wedged, `obsidian restart` often **never reaches** the app (Obsidian will not close). Prefer manual quit over CLI restart in that state. Reusable eval/reload driver: [`.cursor/skills/seek-cli-startup-debug/scripts/verify-vault-seek.ps1`](.cursor/skills/seek-cli-startup-debug/scripts/verify-vault-seek.ps1) (auto-launch, copy, reload, eval — no screenshots). Use `-NoLaunch` to require Obsidian already up. See `.cursor/rules/deploy-and-verify.mdc` and `.cursor/skills/obsidian-plugin-debug/SKILL.md`. For IDB corruption, CLI restart failures, and sandbox recovery procedures, see [`.cursor/skills/seek-dev-troubleshooting/SKILL.md`](.cursor/skills/seek-dev-troubleshooting/SKILL.md).
- **Logging report (local debug):** Settings → Seek → Diagnostics → **Generate logging report**, or `obsidian eval vault=plugin-sandbox-Obsidian code="app.plugins.plugins.seek.openLoggingReport().then(()=>'ok')"` (use `vault=Obsidian` only when promoting/reproducing in production). That is `SeekPlugin.openLoggingReport()` → `SeekLogger.writeReport()` (`src/main.ts`, `src/logger.ts`). It writes vault-root `seek-report.md` (human summary, opened in a leaf) and `.seek-artifacts/seek-report.json` (parse target: `sidecar-hydrate`, `index-complete` with `chunkDurationMs` / `embedDurationMs`, `rechunk-live`, `startup-span`, `startup-gate`, searches, errors; no note bodies). Honors `redactReport`. Prefer the JSON over `dev:console` for index/startup forensics — the CDP buffer often misses hydrate. The old command-palette `seek-generate-log` entry is gone.
- **Startup path deploy:** Build from the main repo checkout. Deploy: `deploy-worktree-to-vault.ps1 -PathId <id>`. Cursor agent worktrees use `.cursor/worktrees.json` (`npm ci` on create). Measure via `startup-trace-probe.ps1` → `gate-trace.jsonl` + `parse-startup-trace.mjs` → `.cursor/scorecards/` and `.cursor/startup-path-results.md`.
- **Telemetry playbook (S1–S7, F1–F10):** Master catalog [`.cursor/skills/seek-playbook-catalog/SKILL.md`](.cursor/skills/seek-playbook-catalog/SKILL.md) — `list-scenarios.ps1`, `run-scenario.ps1 -Id F3`. Performance detail: `seek-telemetry-playbook`; functional detail: `seek-functional-telemetry`. Canvas dashboard: `sandbox-run-history.canvas.tsx` (local Cursor canvases folder). **After telemetry runs, update that canvas per [`.cursor/rules/telemetry-canvas-update.mdc`](.cursor/rules/telemetry-canvas-update.mdc).**

## Vault roles — sandbox default, Obsidian production

| Vault (CLI) | Path | Role |
|-------------|------|------|
| `plugin-sandbox-Obsidian` | `C:\plugin-sandbox-Obsidian` | **Default** — routine deploy, reload, CLI verify, playbooks, cold-start at scale (~3k notes) |
| `Obsidian` | `C:\Obsidian` | **Production** — personal notes; deploy **only** on explicit promotion or after merge to `main` + user request |

Copy `main.js`, `manifest.json`, and `styles.css` to the sandbox plugin path for testing. Do **not** copy to `C:\Obsidian\.obsidian\plugins\seek\` during feature branches or routine task completion. Policy is in `.cursor/rules/deploy-and-verify.mdc`.

## Sandbox vault — cold-boot / indexing CLI runs

**Indexing and cold-start probes** use the sandbox (large corpus without touching production):

| | |
|--|--|
| Vault name (CLI) | `plugin-sandbox-Obsidian` |
| Plugin path | `C:\plugin-sandbox-Obsidian\.obsidian\plugins\seek\` |
| Corpus | ~3k markdown notes — good for cold-build vs catch-up timing |

Copy the same three artifacts (`main.js`, `manifest.json`, `styles.css`) to the sandbox plugin folder. Verify hashes match before probing.

### Sandbox recovery

The sandbox vault can enter unrecoverable IDB states (corruption after version change, locked store, stuck generation at 0). See [`.cursor/skills/seek-dev-troubleshooting/SKILL.md`](.cursor/skills/seek-dev-troubleshooting/SKILL.md) for diagnosis commands and recovery procedures.

### Avoid debug interruptions (learned 2026-08-29)

A cold-boot test runs `scheduleColdBuild()` → `runFullReindex({ skipConfirm: true })`. That pass holds the embedder iframe for many minutes. **Do not reload or disable Seek while it is running.**

| Action during full reindex | Effect |
|--------------------------|--------|
| `plugin:reload id=seek` | **Aborts** the pass (`seek-full-reindex` / `iframe disposed` in logs); leaves a partial index (few files/chunks) |
| `plugin:disable` / Obsidian restart | Same — torn-down iframe, incomplete IDB |
| Polling `obsidian eval` every 10s | **OK** — read-only probes do not interrupt |

After an aborted run, the sandbox often shows `uiHealth: error`, `index-identity-mismatch` (empty/partial meta), and **no** further indexing until you reset IDB and retry.

**Wrong (aborts cold build):** disable → delete IDB → restart → `plugin:enable` → **`plugin:reload`** → poll.

**Right (cold empty index → full reindex):**

1. `obsidian plugin:disable id=seek vault=plugin-sandbox-Obsidian`
2. Delete IndexedDB (plugin must be disabled so nothing holds the DB):

   ```powershell
   obsidian eval vault=plugin-sandbox-Obsidian code="(()=>{const id=app.appId||app.vault.getName();return 'seek-index:'+id})()"
   # then, with that db name:
   obsidian eval vault=plugin-sandbox-Obsidian code="new Promise((res)=>{const r=indexedDB.deleteDatabase('seek-index:<appId>');r.onsuccess=()=>res('deleted');r.onerror=()=>res('error');r.onblocked=()=>res('blocked')})"
   ```

3. `obsidian plugin:enable id=seek vault=plugin-sandbox-Obsidian` — **do not reload**. If enable fails or IDB delete was `blocked`, use global restart only after confirming the user accepts closing **all** open vaults (see the global skill `obsidian-multi-vault-cli`).
4. Poll serially (e.g. every 10s) for `getIndexJob().kind === 'full'` and rising `done`/`total` (~2998 notes)
5. Confirm in `logs/seek-log-*.ndjson`: `index-complete` with `"mode":"full"`; final `getIndexStats()` ~2998 files; optional `seek:search` smoke

Success on sandbox (2026-08-29, post cold-build routing): **~3 minutes** for ~3k notes on full path vs hours on old 8-file catch-up bursts.

Keep all CLI (`eval`, `seek:search`, `dev:console`) **serial** on one Obsidian session. For first-load forensics, follow `.cursor/skills/seek-cli-startup-debug/SKILL.md` (cold-start may need restart — warn that it closes every vault — then enable; not reload mid-pass).
 (Settings → Seek / `settings-tab.ts`). Do not add a user-tunable flag (synced `data.json` or per-device localStorage) without a corresponding control there. Hidden silent defaults are only for ratified non-user knobs already documented in `DEFAULT_SETTINGS`.

User-facing features, fixes, and settings changes: add bullets to `CHANGELOG.md` `[Unreleased]` when ready; version bump on `main` only — see global skill `~/.cursor/skills/obsidian-plugin-dev/SKILL.md` (Release notes and semantic versioning). Upstream sync adopts upstream version; fork-only patches accumulate under `[Unreleased]` until a fork release on `main`.

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
7. Deploy to **sandbox** (`plugin-sandbox-Obsidian`: copy artifacts + reload + verify); promote to `Obsidian` only when merged to `main` and user requests production
8. Delete the temp branch when done

Conflict heuristics:
- Prefer **upstream** for index/store/embedder/BM25/pacer/logger/redact/sidecar/stall paths
- Prefer **fork** for search-modal UX, insert-link (Alt+Enter / alias modes), OpenTarget modifiers (`seek:open`), modal size/snippet/alias settings, Windows CRLF atom fix
- Manually combine `CHANGELOG.md`; version tracks the upstream release unless a fork-only patch is required
- Do not silently pick sides when both change behavior — list conflicts and ask
