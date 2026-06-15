# Derived search indexes: rebuild the cheap one, persist the expensive one

> Status: accepted — PRD `recon-prose-analyzer-00`, 2026-06-15

Recon's `serve` is snapshot-based — it loads persisted artifacts and never reparses source. So retrieval has two layers with different persistence rules:

- **Serve inputs are persisted snapshots:** `graph.json` (structure), `search-text.json` (prose body text), and `embeddings.json` (vectors). Prose body is kept OFF the `graph.json` node (so the served graph stays small) and persisted instead in `search-text.json` — its own snapshot, co-written with `graph.json` and updated by the watcher in lockstep, so it cannot drift. Embeddings are persisted because they are expensive to derive (model inference = minutes), with SHA-256 incremental freshness so only changed nodes re-embed.
- **The derived index is NOT persisted:** the BM25 inverted index (postings) is cheap to rebuild (sub-second over ~38k nodes) and is **rebuilt in memory on `serve`** from the inputs above. A stored index could drift from its inputs — the exact bug class that bloated `recon.db` to 603MB of stale rows — so it is never written to disk. It sits behind an interface, so a serialized cache can be added later without behavior change if startup ever becomes a concern.

The principle: **persist the inputs (as freshness-guarded snapshots), derive the index.** `graph.json` + `search-text.json` + `embeddings.json` are the authoritative artifacts; the BM25 index is reconstructed, never stored.
