# Startup metrics fixtures

These tests validate startup scorecard and probe bookkeeping without Obsidian.

Synthetic JSONL and logging-report fixtures cover:

- current-session selection when peer-device rows are newer;
- run and path scoping;
- actual gate-eval latency p50, p95, maximum, and sample count;
- separation of long-task duration from CLI eval latency;
- catch-up first-hit timing after search completion;
- artifact generation before a probe returns its verdict.

They do not measure Electron, IndexedDB, model, or vault performance. Live probes
still provide those samples; this suite ensures the samples are interpreted and
recorded correctly.
