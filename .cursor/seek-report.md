# Seek Diagnostic Report

_Generated 2026-08-26T05:02:08.466Z · log schema v16_

> [!info] Redacted report — note paths, titles, and query text were replaced by salted tokens (`note-3f9a21c4.md`). Identical tokens mean the identical note, so the diagnostics still read. Please still skim before sharing.

**Full data:** `seek-report.json` — parse that for analysis; this `.md` is a human summary.

## At a Glance
- This device: `desktop-c42c606c` · session `809e96fe-1a98-4f89-84d3-0cf8f4887cdf`
- Events: 333 in report of 384 total (older high-volume entries capped — see `caps` in the JSON) · 2026-08-25T00:43:33.726Z → 2026-08-26T05:00:17.245Z
- Devices: `desktop-c42c606c` (384)
- Last init: v1.1.4, iframe ✅
- Platform: desktop · GPU yes · storage 210 MB / 84613 MB
- Last model load: webgpu (dtype=q4)
- Searches 1 · index runs 43 · errors 0 · crashes 12

## Main-Thread Stalls (long tasks ≥250 ms, capped sample)
- `idle` 50× (40.9 s total · max 2.5 s)
- `indexing` 8× (12.2 s total · max 8.6 s)
- `catchup` 6× (3.4 s total · max 0.8 s)
- `reconcile` 7× (3.0 s total · max 0.8 s)
- `bm25-warm` 4× (1.2 s total · max 0.3 s)
- ↳ unattributed (`idle`) stalls by frame: `self` 50× — `self` = this window (Obsidian core, another plugin, or Seek's own main thread), a descendant = an iframe.

## Incremental Patches (delta-apply)
- 34/55 applied in place · mutex hold p95 193411 ms · max 492404 ms
- fallbacks (full cache rebuild): `cold caches` 21×

## ⚠️ Last Crash
- 2026-08-26T05:00:16.302Z · `desktop-c42c606c` · **evicted-while-hidden**
