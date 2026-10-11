---
name: seek-index-lab-vault
description: >-
  Build and target the ~500-note Seek index lab vault (seek-index-lab-500) for
  full-reindex throughput, GPU/CPU saturation, and embed queue/batch control
  runs. Use instead of the 3k sandbox when a cycle would take ~1 hour. Not for
  UI verify, production, or scale/cold-start playbooks.
---

# Seek index lab vault (~500 notes)

Repeatable **index-throughput** vault. Goal is **resource saturation and notes/s**, not a wall-clock target.

| | |
|--|--|
| CLI vault name | `seek-index-lab-500` |
| Path | `C:\seek-index-lab-500` |
| Seek plugin | `C:\seek-index-lab-500\.obsidian\plugins\seek\` |
| Corpus | 500 markdown notes sampled from `C:\plugin-sandbox-Obsidian` |
| Typical full reindex | minutes, not ~1 hour |

**Do not** name this vault with the substring `Obsidian` (CLI `vault=` matching). Never `vault=Obsidian`.

## When to use

| Work | Vault |
|------|--------|
| Queue/batch / GPU saturation / full-reindex telemetry (B/D/E) | **`seek-index-lab-500`** |
| UI, Settings, playbooks S*/F*, 3k cold-start at scale | `plugin-sandbox-Obsidian` |
| Production | `Obsidian` (cwd `C:\Obsidian`, omit `vault=`) |

Disable Seek on the 3k sandbox before a lab GPU run so two vaults do not share the encoder.

## Rebuild

```powershell
.\.cursor\skills\seek-index-lab-vault\scripts\build-index-lab-vault.ps1 -Force -InitialSet B
```

`-Force` deletes and recreates `C:\seek-index-lab-500`. Copies 500 notes (stable stride + seed 42), a Seek-only `.obsidian`, and `main.js` / `manifest.json` / `styles.css` from the Gemma worktree if present, else repo root. Writes `data.json` queue/batch for `-InitialSet` (`B` = q1 b8, `D` = q10 b8, `E` = q10 b4). Sync is off. No IDB / `index/` copy.

Open only if the vault window is not already up:

```powershell
Start-Process "obsidian://open?vault=seek-index-lab-500"
```

Then identity gate (serial CLI, `vault=` first):

```powershell
obsidian vault=seek-index-lab-500 eval code="JSON.stringify({name:app.vault.getName(),base:app.vault.adapter.basePath})"
```

Expect `name` = `seek-index-lab-500` and `base` = `C:\seek-index-lab-500`. Abort if either mismatches.

New vaults start with community plugins **off** (`app.plugins.isEnabled() === false`). After identity, **once**:

```powershell
obsidian vault=seek-index-lab-500 eval code="new Promise((res)=>{app.plugins.setEnable(true);app.plugins.enablePluginAndSave('seek').then(()=>res(JSON.stringify({ok:!!app.plugins.getPlugin('seek'),tabs:(app.setting.pluginTabs||[]).filter(t=>t.id==='seek').length})))})"
```

Do **not** also `plugin:enable`, `loadPlugin`, or `plugin:reload` on that first turn — stacking those registers a second Seek settings tab on the same instance. Expect `tabs: 1`. If you already have two, disable Seek, splice leftover `pluginTabs` with `id==='seek'`, then `enablePluginAndSave` once.

First enable of Seek on an empty lab index starts `scheduleColdBuild` (full reindex). Copy artifacts **before** first open. **Do not** `plugin:reload` / disable while that pass is running.

## Deploy after a rebuild of Seek

Copy the three artifacts into `C:\seek-index-lab-500\.obsidian\plugins\seek\`, identity gate, then `obsidian vault=seek-index-lab-500 plugin:reload id=seek` **only when no full reindex is in flight**.

## Timing sets (queue / batch)

Driver: `scripts/run-full-index-timing-set.ps1` (defaults to this vault).

| Set | `embedInFlightMax` | `rollingBatchMax` | Role |
|-----|--------------------|-------------------|------|
| B | 1 | 8 | Serial control |
| D | 10 | 8 | Queue treatment |
| E | 10 | 4 | Batch treatment |

Score **GPU SM%**, persist wait, inflight high-water, effective batch, notes/s. Wall clock is a consequence, not a pass bar.

Sampler (no CLI): `scripts/sample-full-index-load.ps1`.

## Identity / CLI

Same rules as deploy-and-verify: one `obsidian` command at a time; `vault=seek-index-lab-500` first; do not treat “Seek is loaded” as proof of vault.

## See also

- [seek-cli-startup-debug](../seek-cli-startup-debug/SKILL.md)
- [seek-playbook-catalog](../seek-playbook-catalog/SKILL.md) — keep S*/F* on the 3k sandbox
