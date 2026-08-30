---
name: seek-visual-verify
description: Capture Obsidian screenshots for visual verification of Seek UI (status bar, settings, search modal, main chrome). Use when finishing UI/CSS/layout/modal/settings/status-bar work, reporting visual bugs, or when deploy-and-verify requires proof beyond eval — not for startup timing-only probes.
---

# Seek visual verification (screenshots)

Runtime proof for **what the user sees** in Obsidian. `eval` and unit tests are not enough for CSS, layout, status-bar labels, modal chrome, or Settings rows.

**Prerequisites:** Obsidian desktop, `obsidian` on PATH, serial CLI only (one command at a time). Shared helpers: [`.cursor/skills/seek-cli-startup-debug/scripts/lib/ObsidianCliSerial.ps1`](../seek-cli-startup-debug/scripts/lib/ObsidianCliSerial.ps1).

**Related:** Low-level DOM/screenshot notes — [`obsidian-plugin-debug`](file:///C:/Users/tilou/.cursor/skills/obsidian-plugin-debug/SKILL.md). Deploy/reload first — [`.cursor/rules/deploy-and-verify.mdc`](../../rules/deploy-and-verify.mdc).

**Default vault:** `plugin-sandbox-Obsidian`. Use `Obsidian` only for production promotion verification when the user explicitly requests it.

## When to run (agent checklist)

Run this skill **after** deploy + `plugin:reload` when the task touches any of:

| Change area | Capture surface(s) |
|-------------|-------------------|
| Status bar dot, label, `%`, ETA, orange glow | `StatusBar` or `Main` |
| Settings → Seek (progress row, buttons, copy) | `Settings` only |
| Search modal (layout, snippets, footer, blocking message) | `SearchModal` |
| `styles.css` / global plugin chrome | `Main` + the affected surface |
| “Looks wrong in Obsidian” bug reports | Surface the user named; default `Main` |

**Skip screenshots** for: pure logic/index/store, typos in comments, test-only, docs-only, telemetry JSON-only runs.

**Do not** open Settings unless you are capturing `Settings`. The rest of the UI (editor, status bar, modals) is verified with `Main`, `StatusBar`, or `SearchModal` only.

## Driver script

From repo root (PowerShell, **serial** — do not run alongside other `obsidian` CLI):

```powershell
.\.cursor\skills\seek-visual-verify\scripts\capture-surfaces.ps1 `
  -Vault plugin-sandbox-Obsidian `
  -Surface Main, StatusBar

.\.cursor\skills\seek-visual-verify\scripts\capture-surfaces.ps1 `
  -Vault plugin-sandbox-Obsidian `
  -Surface Settings

.\.cursor\skills\seek-visual-verify\scripts\capture-surfaces.ps1 `
  -Vault plugin-sandbox-Obsidian `
  -Surface SearchModal
```

| Parameter | Default | Notes |
|-----------|---------|-------|
| `-Vault` | `plugin-sandbox-Obsidian` | `Obsidian` = production promotion only |
| `-Surface` | `Main` | `Main`, `StatusBar`, `Settings`, `SearchModal` (comma-separated or repeated) |
| `-OutputDir` | `.seek-artifacts/visual-<vault>/` | Gitignored |
| `-NoLaunch` | off | Fail if Obsidian not running |

Output files: `main.png`, `status-bar.png`, `seek-settings.png`, `search-modal.png`.

## Workflow (what the script does)

1. **Ensure vault ready** — launch/focus via `obsidian://open?vault=…` if needed; poll until `eval code='alive'`.
2. **Focus Obsidian window** (Win32) so `dev:screenshot` is not an empty “New tab” from Cursor focus.
3. **Per surface — prepare UI, then one screenshot:**
   - **Main / StatusBar:** dismiss modals and close Settings; leave normal editor chrome (status bar visible at bottom).
   - **Settings:** open Settings → Seek tab, then capture (never use this step for status-bar-only checks).
   - **SearchModal:** dismiss other UI, run `seek:search`, wait for modal paint, capture.
4. **Report paths** to the user; open images locally when judging pass/fail.

## Manual CLI (if not using the script)

Always: focus vault URI → focus Obsidian window → prepare target UI → **one** `dev:screenshot`:

```powershell
Start-Process "obsidian://open?vault=plugin-sandbox-Obsidian"
obsidian eval vault=plugin-sandbox-Obsidian code="app.commands.executeCommandById('seek:search')"
obsidian dev:screenshot vault=plugin-sandbox-Obsidian path=C:\Coding_projects\Obsidian-Seek\.seek-artifacts\visual-plugin-sandbox-Obsidian\search-modal.png
```

Production promotion only:

```powershell
Start-Process "obsidian://open?vault=Obsidian"
obsidian dev:screenshot vault=Obsidian path=C:\Coding_projects\Obsidian-Seek\.seek-artifacts\visual-Obsidian\search-modal.png
```

Close stacked modals before capturing a different surface (Escape / close Settings). See obsidian-plugin-debug “UI capture” section.

## Pass criteria examples (1.1.x index UI)

- **Starting:** orange pending dot + “Starting” before inventory/boot decision completes.
- **Full index:** status bar exact `%` + rough ETA; Settings progress row matches `getIndexJob()` when `-Surface Settings`.
- **Search blocked during full pass:** modal shows not-ready copy; capture with `-Surface SearchModal` while job `kind==='full'`.

## Anti-patterns

- **Parallel CLI** — wedges IPC; screenshots hang or capture wrong vault.
- **Screenshot without focus** — blank or wrong window (always run the driver or focus first).
- **`-OpenSettings` for every verify** — only when the task changed Settings UI.
- **Bundling into `verify-vault-seek.ps1`** — that script is eval/reload only; use this skill for visuals.
- **Defaulting to production vault** — routine visual verify uses sandbox.

## Vault paths

| CLI name | Path | Deploy default |
|----------|------|----------------|
| `plugin-sandbox-Obsidian` | `C:\plugin-sandbox-Obsidian` | **Yes** |
| `Obsidian` | `C:\Obsidian` | Promotion only |
