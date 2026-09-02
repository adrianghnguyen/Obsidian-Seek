---
name: seek-dev-troubleshooting
description: Troubleshooting guide for Seek development environment issues — IDB corruption, CLI reliability, PowerShell quirks, and sandbox recovery. Use when the CLI hangs, IDB refuses to open, restart kills Obsidian, or tests fail with environment-related errors.
---

# Seek development troubleshooting

## IndexedDB (IDB) corruption after manifest version change

Bumping `manifest.json` requires a full Obsidian restart (not just `plugin:reload`). The restart sequence can leave IDB permanently corrupted:

- `Internal error opening backing store for indexedDB.open` — the database backing store is unrecoverable.
- `indexedDB.deleteDatabase()` returns `blocked` — another window or handle holds the connection.
- `store.isOpen()` stays `false`, `generation` stays `0` permanently.
- `seek:retry-index-store` command is a no-op in this state.

**Recovery:**

1. `obsidian plugin:disable id=seek vault=<vault>` (if plugin is still loaded)
2. Quit Obsidian entirely from tray (right-click tray icon -> Quit). CLI restart often cannot kill the process.
3. Manually delete the IDB files at:
   `%APPDATA%\Obsidian\IndexedDB\https_app.obsidian.md_0\seek-index:<appId>.*`
   (or the whole `https_app.obsidian.md_0` directory — Obsidian recreates it).
4. Relaunch Obsidian, re-enable Seek, and let it rebuild from scratch.

**Prevention:**
- Before a `manifest.json` version bump, note the current sandbox state so you can detect post-restart corruption.
- Prefer `plugin:reload` over `obsidian restart` whenever possible. Only restart when the version actually changed.

## CLI restart reliability

`obsidian restart` has several failure modes:

- **Never reaches the app.** When the IPC queue is wedged, `obsidian restart` returns "Restarting..." but the app never closes. The process stays alive in the background.
- **Kills but doesn't restart.** The app closes but the CLI reconnection fails silently. Subsequent `eval` commands return "The CLI is unable to find Obsidian."
- **No readiness probe.** After restart, there is no way to poll for Obsidian being ready again. The `eval` command either works or fails — there is no "waiting" state.

**Recovery:**
- Always use manual Quit (tray -> Quit) instead of `obsidian restart` for reliability.
- After restart, wait ~20s before probing with `obsidian eval vault=<vault> code="'alive'"`.
- If the CLI still can't find Obsidian, start the vault with `Start-Process "obsidian://open?vault=<vault>"` and wait 15-20s before retrying.

## CLI serial-only constraint

The CLI is a single IPC queue. Running `obsidian` commands in parallel (across subagents, background shells, or concurrent tool calls) wedges the queue:

- A stuck `eval` (no `=>` output for ~15s) blocks all subsequent commands.
- `obsidian restart` issued while an earlier command is still queued silently fails.
- Chaining many CLI calls in one long script also wedges the queue if an early step hangs.

**Always:** one `obsidian` command at a time, wait for it to finish (or fail) before the next.

### Wedge anatomy and recovery (evidence from the 2026-09-01 worker verification)

> Canonical home: the global skill `~/.cursor/skills/obsidian-plugin-dev/SKILL.md` § "CLI IPC queue discipline" now carries the general rule (one command per invocation, wedge-vs-slow, exit-code signature, recovery). The notes below are the Seek-specific evidence record.

Two wedges occurred during the dedicated-worker reload stress session, both from **chained commands in one shell line** (`plugin:reload ; eval`, then `seek:search ; eval`) — the first command stalled the app's main thread (once, an Obsidian "Error" dialog window was up, which alone stops the queue being serviced) and the second queued behind it forever.

- **Wedge vs slow.** A wedge is silence: no `=>` line and no exit, indefinitely. Contrast a *slow-but-succeeding* `seek:search` right after a reload — catch-up can hold it for 100–130s and it still exits 0 with output. Don't kill a search that is still writing output.
- **Killed-shell signature.** A shell force-killed during a wedge reports exit code `4294967295` (0xFFFFFFFF) — the kill, not a command failure.
- **Why it's not plugin code.** The queue is a parent-app ↔ CLI channel; plugin runtime state (e.g. a nested Web Worker in an iframe) shares neither the thread nor the queue. After each wedge's recovery, the same session ran repeated reload + search cycles with the worker actively serving queries — zero hangs, zero Seek log errors.
- **Recovery (same as CLI restart reliability above):** kill the stuck shell → force-quit Obsidian (tray Quit; `Stop-Process` when the Error window blocks it) → relaunch `Start-Process "obsidian://open?vault=<vault>"` → wait ~15–20s → retry ONE probe (`eval code="'alive'"`).
- **Prevention that held:** strictly ONE `obsidian` command per shell invocation — never `;`-chain two CLI commands, even read-only ones behind a reload. A timeout wrapper (single command, ~20s cap, auto-kill on hang) would make the rule mechanical.

## PowerShell shell quirks

The development environment uses PowerShell, not bash. Common differences:

| Action | PowerShell | bash |
|--------|-----------|------|
| Command chaining | `cmd1; cmd2` | `cmd1 && cmd2` |
| Variable assignment | `$var = "value"` | `var=value` |
| String quoting | `@"..."@` for heredoc | `cat <<'EOF'` |
| Pipeline | `cmd1 \| cmd2` | `cmd1 \| cmd2` (same) |
| Path separator | `\` (native) | `/` (native) |

**Always use `;` for sequential commands, never `&&`.**

## Sandbox vault state

The sandbox vault (`plugin-sandbox-Obsidian`) can enter unrecoverable states:

- **IDB locked.** After a version change restart, the store may never re-open. See IDB corruption above.
- **Generation stuck at 0.** The index coordinator's generation counter never advances because the store is closed. No search can run.
- **Index locked.** The CLI returns `"search index is locked"` for all queries. This happens when a full reindex, sidecar hydrate, or catch-up is in progress, but also when the store is closed (the lock is never released).

**Diagnosis commands** (run serial, one at a time):

```powershell
# Basic liveness
obsidian eval vault=plugin-sandbox-Obsidian code="'alive'"

# Store + index state
obsidian eval vault=plugin-sandbox-Obsidian code="(async()=>{const s=app.plugins.plugins.seek;const o=s.orchestrator;return JSON.stringify({isOpen:o.store.isOpen(),gen:o.coord.generation,writing:o.coord.isWriting(),hasJob:!!o.coord.job,hasBm25:o.hasBm25Cache()})})()"

# Chunk count
obsidian eval vault=plugin-sandbox-Obsidian code="(async()=>{const s=app.plugins.plugins.seek;return JSON.stringify(await s.orchestrator.indexedChunkCount())})()"

# Search
obsidian seek:search vault=plugin-sandbox-Obsidian query="test" format=json

# Errors
obsidian dev:errors vault=plugin-sandbox-Obsidian
```

## Obsidian restart vs plugin:reload decision

| Scenario | Action | Notes |
|----------|--------|-------|
| `manifest.json` version changed | **Restart** (warn: closes every vault) | `plugin:reload` is not enough |
| Only `main.js` / `styles.css` changed | `plugin:reload` | Fast, no disruption |
| CSS/layout looks stale after reload | Try `obsidian reload vault=…` first | Then restart if still stale |
| Cold-boot / full reindex test | Prefer manual Quit + relaunch | CLI restart may wedge |

## Build verification checklist

When the full test suite passes but sandbox verification fails, first confirm the build artifacts are actually deployed:

```powershell
# Compare hash between repo build and vault
certutil -hashfile "C:\Coding_projects\Obsidian-Seek\main.js" SHA256
certutil -hashfile "C:\plugin-sandbox-Obsidian\.obsidian\plugins\seek\main.js" SHA256
```

A mismatch means the vault is running a stale build — re-copy and reload.