---
name: seek-cli-startup-debug
description: Probes Seek first-load and startup behavior via the Obsidian CLI (obsidian eval, dev:debug, dev:console, dev:errors, restart, plugin:reload, seek:search). Use when debugging cold-start timing, hydrate/catch-up, model load, warmCaches, or empty search during startup — not for npm test/build unless explicitly asked.
---

# Seek CLI startup debugging

Runtime probe of Seek **first-load / cold-start** behavior through the Obsidian CLI. Do not run `npm test` / `npm run build` as part of this workflow unless the user asks.

Defaults: vault `Obsidian`, plugin id `seek`, vault plugin path `C:\Obsidian\.obsidian\plugins\seek\`.

## Golden rule

**Always begin with `obsidian restart vault=Obsidian`** when investigating cold-start / first-load behavior. Warm-session baselines are misleading.

## Readiness gates (source of truth)

Maps to `src/index-notice.ts`, `src/main.ts`, `src/search.ts`.

### Internal phases (`resolveIndexLoadPhase`)

| Phase | Set when | Clears when |
|-------|----------|-------------|
| `hydrating` | `indexBootPending \|\| sidecarHydrating` | Sidecar/reconcile IIFE `finally` block |
| `indexing` | `catchUpPending`, `catchUpRunning`, `flushing`, `isIndexing`, or orchestrator `isWriting()` | Each flag clears independently |
| `idle` | None of the above | — |

Boot sequence (onload): orchestrator created **synchronously** → `sidecarHydrating=true` → async IIFE (identity gate → sidecar hydrate → `reconcileOnLoad`) → `finally`: clear hydrate flags, `touchIndexInventory`, fire `warmCaches('startup')` if `getStartupWarm()`.

### UI / status-bar labels (`indexUiHealth`, modal footer)

| Code signal | Status-bar / footer label |
|-------------|---------------------------|
| `waitingForSidecar` / peer sync | Restoring |
| `hydrating` / `indexWarmPhase==='starting'` | Starting |
| `catchUp*` / `flushing` / `isIndexing` / `recovering` / active job | Indexing |
| `indexHealth==='degraded'` | Error |
| `files===0` (inventory) | None |
| Otherwise + model ready | Ready (`ok`) |

### CLI `seek:search` gate

| Output | Meaning |
|--------|---------|
| `Seek not initialized — plugin still loading` | `orchestrator` is null (very early onload only) |
| `Seek not ready — search index still loading` | `indexWarmPhase`/`uiHealth` is starting |
| `Seek not ready — restoring search index from another device` | restoring / sidecar wait |
| `Seek not ready — index still building` | indexing with **zero** searchable chunks |
| `Seek not ready — no indexed notes yet` | idle empty inventory |
| `Seek · "…" · no results` | Search ran; empty frame, bad query, or coherence/dim fault — **not** a loading gate |
| Ranked hits | Search pipeline succeeded for this query |

CLI does **not** wait for catch-up or `warmCaches` once chunks exist. It **does** block during starting/restoring so a query cannot race sidecar hydrate.

### When is search “ready”?

Do **not** use orchestrator presence or absence of “still loading” as ready.

Prefer this checklist (all via public eval fields below):

1. `indexWarmPhase === null` — hydrate IIFE finished
2. `indexUiHealth === 'ok'` — not starting/restoring/indexing/error/none
3. `chunks > 0` in `getIndexStats()` — frame can be built
4. `seek:search` returns ranked hits for a probe query that should match vault content

`warmCaches('startup')` is async and **not** CLI-observable; search may return hits before warm finishes. `getIndexStats()` inventory can lag mid-pass — during an active job, trust `getIndexJob()` remaining over file/chunk counts.

### Private vs observable

| Private (no eval access) | Observable workaround |
|--------------------------|----------------------|
| `indexBootPending`, `sidecarHydrating` | `indexWarmPhase`, `isIndexWarmingUp` |
| `catchUpPending`, `catchUpRunning`, `flushing` | `indexUiHealth === 'indexing'`, `getIndexJob()` |
| `indexLoadState()` / `phase` | Combine `indexWarmPhase` + `indexUiHealth` + stats |
| `orchestrator` | CLI accepts `seek:search` once plugin loaded; empty vs error semantics above |
| `warmCaches` in flight | No direct probe; infer from console or post-idle search latency |

## Protocol (ordered steps)

Run probes **serially** — never parallel eval/search storms (contaminates timing + console).

1. Clear buffers: `dev:console clear`, `dev:errors clear`
2. `obsidian restart vault=Obsidian`
3. Poll until alive (every 1–2s, typical ~5–8s):

   ```powershell
   obsidian eval vault=Obsidian code="JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})"
   ```

4. **Reattach debugger** (does NOT survive restart): `obsidian dev:debug on vault=Obsidian`
5. Poll timeline every 2–3s for up to ~90s (large vaults may need longer) — use **gate bundle** probe each tick
6. Capture `dev:console limit=150` and `dev:errors` at end
7. Log to `.startup-probe.log` in repo root for clean parsing

Optional helper: [scripts/startup-probe.ps1](scripts/startup-probe.ps1) runs steps 1–5 with serial probes.

## Eval probes (PowerShell-safe)

Top-level `await` does **NOT** work in `obsidian eval` — use `.then(...)`.

Parse eval stdout: result lines start with `=>`.

| Probe | Command |
|-------|---------|
| Version (sync) | `app.plugins.plugins.seek ? app.plugins.plugins.seek.manifest.version : 'missing'` |
| **Gate bundle** | See below |
| Index stats | `app.plugins.plugins.seek.getIndexStats().then(x=>JSON.stringify({files:x.files,chunks:x.chunks,indexMB:Math.round(x.indexMB\|\|0),modelMB:Math.round(x.modelMB\|\|0),calibrated:x.calibrated}))` |
| Model status | `app.plugins.plugins.seek.getModelStatus().then(x=>JSON.stringify({downloaded:x.downloaded,persisted:x.persisted,name:x.name}))` |
| Warm flag | `localStorage.getItem('seek-startup-warm')` — **`null` means ON** (`src/platform.ts` `getStartupWarm`) |

Gate bundle (one eval per poll tick):

```text
(()=>{const s=app.plugins.plugins.seek;if(!s)return JSON.stringify({seek:false});const j=s.getIndexJob();return s.getIndexStats().then(st=>JSON.stringify({ver:s.manifest.version,warmPhase:s.indexWarmPhase,warmingUp:s.isIndexWarmingUp,uiHealth:s.indexUiHealth,indexHealth:s.indexHealthState,isIndexing:s.isIndexing,job:j?{done:j.done,total:j.total,remaining:Math.max(0,j.total-j.done)}:null,files:st.files,chunks:st.chunks}))})()
```

Example one-liner:

```powershell
obsidian eval vault=Obsidian code="app.plugins.plugins.seek.getIndexStats().then(x=>JSON.stringify({files:x.files,chunks:x.chunks}))" 2>&1 | Tee-Object -Append .startup-probe.log
```

## Search probe

```powershell
obsidian seek:search query=probe limit=1 vault=Obsidian
```

Run **after** gate bundle on the same tick. Interpret with the table above — `no results` during `warmPhase:'starting'|'restoring'` or `chunks:0` is expected; during `uiHealth:'ok'` with `chunks>0` it warrants investigation (stranded index, query mismatch, degraded index).

## Expected startup timeline

Approximate; vault-size dependent. Use gate bundle columns, not fixed seconds alone.

| Gate bundle signal | Typical timing | Notes |
|--------------------|----------------|-------|
| `seek:true` | ~5–8s | Obsidian CLI alive |
| `warmPhase:'starting'` or `'restoring'` | hydrate IIFE | Sidecar restore / identity; search often `no results`, `chunks` may be 0 |
| `warmPhase:null`, `uiHealth:'indexing'` | post-hydrate | `reconcileOnLoad` catch-up or `warmCaches`; job badge may show remaining |
| `warmPhase:null`, `uiHealth:'ok'`, `chunks>0` | vault-size dependent | Index inventory stable; search should hit for good probe query |
| Console (normal) | during warm | `[seek] model loaded with warnings on webgpu`, binary divergence, orphan drops |
| Console (actionable) | stranded | `[seek] index is EMPTY and the sidecar restored nothing` |

## Plugin reload probe (optional, separate battery)

Only after a **clean restart + stable index** (`uiHealth:'ok'`, stable chunks).

1. Clear buffers
2. `obsidian plugin:reload id=seek vault=Obsidian`
3. Poll gate bundle + search every 2–3s

Reload can briefly return hits on a partial index, then `no results` or `uiHealth:'indexing'` during catch-up. **Never** run reload probe concurrently with restart probe.

## PowerShell notes

- Use `;` not `&&` on Windows PowerShell
- Log to `.startup-probe.log` for clean parsing
- Git safe.directory prefix if needed: `git -c safe.directory=C:/coding_projects/Obsidian-Seek ...`

## Report template

Return a concise summary using this table plus verbatim Seek console lines.

| elapsed_s | ver | warmPhase | uiHealth | files/chunks | job remaining | model downloaded | search snippet | notes |
|-----------|-----|-----------|----------|--------------|---------------|------------------|----------------|-------|
| 0 | — | — | — | — | — | — | — | restart issued |
| 8 | 0.x.x | starting | starting | 0/0 | — | true | no results | hydrate IIFE |
| 48 | 0.x.x | null | ok | 412/1834 | — | true | ranked hit | ready |

Also list:

- Seek `[seek]` console lines verbatim (from `dev:console`)
- Any `dev:errors` entries
- Probe caveats (warm session skipped, vault size, parallel contamination, `warmCaches` not observable)

## Anti-patterns

- Probing warm instance without restart for first-load questions
- Parallel subagents hitting CLI simultaneously
- Treating `seek:search` acceptance or absence of “still loading” as ready
- Treating `no results` as ready when `uiHealth !== 'ok'` or `chunks === 0`
- Expecting `dev:console` to work before `dev:debug on`
- Running npm test/build as part of startup probe unless asked
