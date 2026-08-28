# Startup hypothesis report (sidecar)

_Companion to `seek-report.json` / `seek-report.md` · vault Obsidian · Seek 1.1.4 · 2026-08-27_

Serial subagent run (H1–H6, T1–T3). **Run A** (cold restart) for H1/H2; historical report mixed cold and warm — see protocol below.

## Executive summary

**Problem:** On this vault (~4.4k notes), Seek blocks search for **~87 s** after a cold Obsidian restart because hydrate runs a whole-vault `reChunkLive` pass (read + chunk + tokenizer RPC per file, no embed). That is **48–185×** more chunk time than embed on large passes. After eviction, recovery adds **~20–43 s** of mutex time deleting ~16k chunks (`cold caches`), not BM25 rebuild (~300 ms). Daily reload catch-up is usually embed-heavy on small bursts (93% median) but chunk-heavy when thousands of files are dirty.

**What we should expect to gain** (realistic, this vault):

| User scenario | Today (baseline) | After prioritized fixes | Expected gain |
|---------------|------------------|-------------------------|---------------|
| **Daily use** — peer sync, no new ids (`needed: 0`) | Hydrate **&lt;1 s**; reload already fast | Stay **&lt;1.5 s** (regression guard) | **~0%** — already good |
| **Daily use** — 1–50 notes changed on peer | Treated like full vault walk today → **~87 s** blocked | Incremental oracle (§1) | **~80–95%** → **&lt;10–15 s** to search-ready |
| **Cold restart** — full index recovery (16.6k fresh chunks) | Hydrate **53–265 s** + search blocked | Batching (§3) shaves chunk cost | **~15–35%** on hydrate → **~35–170 s**; still O(vault) — no magic |
| **Cold restart** — UI during Starting | Editor frozen ~87 s | `cheapYield` (§2) | **~0% faster**; UI/eval responsive; **+0–10%** wall time |
| **After minimize / eviction** | +**~26 s** mutex (16k deletes) on top of hydrate | Persist frame/BM25 (§4) | **~20–43 s** saved on recovery boot |
| **Reload with catch-up** — typical small delta | Embed **~93%** of burst time | Batching (§3) on chunk phase | **Modest** unless backlog is huge |
| **Reload with 4k+ backlog** | Must wait for drain; chunk **~28–32 s** | Burst cap (§6) | **0%** total drain time; **useful search in ~5–30 s** while badge still high |

**Combined realistic outcomes:**

- **Highest ROI:** incremental hydrate (§1) for the common case (small peer deltas). This is where users feel **~1 min → ~10 s** improvement on restart when only a few notes changed.
- **Second:** persist caches across eviction (§4) — **~20–40 s** off bad recovery boots, not every boot.
- **Third:** batch tokenizer RPCs (§3) — **~5–15 s** to **~25 s** on full-vault chunk passes (20–40% of **~28–32 s** chunk phase); compounds with §1 on cold recovery.
- **UX-only:** `cheapYield` (§2) and burst cap (§6) — responsiveness and earlier search hits, not shorter total indexing time.
- **Not worth pursuing:** workers (H6), BM25-only tuning (~300 ms), recency-first embed (already shipped).

**Bottom line:** Expect **large wins on small-delta restarts** (80–95% off `T_start`), **modest wins on full cold recovery** (15–35% off hydrate chunk work), **material wins after eviction** (~20–43 s), and **UX wins on large catch-up** (search usable minutes sooner without finishing the backlog). Full cold recovery of an empty IDB will remain **tens of seconds to minutes** — correctness-bound, not embed-bound.

---

**Never mix `cold-restart` and `warm-reload` in one results table.** They answer different questions.

| | **Run A — `cold-restart`** | **Run B — `warm-reload`** |
|---|---------------------------|---------------------------|
| **Purpose** | Hydrate IIFE, search gate (H1, H2, H3, H4), eviction recovery (T2), cold delta | Daily behavior: catch-up size, embed vs chunk (H5), burst cap (§6), search latency |
| **Trigger** | `obsidian restart vault=Obsidian` | `obsidian plugin:reload id=seek vault=Obsidian` |
| **Precondition** | Obsidian was closed or fully restarted | **`uiHealth: ok`**, `getIndexJob().remaining === 0`, index warm |
| **Poll** | **Immediately** — first gate poll before `dev:debug on` if needed to catch Starting | After reload; 1–2 s ticks until idle or stable Indexing |
| **`seek:search`** | **Once** during `warmPhase: starting\|restoring` only (H2 gate test) | After `warmPhase: null` — first ranked hit / `no results` |
| **Stop when** | `warmPhase: null` **or** hydrate window missed + 90 s cap → `openLoggingReport()` → **stop** | Catch-up finishes or stable Indexing window captured → report |
| **Do not** | Use for H5, `chunkDurationMs`/`embedDurationMs`, or catch-up perf — restart may spawn **4k+ file catch-up** | Use for hydrate-only SLOs — reload skips full Obsidian boot |

### Run A — `cold-restart` (hydrate / gate)

```powershell
obsidian restart vault=Obsidian
# poll immediately (do not wait for debug first)
obsidian eval vault=Obsidian code="JSON.stringify({alive:true,seek:!!app.plugins.plugins.seek})"
obsidian dev:debug on vault=Obsidian
# gate bundle every 1-2s; status-bar DOM during Starting/Restoring
# ONCE while warmPhase is starting|restoring:
obsidian seek:search query=probe limit=1 vault=Obsidian
# when warmPhase null OR 90s cap: STOP — do not wait for catch-up
obsidian eval vault=Obsidian code="app.plugins.plugins.seek.openLoggingReport().then(()=>'ok')"
```

**Record (Run A only):** `T_start`, `T_hydrate`, `T_gate_test`, `sidecar-hydrate` (`needed`, `scanned`, `hydrated`), H1/H2/H3 verdict fields. Label report artifact: `seek-report-cold-YYYYMMDD.json`.

### Run B — `warm-reload` (daily / catch-up)

```powershell
# PRE: wait until idle — uiHealth ok, job remaining 0
obsidian plugin:reload id=seek vault=Obsidian
obsidian dev:debug on vault=Obsidian
# gate bundle every 2s; track job.remaining, catchUpRunning
# seek:search ONLY after warmPhase null — never during uiHealth indexing (hangs)
obsidian seek:search query=<recent-note-title> limit=3 vault=Obsidian
obsidian eval vault=Obsidian code="app.plugins.plugins.seek.openLoggingReport().then(()=>'ok')"
```

**Record (Run B only):** catch-up `job.total` / `job.remaining` on first Indexing poll, `T_first_search`, `index-complete` rows on **this boot** (`chunkDurationMs`, `embedDurationMs`, `filesIndexed`), `delta-apply` (incremental vs cold). Label: `seek-report-warm-YYYYMMDD.json`.

### Hypothesis → run mapping

| ID / target | Run A | Run B |
|-------------|:-----:|:-----:|
| H1 hydrate `reChunkLive` | ✓ | |
| H2 search gate | ✓ | |
| H3 one-id full walk | ✓ (or forced cold) | |
| H4 main-thread yield | ✓ (eval latency during Starting) | |
| H5 embed vs chunk | | ✓ |
| T1 cold caches / mutex | ✓ (post-eviction cold only) | ✓ (incremental delta) |
| T2 eviction recovery | ✓ | |
| T3 idle attribution | either (label run type) | |
| §1 incremental hydrate | ✓ | |
| §2 cheapYield | ✓ | |
| §3 batch RPCs | ✓ (`T_hydrate`) | ✓ (`T_chunk`, small bursts) |
| §4 persist caches | ✓ (eviction → restart) | |
| §6 burst cap | | ✓ |

---

## Verdicts

_Evidence from mixed historical log; re-verify with labeled Run A / Run B._

| ID | Claim | Verdict | Valid run |
|----|-------|---------|
| H1 | Hydrate `reChunkLive` dominates, not embed | **Supported** — cold hydrate 53–265s; chunk/embed 48–185× on 4.4k passes | **A** |
| H2 | Search gated until hydrate IIFE finishes | **Supported** — `Seek not ready` while `warmPhase: starting` (~87s) | **A** |
| H3 | One fresh sidecar id ⇒ whole-vault re-chunk | **Inconclusive** — warm `needed=0` ~300ms; code yes, report lacks one-id proof | **A** |
| H4 | `reChunkLive` monopolizes main thread | **Supported** — no `cheapYield`; hydrate unspanned | **A** |
| H5 | Catch-up Indexing ⇒ embed dominates | **Partial** — embed ~93% on &lt;50-file bursts; chunk wins on 4.4k drains | **B** (not cold session) |
| H6 | Workers won't help hydrate oracle | **Supported** — vault read + iframe tokenizer | code |
| T1 | `cold caches` BM25 costs tens of seconds | **Falsified** — BM25 ~300ms; mutex is delta deletes | **A** cold / **B** inc |
| T2 | Hidden eviction ⇒ expensive next boot | **Supported** — 12/12 evicted; 10/10 recoveries `cold caches` | **A** |
| T3 | `idle` long tasks are Seek startup | **Inconclusive** — 40.9s idle, no plugin attribution | either |

## Bottleneck order

1. **Cold hydrate `reChunkLive`** — O(files) chunk+tokenize, search blocked (H1, H2).
2. **Eviction → cold delta** — ~16k chunk deletes in mutex, not BM25 fit (T2, T1).
3. **Large catch-up drains** — chunk-heavy when thousands dirty (H5); small bursts are embed-heavy.

## Performance baselines (this vault)

Seek 1.1.4, desktop, WebGPU q4. **Split by run type** — values from `seek-report.json` unless noted.

### Run A — `cold-restart` baselines

| Metric | Symbol | Baseline | Source |
|--------|--------|----------|--------|
| Indexable notes | `N_notes` | **4,427** | vault inventory |
| Indexed chunks (cold hydrate) | `N_chunks` | **~16,588** | `sidecar-hydrate.needed` |
| Sidecar records scanned | `N_sidecar` | **~28,020** | `sidecar-hydrate.scanned` |
| `warmPhase: starting` duration | `T_start` | **~87 s** | Run A gate polls (H2) |
| Hydrate scan→complete (cold) | `T_hydrate_cold` | **53–265 s** | `needed` ≈ 16.6k |
| Hydrate scan→complete (no-op) | `T_hydrate_warm` | **314–1,195 ms** | `needed: 0` within cold boot |
| Hydrate (`needed: 2`) | `T_hydrate_2` | **718 ms** | tiny fresh-id cold boot |
| Per-file reChunk wall | `T_file` | **~8–19 ms** | `perFileWallMs` on 4k pass |
| Gate string during Starting | `T_gate` | `Seek not ready — …` | H2 `seek:search` |
| Cold delta mutex | `T_mutex_cold` | **p50 25.8 s · p95 193 s** | first `delta-apply`, `cold caches` |
| Chunks removed (cold delta) | — | **~16,577** | post-eviction |
| BM25 warm | `T_bm25` | **≤318 ms** | off-mutex; not the cold tax |

**Run A scorecard:** `T_start`, `T_hydrate`, `T_gate`, `needed`/`hydrated`, first `delta-apply` after eviction.

### Run B — `warm-reload` baselines

| Metric | Symbol | Baseline | Source |
|--------|--------|----------|--------|
| Catch-up backlog (after polluted cold run) | `job.remaining` | **4,461** | ⚠️ H2 cold session — not a clean Run B |
| Full-vault chunk pass | `T_chunk_4k` | **27.4–31.6 s** | `chunkDurationMs`, 4,427 files |
| Full-vault embed (same pass) | `T_embed_4k` | **0.15–0.66 s** | `embedDurationMs` |
| Chunk / embed ratio (4k pass) | — | **48–185×** | large drain |
| Small burst embed share | — | **median 93%** | `index-complete`, `filesIndexed` &lt;50 |
| Incremental delta mutex | `T_mutex_inc` | **p50 1.3 s · p95 91 s** | `appliedIncrementally: true` |
| Reload → first search | `T_first_search` | _measure on clean Run B_ | reload → non-gate `seek:search` |

**Run B scorecard:** `job.total` on first Indexing poll, `chunkDurationMs`/`embedDurationMs` on **this session's** `index-complete` rows only, `T_first_search`, `T_drain_total`.

**Derived (Run A):** `T_start` ≈ `N_notes × T_file` → 4,427 × ~20 ms ≈ **88 s**.

**Derived (Run B):** embed share ≈ `embedDurationMs / (chunkDurationMs + embedDurationMs)` per `index-complete` row.

---

## Speedup targets — performance metrics

**3× Run A** and **3× Run B** per feature branch (separate tables). Report **p50** + **max**. Never compare cold metrics against warm baselines.

### 1. Incremental hydrate oracle — **Run A only**

**Change:** `reChunkLive` walks only candidate notes, not all `indexableFiles()`.

| KPI | Run A baseline | Target (SLO) | JSON / CLI field |
|-----|----------------|--------------|------------------|
| `T_start` | **~87 s** | See scenarios | Gate poll: `warmPhase` null − restart |
| `T_hydrate` | **53–265 s** (cold) · **&lt;1.2 s** (no-op) | Scenarios | `sidecar-hydrate-scan` → `sidecar-hydrate` Δt |
| `files_walked` | **4,427** | ≤ candidates | Instrument `reChunkLive` |
| `needed` / `hydrated` | 16,588 / 16,588 | tiny on small delta | `sidecar-hydrate` |
| `T_gate` | gate string during Starting | non-gate only after `warmPhase: null` | `seek:search` once in Starting |

**Run A scenario SLOs** (cold-restart, stop after hydrate — do not wait for catch-up):

| Scenario | `files_walked` | `T_hydrate` SLO | `T_start` SLO | Expected Δ |
|----------|----------------|-----------------|---------------|------------|
| no-op (`needed: 0`) | 0 | **≤ 1.5 s** | ≤ 15 s (Obsidian boot floor) | 0% guard |
| 1 new peer note | 1 | **≤ 2 s** | **≤ 10 s** | **~88%** on `T_start` |
| 50 dirty notes | ≤ 50 | **≤ 1 s** + overhead | **≤ 15 s** | **~83%** |
| full recovery | 4,427 | **≤ 265 s** (no regression) | **≤ 270 s** | 0% |

**Pass (Run A):** small-delta scenarios: `files_walked` ≪ `N_notes`, `T_start` improves ≥ **80%**. **Fail:** `needed: 2` but `files_walked > 100`.

---

### 2. `cheapYield` in `reChunkLive` — **Run A only**

| KPI | Run A baseline | Target (SLO) | Measure |
|-----|----------------|--------------|---------|
| `T_start` | **~87 s** | **≤ 96 s** (+10%) | Gate polls |
| `T_eval_p95` during Starting | multi-second | **≤ 2 s** | Eval every 1 s |
| `long_task_max` in Starting | unspanned | **≤ 500 ms** | `long-task` in hydrate window |

**Expected Δ:** 0–10% slower wall clock; eval p95 and UI responsiveness improve. **Not measured on Run B.**

---

### 3. Batch tokenizer RPCs — **Run A + Run B**

| KPI | Run | Baseline | Target (SLO) |
|-----|-----|----------|--------------|
| `token_counts_rpc` | **A** | ~4,427 / full walk | ≤ `N_notes / B` |
| `T_hydrate` | **A** | 53–265 s | **−15% to −35%** if RPC-bound |
| `T_chunk_4k` | **B** | 27.4–31.6 s | **≤ 22 s** (−20%) |
| embed share (&lt;50 files) | **B** | 93% | no regression (&lt;5% embed ms) |
| `chunk_id` | Vitest | — | byte-identical |

**Run A** proves hydrate-phase RPC reduction. **Run B** proves catch-up chunk-phase reduction on `index-complete` rows from that reload session only.

---

### 4. Persist frame/BM25 across eviction — **Run A only**

| KPI | Run A baseline | Target (SLO) |
|-----|----------------|--------------|
| First `delta-apply` after eviction | `cold caches`, `removed` ~16,577 | `appliedIncrementally: true`, `removed ≤ 100` |
| `T_mutex_cold` (first delta) | p50 **25.8 s** | **≤ 2 s** |
| `T_start` + mutex (recovery boot) | ~87 s + ~26 s | **≤ 90 s** total |

**Protocol:** minimize 30 s → restore → **Run A** restart → report → stop. Compare to baseline cold `delta-apply` rows.

---

### 5. `pushTaskContext` on hydrate — **Run A** (primary)

| KPI | Baseline | Target |
|-----|----------|--------|
| `idle` ms in first 5 min | 4.6 s startup slice | **−≥30%** |
| Attributed hydrate ms | 0 | **≥50%** of hydrate wall in `hydrating` |

0% user-facing speed. Label run type if also checked on Run B.

---

### 6. Desktop catch-up burst cap — **Run B only**

| KPI | Run B baseline | Target (SLO) |
|-----|----------------|--------------|
| `job.total` on first Indexing poll | measure clean reload | record only |
| `T_first_hit` | wait for `uiHealth: ok` | **≤ 30 s** after reload while `remaining > 0` |
| `T_drain_total` | 34–42 s (4k pass) | **±10%** |
| embed share per burst | 93% (&lt;50 files) | **≥ 80%** |

**Precondition:** idle vault (`remaining: 0`) before reload. Edit one recent note if needed to ensure small dirty set for burst-cap test.

---

## Results tables (never mix runs)

### Table A — `cold-restart` (feature vs baseline)

| label | date | `T_start` | `T_hydrate` | `needed` | `files_walked` | `T_gate` | `mutexHoldMs` | notes |
|-------|------|-----------|-------------|----------|----------------|----------|---------------|-------|
| baseline | 2026-08-27 | 87 s | 139 s | 16588 | 4427 | gated | 25770 | `seek-report.json` |
| feature | | | | | | | | `seek-report-cold-*.json` |

### Table B — `warm-reload` (feature vs baseline)

| label | date | `job.total` | `T_first_search` | `T_drain_total` | `chunkMs` | `embedMs` | `embed_share` | notes |
|-------|------|-------------|------------------|-----------------|----------|-----------|---------------|-------|
| baseline | _pending clean B_ | — | — | — | 31573 | 655 | 2% (4k pass) | polluted by cold H2 run |
| feature | | | | | | | | `seek-report-warm-*.json` |

**Checklist per feature branch:**

1. `npm run typecheck` + tests (chunk_id golden for §3).
2. Deploy to vault.
3. **Run A ×3** → copy report as `seek-report-cold-*.json` → fill Table A → **stop** (ignore catch-up).
4. Wait `uiHealth: ok`, `remaining: 0`.
5. **Run B ×3** → `seek-report-warm-*.json` → fill Table B.
6. Never use Run A session for H5 / `index-complete` perf rows.

**Primary metrics:** Run A → `T_start`. Run B → `embed_share` on typical bursts + `T_first_hit` (§6).

## Out of scope

Workers (H6), recency-first embed (already on), BM25-only tuning (~300ms).

## Caveats

- Original H2 probe was **Run A** but continued into catch-up — **4,461 `remaining`** invalidates Run B baselines until a clean warm-reload session.
- H3 needs injected fresh id on a dedicated **Run A**.
- T3 needs plugin bisect or hydrate task-context span (§5).
- **Never** run `seek:search` during `uiHealth: indexing` on either run (hangs).

**Artifacts:** `seek-report.json` (mixed — supersede with labeled cold/warm copies), `hyp-probe.ps1`, `seek-cli-startup-debug` skill.
