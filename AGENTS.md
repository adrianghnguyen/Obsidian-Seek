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
- To run the built plugin in a real vault, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/seek/`. First real index downloads the embedding model from `huggingface.co` and the transformers.js runtime from `cdn.jsdelivr.net` (once per device).
