# Seek

<img width="693" height="817" alt="Screenshot 2026-06-29 at 14 33 54" src="https://github.com/user-attachments/assets/127d554d-9faf-45c0-8215-02e151c1f5c4" />


Seek is an Obsidian native hybrid search for Obsidian vaults, built to find buried information in large and complex vaults. It combines dense semantic embeddings with lexical (keyword) search to find exactly what you're looking for, all running within Obsidian. No APIs, or local servers needed. 

Relevance has been tested and evaluated on hundreds of thousands of queries and notes, and offers easy customization to best suit your vault.

<img width="735" height="595" alt="Screenshot 2026-06-30 at 09 25 33" src="https://github.com/user-attachments/assets/ab5bf543-8d57-4f79-b912-bede11bac059" />



## Features
- Support for 52 languages (plus code)
- Inline filtering with autosuggestions
- Support for mobile with a cross device, synced index
- Highly tuned and evaluated for relevance on any size of Obsidian vault, even up to tens of thousands of notes. 


The user guide for seek can be found [here](https://publish.obsidian.md/rmm/Seek+Documentation/About+Seek), and more information about Seek's relevance tuning and evaluation is [here](https://publish.obsidian.md/rmm/Seek+Documentation/Seek+Evaluation+%26+Development).

## Installation

1. Install the plugin in your vault.
2. In Seek settings, click index to let Seek scan your vault. (typically 1–3 minutes; longer for very large vaults).
3. Open search with the **Search** command and start typing.

## How It Works

Seek embeds your notes with a local embedding model and fuses those semantic scores with a lexical BM25 ranker. Indexing, embedding, and ranking all happen inside Obsidian. Your notes and queries never leave your machine.

### Progressive search: three tiers, promoted in place

A search streams results through three tiers, each promoting into the next without a flash or flicker:

1. **Name match** — the basename and alias prefix paint first, so a known-item keystroke shows its note immediately.
2. **Lexical BM25** — the persisted keyword index ranks matches within a few milliseconds, before the embedding model has finished computing vectors.
3. **Hybrid semantic** — the dense embedding and fusion pass reconciles the list in place with the final ranked results.

The search footer shows this ladder (Name match → Lexical BM25 → Hybrid semantic), bolding the active stage as each tier resolves. Because the lexical tier is served from the persisted index, search works even on a cold start, before the model finishes downloading or loading.

### Local index cache

The index lives in an IndexedDB database scoped to your vault (`seek-index:<appId>`). Notes are chunked and stored across tiered object stores so the search hot path only reads what it needs:

- **Chunk metadata and bodies** — text and per-chunk metadata for snippets and ranking.
- **Quantized embeddings** — vectors stored as int8 (SQ8), a 4× shrink over fp32 with negligible relevance loss.
- **Sign-bit projections** — a compact binary tier used to pick candidate chunks before exact reranking.
- **Persisted BM25** — the lexical index is serialized and reloaded on startup instead of being rebuilt from scratch.

The resident frame (the corpus in ranked order plus its packed vectors) is cached in memory and reused across keystrokes, so a warm query makes no IndexedDB round-trips. For multi-device use, Seek also writes a synced sidecar — per-device vault files that Obsidian Sync or iCloud can carry between devices — so a phone can hydrate the index without re-embedding.

## Network Use

Seek runs the embedding model locally, but it has to download the model and its runtime **once per device**, the first time you index a vault:

- **Model weights** are fetched from **Hugging Face** (`huggingface.co`) — the IBM Granite multilingual embedding model (~100 MB, quantized).
- **The transformers.js runtime** (the library that runs the model) is loaded from the **jsDelivr CDN** (`cdn.jsdelivr.net`).

These downloads happen only when the assets are not already cached. They are cached on-device afterward, so there are no repeat downloads, and Seek works fully offline once the model is in place. Only these model assets are ever fetched. No note content, query text, or usage data is transmitted.

## Privacy and Local Logging

Seek writes diagnostic logs (indexing progress, search activity, and errors) to local files inside your vault to help debug performance and relevance. These logs stay on your device and are never transmitted anywhere. Additionaly, diagnostics for search and relevance can be generated which creates a report of your recent searches, with note titles, and metadata included. Results content is not included in these reports, and the reports are written to your local Seek folder. 

Seek transmits no logging or data to me about your index, or your queries. 

## License and Attribution

Seek is released under the MIT License (see [`LICENSE`](./LICENSE)).

It builds on:

- [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) — on-device model inference.
- [IBM Granite embedding models](https://huggingface.co/ibm-granite) (Apache-2.0) — the embedding model.
- [MiniSearch](https://github.com/lucaong/minisearch) (MIT) — lexical (BM25) search.
