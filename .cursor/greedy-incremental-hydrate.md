# Greedy incremental hydrate (sidecar companion)

_Companion to [`startup-hypothesis-report.md`](startup-hypothesis-report.md) · `.seek-artifacts/seek-report.json` · Seek 1.1.4_

**North-star metric:** `T_first_good` — wall clock from Obsidian ready → first **useful** search result (ranked hit on a note touched in the last 3–7 days, or non-gate `seek:search` with `chunks > 0` on recent corpus). Not “hydrate finished” and not “full vault indexed.”

**Problem today:** When `hasFreshId` is true, `hydrateFromSidecar` calls `reChunkLive()` on **every** indexable file (~4.4k × ~20 ms ≈ **88 s**) before hydrating anything. Search stays gated for the whole IIFE (`warmPhase: starting`). Catch-up is already recency-first, but runs **after** hydrate.

**Proposal:** **Greedy tiered hydrate** — reChunk + hydrate in widening **mtime windows**, release the gate after tier 0 when the index is “good enough,” finish remaining tiers in the background.

---

## Design goal

| User expectation | Today | Target |
|------------------|-------|--------|
| “I restarted Obsidian; search my recent notes” | Wait **~87 s** | **`T_first_good ≤ 5–15 s`** |
| “Peer synced 3 notes overnight” | Full vault walk | **Walk ≤ tier-0 files** (~3d window) |
| “Cold recovery after eviction (empty IDB)” | **53–265 s** blocked, then search | **Recent notes searchable in tier 0**; full corpus restores in background |
| “Is the index complete?” | Binary (Starting → Ready) | **Progressive:** `good-enough` → `restoring` → `ok` |

---

## Recency tiers (greedy schedule)

Cumulative mtime cutoffs from `Date.now()` at hydrate start. Each tier **adds** files not yet processed in prior tiers (not re-walked unless content changed).

| Tier | Window | Label | Role |
|------|--------|-------|------|
| **0** | last **3 days** | `hydrate-tier-3d` | **Good-enough gate** — daily journal, meetings, inbox |
| **1** | last **7 days** | `hydrate-tier-7d` | Weekly review, short-term projects |
| **2** | last **14 days** | `hydrate-tier-14d` | Fortnight backlog |
| **3** | last **30 days** | `hydrate-tier-30d` | Monthly archive |
| **4** | last **90 days** | `hydrate-tier-90d` | Quarter |
| **5** | **all remaining** | `hydrate-tier-full` | Cold completeness; orphan coverage |

**Greedy stop (per boot):** After each tier, if `freshIdsRemaining.size === 0` (every missing sidecar id now in IDB or tombstoned), **skip** tiers 5…N for reChunk (still run `hasFreshId` no-op path on later boots).

**Optional future knob:** settings tier list or “aggressive / balanced / complete” preset. Default: table above.

---

## Algorithm

### Inputs

- `scan` — `scanJsonl` → `Map<chunk_id, ResolvedEntry>`
- `existing` — chunk ids already in IDB
- `freshIds` — `{ id ∈ scan.keys() | id ∉ existing }`
- `files` — `indexableFiles()` sorted **`mtime` descending** (same as catch-up)

### Per tier `T`

```
cutoffMs = now - tier.window
tierFiles = files where mtime >= cutoffMs and path not in processedPaths

live = reChunkLiveSubset(tierFiles)   // tokenizer only, cheapYield every 8 files
candidates = filter live notes:
  - not fully in existing
  - every live chunk_id has scan entry (coverable)
  - at least one chunk_id ∈ freshIds (or ∈ freshIdsRemaining)

hydrate candidates (shard reads, IDB batch, existing path steps 6–8)
freshIdsRemaining -= hydrated ids
processedPaths += tierFiles paths

if tier === 0 OR freshIdsRemaining empty:
  markIndexGoodEnough()   // see Gate semantics
  maybe release search gate

if freshIdsRemaining empty:
  break

// tier 5: tierFiles = all not in processedPaths
```

### `reChunkLiveSubset(files)` vs today’s `reChunkLive()`

Same pipeline per file: `cachedRead` → `chunksFor` → `enforceTokenBudget` → `chunk_id`s. Only the **file list** shrinks. No protocol change; sidecar still keyed by `chunk_id` only.

### Id-bounded early exit (greedier than pure calendar tiers)

Within a tier, process files in **mtime desc** order. After each file (or batch of 8 with yield):

- If all ids produced by that file that appear in `freshIdsRemaining` are now satisfied → continue.
- If `freshIdsRemaining` becomes empty → **stop reChunk** even mid-tier.

This handles “one old note synced” without walking the full 3d window.

---

## Gate semantics (`T_first_good`)

Today (`main.ts`): search blocked while `indexBootPending || sidecarHydrating`.

**Proposed states:**

| Phase | `indexWarmPhase` / UI | Search |
|-------|------------------------|--------|
| Tier 0 in flight | `starting` | Gate: `Seek not ready` |
| Tier 0 done + `chunks > 0` for recent paths | `null` / **`good-enough`** | **Allowed** — ranked search on hydrated subset |
| Tiers 1…N in flight | `restoring` (or `indexing` with job badge) | Allowed; results improve as tiers land |
| All tiers done or `freshIds` empty | `ok` | Full |

**`good-enough` criteria (all required):**

1. Tier 0 hydrate committed **or** `freshIdsRemaining` empty.
2. `getIndexStats().chunks > 0`.
3. Frame buildable (`ensureFrame` succeeds).

**Not required for good-enough:** full vault walked, `reconcileOnLoad` finished, `warmCaches` done (can run parallel after gate release).

Status bar example: `Seek: Recent notes ready · 1,240 remaining` during tier 3.

---

## Performance model (vault baseline)

From [`startup-hypothesis-report.md`](startup-hypothesis-report.md): `N_notes = 4,427`, `T_file ≈ 20 ms`, full walk ≈ **88 s**.

**Estimate tier file counts** (measure on vault; placeholders until instrumented):

| Tier | Assumed % of `N_notes` | Files | ReChunk only (`× T_file`) | `T_first_good` (tier 0 + commit) |
|------|------------------------|-------|---------------------------|----------------------------------|
| 0 — 3d | 3–8% | 130–350 | **2.6–7 s** | **3–10 s** |
| 1 — 7d | 5–15% | 220–660 | +4–13 s | — |
| 2 — 14d | 8–20% | 350–885 | +7–18 s | — |
| 3 — 30d | 15–35% | 660–1,550 | +13–31 s | — |
| 4 — 90d | 30–60% | 1,330–2,660 | +27–53 s | — |
| 5 — full | 100% | 4,427 | **~88 s** | same as today |

**Expected gains vs today:**

| Scenario | Today `T_search_ready` | With greedy + early gate | Δ |
|----------|------------------------|---------------------------|---|
| Peer delta, ids only in 3d window | **~87 s** | **3–10 s** | **~88–95%** |
| Peer delta, 1 old note (id-bounded exit) | **~87 s** | **&lt; 2 s** | **~98%** |
| Cold empty IDB (full recovery) | **~87 s** blocked + background | **`T_first_good` 3–10 s**; total restore still **53–265 s** | **Perceived** win; total work unchanged |
| `needed: 0` warm sync | **&lt; 1 s** | **&lt; 1.5 s** | regression guard |

**Batching tokenizer RPCs** (parent report §3) stacks on top: tier 0 chunk cost −20–40% if RPC-bound.

---

## Interaction with other paths

| Path | Interaction |
|------|-------------|
| `hasFreshId` skip | Unchanged — no fresh ids → no reChunk at all |
| `reconcileOnLoad` | Run **after** tier 0 gate release **or** on deferred schedule; must not block `T_first_good` |
| Catch-up (`reindexDelta`) | Continues recency-first for **embed**; greedy hydrate handles **sidecar copy** |
| Eviction recovery | Tier 0 first → **`T_first_good` fast**; persist frame/BM25 (parent §4) still saves **~20–43 s** mutex on delta |
| Mobile jetsam | Tier 0 cap + `cheapYield`; optional `maxFiles` per tier same as catch-up burst |

---

## Instrumentation (logging report)

New NDJSON / `.seek-artifacts/seek-report.json` rows:

```json
{
  "type": "sidecar-hydrate-tier",
  "tier": "hydrate-tier-3d",
  "filesWalked": 142,
  "chunksProduced": 518,
  "needed": 12,
  "hydrated": 12,
  "freshIdsRemaining": 16400,
  "durationMs": 2840,
  "gateReleased": true
}
```

Summary row:

```json
{
  "type": "sidecar-hydrate-greedy",
  "tiersRun": 3,
  "stoppedEarly": true,
  "reason": "freshIds-empty",
  "T_first_good_ms": 4200,
  "T_hydrate_total_ms": 18500
}
```

**Counters to add in code:** `filesWalked`, `tokenCountsRpc`, `freshIdsRemaining` after each tier.

---

## Test protocol

Uses parent **two-run** discipline. **Never mix** `cold-restart` and `warm-reload` tables.

### Run A — `cold-restart` (greedy hydrate)

1. `obsidian restart vault=Obsidian`
2. Poll immediately; record `T_first_good` = first tick where:
   - `warmPhase: null` **and** `seek:search` on a **3d note title** returns a ranked hit, **or**
   - status shows `good-enough` / “Recent notes ready”
3. Continue polling until hydrate job idle or 120 s cap
4. `openLoggingReport()` → label `seek-report-greedy-cold-YYYYMMDD.json`

**Run A scorecard:**

| KPI | Baseline | SLO (greedy) |
|-----|----------|--------------|
| `T_first_good` | ~87 s (blocked) | **≤ 10 s** (tier 0) |
| `T_start` (gate clears) | ~87 s | **≤ 15 s** |
| Tier 0 `filesWalked` | 4,427 | **≤ 350** (3d) |
| `T_hydrate_total` (cold full) | 53–265 s | **no regression** vs baseline |
| `freshIds` empty tier | — | log tier index |

### Run B — `warm-reload` (background tiers + catch-up)

**Pre:** `uiHealth: ok`, `job.remaining === 0`.

1. `obsidian plugin:reload id=seek vault=Obsidian`
2. Measure background tier progress via `getIndexJob()` / status badge
3. `index-complete` on this session only: embed vs chunk
4. Label `seek-report-greedy-warm-YYYYMMDD.json`

**Run B scorecard:** `T_drain_total` ±10%; embed share on small bursts ≥80%.

### Scenarios

| ID | Setup | Run | Pass |
|----|-------|-----|------|
| G1 | Normal boot, `needed: 0` | A | `skip-rechunk`; `T_first_good` ≤ 15 s |
| G2 | Peer adds 1 note (3d mtime) | A | `filesWalked ≤ 5`; `T_first_good ≤ 5 s` |
| G3 | Cold empty IDB | A | `T_first_good ≤ 10 s`; tiers 1…N continue; total hydrate ≤ baseline max |
| G4 | Daily reload, small dirty set | B | `T_first_search` unchanged or better |
| G5 | Minimize → eviction → restart | A | `T_first_good` ≤ 15 s; first delta incremental if §4 shipped |

---

## Implementation phases

| Phase | Scope | Unlocks |
|-------|--------|---------|
| **P0** | `reChunkLiveSubset(files)` + tier loop inside `hydrateFromSidecar`; logging only | Prove `filesWalked` / tier timings (Run A) |
| **P1** | Early gate + `good-enough` UI; background tiers 1…N | **`T_first_good` SLO** |
| **P2** | `freshIdsRemaining` early exit within tier | G2 one-old-note case |
| **P3** | Settings preset; mobile per-tier `maxFiles` | tuning |

**Out of scope:** workers; sidecar path index (protocol change); skipping tokenizer on hydrate paths.

---

## Risks

| Risk | Mitigation |
|------|------------|
| Search on partial index confuses users | Status bar + “Restoring N chunks”; recency-biased results already expected |
| `reconcileOnLoad` marks whole vault dirty | Defer or narrow delta until tier 0 committed |
| Old note with fresh id in tier 5 | Id-bounded exit within tier; worst case one extra file read |
| Tier 0 too small on this vault | Measure 3d file count once; adjust to 5d if &lt;50 files |
| Correctness: partial note hydration | Keep all-or-nothing per note (existing rule) |

---

## Relation to parent speedup table

| Parent target | Greedy hydrate |
|---------------|----------------|
| §1 Incremental oracle | **This doc** — tier + id-bounded reChunk |
| §2 `cheapYield` | Required inside `reChunkLiveSubset` |
| §3 Batch RPCs | Multiplies tier savings |
| §4 Persist caches | Composes on eviction recovery |
| §6 Burst cap | Analogous UX for **post-gate** embed catch-up |

**Artifacts:** implement in `sidecar-sync.ts` + `search.ts` (`reChunkLiveSubset`); gate in `main.ts` + `index-notice.ts`.

**Worktree:** `path/greedy-hydrate` from `startup/trace-infra` (`../Obsidian-Seek-path-greedy`). Use `startup-trace-probe.ps1 -Run A -PathId greedy-hydrate` and `parse-startup-trace.mjs` for isolated scorecards. See [startup-path-results.md](startup-path-results.md).
