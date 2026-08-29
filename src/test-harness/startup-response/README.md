# Startup response harness

This suite checks Seek's early-result policy without opening Obsidian or reading a
real vault.

It uses:

- the real sidecar writer, scanner, and greedy hydrate policy;
- the real `IndexStore` over `fake-indexeddb`;
- the real `SearchOrchestrator` frame, BM25, and ranking pipeline;
- the real modal index-poll decision;
- in-memory vault and sidecar fixtures;
- deterministic embeddings and logical stage costs.

Run it with:

```sh
npx vitest run src/test-harness/startup-response
```

The logical clock verifies orchestration against a 10-second budget. It is not a
hardware benchmark and cannot model Electron IndexedDB contention, WebGPU model
load, iOS memory pressure, or Obsidian's vault-enumeration timing. Those remain
runtime CLI checks.

The three-day coverage and modal retry cases are ordinary tests. They fail when
production code regresses either part of the early-result contract.
