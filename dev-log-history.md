# Seek living memory

how: .cursor/skills/seek-dev-log/SKILL.md
file: dev-log-history.md

---

## standing

branch: fix-seek-index-modal
remote: origin/fix-seek-index-modal
status: open
tag: startup
tag: cli
tag: webgpu
file: src/index-notice.ts
file: src/startup-drain.ts
file: src/main.ts
file: src/index-status-bar.ts
file: src/iframe-runner.ts
sym: resolveIndexUiStatus
sym: resolveCliSearchGate
sym: retainIndexInventory
sym: shouldAutoDrainStartupCatchUp
sym: scheduleStartupCatchUp
sym: beginIndexJob
sym: isChromiumPowerPreferenceAdapterWarning
open: webgpu-filter-uncommitted
exclude: idb-cross-device
exclude: sidecar-protocol
exclude: webgpu-device-lost-mobile
exclude: wasm-fallback

---

## 2026-08-19 git-ownership

id: 2026-08-19-git-ownership
date: 2026-08-19
status: done
tag: git
cmd: git
found: fatal detected dubious ownership
found: repo owned by Administrators SID user different
found: agent likely different signature
rca: git safe.directory check
did: add C:/Coding_projects/Obsidian-Seek to global safe.directory
did: list branches

---

## 2026-08-19 cli-startup-probes

id: 2026-08-19-cli-startup-probes
date: 2026-08-19
status: done
tag: startup
tag: cli
cmd: obsidian restart
cmd: obsidian eval
cmd: obsidian dev:debug
cmd: seek:search
found: first-load behavior unknown
found: debugger drop on restart
found: PowerShell && fail
found: top-level await in obsidian eval fail
rca: dev:debug on does not persist across obsidian restart
rca: eval not async-friendly
rca: probe parse choke on extra log lines
did: always restart first for cold boot
did: re-attach obsidian dev:debug on after restart
did: use .then() not await
did: parse only => lines
open: gates on paper vs code

---

## 2026-08-19 gate-mismatch

id: 2026-08-19-gate-mismatch
date: 2026-08-19
status: done
tag: startup
tag: cli
file: .cursor/skills/seek-cli-startup-debug/SKILL.md
file: .cursor/skills/seek-cli-startup-debug/scripts/startup-probe.ps1
file: src/index-notice.ts
file: src/main.ts
sym: warmingCaches
found: UI/CLI phases not match expected starting hydrating restoring indexing ready
found: skill wrote hoped-for gates code did not match
rca: many flags no single resolver
rca: warmingCaches treated as indexing
rca: hydrate labeled Indexing
rca: empty inventory during IDB read
did: write seek-cli-startup-debug skill and startup-probe.ps1
did: compare skill vs index-notice.ts main.ts
did: update skill after code caught up
open: implement the gates not just document

---

## 2026-08-19 startup-gates-fix

id: 2026-08-19-startup-gates-fix
date: 2026-08-19
status: done
tag: startup
tag: ui
tag: cli
tag: catch-up
tag: progress
file: src/index-notice.ts
file: src/startup-drain.ts
file: src/main.ts
file: src/index-status-bar.ts
file: src/search-modal.ts
file: src/settings-tab.ts
file: src/index-notice.test.ts
file: src/startup-drain.test.ts
file: src/embedder.test.ts
sym: resolveIndexUiStatus
sym: resolveCliSearchGate
sym: retainIndexInventory
sym: shouldAutoDrainStartupCatchUp
sym: scheduleStartupCatchUp
sym: beginIndexJob
sym: reconcileOnLoad
sym: ensureModelLoaded
sym: catchUpPending
cmd: obsidian restart
cmd: seek:search
found: UI said Indexing during hydrate sidecar restore cache warm
found: desktop catch-up waited for Search modal
found: user must open modal once before model load
found: progress numbers junk 0/0 totals jump
found: seek:search returned no results while still loading
rca: no canonical UI status bar card modal CLI each guess
rca: reconcileOnLoad only set catchUpPending embeds wait ensureModelLoaded on Search
rca: desktop should drain mobile stay lazy jetsam did not drain
rca: jobs unowned update/hide global stale job stomp
rca: transient store.count 0/0 overwrite last good inventory
rca: CLI treat empty frame as search miss not not-ready
did: resolveIndexUiStatus resolveCliSearchGate cache warm not indexing
did: shouldAutoDrainStartupCatchUp scheduleStartupCatchUp on onload and onLayoutReady
did: beginIndexJob ids status bar jobId guard clamp done<=total
did: retainIndexInventory gen-keyed touchIndexInventory
did: CLI block start/restore always indexing block only if chunks=0
did: populated index searchable mid catch-up
did: loop patch copy main.js restart probe no full test suite
commit: feat: add CLI startup-debug skill and desktop catch-up drain helper
commit: fix: unify startup index labels, progress jobs, and CLI readiness
commit: test: cover startup UI gates, catch-up drain, and tokenizer init

---

## 2026-08-19 webgpu-powerpreference

id: 2026-08-19-webgpu-powerpreference
date: 2026-08-19
status: open
tag: webgpu
tag: chromium
tag: iframe
file: src/iframe-runner.ts
file: src/iframe-runner.test.ts
sym: WEBGPU_POWER_PREFERENCE_WARN_FILTER
sym: isChromiumPowerPreferenceAdapterWarning
sym: loadModel
sym: requestAdapter
bug: crbug.com/369219127
cmd: obsidian plugin:reload
found: console.warn twice per model load
found: message names powerPreference and requestAdapter
found: vault main.js had local iframe filter repo did not
rca: Chromium Windows ignores WebGPU powerPreference hint
rca: transformers.js WebGPU backend and ORT-Web session each call requestAdapter
rca: two independent adapter requests two warns
rca: correctness none same model same outputs
rca: GPU pick is Chromium default not discrete hint
rca: real WebGPU fail still falls back WASM in loadModel
did: port filter into iframe-runner.ts bootstrap
did: swallow console.warn only if both powerPreference and requestAdapter
did: test in iframe-runner.test.ts
did: build copy vault plugin:reload hashes match
open: not committed
open: iframe needs reload or restart to pick up filter
