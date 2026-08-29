# T5 — burst-cap

**PR:** #12 · **Branch:** `path/burst-cap` · **Vault:** Obsidian (~4.4k notes, ~16.7k chunks)

## 1. Executive summary

On warm reload with ~4k dirty files, catch-up held the shared iframe and IDB write lock for long bursts — blocking `seek:search` for 30+ seconds. T5 caps desktop catch-up bursts (**8 files / 4 s**, down from 40 / 15 s) so search can return hits while the Indexing badge still shows backlog. **T_first_hit = 468 ms** (warm caches) and **10.8 s** (warmDeferred probe); SLO ≤ 30 s. **Verdict:** pass. Additional UX fixes (query-priority RPC, warmDeferred) ship in PR #14 (T6).

## 2. Why the bottleneck existed

Catch-up indexing and search share the **same iframe embedder** and **IDB write mutex**:

- **Large bursts** (40 files / 15 s) kept the write lock and iframe busy too long per yield window.
- **Query `embed` queued behind `embed-batch`** on a single-flight iframe runner.
- **Pre-catchup warm** could hold `rem=0` for minutes while `ensureFrame` / BM25 fit ran.
- **`seek:search` during catch-up** timed out waiting for index traffic to yield.

Goal is **earlier first useful hit**, not faster total drain (burst cap does not reduce total catch-up wall time).

## 3. What we diagnosed

| Finding | Evidence |
|---------|----------|
| Search blocked during 4k backlog | `seek:search` 30s+ timeout on shared embedder |
| Invalid fixture false fail | Cleared file records → **261 s** fake fail (hydrate path, not burst) |
| Valid fixture protocol | Stamp `mtime=0`, drop `contentHash`, keep `chunk_ids` |
| Burst constants tuned | 8 files / 4 s from experiments (was 40 / 15 s) |
| Further fixes needed | warmDeferred, query-priority RPC → T6 / PR #14 |
| Wedged vault recovery | `heal-catchup-backlog-fixture.ps1` — rem≈4500 → rem=0 |

**Run B only** — catch-up UX SLOs use `plugin:reload`, not cold restart.

## 4. How we solved it

### PR #12 scope (`path/burst-cap`)

1. **`DESKTOP_CATCHUP_MAX_FILES_PER_BURST = 8`** (was 40).
2. **`DESKTOP_CATCHUP_BURST_BUDGET_MS = 4000`** (was 15,000).
3. **Boot scheduling tweaks** in `src/main.ts` for catch-up priority.
4. **Tests** — `src/catchup.test.ts`.

### Extended in T6 (PR #14) — cross-reference

- Query-priority iframe RPC pump (`src/iframe-runner.ts`).
- `warmDeferred`, drain-first `runCatchUp`, stale frame during writes (`src/search.ts`, `src/main.ts`).

**Key files (this PR):** `src/catchup.ts`, `src/main.ts`, `src/catchup.test.ts`.

### 4.1 Measurements / evidence

| Metric | Run | Baseline | Measured | SLO | Verdict |
|--------|-----|----------|----------|-----|---------|
| `T_first_hit_ms` (warm frame+BM25) | B | — | **468 ms** | ≤ 30 s | **Pass** |
| `T_first_hit_ms` (warmDeferred probe) | B | — | **10,812 ms** | ≤ 30 s | **Pass** |
| `rem` at first hit | B | — | ~4,362–4,473 | > 0 expected | Search usable during backlog |
| Invalid fixture | B | — | ~261 s | — | **Fail** (wrong fixture) |

**Scorecard:** `.cursor/scorecards/persist-cache-catchup-ux-backlog-4k-20260828-204014.json`

**Commit:** `2894abf` — `feat(catchup): cap desktop catch-up bursts for earlier search`
