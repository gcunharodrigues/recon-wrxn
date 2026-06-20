# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [6.0.0-wrxn.7] - 2026-06-20

### Fixed
- **serve-endpoint discovery race (#4)** — concurrent `serve` processes no longer clobber each other's discovery file, which had left a live HTTP query door unannounced (kernel recall silently went dark). `removeEndpoint` is now pid-guarded (deletes the file only when it owns it), `claimEndpoint` writes only when the file is free (absent / dead-pid owner), and a ~10s `unref()`'d heartbeat lets a surviving serve re-claim the file after the announcing serve dies. The `{pid,port}` single-file discovery contract, path, and 0600 mode are unchanged — readers (kernel recall hook, `wrxn brain query`) need no change.

## [6.0.0-wrxn.6] - 2026-06-18

### Added
- **Orphaned drift class** — `recon_drift` surfaces pages whose `synced_to` watermark dangles (the code symbol it tracked no longer exists), reported distinctly from `stale`.

### Fixed
- **Watcher recency on incremental update** — an incremental markdown edit now applies recency decay, not only a full re-index.
- **npm 11 bin path** — dropped the leading `./` from the `bin` path so npm 11 keeps the executable bit on `recon-wrxn`.

## [6.0.0-wrxn.5] - 2026-06-17

### Added
- **Decay-weighted retrieval** — prose nodes carry `importance` and a reinforced recency; a decay-weight scorer (recency × importance) feeds the RRF ranking hook so fresh, important pages outrank stale ones. Mandatory decay-weight gate + durable harvest report (ADR 0005).

## [6.0.0-wrxn.4] - 2026-06-17

### Added
- **`recon_drift` MCP tool** — a computable stale-doc set: each prose page's `synced_to` watermark is diffed against the current AST fingerprint of the code it describes. Rides a structured drift sidecar over the serve door.
- **Per-symbol AST fingerprint** — every code symbol gets a fingerprint, the basis for drift detection.
- **`synced_to` watermark** stored and exposed on prose nodes.

### Fixed
- Drift bucketing hardened — multi-anchor + whole-file buckets, watermark hardening (review fixes).

## [6.0.0-wrxn.3] - 2026-06-16

### Added
- **HTTP serve door** — concurrent stdio + HTTP server with endpoint discovery; a structured hybrid `find` response served over a live in-memory store.
- **Hybrid retrieval quality** — weighted RRF fusion plus a semantic floor (tuned to 0.4) so gibberish queries return empty while GOLD-set recall holds.
- **Mid-session hybrid search** — a detached embed + live store swap brings semantic search online without a serve restart; the watcher refreshes retrieval freshness in place.

### Changed
- **Watcher burst coalescing** — a burst of file changes collapses to a single rebuild.

### Fixed
- **Serve hardening** — door-route allowlist, `recon_changes` via `execFile`, fail-open, `0600` socket permissions, structured `explain`, clean `400` on malformed JSON, widened git-ref allowlist.
- **Doc edges** — doc-asserted edges carry confidence `<1.0`; added a real embedder-seam smoke test.

## [6.0.0-wrxn.2] - 2026-06-16

### Added
- **Multi-format source indexing** — non-markdown files become searchable `Source` nodes: text-native (`.html`/`.txt`/`.yaml`/`.yml`/`.json`) carry a key+value `searchText` snapshot; binary (`.pdf`/`.docx`/`.pptx`/`.xlsx`) get a minimal path-only node. `exported:false` and type-gated like prose — excluded from `recon_rules`/`recon_impact`/`recon_map`.
- **Provenance to raw sources** — a distilled wiki page's `derived_from: <path>` resolves to its raw `Source` node, producing a `DOCUMENTED_BY` edge shown both directions by `recon_explain`; `recon_impact` does not traverse it.
- **Optional `maxFileSize` config** (`.recon-wrxn.json`) — an OOM escape hatch; invalid/non-positive values coerce to unlimited with a warning.

### Changed
- **Removed the hard 1 MB file-size cap** across all walkers — default is now unlimited (ReDoS protection is unchanged: bounded by the per-token citation cap, not file size).
- **Walker selectivity** — skip machine-generated lockfiles (`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`) and transient dump dirs (`.playwright-mcp`); the ignore set is consolidated to a single source of truth (`src/analyzers/ignore.ts`) shared by the markdown, source, and code walkers.

### Fixed
- Multi-document YAML (`---`-separated, e.g. k8s/helm manifests) is now indexed instead of skipped as malformed; empty `.json`/`.yaml` handled consistently; key+value serialization is depth-bounded.

## [5.4.2] - 2026-03-24

### Added
- **Graph Export** — `recon export` CLI + `recon_export` MCP tool (Mermaid/DOT, package/symbol/type/edge filters, subgraph clustering)
- **PR Review** — `recon review` CLI + `recon_pr_review` MCP tool (graph-aware blast radius, per-file risk 🔴🟡🟢, affected execution flows, Mermaid diagram, review priorities)
- **Auto-detect semantic search** — if `@huggingface/transformers` is installed, embeddings are generated automatically during `recon index`
- **Embedder pre-init on serve** — background embedder initialization for query-time hybrid search

## [5.3.0] - 2026-03-19

### Added
- **Worker pool** for parallel tree-sitter parsing — `worker_threads` with round-robin distribution, auto-enabled for 100+ files (3-4× speedup on large repos)
- "How It Works" section in README — 7-step flow explanation
- Multi-project setup guide in README — separate servers vs multi-repo
- Auto-indexing documentation table in README

## [5.1.1] - 2026-03-18

### Fixed
- `typescript` moved from `devDependencies` to `dependencies` — fixes `ERR_MODULE_NOT_FOUND` crash on global install and `npx`

## [5.1.0] - 2026-03-18

### Added
- **MCP Prompts**: `detect_impact`, `generate_map`, `onboard` — guided workflows for AI agents
- **`recon_augment` tool** — compact context injection for AI search augmentation
- **Framework detection** — automatic entry point multipliers for 20+ frameworks (Next.js, Express, NestJS, Django, Go, Spring, Rust, etc.)
- **Staleness check** — auto-detect stale index by comparing git commit hashes
- **`AGENTS.md` generation** — auto-generated codebase guide in `.recon/`
- **Live search dropdown** — 200ms debounce, keyboard navigation (↑↓ Enter Esc), type badges
- **Dashboard premium upgrade** — dark theme, Graph + Processes + Impact tabs, graph legend, community coloring toggle
- 55 new tests: `framework-detection.test.ts` (27) and `augmentation.test.ts` (28)

### Changed
- Professional README rewrite with badges (npm, downloads, license, MCP, tests), feature grid, complete tool reference

## [5.0.2] - 2026-03-17

### Fixed
- Process tab parser — correct execution flow rendering

## [5.0.1] - 2026-03-16

### Added
- Initial public release on npm
- **11 MCP tools**: packages, impact, context, query, detect_changes, api_map, rename, query_graph, list_repos, processes, augment
- **5 MCP resources**: packages, stats, symbol, file, process (`recon://` URIs)
- **13 language support** via tree-sitter: Python, Rust, Java, C, C++, Ruby, PHP, C#, Kotlin, Swift, Go, TypeScript, cross-language
- **BM25 search** with camelCase/snake_case tokenization
- **Hybrid semantic search** — BM25 + vector embeddings (all-MiniLM-L6-v2) with RRF fusion
- **Cypher-like graph queries** — MATCH/WHERE/RETURN structural queries
- **Multi-repo support** — index and query multiple repos from single `.recon/`
- **Community detection** — label propagation clustering
- **Incremental indexing** — SHA-256 file hashing, only re-parse changed files
- **HTTP REST API** + interactive dashboard on `:3100`
- **Cross-language tracing** — Go route handlers ↔ TypeScript API consumers
- **Graph-aware rename** — safe multi-file renames with confidence tagging
- **MCP server instructions** — auto-injected into AI agent system prompts
- **410 tests** across 14 test suites
