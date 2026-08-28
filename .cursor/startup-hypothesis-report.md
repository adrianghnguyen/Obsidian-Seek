# Startup hypothesis report (sidecar)

_Companion to `seek-report.json` / `seek-report.md` · vault Obsidian · Seek 1.1.4 · 2026-08-27_

Serial subagent run (H1–H6, T1–T3). One cold restart for H2; rest parsed from report + code.

## Verdicts

| ID | Claim | Verdict |
|----|-------|---------|
| H1 | Hydrate `reChunkLive` dominates, not embed | **Supported** — cold hydrate 53–265s; chunk/embed 48–185× on 4.4k-file passes |
| H2 | Search gated until hydrate IIFE finishes | **Supported** — `Seek not ready` while `warmPhase: starting` (~87s) |
| H3 | One fresh sidecar id ⇒ whole-vault re-chunk | **Inconclusive** — warm `needed=0` ~300ms; code path yes, report lacks one-id proof |
| H4 | `reChunkLive` monopolizes main thread | **Supported** — no `cheapYield` (unlike `collectLiveIds`); hydrate unspanned |
| H5 | Catch-up Indexing ⇒ embed dominates | **Partial** — embed ~93% on &lt;50-file bursts; chunk wins on 4.4k drains |
| H6 | Workers won't help hydrate oracle | **Supported** — vault read + iframe tokenizer; not inference-bound |
| T1 | `cold caches` BM25 costs tens of seconds | **Falsified** — BM25 warm ~300ms; mutex time is delta deletes |
| T2 | Hidden eviction ⇒ expensive next boot | **Supported** — 12/12 evicted; 10/10 recoveries start `cold caches` |
| T3 | `idle` long tasks are Seek startup | **Inconclusive** — 40.9s idle, no plugin attribution; 11% in first 5 min |

## Bottleneck order

1. **Cold hydrate `reChunkLive`** — O(files) chunk+tokenize, search blocked (H1, H2).
2. **Eviction → cold delta** — ~16k chunk deletes in mutex, not BM25 fit (T2, T1).
3. **Large catch-up drains** — chunk-heavy when thousands dirty (H5); small bursts are embed-heavy.

## Speedup targets (test before ship)

1. Incremental hydrate oracle — re-chunk only fresh/missing sidecar ids (H3).
2. `cheapYield` in `reChunkLive` — mirror `collectLiveIds` (H4).
3. Batch tokenizer RPCs — fewer iframe round-trips (H6).
4. Persist frame/BM25 across eviction — avoid cold delta on recovery (T2).
5. `pushTaskContext` on hydrate — attribute stalls in future reports (T3).

## Out of scope

Workers (H6), recency-first embed (already on), BM25-only tuning (~300ms).

## Caveats

- H2 restart left **4,461-file catch-up** — large-drain regime.
- H3 needs injected fresh id + `reChunkLive` file counter.
- T3 needs plugin bisect or hydrate task-context span.

**Artifacts:** `seek-report.json`, `hyp-probe.ps1`, `seek-cli-startup-debug` skill.
