# Sidecar sharing — failure modes and mitigations

Seek’s cross-device index lives in vault-synced files under `.seek-artifacts/` (per-device jsonl, embedding shards, meta, optional BM25 gzip). Obsidian Sync / iCloud deliver those files independently and out of order. This document is the review checklist for sidecar reliability work; the hydrate engine also carries a short pointer comment in `src/sidecar/sidecar-sync.ts`.

## Producer / consumer model

| Role | Who | Writes | Reads |
| --- | --- | --- | --- |
| **Producer** | This device while indexing (catch-up / full reindex) | Own `index.<deviceId>.jsonl`, shards, meta; desktop may emit `bm25.<deviceId>.json.gz` | Own live-id oracle only (compaction) |
| **Consumer** | Every device at boot, idle reconcile, or embed-free recovery | **Local IndexedDB only** — never another device’s sidecar files | All devices’ artifacts under the shared index dir (`listSidecarDeviceIds`) |
| **Orchestration** | `SidecarCoordinator` + `SearchOrchestrator` | Schedules hydrate under `IndexCoordinator.runExclusive` | `reconcileSidecarIfChanged`, startup hydrate before catch-up |

Each Obsidian window on the same vault shares the same synced sidecar directory; “multi-window” is not a separate protocol — last-writer per device id still goes through per-device jsonl merge rules. Two different machines are two producer ids in the same folder.

## Cross-device hydration

1. **Discover remote updates** — `sidecarDirSignature(adapter, dir, selfDeviceId)` hashes peer jsonl/meta size+mtime. Change (or empty local IDB) triggers `hydrateFromSidecar`. While unchanged, `probePeerAhead` still runs so UI reflects a newer peer meta without a full scan.
2. **Gate producers** — `scanProducerGate` walks every artifact device id; `metaAccepts` enforces model/revision/chunker/dim. Hydrate requires a committed jsonl; meta-only peers surface in logs (`artifactOnly`) and `peerSidecarPresent` (Restoring) until jsonl syncs.
3. **Merge** — `scanJsonl` unions accepted producers; duplicate chunk ids pick a deterministic winner (lex-larger device id at equal mtime — see sidecar tests). Consumer re-chunks **local vault text** and hydrates only ids in the intersection (liveness oracle).
4. **Apply safely** — All-or-nothing per note; partial shard arrival skipped until bytes exist. Writes go to IDB inside the write mutex; no clobber of peer files. Local indexing may still embed gaps the peer has not synced yet.
5. **UI / status** — `peerSidecarPresent` → Restoring / syncing copy when a compatible peer exists. `peerAhead` → update Seek / degraded. Refused stale peers do not pin Restoring (1.12.1 fix). Logging: `sidecar-hydrate-scan`, `sidecar-hydrate` in seek-report JSON.

**Not in scope of file-sidecar alone:** real-time push between devices (sync provider latency is assumed). Clock skew affects mtime tie-break only; content ids are content hashes, not wall clock.

## Failure modes

| Mode | What goes wrong | Detection | Mitigation / fail-safe |
| --- | --- | --- | --- |
| Partial sync order | Meta or BM25 arrives before `index.<device>.jsonl` or shard bytes | `listSidecarDeviceIds` vs jsonl-ready set; `sidecar-hydrate-scan` logs `artifactOnly` | Version gate uses union enumeration; hydrate waits for jsonl; `peerSidecarPresent` matches gate; all-or-nothing per note if shard lags (`isOffsetInRange`) |
| Stale peer identity | Older model/revision/chunker sidecar cannot hydrate current index | `metaAccepts` refusal; throttled `onRefusedProducer` | Excluded from hydrate/rank; `reapDeadIdentitySidecars` clears dead identity; status not stuck on “Restoring” (`peerSidecarPresent` requires accepting meta) |
| Peer ahead | Newer chunker on another device; this build too old to read | `peerAhead` / `probePeerAhead` (meta scan, hydrate-independent) | Update Seek banner; mobile grind-stop skips futile full re-embed |
| Atomic write crash | `.tmp` left without final rename | Strict glob excludes `.tmp` from scans; `sweepOrphanTmpFiles` | Recover own `.tmp`; never delete a **peer** `.tmp` (in-flight write) |
| Meta floor race | `writeDeviceMeta` preserve-read clobbers seq floor raised under dir lock | Unit test: meta write blocked on held lock | `writeDeviceMeta` runs under same dir lock as floor raises |
| Concurrent IDB + sidecar | Hydrate vs catch-up vs reload vs full drop | `IndexCoordinator.runExclusive` write mutex | Hydrate before catch-up; wipe+hydrate stay in one exclusive section; inspect producer before clearAllStores; UI precedence hydrate > empty-after-drop > catch-up (`resolveIndexUiStatus`) |
| CRC / corrupt shard | Bit flip or truncated shard | `readRecordAt` → null; hydrate skips partial note | No partial file records; retry on next reconcile when bytes heal |
| Half-cleared dead device | jsonl deleted, meta/bm25/shards remain | `listSidecarDeviceIds` union (not jsonl-only reap) | Idempotent `clearDevice`; reap revisits leftovers |
| Warm hydrate no-op | Every synced id already in IDB | Fresh-id pre-gate | Release startup gate (`onGoodEnough`); avoid full-vault re-chunk |
| Plugin reload / vault close mid-index | In-flight append or hydrate | Generation/mutex; deferred compaction | No silent IDB corruption; recovery via Settings **Recover search index** / retry (see index-store timeouts) |
| Wedged IndexedDB | Store read hangs | Boot watchdog, bounded reads | Stuck UI + retry/rebuild (1.12.x); unrelated to sidecar files but blocks hydrate commit |
| ORT / embed worker stall | Model load hangs during catch-up after hydrate | Separate indexing path | Bounded model load; sidecar hydrate does not require full model (tokenizer-only for re-chunk oracle) |
| Remote ahead of local | Peer chunker/model newer than this build | `peerAhead`, `probePeerAhead` | No ingest; user asked to update; mobile avoids futile re-embed |
| Local ahead of remote | Peer older identity | `metaAccepts` false, `refusedProducers` | Local index + catch-up; optional `reapDeadIdentitySidecars` |
| Concurrent producers | Two devices append same chunk id | `scanJsonl` merge rules | Deterministic winner; loser record ignored for that id |
| Empty sidecar on one device | Phone has IDB evicted, desktop has full sidecar | `indexEmpty` + signature / hydrate | Desktop producer files hydrate phone IDB; phone may only write after local embed |
| Reload mid-sync | Plugin reload during hydrate or append | Write mutex, generational compact | Idempotent hydrate; peer `.tmp` never deleted by consumer |

## Verification

- Unit: `src/sidecar/sidecar-sync.test.ts`, `src/sidecar/sidecar.test.ts`, `src/sidecar/sidecar-coordinator.test.ts`
- CLI/logging: `.seek-artifacts/seek-report.json` → `sidecar-hydrate`, `sidecar-hydrate-scan`, `sidecar-commit`
- Sandbox: deploy + identity gate + cold/warm boot (see AGENTS.md and `seek-cli-startup-debug` skill)

## Related code

- Producer gate (union enumeration): `scanProducerGate` in `sidecar-sync.ts`
- Peer presence: `SidecarCoordinator.peerSidecarPresent`
- Reap: `SidecarCoordinator.reapDeadIdentitySidecars` + `listSidecarDeviceIds`
