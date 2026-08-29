import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  CollapsibleSection,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Swatch,
  Table,
  Text,
  computeDAGLayout,
  useCanvasAction,
  useCanvasState,
  useHostTheme,
} from "cursor/canvas";

type ViewId = "system" | "index" | "search" | "persist" | "modules";
type ColorName = "blue" | "purple" | "green" | "orange" | "cyan" | "yellow";
type PipelineStep = {
  id: string;
  title: string;
  file: string;
  body: string;
  facts?: [string, string][];
};

const VIEWS: { id: ViewId; label: string }[] = [
  { id: "system", label: "System map" },
  { id: "index", label: "Index pipeline" },
  { id: "search", label: "Search pipeline" },
  { id: "persist", label: "Persistence" },
  { id: "modules", label: "Modules" },
];

const INDEX_SUBS = [
  { id: "pipeline", label: "Pipeline" },
  { id: "modes", label: "Modes & scheduling" },
  { id: "chunk", label: "Chunk identity" },
  { id: "embed", label: "Embed batches" },
] as const;

const SEARCH_SUBS = [
  { id: "pipeline", label: "Pipeline" },
  { id: "pools", label: "Stage-1 pools" },
  { id: "fusion", label: "Fusion" },
  { id: "query", label: "Query syntax" },
] as const;

const PERSIST_SUBS = [
  { id: "layers", label: "Two layers" },
  { id: "idb", label: "IndexedDB" },
  { id: "sidecar", label: "Sidecar hydrate" },
  { id: "identity", label: "Identity gates" },
] as const;

const SYSTEM_NODES: { id: string; label: string; file: string; detail: string }[] = [
  {
    id: "cmd",
    label: "Commands",
    file: "src/main.ts",
    detail: "Command palette and hotkeys open the search modal (seek:search) or trigger reindex / diagnostics.",
  },
  {
    id: "uri",
    label: "Protocol",
    file: "src/main.ts",
    detail: "obsidian://seek deep links can search or open a ranked hit in a chosen pane (tab / split / window).",
  },
  {
    id: "cli",
    label: "CLI",
    file: "src/main.ts",
    detail: "Headless handlers (seek:search, seek:open, seek:insert-link) register when the Obsidian CLI bridge is present.",
  },
  {
    id: "plugin",
    label: "SeekPlugin",
    file: "src/main.ts",
    detail: "Plugin shell: settings, schedulers, vault listeners, model-load gate, and wiring for every subsystem.",
  },
  {
    id: "modal",
    label: "Search modal",
    file: "src/search-modal.ts",
    detail: "Custom Modal (not SuggestModal): pill query field, debounced search, keyboard open/insert, infinite scroll.",
  },
  {
    id: "tab",
    label: "Settings",
    file: "src/settings-tab.ts",
    detail: "Index, relevance, display, model, and diagnostics. Live settings object is shared with the orchestrator.",
  },
  {
    id: "orch",
    label: "Orchestrator",
    file: "src/search.ts",
    detail: "Owns chunk → embed → store → search. Exposes search(), reindexAll(), reindexDelta(), sidecar hydrate, and the in-memory frame.",
  },
  {
    id: "embed",
    label: "Embedder",
    file: "src/embedder.ts",
    detail: "Parent-side embed API. Coalesces loads, caches query vectors, and talks to the sandboxed model iframe.",
  },
  {
    id: "store",
    label: "IndexStore",
    file: "src/index-store.ts",
    detail: "Per-vault IndexedDB: chunk meta/body, int8 embeddings, packed sign bits, BM25 JSON, file records, identity meta.",
  },
  {
    id: "iframe",
    label: "Model iframe",
    file: "src/iframe-runner.ts",
    detail: "Sandboxed srcdoc iframe runs transformers.js (WebGPU or WASM) because Obsidian CSP blocks remote import() in the plugin.",
  },
  {
    id: "sidecar",
    label: "Sidecar",
    file: "src/sidecar.ts",
    detail: "Vault-file index (JSONL + binary shards). Lets another device hydrate IndexedDB without re-embedding.",
  },
  {
    id: "notes",
    label: "Vault notes",
    file: "src/chunker.ts",
    detail: "Markdown notes always; .base files when indexBases is on. Chunker splits at headings and extracts tags, aliases, properties.",
  },
];

const SYSTEM_EDGES: { from: string; to: string }[] = [
  { from: "cmd", to: "plugin" },
  { from: "uri", to: "plugin" },
  { from: "cli", to: "plugin" },
  { from: "plugin", to: "modal" },
  { from: "plugin", to: "tab" },
  { from: "plugin", to: "orch" },
  { from: "modal", to: "orch" },
  { from: "orch", to: "embed" },
  { from: "orch", to: "store" },
  { from: "orch", to: "notes" },
  { from: "orch", to: "sidecar" },
  { from: "embed", to: "iframe" },
];

const RANK_LABELS = ["Obsidian host", "Plugin shell", "UI + core", "Compute + storage"];

const INDEX_STEPS: PipelineStep[] = [
  {
    id: "file",
    title: "Read vault file",
    file: "src/main.ts",
    body: "Markdown is always indexed. `.base` files join when indexBases is on. honorIgnoredFolders can skip Obsidian-ignored paths. A delta larger than 50 files is treated as a bulk import: progress is shown, a live query can preempt the embed, and a cold desktop model is deferred rather than force-loaded for a background paste.",
    facts: [
      ["Full reindex", "Settings → Reindex: nuke IDB, walk every indexable file"],
      ["Incremental", "Save / create / delete → reindexDelta()"],
      ["Bulk threshold", "50 files — above this, mini-reindex machinery"],
    ],
  },
  {
    id: "chunk",
    title: "Chunk at headings",
    file: "src/chunker.ts",
    body: "Fence-aware H1–H6 split. Titles are hierarchical (`Note | alias > H1 > H2`). Frontmatter tags, aliases, properties, and dates are extracted; inline `#tags` union into the same tag set. Empty notes still get a title-only lexicalOnly chunk so they remain findable by name.",
    facts: [
      ["CHUNKER_VERSION", "10 — bump invalidates sidecar ids"],
      ["denseSuffix", "Frontmatter values, dense channel only"],
      ["link_terms", "Wikilink text for BM25-only reclamation"],
    ],
  },
  {
    id: "budget",
    title: "Enforce token budget",
    file: "src/token-budget.ts",
    body: "Whole sections emit from the chunker; splitting happens once, at atom boundaries (paragraphs, fences, tables, callouts). Nothing exceeds the 512-token embed window. Hydration reproduces the same ids by running this step with the tokenizer only — not the ~100 MB model — so iPhone can restore an index without loading weights.",
    facts: [
      ["Cap", "512 tokens per chunk"],
      ["Atoms", "Fences / tables / callouts never split internally except at the hard ceiling"],
      ["Hydrate", "embedder.ensureTokenizer() only, a few MB"],
    ],
  },
  {
    id: "embed",
    title: "Embed in length buckets",
    file: "src/embedder.ts",
    body: "Chunks go into rolling buffers keyed by their exact token-count bucket. A buffer flushes when it hits rollingBatchFor(bucket) = clamp(round(512 / bucket), 1..8). Same-length batches mean almost no padding. CompositorPacer yields between dispatches. Full reindex pauses between files while search is active (250 ms poll, 2 min cap).",
    facts: [
      ["Model", "IBM Granite 97m multilingual, 384-d, q4"],
      ["Runtime", "transformers.js in a sandboxed srcdoc iframe"],
      ["Progress", "Every 25 files, or 2.5 s of silence"],
    ],
  },
  {
    id: "quant",
    title: "Quantize + pack",
    file: "src/quant.ts",
    body: "Stored vectors are unit-L2. Each becomes int8 + a per-vector max-abs scale (388 B vs 1536 B fp32, ≤0.003 nDCG@10 cost). Sign bits are packed separately for the cheap stage-1 scan. Query vectors stay fp32; both binary and cosine scoring are asymmetric.",
    facts: [
      ["Rerank tier", "int8 + scale (quant.ts)"],
      ["Candidate tier", "packed sign bits (binary.ts)"],
      ["Hot frame", "Bodies stay out of RAM until display / BM25 refit"],
    ],
  },
  {
    id: "idb",
    title: "Write IndexedDB",
    file: "src/index-store.ts",
    body: "putBatch writes meta, body, embeddings, binary, and the file record (mtime, content hash, chunk id list) together. IndexCoordinator.runExclusive() serializes all mutations. A delta sets currentDelta so ensureFrame waits for the fully applied result; a full reindex does not — it is meant to be queryable as it fills.",
    facts: [
      ["Mutex", "FIFO async lock; two writers never overlap"],
      ["Generation", "Bumped on every mutation; BM25 / binary / frame caches key on it"],
      ["DB_VERSION", "11 — schema bump empties stores via onupgradeneeded"],
    ],
  },
  {
    id: "bm25",
    title: "Fit BM25 + sidecar",
    file: "src/bm25.ts",
    body: "Multi-field MiniSearch (title 10, aliases 6, tags 3, content 3, properties 2, headings 3). Full reindex fits from scratch; a delta applyDelta()s the frame. Sidecar bulkAppend writes JSONL + 4 MB embedding shards so a peer can hydrate without re-embed. BM25 .gz emit is desktop-only.",
    facts: [
      ["Analyzer", "ANALYZER_VERSION stamps the blob; mismatch refits from bodies, no nuke"],
      ["Coverage", "raw BM25 × (matched/total)² — partial-match discount"],
      ["Sidecar format", "SIDECAR_FORMAT = 3"],
    ],
  },
];

const SEARCH_STEPS: PipelineStep[] = [
  {
    id: "parse",
    title: "Parse filters + text",
    file: "src/query-parser.ts",
    body: "Inline operators are stripped into QueryFilters. The residual cleanedQuery is what gets embedded and BM25-scored. FilterContext (Number-typed props, recency date field) is shared by parse and match so they cannot disagree. Filter-only queries (pills, no free text) skip embedding entirely and sort via browseOrder().",
    facts: [
      ["Tags", "#tag, tag:x, hierarchical #parent/child"],
      ["Path / props", "path:glob, [key:value], [key>n] on Number props"],
      ["Negation", "Bare -term excludes the whole note (Obsidian-style)"],
    ],
  },
  {
    id: "frame",
    title: "Ensure resident frame",
    file: "src/search.ts",
    body: "The frame is the corpus in binary-index order: metadata, packed sign bits, optional resident int8 block, tombstone mask. Cached by IndexCoordinator.generation. A warm keystroke is zero IDB traffic — that cache removed ~55% of old warm latency (per-query listAllChunks). In-flight deltas block; a filling full reindex does not.",
    facts: [
      ["Order", "One index i for binary, BM25, recency, and cosine"],
      ["Tombstones", "Incremental deletes stay until compaction; excluded by the selection mask"],
      ["Resident int8", "Desktop; mobile fetches int8 per candidate from IDB"],
    ],
  },
  {
    id: "s1",
    title: "Stage 1 candidate union",
    file: "src/binary.ts",
    body: "Three cheap arms, then union. Binary is an O(N) asymmetric sign-bit scan (desktop: BinaryScorerWorker). BM25 is multi-field with fuzzy, prefix-last-token, synonyms, and coverage². Recency is a fixed top-50 of newest notes so they are always reachable. Filters apply as a match-mask over the full indexes — the frame stays cache-valid.",
    facts: [
      ["Floors (N≤5k)", "binary 200 · BM25 100 · recency 50"],
      ["Ceilings", "binary 800 · BM25 400 · recency never scales"],
      ["Curve", "cap = floor · √(N / 5000), clamped"],
    ],
  },
  {
    id: "s2",
    title: "Stage 2 cosine",
    file: "src/ranker.ts",
    body: "Dequantize int8 → cosine against the fp32 query, only on the union (typically a few hundred rows, never the corpus). This is the expensive step the pool caps exist to bound. On mobile each union member is one IDB embedding read, which is why ceilings exist.",
    facts: [
      ["Query", "fp32, LRU-cached on the parent embedder"],
      ["Docs", "int8 dequant; not re-normalized (drift ≪ nDCG noise)"],
      ["Typical union", "200–800 at current vault sizes"],
    ],
  },
  {
    id: "rank",
    title: "Hybrid rank",
    file: "src/fusion.ts",
    body: "TM2C2 theoretical norms, not per-query min-max (min-max manufactured a fake 1.0 dense winner on out-of-vocabulary queries). dense_norm = (cos+1)/2; bm25_norm = raw / theoretical query bound. hybrid = α·dense + (1−α)·bm25. Recency is an additive ε-tiebreaker (ships Off). Title boost rewards query terms that are a subset of the note title.",
    facts: [
      ["α denseWeight", "0.85 default, live from settings, no reindex"],
      ["final", "hybrid + ε·recency + titleBoost"],
      ["ε default", "0 (Off). Default stage 0.04 · 180d half-life"],
    ],
  },
  {
    id: "hydrate",
    title: "Dedup + snippets",
    file: "src/snippet.ts",
    body: "Note-level dedup keeps the best chunk per path. Bodies are fetched only for the top-K that will render. Modal shows 10 rows, fetches 50, infinite-scrolls. Enter opens; modifiers pick tab/split; Alt+Enter inserts a wikilink.",
    facts: [
      ["Debounce", "200 ms desktop / 400 ms mobile"],
      ["Catch-up", "Paused while the modal is searching"],
      ["Scores", "Shown only when the corpus is calibrated (bgMean / bgStd)"],
    ],
  },
];

const IDB_STORES: [string, string][] = [
  ["chunk_meta", "Metadata without body — the frame-lite hot path"],
  ["chunk_body", "Chunk text; fetched for BM25 refit, negation, snippets"],
  ["embeddings", "Int8 vectors + per-vector scale"],
  ["binary", "Sign-bit packed vectors for stage-1 scan"],
  ["files", "Per-note mtime, content hash, chunk id list"],
  ["meta", "Singleton: model, dim, chunker, bg stats, identity"],
  ["bm25", "Persisted MiniSearch JSON + analyzer stamp"],
];

const MODULE_GROUPS: {
  title: string;
  color: ColorName;
  file: string;
  items: { name: string; role: string }[];
}[] = [
  {
    title: "Plugin shell",
    color: "blue",
    file: "src/main.ts",
    items: [
      { name: "main.ts", role: "Lifecycle, commands, protocol, CLI, index schedulers" },
      { name: "types.ts", role: "SeekSettings, Chunk, log schema, migrations" },
      { name: "settings-tab.ts", role: "Options UI for every user-tunable flag" },
    ],
  },
  {
    title: "Search and ranking",
    color: "purple",
    file: "src/search.ts",
    items: [
      { name: "search.ts", role: "SearchOrchestrator — the hub" },
      { name: "query-parser.ts", role: "Inline filter syntax" },
      { name: "bm25.ts / fusion.ts / ranker.ts", role: "Lexical score, TM2C2 fusion, hybrid rank" },
      { name: "select.ts / pool.ts", role: "Top-N and √N candidate caps" },
    ],
  },
  {
    title: "Indexing and storage",
    color: "green",
    file: "src/index-store.ts",
    items: [
      { name: "chunker.ts / token-budget.ts / atoms.ts", role: "Heading split, 512-token cap" },
      { name: "index-store.ts / index-coordinator.ts", role: "IndexedDB + write mutex" },
      { name: "catchup.ts / pacer.ts", role: "Idle drain and compositor-friendly batches" },
      { name: "identity.ts", role: "Model / chunker / dim fingerprint" },
    ],
  },
  {
    title: "Dense retrieval",
    color: "orange",
    file: "src/embedder.ts",
    items: [
      { name: "embedder.ts / iframe-runner.ts", role: "Parent API + sandboxed transformers.js" },
      { name: "platform.ts / model-registry.ts", role: "WebGPU vs WASM, Granite 97m spec" },
      { name: "quant.ts / binary.ts", role: "Int8 storage and stage-1 sign-bit scan" },
    ],
  },
  {
    title: "Sidecar sync",
    color: "cyan",
    file: "src/sidecar.ts",
    items: [
      { name: "sidecar.ts", role: "JSONL + binary shards, CRC, tombstones" },
      { name: "sidecar-sync.ts", role: "Hydrate IDB from a peer without re-embed" },
      { name: "sidecar-meta.ts", role: "Producer acceptance gates" },
    ],
  },
  {
    title: "UI",
    color: "yellow",
    file: "src/search-modal.ts",
    items: [
      { name: "search-modal.ts / query-field.ts", role: "Modal, pills, autocomplete" },
      { name: "open-target.ts / insert-link.ts", role: "Pane targets and wikilink insert" },
      { name: "index-notice.ts / index-status-bar.ts", role: "Stale / syncing / progress" },
    ],
  },
];

const THEMES = [
  {
    title: "Two-stage retrieval",
    body: "Cheap binary + BM25 + recency union, then cosine only on hundreds of candidates.",
  },
  {
    title: "Frame-lite hot path",
    body: "Metadata and packed vectors stay in RAM; bodies load only for BM25 refit, negation, and top-K display.",
  },
  {
    title: "Generation-keyed caches",
    body: "BM25, binary index, and resident frame share IndexCoordinator.generation so deltas cannot tear the corpus.",
  },
  {
    title: "Sidecar as sync transport",
    body: "IndexedDB is the query engine. Vault files are the durable, Sync-friendly backup for iOS eviction and other devices.",
  },
  {
    title: "Lazy model load",
    body: "Plugin boots without weights. First search or reindex downloads Granite (~100 MB) and transformers.js once per device.",
  },
  {
    title: "Synced rank, local compute",
    body: "denseWeight and friends live in data.json. WebGPU vs WASM stays in localStorage because devices differ.",
  },
];

function FileButton({ path }: { path: string }) {
  const dispatch = useCanvasAction();
  return (
    <Button variant="ghost" onClick={() => dispatch({ type: "openFile", path })}>
      {path}
    </Button>
  );
}

function SubNav<T extends string>({
  items,
  value,
  onChange,
}: {
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <Row gap={8} wrap>
      {items.map((item) => (
        <span key={item.id}>
          <Pill active={value === item.id} onClick={() => onChange(item.id)}>
            {item.label}
          </Pill>
        </span>
      ))}
    </Row>
  );
}

function Graph() {
  const theme = useHostTheme();
  const [selected, setSelected] = useCanvasState("system-node", "orch");
  const nodeW = 132;
  const nodeH = 48;
  const layout = computeDAGLayout({
    nodes: SYSTEM_NODES.map((n) => ({ id: n.id })),
    edges: SYSTEM_EDGES,
    direction: "vertical",
    nodeWidth: nodeW,
    nodeHeight: nodeH,
    rankGap: 56,
    nodeGap: 20,
    padding: 8,
  });
  const nodeById = new Map(SYSTEM_NODES.map((n) => [n.id, n]));
  const active = nodeById.get(selected) ?? SYSTEM_NODES[6];

  return (
    <Stack gap={12}>
      <div
        style={{
          position: "relative",
          width: "100%",
          overflowX: "auto",
          minHeight: layout.height,
        }}
      >
        <div style={{ position: "relative", width: layout.width, height: layout.height }}>
          <svg
            width={layout.width}
            height={layout.height}
            style={{ position: "absolute", inset: 0 }}
          >
            {layout.ranks.map((rank) => (
              <rect
                key={rank.rank}
                x={rank.x}
                y={rank.y}
                width={rank.width}
                height={rank.height}
                fill={theme.fill.quaternary}
                rx={6}
              />
            ))}
            {layout.edges.map((edge, i) => (
              <line
                key={`${edge.from}-${edge.to}-${i}`}
                x1={edge.sourceX}
                y1={edge.sourceY}
                x2={edge.targetX}
                y2={edge.targetY}
                stroke={theme.stroke.primary}
                strokeWidth={1}
              />
            ))}
          </svg>
          {layout.ranks.map((rank) => (
            <div
              key={`label-${rank.rank}`}
              style={{
                position: "absolute",
                left: rank.x + 8,
                top: rank.y + 4,
                fontSize: 10,
                lineHeight: "14px",
                color: theme.text.tertiary,
                pointerEvents: "none",
              }}
            >
              {RANK_LABELS[rank.rank] ?? `Layer ${rank.rank}`}
            </div>
          ))}
          {layout.nodes.map((n) => {
            const meta = nodeById.get(n.id);
            const isActive = n.id === selected;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setSelected(n.id)}
                style={{
                  position: "absolute",
                  left: n.x,
                  top: n.y,
                  width: nodeW,
                  height: nodeH,
                  margin: 0,
                  padding: "6px 8px",
                  border: `1px solid ${isActive ? theme.accent.primary : theme.stroke.primary}`,
                  borderRadius: 6,
                  background: isActive ? theme.fill.primary : theme.bg.elevated,
                  color: theme.text.primary,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 590, lineHeight: "16px" }}>
                  {meta?.label ?? n.id}
                </div>
                <div style={{ fontSize: 10, lineHeight: "14px", color: theme.text.tertiary }}>
                  {meta?.file.replace("src/", "")}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <Card>
        <CardHeader trailing={<FileButton path={active.file} />}>
          {active.label}
        </CardHeader>
        <CardBody>
          <Text>{active.detail}</Text>
        </CardBody>
      </Card>
    </Stack>
  );
}

function Pipeline({
  steps,
  stateKey,
}: {
  steps: PipelineStep[];
  stateKey: string;
}) {
  const theme = useHostTheme();
  const [selected, setSelected] = useCanvasState(stateKey, steps[0].id);
  const active = steps.find((s) => s.id === selected) ?? steps[0];
  const idx = steps.findIndex((s) => s.id === active.id) + 1;

  return (
    <Grid columns="minmax(220px, 0.9fr) minmax(0, 1.2fr)" gap={16} align="start">
      <Stack gap={4}>
        {steps.map((step, i) => {
          const isActive = step.id === selected;
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => setSelected(step.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: 0,
                padding: "8px 10px",
                border: "none",
                borderLeft: `2px solid ${isActive ? theme.accent.primary : theme.stroke.tertiary}`,
                background: isActive ? theme.fill.secondary : "transparent",
                color: theme.text.primary,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span
                style={{
                  width: 20,
                  fontSize: 12,
                  color: isActive ? theme.accent.primary : theme.text.tertiary,
                  fontWeight: 590,
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <span style={{ fontSize: 13, fontWeight: isActive ? 590 : 400 }}>
                {step.title}
              </span>
            </button>
          );
        })}
      </Stack>
      <Card>
        <CardHeader trailing={<FileButton path={active.file} />}>
          {`${idx}. ${active.title}`}
        </CardHeader>
        <CardBody>
          <Stack gap={12}>
            <Text>{active.body}</Text>
            {active.facts && (
              <Table headers={["", ""]} rows={active.facts} framed={false} />
            )}
          </Stack>
        </CardBody>
      </Card>
    </Grid>
  );
}

function SystemView({ onOpen }: { onOpen: (id: ViewId) => void }) {
  return (
    <Stack gap={16}>
      <Text>
        Seek is an Obsidian plugin that does on-device hybrid search: dense embeddings plus BM25, fused at query time. There is no API and no local server. `SearchOrchestrator` in `src/search.ts` is the hub; `SeekPlugin` in `src/main.ts` is the wiring.
      </Text>
      <Row gap={8} wrap>
        <Button variant="secondary" onClick={() => onOpen("index")}>
          Index pipeline
        </Button>
        <Button variant="secondary" onClick={() => onOpen("search")}>
          Search pipeline
        </Button>
        <Button variant="secondary" onClick={() => onOpen("persist")}>
          Persistence
        </Button>
      </Row>
      <Graph />
      <H2>Boot order</H2>
      <Text tone="secondary" size="small">
        Model weights are not loaded at startup. First search or reindex calls ensureModelLoaded().
      </Text>
      <Table
        headers={["Step", "What happens"]}
        rows={[
          ["Logger + settings", "NDJSON log, migrateSettings(), merge DEFAULT_SETTINGS"],
          ["IndexedDB", "IndexStore.open() scoped per vault + plugin id"],
          ["Forensics", "Inspect prior session; log crash if unclosed"],
          ["Orchestrator", "Construct with store, embedder, live settings ref"],
          ["Vault events", "Dirty-file queue, 5 min idle flush, catch-up when modal is idle"],
          ["Sidecar", "Hydrate + identity gates + periodic reconcile"],
          ["Embedder init", "Non-blocking; iframe/model stay lazy"],
        ]}
        striped
      />
    </Stack>
  );
}

function IndexView() {
  const [sub, setSub] = useCanvasState<(typeof INDEX_SUBS)[number]["id"]>(
    "index-sub",
    "pipeline",
  );

  return (
    <Stack gap={16}>
      <Text>
        Two modes share the same chunk → embed → write path. Inner tabs below go from the linear pipeline into scheduling, chunk identity, and embed-batch physics.
      </Text>
      <SubNav items={INDEX_SUBS} value={sub} onChange={setSub} />

      {sub === "pipeline" && (
        <Stack gap={16}>
          <Pipeline steps={INDEX_STEPS} stateKey="index-step" />
          <Callout tone="info" title="Write mutex">
            IndexCoordinator.runExclusive() serializes writes. currentDelta blocks ensureFrame() so a search never sees a torn multi-file delta. A full reindex stays readable as it fills.
          </Callout>
        </Stack>
      )}

      {sub === "modes" && (
        <Stack gap={16}>
          <H3>How work is scheduled</H3>
          <Table
            headers={["Mode", "Trigger", "Behavior"]}
            rows={[
              ["Full reindex", "Settings → Reindex", "Nuke IDB, walk the vault, embed all, fit BM25, rewrite sidecar"],
              ["Incremental delta", "Save / create / delete", "Drop stale chunks, embed changed ones, applyDelta() on BM25"],
              ["Idle flush", "Leave a note for 5 min", "Debounced embed of dirty files (IDLE_FLUSH_MS)"],
              ["Structural flush", "Delete / rename / move", "1.5 s window — model-free, a dead hit is jarring"],
              ["Catch-up", "Modal idle after backlog", "Mobile: 3 files or 8 s per burst, then yield (jetsam-safe)"],
              ["Bulk delta", ">50 dirty files", "Mini-reindex: progress, search preempt, defer cold model load"],
            ]}
            striped
          />
          <Callout tone="warning" title="Search always wins">
            indexingBlocked pauses embeds while a query is in flight. Full reindex pauses between files (250 ms poll, 2 min cap, 3 wedge episodes) rather than aborting — a full pass must finish.
          </Callout>
          <H3>IndexCoordinator</H3>
          <Text>
            Shared state, not a base class. writeLock is a FIFO async mutex. currentDelta is set only around incremental mutations. generation is the cache key for BM25, packed binary, and the resident frame. isWriting() tells the reconcile poll not to identity-heal a 7-minute reindex out from under itself.
          </Text>
          <Row gap={8}>
            <FileButton path="src/index-coordinator.ts" />
            <FileButton path="src/catchup.ts" />
          </Row>
        </Stack>
      )}

      {sub === "chunk" && (
        <Stack gap={16}>
          <H3>What a chunk contains</H3>
          <Text>
            One heading section is one chunk after token-budget re-split. The id is `chunkIdFor(notePath, title, content, denseSuffix)` — a path-salted hash. Two notes with identical body get distinct ids, so deleting one cannot orphan the other. A folder move changes the path, so that note re-embeds. Sidecar hydrate reproduces ids by re-chunking the live file with the same pipeline.
          </Text>
          <Table
            headers={["Channel", "What it carries"]}
            rows={[
              ["Dense", "Cleaned body + denseSuffix from frontmatter values"],
              ["BM25 title", "Note title | aliases > heading path"],
              ["BM25 tags", "Frontmatter tags ∪ inline #tags"],
              ["BM25 properties", "Searchable scalar props (setting-gated)"],
              ["BM25 link_terms", "Wikilink display text, lexical only"],
              ["lexicalOnly", "Title-only fallback for empty notes"],
            ]}
            striped
          />
          <Callout tone="info" title="CHUNKER_VERSION = 10">
            A bump changes chunk bytes and/or ids. Local identityMatches() then demands re-embed or re-hydrate. Peers whose sidecar is one version behind are refused until they reindex.
          </Callout>
          <Row gap={8}>
            <FileButton path="src/chunker.ts" />
            <FileButton path="src/token-budget.ts" />
            <FileButton path="src/atoms.ts" />
          </Row>
        </Stack>
      )}

      {sub === "embed" && (
        <Stack gap={16}>
          <H3>Rolling length buckets</H3>
          <Text>
            Naive per-file batching averaged ~2.2 chunks and padded to the longest member (~45% efficient). Chunks now flush from a buffer keyed by their own seq bucket. Batch size = clamp(round(512 / bucket), 1..8), so a 512-token chunk dispatches alone and short chunks pack up to 8. Same-length members → almost no padding. pace() still runs between flushes.
          </Text>
          <Grid columns={3} gap={12}>
            <Stat value="512" label="Token budget per dispatch" />
            <Stat value="1–8" label="Batch size by bucket" />
            <Stat value="iframe" label="WebGPU desktop / WASM mobile" />
          </Grid>
          <Table
            headers={["Why an iframe", "Detail"]}
            rows={[
              ["CSP", "Obsidian blocks remote import() in the plugin context"],
              ["srcdoc sandbox", "Permissive CSP loads transformers.js from jsDelivr once"],
              ["Lazy weights", "Granite ~100 MB from Hugging Face on first search/reindex"],
              ["Idle unload", "Mobile tears down the iframe after 3 min idle (~240 MB)"],
            ]}
            striped
          />
          <Row gap={8}>
            <FileButton path="src/embedder.ts" />
            <FileButton path="src/iframe-runner.ts" />
            <FileButton path="src/pacer.ts" />
          </Row>
        </Stack>
      )}
    </Stack>
  );
}

function SearchView() {
  const [sub, setSub] = useCanvasState<(typeof SEARCH_SUBS)[number]["id"]>(
    "search-sub",
    "pipeline",
  );

  return (
    <Stack gap={16}>
      <Text>
        Parse → resident frame → cheap candidate union → cosine on the union → hybrid rank. Cosine never scans the full corpus. Inner tabs cover pool scaling, fusion math, and the filter language.
      </Text>
      <SubNav items={SEARCH_SUBS} value={sub} onChange={setSub} />

      {sub === "pipeline" && (
        <Stack gap={16}>
          <Pipeline steps={SEARCH_STEPS} stateKey="search-step" />
          <Grid columns={3} gap={12}>
            <Stat value="0.85" label="Default denseWeight (α)" />
            <Stat value="√N" label="Binary + BM25 pool scaling" />
            <Stat value="200–800" label="Typical stage-2 union" />
          </Grid>
        </Stack>
      )}

      {sub === "pools" && (
        <Stack gap={16}>
          <H3>Three recall arms, one union</H3>
          <Text>
            The binary scan is already O(corpus); raising a cap is almost free on the scan side. The cost is the larger union that stage 2 (and mobile IDB) must touch. Caps therefore grow with live N, anchored so a ~5k-chunk vault sits exactly at the validated floors.
          </Text>
          <Table
            headers={["Arm", "Floor", "Ceiling", "Job"]}
            rows={[
              ["Binary (S1a)", "200", "800", "Asymmetric sign-bit scan; recovers the dense ceiling"],
              ["BM25 (S1b)", "100", "400", "The ~9% of gold dense cannot reach"],
              ["Recency (S1c)", "50", "50 (flat)", "Newest notes always reachable for the ε-tiebreaker"],
            ]}
            striped
            columnAlign={["left", "right", "right", "left"]}
          />
          <Callout tone="info" title="cap = floor · √(N / 5000)">
            Clamped to [floor, ceil]. Binary hits its ceiling around 80k chunks. Recency does not scale — “the newest note is reachable” is a constant concern, not a fraction of the corpus.
          </Callout>
          <Text size="small" tone="secondary">
            Filters compile to a boolean mask over the full frame. Indexes stay cache-valid across filtered queries. Tombstones are excluded in the same mask, including the browse path.
          </Text>
          <Row gap={8}>
            <FileButton path="src/pool.ts" />
            <FileButton path="src/binary.ts" />
            <FileButton path="src/binary-scorer.ts" />
          </Row>
        </Stack>
      )}

      {sub === "fusion" && (
        <Stack gap={16}>
          <H3>TM2C2, not min-max</H3>
          <Text>
            Per-query min-max used to map the best dense hit to 1.0 even when the model had no opinion (empty notes, opaque IDs). Theoretical norms are query-invariant: cosine maps to [0, 1] via (cos+1)/2; BM25 is divided by MiniSearch’s theoretical query bound.
          </Text>
          <Table
            headers={["Term", "Definition"]}
            rows={[
              ["dense_norm", "(cosine + 1) / 2"],
              ["bm25_norm", "raw BM25 / per-query theoretical bound"],
              ["hybrid", "α · dense_norm + (1 − α) · bm25_norm"],
              ["recency", "0.5^(daysOld / halfLife) on created (default) or mtime"],
              ["final", "hybrid + ε · recency + titleBoost"],
            ]}
            striped
          />
          <Grid columns={3} gap={12}>
            <Stat value="0.85" label="α (denseWeight)" />
            <Stat value="0" label="ε ships Off" />
            <Stat value="0.5" label="navTitleBoost default" />
          </Grid>
          <H3>BM25 field boosts</H3>
          <Table
            headers={["Field", "Boost", "Notes"]}
            rows={[
              ["title", "10", "Note title + aliases in the title string"],
              ["aliases", "6", "Raised to 9 when boostedBm25 is on"],
              ["tags / content", "3 / 3", "Body was 1.0 before the de-franken re-eval"],
              ["properties", "2", "Only indexed when searchableProperties is on"],
              ["headings", "3", "Experimental toggle; 4 when boostedBm25 is on"],
            ]}
            striped
            columnAlign={["left", "right", "left"]}
          />
          <Text size="small" tone="secondary">
            Recency is a vault-global definition (created property → YYYY-MM-DD in the filename → mtime), never per-query. A click study showed 50% of episodic clicks target notes older than 90 days, so ε is sized below real score gaps. It ships Off; the Default settings stage is ε=0.04 with a 180-day half-life.
          </Text>
          <Row gap={8}>
            <FileButton path="src/fusion.ts" />
            <FileButton path="src/ranker.ts" />
            <FileButton path="src/bm25.ts" />
          </Row>
        </Stack>
      )}

      {sub === "query" && (
        <Stack gap={16}>
          <H3>Inline syntax</H3>
          <Text>
            Matched tokens are stripped, not flattened. The residual is pure semantic text for embed + BM25. Tag hierarchy is enforced by the filter layer. Pills in the modal serialize to this same language.
          </Text>
          <Table
            headers={["Operator", "Meaning"]}
            rows={[
              ["#tag / tag:x", "Hierarchical tags"],
              ["path:folder/*", "fnmatch glob; quoted form allows spaces"],
              ["[key:value]", "Frontmatter substring, case-insensitive, wikilink-aware"],
              ['[key:"value"]', "Exact whole-value match"],
              ["[key>n] [key<n] [key=n]", "Numeric compare, only on Number-typed props"],
              ["after:DATE / before:DATE", "Inclusive, keyed off the recency date field"],
              ["-term", "Note-level negation (bare word only)"],
            ]}
            striped
          />
          <Callout tone="neutral" title="Not parsed (treated as plain text)">
            Negated operators (`-#tag`), phrases, boolean OR / grouping, `file:`, `match-case:`, `/regex/`.
          </Callout>
          <Text>
            Filter-only queries skip the embedder and sort with browseOrder() (recency + title). SuggestEngine autocompletes from vault tags, paths, and property keys.
          </Text>
          <Row gap={8}>
            <FileButton path="src/query-parser.ts" />
            <FileButton path="src/query-field.ts" />
            <FileButton path="src/suggest.ts" />
          </Row>
        </Stack>
      )}
    </Stack>
  );
}

function PersistView() {
  const [sub, setSub] = useCanvasState<(typeof PERSIST_SUBS)[number]["id"]>(
    "persist-sub",
    "layers",
  );

  return (
    <Stack gap={16}>
      <Text>
        IndexedDB is the query engine. Sidecar files in the vault are the durable copy that survives iOS eviction and travels over Obsidian Sync / iCloud. Inner tabs cover store layout, the hydrate algorithm, and the two identity gates.
      </Text>
      <SubNav items={PERSIST_SUBS} value={sub} onChange={setSub} />

      {sub === "layers" && (
        <Stack gap={16}>
          <Grid columns={2} gap={16}>
            <Card>
              <CardHeader trailing={<FileButton path="src/index-store.ts" />}>
                IndexedDB (per device)
              </CardHeader>
              <CardBody>
                <Stack gap={8}>
                  <Text>
                    Fast query path, scoped per vault + plugin id. Can be evicted on iOS WebView. Bodies are split from meta so the hot frame stays small.
                  </Text>
                  <Table headers={["Store", "Contents"]} rows={IDB_STORES} framed={false} />
                </Stack>
              </CardBody>
            </Card>
            <Card>
              <CardHeader trailing={<FileButton path="src/sidecar.ts" />}>
                Sidecar (synced vault files)
              </CardHeader>
              <CardBody>
                <Stack gap={8}>
                  <Text>
                    Default: `.obsidian/plugins/seek/index/`. Split-config Sync can use vault-root `Seek Index/`.
                  </Text>
                  <Table
                    headers={["Artifact", "Purpose"]}
                    rows={[
                      ["index.<device>.jsonl", "Chunk id → shard offset + CRC"],
                      ["embeddings.<device>.<seq>.bin", "Packed int8, 4 MB shards"],
                      ["meta.<device>.json", "Format, model, chunker, dim, bg stats"],
                      ["bm25.<device>.json.gz", "Desktop-only MiniSearch dump"],
                    ]}
                    framed={false}
                  />
                </Stack>
              </CardBody>
            </Card>
          </Grid>
          <Callout tone="info" title="Why two layers">
            IndexedDB cannot cross devices and iOS may drop it. Vault files ride the same sync the notes do. Hydrate restores vectors without a GPU/WASM re-embed if identity matches.
          </Callout>
        </Stack>
      )}

      {sub === "idb" && (
        <Stack gap={16}>
          <H3>Frame-lite layout</H3>
          <Text>
            Search never walks fp32. The resident frame is chunk_meta + packed binary (+ optional int8 on desktop). chunk_body is a separate store so BM25 refit, `-term` negation, and snippet render pay for text only when needed. files lets computeDelta decide dirty vs unchanged from mtime + content hash without opening every note.
          </Text>
          <Table
            headers={["Invariant", "How it is kept"]}
            rows={[
              ["No torn delta", "currentDelta; ensureFrame waits"],
              ["Cache coherence", "generation bumped in invalidateBm25Cache()"],
              ["Schema", "DB_VERSION = 11; onupgradeneeded empties stores"],
              ["Quota", "Quota errors surface INDEX_QUOTA_MSG; no silent truncate"],
            ]}
            striped
          />
          <Text size="small" tone="secondary">
            Tombstoned rows stay in the frame until compaction so a mid-delta reader never sees a hole in binary-index order. The selection mask drops them everywhere, including browse.
          </Text>
          <FileButton path="src/index-store.ts" />
        </Stack>
      )}

      {sub === "sidecar" && (
        <Stack gap={16}>
          <H3>Hydrate without re-embedding</H3>
          <Text>
            A chunk id is a deterministic path-salted hash, so the consumer reproduces the producer’s ids by re-chunking its own vault (chunk + token budget, tokenizer only) and keeping the intersection. Deleted notes match nothing — cross-device deletes need no protocol.
          </Text>
          <Table
            headers={["Step", "What happens"]}
            rows={[
              ["1. Gate producers", "metaAccepts: format, model, revision, chunker, dim"],
              ["2. Rank", "Freshest lastFullReindex first; self is eligible after iOS eviction"],
              ["3. Re-chunk live", "Same pipeline as index; tokenizer only, not the 100 MB model"],
              ["4. Intersect ids", "live ∩ sidecar, skip ids already in IDB"],
              ["5. All-or-nothing note", "Skip a note if any chunk’s bytes are still syncing"],
              ["6. Decode + put", "int8 + binary into IDB; write the file record"],
              ["7. Calibrate", "Inherit bgMean / bgStd from the freshest producer"],
              ["8. Remainder", "computeDelta embeds anything the sidecar did not cover"],
            ]}
            striped
          />
          <Callout tone="warning" title="Partial notes are left for embed">
            Writing a file record for a half-synced note would make computeDelta think the note is done. skippedPartialNotes waits for iCloud/Sync instead.
          </Callout>
          <Text>
            peerAhead is true when a refused producer has a higher chunkerVersion than this build. The modal shows a banner; mobile skips a futile local re-embed. Compaction coalesces small shards and retries incomplete-rechunk at most 3 times per session.
          </Text>
          <Row gap={8}>
            <FileButton path="src/sidecar-sync.ts" />
            <FileButton path="src/sidecar.ts" />
            <FileButton path="src/sidecar-meta.ts" />
          </Row>
        </Stack>
      )}

      {sub === "identity" && (
        <Stack gap={16}>
          <H3>Two gates, two slices</H3>
          <Text>
            pluginIdentity() in identity.ts is the single fingerprint. Local IDB and cross-device sidecar compare different slices on purpose: conflating them would refuse a valid hydrate on an analyzer-only or dbVersion-only bump.
          </Text>
          <Table
            headers={["Field", "Local IDB", "Sidecar", "On mismatch"]}
            rows={[
              ["chunkerVersion", "Yes", "Yes", "Re-embed or re-hydrate; ids/bytes changed"],
              ["modelId + revision", "Yes", "Yes", "Vectors are not comparable"],
              ["dim", "Yes", "Yes", "Defensive; 384 for Granite"],
              ["sidecarFormat", "No", "Yes", "Refuse producer (format 3 now)"],
              ["analyzerVersion", "No", "No", "BM25 blob refits from intact bodies"],
              ["dbVersion", "No*", "No", "IndexedDB onupgradeneeded already empties stores"],
            ]}
            striped
          />
          <Text size="small" tone="secondary">
            *dbVersion is enforced structurally by IndexedDB, not by identityMatches(). An unstamped legacy meta is treated as a guaranteed mismatch and rebuilt.
          </Text>
          <Grid columns={3} gap={12}>
            <Stat value="10" label="CHUNKER_VERSION" />
            <Stat value="11" label="DB_VERSION" />
            <Stat value="3" label="SIDECAR_FORMAT" />
          </Grid>
          <FileButton path="src/identity.ts" />
        </Stack>
      )}
    </Stack>
  );
}

function ModulesView() {
  return (
    <Stack gap={4}>
      <Text>
        Production code is a flat `src/` (~55 modules). Domains are file names, not folders. Tests are colocated `*.test.ts`.
      </Text>
      {MODULE_GROUPS.map((group) => (
        <div key={group.title}>
          <CollapsibleSection
            title={group.title}
            count={group.items.length}
            leading={<Swatch color={group.color} />}
            trailing={<FileButton path={group.file} />}
            defaultOpen={group.title === "Search and ranking"}
          >
            <Stack gap={6}>
              {group.items.map((item) => (
                <div key={item.name}>
                  <Row gap={8} align="start">
                    <Text weight="semibold" size="small" style={{ minWidth: 220 }}>
                      {item.name}
                    </Text>
                    <Text size="small" tone="secondary">
                      {item.role}
                    </Text>
                  </Row>
                </div>
              ))}
            </Stack>
          </CollapsibleSection>
        </div>
      ))}
    </Stack>
  );
}

export default function SeekArchitecture() {
  const [view, setView] = useCanvasState<ViewId>("view", "system");

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 960 }}>
      <Stack gap={8}>
        <Row gap={8} align="center">
          <H1 style={{ margin: 0 }}>Seek architecture</H1>
          <Spacer />
          <Pill size="sm">v1.1.4</Pill>
          <Pill size="sm">id: seek</Pill>
        </Row>
        <Text tone="secondary">
          On-device hybrid search inside Obsidian. IBM Granite 97m (384-d) via transformers.js, MiniSearch BM25, IndexedDB + vault sidecar. Nothing leaves the machine except a one-time model download.
        </Text>
      </Stack>

      <Grid columns={4} gap={12}>
        <Stat value="Obsidian" label="Desktop + mobile" />
        <Stat value="384-d" label="Granite multilingual" />
        <Stat value="Hybrid" label="Dense + BM25 fusion" />
        <Stat value="Local" label="IDB + sidecar, no API" />
      </Grid>

      <Row gap={8} wrap>
        {VIEWS.map((v) => (
          <span key={v.id}>
            <Pill active={view === v.id} onClick={() => setView(v.id)}>
              {v.label}
            </Pill>
          </span>
        ))}
      </Row>

      {view === "system" && <SystemView onOpen={setView} />}
      {view === "index" && <IndexView />}
      {view === "search" && <SearchView />}
      {view === "persist" && <PersistView />}
      {view === "modules" && <ModulesView />}

      {view === "system" && (
        <Stack gap={10}>
          <Divider />
          <H2>Design themes</H2>
          <Grid columns={2} gap={12}>
            {THEMES.map((theme) => (
              <div key={theme.title}>
                <Stack gap={4}>
                  <Text weight="semibold">{theme.title}</Text>
                  <Text size="small" tone="secondary">
                    {theme.body}
                  </Text>
                </Stack>
              </div>
            ))}
          </Grid>
        </Stack>
      )}

      <Text size="small" tone="tertiary">
        Source: repo `docs/ARCHITECTURE.md` and `src/` as of Seek 1.1.4. Open a node, step, or file button to jump to the implementing module.
      </Text>
    </Stack>
  );
}
