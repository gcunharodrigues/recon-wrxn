# Serve runs stdio MCP and the HTTP query door concurrently

> Status: proposed — wrxn Phase 2 grill, 2026-06-16 (PRD pending)

`recon serve` already holds the whole brain warm: the loaded `graph`, the BM25 ranker
(`setFulltextRanker`), the `liveStore` vector holder, and the all-MiniLM embedder singleton. It also
already exposes a hybrid `recon_find` over the HTTP transport (`POST /api/tools/:name` →
`handleToolCall`). The only obstacle is that the two transports are **mutually exclusive** — serve
starts *either* the stdio MCP transport *or* the HTTP server, never both. When a host (Claude Code)
boots serve over stdio for MCP, the HTTP door is closed, so a separate short-lived client (a kernel
recall hook, `wrxn brain query`) has no way to reach the warm index — its only options would be a
cold second serve (double the graph + embeddings + embedder in RAM) or a cold per-prompt load.

**Decision:** allow the HTTP query door to run **concurrently** with stdio in a single serve process,
gated by config. When enabled, serve binds the existing Express app to **127.0.0.1** on an
OS-assigned port and writes a discovery file — `.recon-wrxn/serve-endpoint.json` carrying `{ pid,
port }` — so a client can find the live endpoint and verify liveness by the pid before trusting it.
The HTTP handler must read the vector store through the **live `liveStore` getter**, not capture it
by value, so the door sees slice-C's mid-session embedding hot-swap (today `http.ts` passes the store
by value and would serve stale vectors).

**Consequences:** one warm process serves both consumers — the agent over stdio (full code+prose
hybrid + the `recon_*` tools) and the hook / `wrxn brain` over localhost HTTP — with no second copy of
the index in memory. A new local surface exists: a read-only, loopback-only find endpoint. It is the
same exposure class as the pre-existing dashboard HTTP mode (no new capability beyond `recon_find`),
but it is now on whenever the door is enabled, so it stays bound to 127.0.0.1 and read-only.

**Alternatives rejected:** a dedicated second `recon serve --http` process for the hook — doubles
graph + embeddings + embedder RAM and adds a lifecycle to manage; a cold per-prompt snapshot load in
the client — reintroduces the load + embedder cost the warm design exists to avoid.
